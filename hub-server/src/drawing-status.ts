import { randomUUID } from 'node:crypto';
import { transitionReviewState, type ReviewStatus } from '../../lib/drawing-status.ts';
import { lettersToRound } from '../../lib/rounds.ts';
import { fail, type Actor } from './pcf-model.ts';
import type { PcfStorage } from './pcf-storage.ts';
import { getProjectConfiguration } from './project-read.ts';
import type { PcfRealtime } from './pcf-realtime.ts';

// Caller must hold storage.serial(projectId, drawingId). Builder imports already do.
export function transitionDrawingStatus(storage: PcfStorage, realtime: PcfRealtime, projectId: string, drawingId: string, status: ReviewStatus, source = 'app', actor: Actor = { clientId: 'drawing-status', clientName: source, ip: '' }) {
  if (!['Pending', 'Reviewing', 'Waiting Reply', 'Approved'].includes(status)) fail('Invalid drawing status');
  const db = storage.db;
  let row: any = db.prepare('SELECT * FROM drawings WHERE project_id=? AND id=? AND COALESCE(_deleted,0)=0').get(projectId, drawingId);
  if (!row) fail('Drawing not found', 404);
  const hasPcf = !!db.prepare('SELECT 1 FROM pcf_index WHERE project_id=? AND drawing_id=?').get(projectId, drawingId);
  if (hasPcf) { storage.load(projectId, drawingId); row = db.prepare('SELECT * FROM drawings WHERE project_id=? AND id=?').get(projectId, drawingId); }
  const cfg = getProjectConfiguration(db, projectId);
  const at = new Date();
  const state = transitionReviewState({ status: row.status, currentRound: row.current_round, reviewDeadline: row.review_deadline }, status, { ...cfg, roundACycle: cfg.roundACycle ?? undefined, otherRoundsCycle: cfg.otherRoundsCycle ?? undefined }, at);
  if (row.status === status) return state;
  const commit = () => {
    // With PCF, indexWrite is the only writer of current_round.
    if (hasPcf) db.prepare('UPDATE drawings SET status=?,review_deadline=? WHERE project_id=? AND id=?').run(status, state.reviewDeadline, projectId, drawingId);
    else db.prepare('UPDATE drawings SET status=?,current_round=?,review_deadline=? WHERE project_id=? AND id=?').run(status, state.currentRound, state.reviewDeadline, projectId, drawingId);
    const roundChange = row.current_round !== state.currentRound ? ` | Round: ${row.current_round} -> ${state.currentRound}` : '';
    db.prepare('INSERT INTO drawing_status_history(id,drawing_id,content,created_at) VALUES(?,?,?,?)').run(randomUUID(), drawingId, `Status: ${row.status} -> ${status}${roundChange}`, at.toISOString());
    db.prepare("INSERT INTO audit_log(table_name,row_id,project_id,action,detail,created_at) VALUES('drawings',?,?,'STATUS',?,?)").run(drawingId, projectId, JSON.stringify({ customId: row.custom_id, drawingNo: row.drawing_no, from: row.status, to: status, round: { from: row.current_round, to: state.currentRound }, source }), at.toISOString());
    db.prepare('UPDATE projects SET last_updated=? WHERE id=?').run(at.toISOString(), projectId);
  };
  if (hasPcf && row.current_round !== state.currentRound) {
    const result = storage.transitionRound(projectId, drawingId, lettersToRound(state.currentRound), actor, commit);
    realtime.changed(projectId + '/' + drawingId, result, actor);
  } else {
    db.exec('SAVEPOINT drawing_status');
    try { commit(); db.exec('RELEASE drawing_status'); }
    catch (e) { db.exec('ROLLBACK TO drawing_status; RELEASE drawing_status'); throw e; }
  }
  realtime.projectChanged(projectId, drawingId, ['status', 'currentRound', 'reviewDeadline']);
  return state;
}
