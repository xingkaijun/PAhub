import { hasPermission, type Capability } from './capabilities.ts';
import type { RequestUser } from './identity.ts';
import type { Op, PcfData } from './pcf-model.ts';
export const OP_CAPABILITIES = {
  'comment.add': 'pcf.comment.create', 'round.add': 'pcf.comment.create',
  'content.set': 'pcf.comment.edit_any', 'comment.status': 'pcf.comment.status', 'comment.meta': 'pcf.comment.meta',
  'round.meta': 'pcf.comment.edit_any', 'project.set': 'pcf.document.write', 'settings.set': 'pcf.settings',
  'roundRegister.set': 'pcf.document.write', 'record.delete': 'pcf.comment.edit_any', 'record.restore': 'pcf.comment.edit_any',
  'rounds.addAll': 'pcf.document.write', 'history.set': 'pcf.document.write',
} as const satisfies Record<string, Capability>;
export const ownsRound = (user: RequestUser | null | undefined, round: any): boolean => Boolean(user?.id && round?.initiatorId && round.initiatorId === user.id);
export function authorizeOps(user: RequestUser | null | undefined, ops: Op[], doc: PcfData): { ok: true } | { ok: false; capability: string; opIndex: number } {
  // A browser can create a round and edit it in the same batch. Project only
  // server-owned identities, never client fields, and never shadow existing IDs.
  const comments = (doc.comments || []).map((c: any) => ({ id: c.id, rounds: (c.rounds || []).map((r: any) => ({ id: r.id, initiatorId: r.initiatorId })) }));
  const used = new Set<string>(doc.hub?.tombstones?.map((t: any) => t.id) || []);
  const collect = (comment: any) => { used.add(comment.id); for (const round of comment.rounds || []) used.add(round.id); };
  comments.forEach(collect);
  for (const item of doc.deleted || []) { used.add(item.id); collect(item.data); }
  const freshId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !used.has(id);
  for (const [opIndex, op] of ops.entries()) {
    let capability: Capability = OP_CAPABILITIES[op?.type as keyof typeof OP_CAPABILITIES];
    if (!Object.hasOwn(OP_CAPABILITIES, op?.type)) return { ok: false, capability: 'pcf.op.unknown', opIndex };
    const comment = comments.find((c: any) => c.id === op.commentId);
    const round = comment?.rounds?.find((r: any) => r.id === op.roundId);
    if (op.type === 'content.set') capability = op.side === 'owner' && ownsRound(user, round) ? 'pcf.comment.edit_own' : 'pcf.comment.edit_any';
    if (op.type === 'round.meta') capability = op.field === 'minHeight' && ownsRound(user, round) ? 'pcf.comment.edit_own' : 'pcf.comment.edit_any';
    if (['comment.status', 'comment.meta'].includes(op.type) && !hasPermission(user, 'pcf.comment.edit_any')) {
      if (!comment?.rounds?.length || !comment.rounds.every((r: any) => ownsRound(user, r))) return { ok: false, capability, opIndex };
    }
    if (!hasPermission(user, capability)) return { ok: false, capability, opIndex };
    if (op.type === 'comment.add' && freshId(op.id) && freshId(op.roundIdNew) && op.id !== op.roundIdNew) {
      used.add(op.id); used.add(op.roundIdNew);
      comments.push({ id: op.id, rounds: [{ id: op.roundIdNew, initiatorId: user!.id }] });
    }
    if (op.type === 'round.add' && comment && freshId(op.id)) {
      used.add(op.id); comment.rounds.push({ id: op.id, initiatorId: user!.id });
    }
  }
  return { ok: true };
}
