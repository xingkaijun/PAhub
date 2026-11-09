import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { drawingConflict, writeDrawing, writeDrawingLocked } from './drawing-write.ts';
import type { PcfStorage } from './pcf-storage.ts';
import type { PcfRealtime } from './pcf-realtime.ts';
import { fail, safeId } from './pcf-model.ts';

export type RecordValue = Record<string, any>;
export type Verification = { ok: boolean; checked: number; mismatched: { id: string; customId?: string; fields: string[] }[]; error?: string };
const skipped = (): Verification => ({ ok: true, checked: 0, mismatched: [] });

export function transaction<T>(db: DatabaseSync, name: string, work: () => T): T {
  db.exec('SAVEPOINT ' + name);
  try { const result = work(); db.exec('RELEASE ' + name); return result; }
  catch (error) { db.exec('ROLLBACK TO ' + name + '; RELEASE ' + name); throw error; }
}

// Configuration updates and each child's replacement are synchronous transactions.
// No request can interleave between DELETE and INSERT, regardless of project size.
export function saveConfiguration(db: DatabaseSync, projectId: string, conf: RecordValue, full: boolean): number {
  return transaction(db, 'project_configuration', () => {
    let statements = 0;
    const settings: RecordValue = {
      displayName: conf.displayName, password: conf.password,
      holidays: Array.isArray(conf.holidays) ? JSON.stringify(conf.holidays) : full ? '[]' : undefined,
      roundACycle: conf.roundACycle, otherRoundsCycle: conf.otherRoundsCycle,
      autoSyncInterval: conf.autoSyncInterval,
      projectSummary: conf.projectSummary ? JSON.stringify(conf.projectSummary) : undefined,
    };
    for (const [key, value] of Object.entries(settings)) if (value !== undefined && value !== null) {
      db.prepare('INSERT INTO project_settings(project_id,setting_key,setting_value) VALUES(?,?,?) ON CONFLICT(project_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value').run(projectId, key, String(value)); statements++;
    }
    if (conf.disciplineDefaults && typeof conf.disciplineDefaults === 'object') {
      db.prepare('DELETE FROM discipline_defaults WHERE project_id=?').run(projectId); statements++;
      for (const [discipline, reviewer] of Object.entries(conf.disciplineDefaults)) if (reviewer) {
        db.prepare('INSERT INTO discipline_defaults(project_id,discipline,reviewer_id) VALUES(?,?,?)').run(projectId, discipline, String(reviewer)); statements++;
      }
    }
    if (conf.defaultAssignees && typeof conf.defaultAssignees === 'object') {
      db.prepare('DELETE FROM discipline_default_assignees WHERE project_id=?').run(projectId); statements++;
      for (const [discipline, reviewers] of Object.entries(conf.defaultAssignees)) if (Array.isArray(reviewers)) for (const reviewer of reviewers) {
        db.prepare('INSERT INTO discipline_default_assignees(project_id,discipline,reviewer_id) VALUES(?,?,?)').run(projectId, discipline, String(reviewer)); statements++;
      }
    }
    if (Array.isArray(conf.reviewers)) for (const reviewer of conf.reviewers) if (reviewer.id) {
      db.prepare('INSERT INTO reviewers(id,display_name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name').run(String(reviewer.id), String(reviewer.name || reviewer.id)); statements++;
    }
    return statements;
  });
}

export function writeTracker(db: DatabaseSync, projectId: string, data: RecordValue, replace: boolean, realtime?: PcfRealtime): number {
  let statements = 0;
  for (const [drawingId, reviewers] of Object.entries(data || {})) {
    if (!reviewers || typeof reviewers !== 'object') continue;
    transaction(db, 'tracker_drawing', () => {
      if (replace) { db.prepare('DELETE FROM review_tracker WHERE project_id=? AND drawing_id=?').run(projectId, drawingId); statements++; }
      for (const [reviewerId, info] of Object.entries(reviewers as RecordValue)) {
        if (!info || typeof info !== 'object') fail('Invalid tracker entry');
        db.prepare('INSERT INTO review_tracker(project_id,drawing_id,raw_drawing_ref,reviewer_id,done,done_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,drawing_id,reviewer_id) DO UPDATE SET done=excluded.done,done_at=excluded.done_at').run(projectId, drawingId, drawingId, reviewerId, booleanValue(info.done) ? 1 : 0, info.doneAt ? String(info.doneAt) : null); statements++;
      }
    });
    realtime?.projectChanged(projectId, drawingId, ['reviewTracker']);
  }
  return statements;
}

function booleanValue(value: unknown): boolean {
  return value === true || (typeof value === 'number' && value !== 0) || (typeof value === 'string' && ['1','true','yes','y'].includes(value.trim().toLowerCase()));
}

// Keep the existing read-after-write contract, including protected PCF columns.
export function verifyProjectWrite(db: DatabaseSync, projectId: string, drawings: RecordValue[], tracker: RecordValue | null): Verification {
  if (!drawings.length && !Object.keys(tracker || {}).length) return skipped();
  try {
    const rows = new Map(db.prepare('SELECT * FROM drawings WHERE project_id=?').all(projectId).map(row => [String(row.id), row]));
    const pcfIds = new Set(db.prepare('SELECT drawing_id FROM pcf_index WHERE project_id=?').all(projectId).map(row => String(row.drawing_id)));
    const counts = (table: string) => new Map(db.prepare(`SELECT drawing_id,COUNT(*) AS n FROM ${table} WHERE drawing_id IN (SELECT id FROM drawings WHERE project_id=?) GROUP BY drawing_id`).all(projectId).map(row => [String(row.drawing_id), Number(row.n)]));
    const assignees = counts('drawing_assignees'), remarks = counts('drawing_remarks'), history = counts('drawing_status_history');
    const mismatches = new Map<string, { id: string; customId?: string; fields: string[] }>();
    const add = (id: string, fields: string[], customId?: string) => { if (!fields.length) return; const entry = mismatches.get(id); if (entry) entry.fields.push(...fields); else mismatches.set(id, { id, customId: customId || undefined, fields }); };
    const columns: Record<string, string> = { customId:'custom_id',drawingNo:'drawing_no',discipline:'discipline',title:'title',status:'status',version:'version',currentRound:'current_round',reviewDeadline:'review_deadline',manualCommentsCount:'manual_comments_count',manualOpenCommentsCount:'manual_open_comments_count',checked:'checked',checkedSynced:'checked_synced',receivedDate:'received_date',category:'category',deadline:'deadline' };
    for (const drawing of drawings) {
      const id = String(drawing.id), expected = drawing.__expected || drawing, actual = rows.get(id);
      const fields: string[] = [];
      if (!actual) fields.push('missing');
      else for (const [field, column] of Object.entries(columns)) {
        if (pcfIds.has(id) && ['version','currentRound','manualCommentsCount','manualOpenCommentsCount'].includes(field)) continue;
        if (expected[field] !== actual[column]) fields.push(field);
      }
      if ((assignees.get(id) || 0) !== new Set((expected.assignees || []).filter((a: unknown) => a != null).map(String)).size) fields.push('assigneeCount');
      if ((remarks.get(id) || 0) !== (expected.remarks || []).length) fields.push('remarkCount');
      if ((history.get(id) || 0) !== (drawing.statusHistory || []).length) fields.push('statusHistoryCount');
      add(id, fields, expected.customId);
    }
    const actualTracker = new Map(db.prepare('SELECT drawing_id,reviewer_id,done FROM review_tracker WHERE project_id=?').all(projectId).map(row => [JSON.stringify([row.drawing_id,row.reviewer_id]), Number(row.done)]));
    for (const [id, reviewers] of Object.entries(tracker || {})) {
      if (!reviewers || typeof reviewers !== 'object') continue;
      const fields: string[] = [];
      for (const [reviewer, info] of Object.entries(reviewers as RecordValue)) if ((actualTracker.get(JSON.stringify([id,reviewer])) || 0) !== (booleanValue(info?.done) ? 1 : 0)) fields.push('tracker:' + reviewer);
      add(id, fields);
    }
    return { ok: !mismatches.size, checked: drawings.length + Object.keys(tracker || {}).length, mismatched: [...mismatches.values()] };
  } catch (error) { return { ok: false, checked: 0, mismatched: [], error: error instanceof Error ? error.message : 'Verification query failed' }; }
}

export class ProjectWriter {
  constructor(readonly storage: PcfStorage, readonly realtime: PcfRealtime) {}
  private configuration(projectId: string, conf: RecordValue, full: boolean): void {
    saveConfiguration(this.storage.db,projectId,conf,full);
    for (const row of this.storage.db.prepare('SELECT id FROM drawings WHERE project_id=?').all(projectId)) this.realtime.projectChanged(projectId,String(row.id),['project-data']);
  }
  private async remove(projectId: string, id: string): Promise<void> {
    await this.storage.serial(projectId, safeId(id), () => this.removeLocked(projectId, id));
  }
  // Caller holds storage.serial(projectId, id).
  private removeLocked(projectId: string, id: string): void {
    transaction(this.storage.db, 'delete_drawing', () => {
      // Scope every child deletion by ownership, including legacy tracker rows.
      if (!this.storage.db.prepare('SELECT 1 FROM drawings WHERE project_id=? AND id=?').get(projectId,id)) return;
      for (const table of ['drawing_assignees','drawing_status_history','drawing_remarks']) this.storage.db.prepare('DELETE FROM ' + table + ' WHERE drawing_id=?').run(id);
      this.storage.db.prepare('DELETE FROM review_tracker WHERE project_id=? AND drawing_id=?').run(projectId,id);
      this.storage.db.prepare('DELETE FROM drawings WHERE project_id=? AND id=?').run(projectId,id);
    });
    this.realtime.projectChanged(projectId,id,['project-data']);
  }
  async save(projectId: string, project: RecordValue, tracker: RecordValue, source = 'app'): Promise<Verification> {
    if (!project || !Array.isArray(project.drawings)) return skipped();
    safeId(projectId);
    const db = this.storage.db;
    db.prepare("INSERT INTO projects(id,name,storage_path,last_updated) VALUES(?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,storage_path=excluded.storage_path,last_updated=excluded.last_updated").run(projectId,String(project.name || projectId),String(project.storagePath || ''));
    const valid = new Set(project.drawings.map((d: RecordValue) => String(d.id)));
    for (const row of db.prepare('SELECT id FROM drawings WHERE project_id=?').all(projectId)) if (!valid.has(String(row.id))) await this.remove(projectId,String(row.id));
    if (project.conf) this.configuration(projectId,project.conf,true);
    const written: RecordValue[] = [];
    for (const drawing of project.drawings) written.push(await writeDrawing(this.storage,this.realtime,projectId,drawing,source));
    const sanitized: RecordValue = {};
    for (const drawing of project.drawings) {
      const incoming = tracker?.[drawing.id]; if (!incoming || typeof incoming !== 'object') continue;
      const allowed = new Set([...(drawing.assignees || []).map(String),'__approved__']);
      const entry = Object.fromEntries(Object.entries(incoming).filter(([reviewer]) => allowed.has(reviewer)));
      if (Object.keys(entry).length) sanitized[drawing.id] = entry;
    }
    db.prepare('DELETE FROM review_tracker WHERE project_id=? AND drawing_id NOT IN (SELECT id FROM drawings WHERE project_id=?)').run(projectId,projectId);
    const fullTracker = Object.fromEntries(project.drawings.filter((d: RecordValue) => d.id).map((d: RecordValue) => [d.id,sanitized[d.id] || {}]));
    writeTracker(db,projectId,fullTracker,true,this.realtime);
    return verifyProjectWrite(db,projectId,written,sanitized);
  }
  async patch(projectId: string, body: RecordValue) {
    safeId(projectId);
    const db = this.storage.db;
    if (body.updatedDrawings !== undefined && !Array.isArray(body.updatedDrawings)) fail('Invalid updatedDrawings');
    if (body.deletedDrawingIds !== undefined && !Array.isArray(body.deletedDrawingIds)) fail('Invalid deletedDrawingIds');
    const deleted: string[] = (body.deletedDrawingIds || []).map((id: unknown) => safeId(String(id)));
    const updates: RecordValue[] = (body.updatedDrawings || []).map((drawing: RecordValue) => {
      if (!drawing || typeof drawing !== 'object' || Array.isArray(drawing)) fail('Invalid drawing');
      return { ...drawing, id: safeId(drawing.id ? String(drawing.id) : randomUUID()) };
    });
    // Lock every touched drawing, then check revisions and write everything in
    // one SQLite transaction: a conflict on any drawing rolls back the batch.
    return this.storage.serialMany(projectId, [...deleted, ...updates.map(d => String(d.id))], () => transaction(db, 'project_patch', () => {
      db.prepare('INSERT INTO projects(id,name,last_updated) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(projectId,String(body.projectName || projectId),new Date().toISOString());
      const conflicts = updates.map(drawing => drawingConflict(db,projectId,drawing)).filter(Boolean);
      if (conflicts.length) throw Object.assign(new Error('Drawing changed on the server since it was loaded'), { status: 409, body: { code: 'DRAWING_CONFLICT', conflicts } });
      for (const id of deleted) this.removeLocked(projectId,id);
      // Legacy delta response counted only the final tracker/timestamp group:
      // configuration/deletions were drained before native drawing writes.
      let statements = 0;
      if (body.conf) this.configuration(projectId,body.conf,false);
      const written: RecordValue[] = updates.map(drawing => writeDrawingLocked(this.storage,this.realtime,projectId,drawing));
      if (body.reviewTracker && typeof body.reviewTracker === 'object') statements += writeTracker(db,projectId,body.reviewTracker,true,this.realtime);
      db.prepare("UPDATE projects SET last_updated=datetime('now') WHERE id=?").run(projectId); statements++;
      return { success: true, mode: 'delta', statements, verification: verifyProjectWrite(db,projectId,written,body.reviewTracker || null), drawings: written.map(({ __expected, ...drawing }) => drawing) };
    }));
  }
}
