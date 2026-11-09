import type { Drawing, DrawingPatch, Remark, RemarkOps } from '../types';

export type DirtyDrawingFields = Record<string, Set<keyof Drawing>>;
// Per dirty drawing: the server revision and field values the local edit started from.
export type DirtyDrawingBase = Record<string, { rev?: string; values: Partial<Record<keyof Drawing, unknown>> }>;
// Never sent or tracked as edits: identity, server-computed flags and the revision itself.
const UNTRACKED_FIELDS = new Set<string>(['id', 'hasPcf', 'rev']);
export const PCF_MANAGED_FIELDS: (keyof Drawing)[] = ['manualCommentsCount', 'manualOpenCommentsCount', 'currentRound', 'version'];

export function changedDrawingFields(before: Drawing | undefined, after: Drawing): Set<keyof Drawing> {
  return new Set((Object.keys(after) as (keyof Drawing)[]).filter(field => !UNTRACKED_FIELDS.has(field) &&
    JSON.stringify(before?.[field]) !== JSON.stringify(after[field])));
}

export function drawingFieldPatch(drawing: Drawing, fields: Set<keyof Drawing>) {
  const changes: Partial<Drawing> = {};
  for (const field of fields) {
    if (UNTRACKED_FIELDS.has(field) || field === 'currentRound' || (drawing.hasPcf && PCF_MANAGED_FIELDS.includes(field))) continue;
    (changes as any)[field] = drawing[field] === undefined ? null : drawing[field];
  }
  return { id: drawing.id, changes };
}

// Records the pre-edit value of newly dirty fields; the first recorded value wins.
export function recordDrawingBase(base: DirtyDrawingBase, before: Drawing | undefined, fields: Iterable<keyof Drawing>): DirtyDrawingBase {
  if (!before) return base; // new drawing: nothing on the server to conflict with
  const entry = base[before.id] ? { rev: base[before.id].rev, values: { ...base[before.id].values } } : { rev: before.rev, values: {} as DirtyDrawingBase[string]['values'] };
  let changed = !base[before.id];
  for (const field of fields) if (!(field in entry.values)) { entry.values[field] = before[field] === undefined ? null : JSON.parse(JSON.stringify(before[field])); changed = true; }
  return changed ? { ...base, [before.id]: entry } : base;
}

const remarkBase = (r: Remark) => ({ content: r.content ?? '', resolved: !!r.resolved });

export function diffRemarks(before: Remark[], after: Remark[]): RemarkOps {
  const old = new Map(before.map(r => [r.id, r]));
  const now = new Map(after.map(r => [r.id, r]));
  const ops: RemarkOps = {};
  const add = after.filter(r => !old.has(r.id));
  const update = after.filter(r => old.has(r.id) && JSON.stringify(remarkBase(old.get(r.id)!)) !== JSON.stringify(remarkBase(r)))
    .map(r => ({ id: r.id, content: r.content ?? '', resolved: !!r.resolved, base: remarkBase(old.get(r.id)!) }));
  const remove = before.filter(r => !now.has(r.id)).map(r => ({ id: r.id, base: remarkBase(r) }));
  if (add.length) ops.add = add;
  if (update.length) ops.update = update;
  if (remove.length) ops.remove = remove;
  return ops;
}

// PATCH body for one dirty drawing: changed fields only, plus the revision and
// pre-edit values the server checks them against. Remarks go as id-based ops.
export function buildDrawingPatch(drawing: Drawing, fields: Set<keyof Drawing>, base?: DirtyDrawingBase[string]): DrawingPatch {
  const patch: DrawingPatch = drawingFieldPatch(drawing, fields);
  if (!base?.rev) return patch; // never loaded from the server: plain create/update
  patch.baseRev = base.rev;
  const values: Partial<Drawing> = {};
  for (const field of Object.keys(patch.changes) as (keyof Drawing)[]) if (field in base.values) (values as any)[field] = base.values[field];
  if ('remarks' in patch.changes && Array.isArray(base.values.remarks)) {
    patch.remarkOps = diffRemarks(base.values.remarks as Remark[], drawing.remarks || []);
    delete patch.changes.remarks;
    delete values.remarks;
  }
  if (Object.keys(values).length) patch.base = values;
  return patch;
}
