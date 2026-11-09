import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Main-table columns exposed to the app, in API field order.
export const DRAWING_COLUMNS: Record<string, string> = {
  customId: 'custom_id', drawingNo: 'drawing_no', discipline: 'discipline', title: 'title', status: 'status', version: 'version',
  currentRound: 'current_round', reviewDeadline: 'review_deadline', manualCommentsCount: 'manual_comments_count', manualOpenCommentsCount: 'manual_open_comments_count',
  checked: 'checked', checkedSynced: 'checked_synced', receivedDate: 'received_date', category: 'category', deadline: 'deadline',
};

type RemarkRow = { id: unknown; content?: unknown; createdAt?: unknown; resolved?: unknown };

// Content revision of one drawing row: columns, assignees and remarks.
// Derived from the stored data, so every writer (app, PCF, admin, import)
// changes it without a schema migration or triggers. Status history is
// append-only and excluded.
export function drawingRevision(row: Record<string, any>, assignees: unknown[], remarks: RemarkRow[]): string {
  const canonical = [
    Object.values(DRAWING_COLUMNS).map(column => row[column] ?? null),
    [...new Set(assignees.map(String))].sort(),
    remarks.map(r => [String(r.id), String(r.content ?? ''), String(r.createdAt ?? ''), Number(r.resolved) ? 1 : 0])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ];
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

// One drawing in API shape (without logs), including its revision.
export function readDrawing(db: DatabaseSync, projectId: string, id: string): Record<string, any> | null {
  const row: any = db.prepare('SELECT * FROM drawings WHERE project_id=? AND id=?').get(projectId, id);
  if (!row) return null;
  const hasPcf = !!db.prepare('SELECT 1 FROM pcf_index WHERE project_id=? AND drawing_id=?').get(projectId, id);
  const result: any = { id, hasPcf };
  for (const [field, column] of Object.entries(DRAWING_COLUMNS)) result[field] = row[column];
  result.assignees = db.prepare('SELECT reviewer_id FROM drawing_assignees WHERE drawing_id=?').all(id).map(r => r.reviewer_id);
  result.statusHistory = db.prepare('SELECT id,content,created_at AS createdAt FROM drawing_status_history WHERE drawing_id=? ORDER BY created_at,id').all(id);
  result.remarks = db.prepare('SELECT id,content,created_at AS createdAt,resolved FROM drawing_remarks WHERE drawing_id=?').all(id);
  result.rev = drawingRevision(row, result.assignees, result.remarks);
  return result;
}
