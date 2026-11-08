import { randomUUID } from 'node:crypto';
import { fail, safeId } from './pcf-model.ts';
import { transitionDrawingStatus } from './drawing-status.ts';
import type { PcfStorage } from './pcf-storage.ts';
import type { PcfRealtime } from './pcf-realtime.ts';

const columns: Record<string, string> = {
  customId: 'custom_id', drawingNo: 'drawing_no', discipline: 'discipline', title: 'title', status: 'status', version: 'version',
  currentRound: 'current_round', reviewDeadline: 'review_deadline', manualCommentsCount: 'manual_comments_count', manualOpenCommentsCount: 'manual_open_comments_count',
  checked: 'checked', checkedSynced: 'checked_synced', receivedDate: 'received_date', category: 'category', deadline: 'deadline',
};
const pcfFields = new Set(['version', 'currentRound', 'manualCommentsCount', 'manualOpenCommentsCount']);
function value(field: string, value: any) {
  if (['checked', 'checkedSynced'].includes(field)) return value ? 1 : 0;
  if (['manualCommentsCount', 'manualOpenCommentsCount'].includes(field)) return Number(value) || 0;
  if (['reviewDeadline', 'receivedDate', 'category', 'deadline'].includes(field)) return value ? String(value) : null;
  return String(value ?? '');
}

// First native drawing writer; project configuration/tracker routes remain in the Worker until phase 3.
export async function writeDrawing(storage: PcfStorage, realtime: PcfRealtime, projectId: string, input: any, source = 'app') {
  const id = safeId(input.id || randomUUID());
  safeId(projectId);
  return storage.serial(projectId, id, () => {
    const db = storage.db;
    const owner: any = db.prepare('SELECT * FROM drawings WHERE id=?').get(id);
    if (owner && owner.project_id !== projectId) fail('Drawing belongs to another project', 409);
    if (input.changes !== undefined && (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes))) fail('Invalid drawing changes');
    const changes = input.changes === undefined ? { ...input } : { ...input.changes };
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
      if (changes.remarks !== undefined) {
        db.prepare('DELETE FROM drawing_remarks WHERE drawing_id=?').run(id);
        for (const r of changes.remarks) db.prepare('INSERT INTO drawing_remarks(id,project_id,drawing_id,content,created_at,resolved) VALUES(?,?,?,?,?,?)').run(r.id || randomUUID(), projectId, id, r.content || '', r.createdAt || new Date().toISOString(), r.resolved ? 1 : 0);
      }
      // Do not replace authoritative status history from an old page. Append non-status local entries.
      if (changes.statusHistory !== undefined) for (const h of changes.statusHistory) {
        if (String(h.content || '').includes('Status:')) continue;
        db.prepare('INSERT INTO drawing_status_history(id,drawing_id,content,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').run(h.id || randomUUID(), id, h.content || '', h.createdAt || new Date().toISOString());
      }
      if (owner && !hasPcf && (changes.manualCommentsCount !== undefined || changes.manualOpenCommentsCount !== undefined)) {
        const after: any = db.prepare('SELECT manual_comments_count,manual_open_comments_count FROM drawings WHERE id=?').get(id);
        if (owner.manual_comments_count !== after.manual_comments_count || owner.manual_open_comments_count !== after.manual_open_comments_count) db.prepare("INSERT INTO audit_log(table_name,row_id,project_id,action,detail,created_at) VALUES('drawings',?,?,'COMMENTS',?,?)").run(id, projectId, JSON.stringify({ customId: changes.customId ?? owner.custom_id, drawingNo: changes.drawingNo ?? owner.drawing_no, from: { total: owner.manual_comments_count, open: owner.manual_open_comments_count }, to: { total: after.manual_comments_count, open: after.manual_open_comments_count }, source }), new Date().toISOString());
      }
      db.prepare('UPDATE projects SET last_updated=? WHERE id=?').run(new Date().toISOString(), projectId);
      if (changes.status !== undefined) transitionDrawingStatus(storage, realtime, projectId, id, changes.status, source);
      db.exec('RELEASE native_drawing');
    } catch (e) { db.exec('ROLLBACK TO native_drawing; RELEASE native_drawing'); throw e; }
    realtime.projectChanged(projectId, id, input.changes === undefined ? ['project-data'] : Object.keys(changes).filter(f => f !== 'id' && f !== 'hasPcf'));
    const row: any = db.prepare('SELECT * FROM drawings WHERE project_id=? AND id=?').get(projectId, id);
    const result: any = { id, hasPcf };
    for (const [field, column] of Object.entries(columns)) result[field] = row[column];
    result.assignees = db.prepare('SELECT reviewer_id FROM drawing_assignees WHERE drawing_id=?').all(id).map(r => r.reviewer_id);
    result.statusHistory = db.prepare('SELECT id,content,created_at AS createdAt FROM drawing_status_history WHERE drawing_id=? ORDER BY created_at,id').all(id);
    result.remarks = db.prepare('SELECT id,content,created_at AS createdAt,resolved FROM drawing_remarks WHERE drawing_id=?').all(id);
    result.logs = changes.logs || [];
    const expected = { ...result };
    for (const field of Object.keys(columns)) if (field in changes && field !== 'status' && field !== 'currentRound' && !(statusChanged && field === 'reviewDeadline')) expected[field] = value(field, changes[field]);
    if (changes.assignees !== undefined) expected.assignees = [...new Set(changes.assignees.filter((a: any) => a != null).map(String))];
    if (changes.remarks !== undefined) expected.remarks = changes.remarks;
    return { ...result, __expected: expected };
  });
}
