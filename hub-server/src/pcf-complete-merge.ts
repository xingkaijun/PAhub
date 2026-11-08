import { fail, type PcfData } from './pcf-model.ts';

// Complete offline copies keep every business field, including circulation,
// approval history, legacy deleted records and audit timestamps. Only Hub
// internals are removed: entity clocks, receipts, client identifiers and IPs.
const INTERNAL_KEYS = new Set(['clientId', 'clientIp', 'ip', 'receipts', 'ownerHmac']);
const CLOCK_KEYS = new Set(['rev', 'statusRev', 'metaRev', 'ownerRev', 'replyRev']);

function stripInternals(value: any, top: boolean) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) stripInternals(item, false); return; }
  for (const key of Object.keys(value)) {
    if ((top && (key === 'hub' || key === 'export')) || key === 'hub' || INTERNAL_KEYS.has(key) || CLOCK_KEYS.has(key)) {
      delete value[key];
      continue;
    }
    stripInternals(value[key], false);
  }
}

export function completeData(source: PcfData): PcfData {
  const copy = structuredClone(source);
  stripInternals(copy, true);
  return copy;
}

export type CompleteExportMeta = {
  exportId: string;
  documentId: string;
  baseRev: number;
  round: number;
  exportedAt: string;
  mode: 'complete';
};

export function completeExport(source: PcfData, meta: CompleteExportMeta): PcfData {
  const copy = completeData(source);
  copy.export = { ...meta };
  return copy;
}

export type CompleteConflict = {
  id: string;
  path: string;
  field: string;
  kind: 'changed' | 'local-deleted' | 'server-deleted' | 'both-added';
  commentId?: string;
  roundId?: string;
  commentNumber?: number;
  base: any;
  local: any;
  server: any;
  localMissing?: boolean;
  serverMissing?: boolean;
  reason: string;
  allowed: Array<'local' | 'server' | 'merge'>;
};

type Choice = { choice: 'local' | 'server' | 'merge'; value?: any };
type Context = {
  conflicts: CompleteConflict[];
  choices?: Record<string, Choice>;
  used: Set<string>;
  numbers: Map<string, number>;
};

const MISSING = Symbol('missing');
type Presence = any | typeof MISSING;

const owns = (value: any, key: string) => !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
const plain = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function keyOf(item: any, path: string): string | undefined {
  if (!plain(item)) return undefined;
  if (path.split('/').at(-1) === 'roundRegister' && Number.isSafeInteger(item.round)) return 'round:' + item.round;
  if (typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id)) return 'id:' + item.id;
  return undefined;
}
function keyToken(key: string) { return key.startsWith('id:') ? key.slice(3) : key.slice(6); }
function keyed(value: any, path: string): value is any[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    const key = keyOf(item, path);
    if (!key || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function decide(ctx: Context, conflict: CompleteConflict): Presence {
  ctx.conflicts.push(conflict);
  ctx.used.add(conflict.id);
  const choice = ctx.choices?.[conflict.id];
  // Preview resolves every conflict to the current server value; apply must
  // supply an explicit decision for each one.
  if (!ctx.choices) return conflict.serverMissing ? MISSING : conflict.server;
  if (!choice) fail('Every conflict needs a decision');
  if (!conflict.allowed.includes(choice.choice)) fail('Unsupported conflict decision for ' + conflict.id);
  if (choice.choice === 'local') return conflict.localMissing ? MISSING : conflict.local;
  if (choice.choice === 'server') return conflict.serverMissing ? MISSING : conflict.server;
  if (choice.choice === 'merge') { if (!('value' in choice)) fail('Manual merge value required for ' + conflict.id); return choice.value; }
  fail('Unknown conflict decision');
}

function contextNumbers(server: PcfData, local: PcfData) {
  const numbers = new Map<string, number>();
  for (const comment of [...(local.comments || []), ...(server.comments || [])]) if (plain(comment) && typeof comment.id === 'string') numbers.set(comment.id, Number(comment.number));
  return numbers;
}

function conflictBase(path: string, kind: CompleteConflict['kind'], base: any, local: any, server: any, ctx: Context): CompleteConflict {
  const parts = path.split('/');
  const commentIndex = parts.indexOf('comments');
  const roundIndex = parts.indexOf('rounds');
  const commentId = commentIndex >= 0 ? parts[commentIndex + 1] : undefined;
  const roundId = roundIndex >= 0 ? parts[roundIndex + 1] : undefined;
  const field = kind === 'local-deleted' || kind === 'server-deleted' ? 'deleted' : (parts.at(-1) || path);
  return {
    id: path, path, field, kind,
    ...(commentId ? { commentId } : {}), ...(roundId ? { roundId } : {}),
    ...(commentId && ctx.numbers.has(commentId) ? { commentNumber: ctx.numbers.get(commentId) } : {}),
    base: base === MISSING ? null : base,
    local: local === MISSING ? null : local,
    server: server === MISSING ? null : server,
    ...(local === MISSING ? { localMissing: true } : {}),
    ...(server === MISSING ? { serverMissing: true } : {}),
    reason: kind === 'local-deleted' ? 'Local copy deleted this record; the server changed it'
      : kind === 'server-deleted' ? 'Server deleted this record; the local copy changed it'
      : kind === 'both-added' ? 'Both copies added the same record differently'
      : 'Both copies changed this field',
    allowed: kind === 'server-deleted' ? ['server'] : kind === 'local-deleted' ? ['server', 'local'] : ['local', 'server', 'merge'],
  };
}

function mergeKeyed(base: any[], local: any[], server: any[], path: string, ctx: Context): any[] {
  const order: string[] = [], tokens = new Map<string, string>(), items = new Map<string, { b?: any; l?: any; s?: any }>();
  const collect = (values: any[], slot: 'b' | 'l' | 's') => {
    for (const item of values) {
      const key = keyOf(item, path)!;
      if (!items.has(key)) { items.set(key, {}); order.push(key); tokens.set(key, keyToken(key)); }
      items.get(key)![slot] = item;
    }
  };
  collect(local, 'l'); collect(server, 's'); collect(base, 'b');
  const out: any[] = [];
  for (const key of order) {
    const entry = items.get(key)!, token = tokens.get(key)!;
    const value = mergePresence(path + '/' + token, entry.b ?? MISSING, entry.l ?? MISSING, entry.s ?? MISSING, ctx);
    if (value !== MISSING) out.push(value);
  }
  return out;
}

function mergeObject(base: any, local: any, server: any, path: string, ctx: Context): any {
  const out: any = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(server || {})]);
  for (const key of keys) {
    const child = path ? path + '/' + key : key;
    const b = owns(base, key) ? base[key] : MISSING, l = owns(local, key) ? local[key] : MISSING, s = owns(server, key) ? server[key] : MISSING;
    // Owner/reply cells are merged as one unit so text, markup and images
    // always come from the same side.
    if ((key === 'owner' || key === 'reply') && isContent(b) && isContent(l) && isContent(s) && !same(l, s) && !same(b, l) && !same(b, s)) {
      out[key] = decide(ctx, conflictBase(child, 'changed', b, l, s, ctx));
      continue;
    }
    const value = mergePresence(child, b, l, s, ctx);
    if (value !== MISSING) out[key] = value;
  }
  return out;
}
const isContent = (value: any) => plain(value) && typeof value.text === 'string' && typeof value.html === 'string' && Array.isArray(value.images);

function mergePresence(path: string, base: Presence, local: Presence, server: Presence, ctx: Context): Presence {
  // Audit timestamps are business data, but both sides rewrote them for
  // independent fields. Keep the later value instead of raising a conflict;
  // the selected string itself is preserved exactly.
  const leaf = path.split('/').at(-1);
  if (leaf === 'updatedAt' && typeof local === 'string' && typeof server === 'string') {
    const left = Date.parse(local), right = Date.parse(server);
    if (Number.isFinite(left) && Number.isFinite(right)) return right > left ? server : local;
    return server > local ? server : local;
  }
  // Display numbering is derived; both copies may add comments independently.
  if (path === 'nextCommentNumber' && Number.isSafeInteger(local) && Number.isSafeInteger(server)) return Math.max(local, server);
  if (path === 'nextCommentNumber') return server;
  if (base !== MISSING && local === MISSING) {
    if (server === MISSING || same(server, base)) return MISSING;
    return decide(ctx, conflictBase(path, 'local-deleted', base, local, server, ctx));
  }
  if (base !== MISSING && server === MISSING) {
    if (local === MISSING || same(local, base)) return MISSING;
    return decide(ctx, conflictBase(path, 'server-deleted', base, local, server, ctx));
  }
  if (base === MISSING) {
    if (local === MISSING) return server;
    if (server === MISSING) return local;
    if (same(local, server)) return local;
    if (plain(local) && plain(server)) return mergeObject({}, local, server, path, ctx);
    if (keyed(local, path) && keyed(server, path)) return mergeKeyed([], local, server, path, ctx);
    return decide(ctx, conflictBase(path, 'both-added', base, local, server, ctx));
  }
  if (same(local, server)) return local;
  if (same(base, local)) return server;
  if (same(base, server)) return local;
  if (plain(base) && plain(local) && plain(server)) return mergeObject(base, local, server, path, ctx);
  if (keyed(base, path) && keyed(local, path) && keyed(server, path)) return mergeKeyed(base, local, server, path, ctx);
  return decide(ctx, conflictBase(path, 'changed', base, local, server, ctx));
}

export type CompleteMergeResult = { data: PcfData; conflicts: CompleteConflict[] };

const CLOCK_KEYS_TOP = ['rev', 'statusRev', 'metaRev', 'ownerRev', 'replyRev'];

// Hub clocks are server-owned and are re-derived by storage.replace. Business
// timestamps (updatedAt, dates) survive exactly as merged. Export metadata is
// never persisted into the authoritative document.
export function restoreServerClocks(merged: PcfData, server: PcfData) {
  const dropClocks = (target: any) => {
    if (Array.isArray(target)) return target.forEach(dropClocks);
    if (!target || typeof target !== 'object') return;
    for (const key of CLOCK_KEYS_TOP) delete target[key];
    for (const value of Object.values(target)) dropClocks(value);
  };
  dropClocks(merged);
  if (server.hub) merged.hub = structuredClone(server.hub);
  else delete merged.hub;
  delete merged.export;
  return merged;
}

export function mergeComplete(input: { base: PcfData; local: PcfData; server: PcfData; choices?: Record<string, Choice> }): CompleteMergeResult {
  const ctx: Context = { conflicts: [], choices: input.choices, used: new Set(), numbers: contextNumbers(input.server, input.local) };
  const data = mergeObject(input.base, input.local, input.server, '', ctx) as PcfData;
  if (input.choices) for (const key of Object.keys(input.choices)) if (!ctx.used.has(key)) fail('Unknown conflict choice');
  // Display numbering is derived from the merged comment set.
  data.nextCommentNumber = Math.max(1, ...(data.comments || []).map((comment: any) => Number(comment.number) || 0)) + 1;
  return { data, conflicts: ctx.conflicts };
}
