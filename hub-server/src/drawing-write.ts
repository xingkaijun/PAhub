import { writeAudit } from './audit.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fail, safeId } from './pcf-model.ts';
import { transitionDrawingStatus } from './drawing-status.ts';
import { DRAWING_COLUMNS as columns, readDrawing } from './drawing-revision.ts';
import type { PcfStorage } from './pcf-storage.ts';
import type { PcfRealtime } from './pcf-realtime.ts';

const pcfFields = new Set(['version', 'currentRound', 'manualCommentsCount', 'manualOpenCommentsCount']);
// Envelope keys of an app patch; never stored as drawing fields.
const envelopeKeys = ['baseRev', 'base', 'remarkOps', 'changes'];
function value(field: string, value: any) {
  if (['checked', 'checkedSynced'].includes(field)) return value ? 1 : 0;
  if (['manualCommentsCount', 'manualOpenCommentsCount'].includes(field)) return Number(value) || 0;
  if (['reviewDeadline', 'receivedDate', 'category', 'deadline'].includes(field)) return value ? String(value) : null;
  return String(value ?? '');
}

export type DrawingConflict = { id: string; customId?: string; fields: string[]; current: Record<string, any> | null };

const remarkKey = (r: any) => JSON.stringify([String(r?.content ?? ''), Number(r?.resolved) ? 1 : 0]);
const remarkSet = (list: any[]) => JSON.stringify((list || []).map(r => [String(r?.id ?? ''), remarkKey(r)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
function sameField(field: string, a: any, b: any): boolean {
  if (field === 'assignees') return JSON.stringify([...new Set((a || []).filter((x: any) => x != null).map(String))].sort()) === JSON.stringify([...new Set((b || []).filter((x: any) => x != null).map(String))].sort());
  if (field === 'remarks') return remarkSet(a) === remarkSet(b);
  if (field in columns) return value(field, a) === value(field, b);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function changesOf(input: any): Record<string, any> {
  if (input.changes !== undefined && (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes))) fail('Invalid drawing changes');
  const changes = input.changes === undefined ? { ...input } : { ...input.changes };
  for (const key of envelopeKeys) delete changes[key];
  delete changes.rev;
  return changes;
}

function remarkOpsOf(input: any) {
  const ops = input.remarkOps;
  if (ops === undefined) return null;
  if (!ops || typeof ops !== 'object' || Array.isArray(ops)) fail('Invalid remarkOps');
  for (const key of ['add', 'update', 'remove']) if (ops[key] !== undefined && !Array.isArray(ops[key])) fail('Invalid remarkOps.' + key);
  return { add: ops.add || [], update: ops.update || [], remove: ops.remove || [] } as { add: any[]; update: any[]; remove: any[] };
}

// Optimistic concurrency check for one app patch. A patch without baseRev
// (new drawing, import, legacy client) is not checked. When the stored
// revision moved on, a field is accepted only if the server still holds the
// value the client started from, or already holds the client's new value.
export function drawingConflict(db: DatabaseSync, projectId: string, input: any): DrawingConflict | null {
  if (input?.baseRev === undefined || input.baseRev === null) return null;
  const id = safeId(String(input.id));
  const current = readDrawing(db, projectId, id);
  const changes = changesOf(input);
  if (!current) {
    // Deleted by someone else, unless the id belongs to another project (rejected by the writer).
    if (db.prepare('SELECT 1 FROM drawings WHERE id=?').get(id)) return null;
    return { id, customId: changes.customId, fields: ['deleted'], current: null };
  }
  if (String(input.baseRev) === current.rev) return null;
  const base = input.base && typeof input.base === 'object' ? input.base : {};
  const fields: string[] = [];
  for (const field of Object.keys(changes)) {
    if (['id', 'hasPcf', 'logs', 'statusHistory', 'currentRound'].includes(field)) continue;
    if (current.hasPcf && pcfFields.has(field)) continue;
    if (!(field in columns) && field !== 'assignees' && field !== 'remarks') continue;
    if (sameField(field, current[field], changes[field])) continue;
    if (field in base && sameField(field, current[field], base[field])) continue;
    fields.push(field);
  }
  const ops = remarkOpsOf(input);
  if (ops && !fields.includes('remarks')) {
    const byId = new Map<string, any>(current.remarks.map((r: any) => [String(r.id), r]));
    const stale = ops.update.some((op: any) => {
      const now = byId.get(String(op?.id));
      if (!now) return true; // edited a remark that was deleted meanwhile
      const mine = { content: op.content !== undefined ? op.content : now.content, resolved: op.resolved !== undefined ? op.resolved : now.resolved };
      if (remarkKey(now) === remarkKey(mine)) return false;
      return op.base !== undefined && remarkKey(now) !== remarkKey(op.base);
    }) || ops.remove.some((op: any) => {
      const now = byId.get(String(op?.id ?? op));
      return !!now && op?.base !== undefined && remarkKey(now) !== remarkKey(op.base); // deleting a remark someone edited meanwhile
    });
    if (stale) fields.push('remarks');
  }
  return fields.length ? { id, customId: current.customId || undefined, fields, current } : null;
}

export async function writeDrawing(storage: PcfStorage, realtime: PcfRealtime, projectId: string, input: any, source = 'app') {
  const id = safeId(input.id || randomUUID());
  safeId(projectId);
  return storage.serial(projectId, id, () => writeDrawingLocked(storage, realtime, projectId, { ...input, id }, source));
}

// Caller holds storage.serial(projectId, input.id). Synchronous, so a caller's
// enclosing SQLite savepoint covers every statement.
export function writeDrawingLocked(storage: PcfStorage, realtime: PcfRealtime, projectId: string, input: any, source = 'app') {
  const id = safeId(input.id);
  {
    const db = storage.db;
    const owner: any = db.prepare('SELECT * FROM drawings WHERE id=?').get(id);
    if (owner && owner.project_id !== projectId) fail('Drawing belongs to another project', 409);
    const changes = changesOf(input);
    const remarkOps = remarkOpsOf(input);
    const hasPcf = !!db.prepare('SELECT 1 FROM pcf_index WHERE project_id=? AND drawing_id=?').get(projectId, id);
    for (const field of Object.keys(changes)) if (hasPcf && pcfFields.has(field)) delete changes[field];
    // Rounds of non-PCF drawings are also server-owned after creation.
    if (owner) delete changes.currentRound;
    const statusChanged = owner && changes.status !== undefined && changes.status !== owner.status;
    if (changes.status !== undefined && !['Pending', 'Reviewing', 'Waiting Reply', 'Approved'].includes(changes.status)) fail('Invalid drawing status');
    // Validate relations before transitioning so malformed input cannot partially change status.
    for (const field of ['assignees', 'remarks', 'statusHistory', 'logs']) if (changes[field] !== undefined && !Array.isArray(changes[field])) fail('Invalid ' + field);
    db.exec('SAVEPOINT native_drawing');
    try {
      if (!owner) db.prepare("INSERT INTO drawings(id,project_id,status,current_round) VALUES(?,?,'Pending',?)").run(id, projectId, changes.currentRound || 'A');
      // Write metadata before the transition. Both commit in one SQLite transaction.
      const fields = Object.keys(columns).filter(field => field in changes && field !== 'status' && field !== 'currentRound' && !(statusChanged && field === 'reviewDeadline'));
      if (fields.length) db.prepare(`UPDATE drawings SET ${fields.map(f => columns[f] + '=?').join(',')} WHERE project_id=? AND id=?`).run(...fields.map(f => value(f, changes[f])), projectId, id);
      if (changes.assignees !== undefined) {
        db.prepare('DELETE FROM drawing_assignees WHERE drawing_id=?').run(id);
        for (const a of new Set(changes.assignees.filter((x: any) => x != null).map(String))) db.prepare('INSERT INTO drawing_assignees(drawing_id,reviewer_id) VALUES(?,?)').run(id, a as string);
      }
      // Remarks are written row by row: untouched remarks are never deleted.
      const insertRemark = db.prepare('INSERT INTO drawing_remarks(id,project_id,drawing_id,content,created_at,resolved) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,resolved=excluded.resolved WHERE drawing_remarks.drawing_id=excluded.drawing_id');
      if (changes.remarks !== undefined) {
        // Full list (import, legacy client): delete only the missing rows, upsert the rest.
        const keep = new Set(changes.remarks.map((r: any) => String(r?.id ?? '')).filter(Boolean));
        for (const row of db.prepare('SELECT id FROM drawing_remarks WHERE drawing_id=?').all(id)) if (!keep.has(String(row.id))) db.prepare('DELETE FROM drawing_remarks WHERE id=? AND drawing_id=?').run(row.id, id);
        for (const r of changes.remarks) insertRemark.run(String(r?.id || randomUUID()), projectId, id, String(r?.content || ''), String(r?.createdAt || new Date().toISOString()), r?.resolved ? 1 : 0);
      }
      if (remarkOps) {
        for (const r of remarkOps.remove) db.prepare('DELETE FROM drawing_remarks WHERE id=? AND drawing_id=?').run(String(r?.id ?? r), id);
        for (const r of remarkOps.update) {
          const sets: string[] = [], args: any[] = [];
          if (r?.content !== undefined) { sets.push('content=?'); args.push(String(r.content ?? '')); }
          if (r?.resolved !== undefined) { sets.push('resolved=?'); args.push(r.resolved ? 1 : 0); }
          if (sets.length) db.prepare(`UPDATE drawing_remarks SET ${sets.join(',')} WHERE id=? AND drawing_id=?`).run(...args, String(r.id), id);
        }
        for (const r of remarkOps.add) db.prepare('INSERT INTO drawing_remarks(id,project_id,drawing_id,content,created_at,resolved) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(String(r?.id || randomUUID()), projectId, id, String(r?.content || ''), String(r?.createdAt || new Date().toISOString()), r?.resolved ? 1 : 0);
      }
      // Do not replace authoritative status history from an old page. Append non-status local entries.
      if (source === 'import' && !hasPcf && changes.statusHistory !== undefined) db.prepare('DELETE FROM drawing_status_history WHERE drawing_id=?').run(id);
      if (changes.statusHistory !== undefined) for (const h of changes.statusHistory) {
        if (String(h.content || '').includes('Status:') && !(source === 'import' && !hasPcf)) continue;
        db.prepare('INSERT INTO drawing_status_history(id,drawing_id,content,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').run(h.id || randomUUID(), id, h.content || '', h.createdAt || new Date().toISOString());
      }
      if (owner && !hasPcf && (changes.manualCommentsCount !== undefined || changes.manualOpenCommentsCount !== undefined)) {
        const after: any = db.prepare('SELECT manual_comments_count,manual_open_comments_count FROM drawings WHERE id=?').get(id);
        if (owner.manual_comments_count !== after.manual_comments_count || owner.manual_open_comments_count !== after.manual_open_comments_count) writeAudit(db,{table:'drawings',rowId:id,projectId,action:'COMMENTS',detail:{ customId: changes.customId ?? owner.custom_id, drawingNo: changes.drawingNo ?? owner.drawing_no, from: { total: owner.manual_comments_count, open: owner.manual_open_comments_count }, to: { total: after.manual_comments_count, open: after.manual_open_comments_count }, source },createdAt:new Date().toISOString()});
      }
      db.prepare('UPDATE projects SET last_updated=? WHERE id=?').run(new Date().toISOString(), projectId);
      if (changes.status !== undefined) {
        if (source === 'import' && !owner && !hasPcf) db.prepare('UPDATE drawings SET status=? WHERE id=?').run(changes.status,id);
        else transitionDrawingStatus(storage, realtime, projectId, id, changes.status, source);
      }
      db.exec('RELEASE native_drawing');
    } catch (e) { db.exec('ROLLBACK TO native_drawing; RELEASE native_drawing'); throw e; }
    const changedFields = Object.keys(changes).filter(f => f !== 'id' && f !== 'hasPcf');
    if (remarkOps && !changedFields.includes('remarks')) changedFields.push('remarks');
    realtime.projectChanged(projectId, id, input.changes === undefined ? ['project-data'] : changedFields);
    const result: any = readDrawing(db, projectId, id)!;
    result.logs = changes.logs || [];
    const expected = { ...result };
    for (const field of Object.keys(columns)) if (field in changes && field !== 'status' && field !== 'currentRound' && !(statusChanged && field === 'reviewDeadline')) expected[field] = value(field, changes[field]);
    if (changes.assignees !== undefined) expected.assignees = [...new Set(changes.assignees.filter((a: any) => a != null).map(String))];
    if (changes.remarks !== undefined) expected.remarks = changes.remarks;
    return { ...result, __expected: expected };
  }
}
