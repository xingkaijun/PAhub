import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { drawingRevision } from './drawing-revision.ts';
type Row = Record<string, SQLOutputValue>;

function parse(value: SQLOutputValue | undefined, fallback: unknown): any {
  if (typeof value !== 'string' || !value) return fallback;
  return JSON.parse(value);
}
function integer(value: SQLOutputValue | undefined, fallback: number | null): number | null {
  if (value === undefined || value === null) return fallback;
  const parsed = parseInt(String(value),10); return Number.isFinite(parsed) ? parsed : 0;
}
export function getProjectList(db: DatabaseSync) {
  return db.prepare('SELECT id,name,storage_path,last_updated FROM projects ORDER BY name COLLATE NOCASE ASC').all().map(row => ({ id:row.id,name:row.name,storagePath:row.storage_path || undefined,lastUpdated:row.last_updated || undefined }));
}
export function getProjectConfiguration(db: DatabaseSync, projectId: string) {
  const settings = Object.fromEntries(db.prepare('SELECT setting_key,setting_value FROM project_settings WHERE project_id=?').all(projectId).map(row => [String(row.setting_key),row.setting_value]));
  const defaults = Object.fromEntries(db.prepare('SELECT discipline,reviewer_id FROM discipline_defaults WHERE project_id=?').all(projectId).map(row => [String(row.discipline),row.reviewer_id]));
  const assignees: Record<string, SQLOutputValue[]> = {};
  for (const row of db.prepare('SELECT discipline,reviewer_id FROM discipline_default_assignees WHERE project_id=?').all(projectId)) (assignees[String(row.discipline)] ||= []).push(row.reviewer_id);
  return { reviewers:db.prepare('SELECT id,display_name AS name FROM reviewers').all().map(row => ({...row})),disciplineDefaults:defaults,
    holidays:parse(settings.holidays,[]),roundACycle:integer(settings.roundACycle,10),otherRoundsCycle:integer(settings.otherRoundsCycle,5),
    password:settings.password ?? null,displayName:settings.displayName ?? null,autoSyncInterval:integer(settings.autoSyncInterval,null),
    projectSummary:parse(settings.projectSummary,null),defaultAssignees:assignees };
}
export function getProjectDetail(db: DatabaseSync, projectId: string) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId); if (!project) return null;
  const group = (rows: Row[]) => { const map = new Map<string,Row[]>(); for (const row of rows) { const id = String(row.drawing_id); const {drawing_id,...child} = row; const list = map.get(id) || []; list.push(child); map.set(id,list); } return map; };
  const assignees = group(db.prepare('SELECT drawing_id,reviewer_id FROM drawing_assignees WHERE drawing_id IN (SELECT id FROM drawings WHERE project_id=?)').all(projectId));
  const remarks = group(db.prepare('SELECT drawing_id,id,COALESCE(content,\'\') AS content,COALESCE(created_at,\'\') AS createdAt,resolved FROM drawing_remarks WHERE drawing_id IN (SELECT id FROM drawings WHERE project_id=?)').all(projectId));
  const history = group(db.prepare('SELECT drawing_id,id,COALESCE(content,\'\') AS content,COALESCE(created_at,\'\') AS createdAt FROM drawing_status_history WHERE drawing_id IN (SELECT id FROM drawings WHERE project_id=?)').all(projectId));
  const pcf = new Set(db.prepare('SELECT drawing_id FROM pcf_index WHERE project_id=?').all(projectId).map(row => String(row.drawing_id)));
  const drawings = db.prepare('SELECT * FROM drawings WHERE project_id=? AND IFNULL(_deleted,0)!=1').all(projectId).map(row => { const drawingAssignees = (assignees.get(String(row.id)) || []).map(a => a.reviewer_id), drawingRemarks = remarks.get(String(row.id)) || []; return {
    id:row.id,customId:row.custom_id ?? '',drawingNo:row.drawing_no ?? '',title:row.title ?? '',discipline:row.discipline ?? '',
    assignees:drawingAssignees,status:row.status ?? 'Pending',currentRound:row.current_round ?? 'A',version:row.version ?? '',
    manualCommentsCount:row.manual_comments_count ?? 0,manualOpenCommentsCount:row.manual_open_comments_count ?? 0,reviewDeadline:row.review_deadline,
    receivedDate:row.received_date,category:row.category,deadline:row.deadline,checked:row.checked,checkedSynced:row.checked_synced,
    logs:[],remarks:drawingRemarks,statusHistory:history.get(String(row.id)) || [],hasPcf:pcf.has(String(row.id)),
    // Revision the app sends back as baseRev; matches drawing-write results.
    rev:drawingRevision(row,drawingAssignees,drawingRemarks as any),
  }; });
  return { id:project.id,name:project.name,drawings,storagePath:project.storage_path || undefined,conf:getProjectConfiguration(db,projectId),lastUpdated:project.last_updated || undefined };
}
export function getSettings(db: DatabaseSync) {
  const firstProject = db.prepare('SELECT id FROM projects LIMIT 1').get();
  const defaults = firstProject ? Object.fromEntries(db.prepare('SELECT discipline,reviewer_id FROM discipline_defaults WHERE project_id=?').all(firstProject.id).map(row => [String(row.discipline),row.reviewer_id])) : {};
  const setting = (key: string) => db.prepare('SELECT setting_value FROM project_settings WHERE setting_key=? LIMIT 1').get(key)?.setting_value;
  return {reviewers:db.prepare('SELECT id,display_name AS name FROM reviewers').all().map(row => ({...row})),disciplineDefaults:defaults,holidays:parse(setting('holidays'),[]),roundACycle:integer(setting('roundACycle'),10),otherRoundsCycle:integer(setting('otherRoundsCycle'),5),displayName:setting('displayName') ?? null,autoSyncInterval:integer(setting('autoSyncInterval'),null)};
}
export function getReviewTracker(db: DatabaseSync,projectId: string) {
  const result: Record<string,Record<string,{done:number;doneAt:SQLOutputValue}>> = {};
  const rows = db.prepare('SELECT COALESCE(drawing_id,raw_drawing_ref) AS drawing_id,reviewer_id,done,done_at FROM review_tracker WHERE project_id=? AND IFNULL(_deleted,0)!=1 ORDER BY COALESCE(drawing_id,raw_drawing_ref),reviewer_id').all(projectId);
  for (const row of rows) (result[String(row.drawing_id)] ||= {})[String(row.reviewer_id)] = {done:row.done ? 1 : 0,doneAt:row.done_at};
  return result;
}
