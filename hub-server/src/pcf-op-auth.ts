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
  for (const [opIndex, op] of ops.entries()) {
    let capability: Capability = OP_CAPABILITIES[op?.type as keyof typeof OP_CAPABILITIES];
    if (!Object.hasOwn(OP_CAPABILITIES, op?.type)) return { ok: false, capability: 'pcf.op.unknown', opIndex };
    const comment = doc.comments?.find((c: any) => c.id === op.commentId);
    const round = comment?.rounds?.find((r: any) => r.id === op.roundId);
    if (op.type === 'content.set') capability = op.side === 'owner' && ownsRound(user, round) ? 'pcf.comment.edit_own' : 'pcf.comment.edit_any';
    if (op.type === 'round.meta') capability = op.field === 'minHeight' && ownsRound(user, round) ? 'pcf.comment.edit_own' : 'pcf.comment.edit_any';
    if (['comment.status', 'comment.meta'].includes(op.type) && !hasPermission(user, 'pcf.comment.edit_any')) {
      if (!comment?.rounds?.length || !comment.rounds.every((r: any) => ownsRound(user, r))) return { ok: false, capability, opIndex };
    }
    if (!hasPermission(user, capability)) return { ok: false, capability, opIndex };
  }
  return { ok: true };
}
