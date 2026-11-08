import test from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing, Project, ProjectConfig } from '../types';
import { ensureDrawingHasId, normalizeProjectDrawingIds, stripProjectPayload, getReviewStartDate, recalculateReviewDeadline } from './project';
import { applyDrawingUpdates, editableDrawingUpdates } from './drawing-edit';
import { describeVerification } from './project-save';
import { clearReviewTracker, mergeReviewTracker, verifySentState } from './review-tracker';
import { mergeProjectPreservingDirty } from './merge-project';

const conf: ProjectConfig = { reviewers: [], disciplineDefaults: {}, holidays: ['2026-11-10'], roundACycle: 1, otherRoundsCycle: 2 };
const at = new Date('2026-11-09T00:30:00+08:00');
const drawing: Drawing = { id: 'd', customId: '001', drawingNo: 'D1', title: 'Title', discipline: 'Hull', assignees: ['A'], status: 'Reviewing', currentRound: 'A', version: '1', manualCommentsCount: 0, manualOpenCommentsCount: 0, logs: [], remarks: [], statusHistory: [] };
const project: Project = { id: 'p', name: 'Project', conf, drawings: [drawing] };

test('project normalization adds missing IDs, defaults rounds and sorts history without changing input', () => {
  assert.strictEqual(ensureDrawingHasId(drawing, () => assert.fail('unnecessary ID')), drawing);
  const input = { ...project, drawings: [{ ...drawing, id: '', currentRound: '', statusHistory: [{ id: 'new', content: '', createdAt: '2026-11-10' }, { id: 'old', content: '', createdAt: '2026-11-09' }] }] };
  const normalized = normalizeProjectDrawingIds(input, () => 'generated');
  assert.equal(normalized.drawings[0].id, 'generated');
  assert.equal(normalized.drawings[0].currentRound, 'A');
  assert.deepEqual(normalized.drawings[0].statusHistory.map(log => log.id), ['old', 'new']);
  assert.equal(input.drawings[0].id, '');
  assert.equal(input.drawings[0].statusHistory[0].id, 'new');
  assert.strictEqual(stripProjectPayload(project, true), project);
  assert.deepEqual(stripProjectPayload(project, false).drawings, []);
  assert.equal(project.drawings.length, 1);
});

test('review deadlines use latest Reviewing entry and deterministic fallback time', () => {
  const input = { ...drawing, statusHistory: [{ id: 'old', content: 'Status: Pending -> Reviewing', createdAt: '2026-11-06T00:30:00+08:00' }, { id: 'latest', content: 'Status: Waiting Reply -> Reviewing', createdAt: at.toISOString() }] };
  assert.equal(getReviewStartDate(input, new Date('2026-12-01')).toISOString(), at.toISOString());
  assert.equal(recalculateReviewDeadline(input, conf, at).reviewDeadline, '2026-11-10T16:00:00.000Z');
  assert.equal(getReviewStartDate({ ...drawing, statusHistory: [{ id: 'bad', content: 'Status: Pending -> Reviewing', createdAt: 'invalid' }] }, at).toISOString(), at.toISOString());
  const pending = { ...drawing, status: 'Pending' as const };
  assert.strictEqual(recalculateReviewDeadline(pending, conf, at), pending);
});

test('editable updates protect PCF-owned fields without mutating requested changes', () => {
  const changes = { currentRound: 'ZZ', version: '2', manualCommentsCount: 99, manualOpenCommentsCount: 98, title: 'Edited' };
  assert.deepEqual(editableDrawingUpdates({ ...drawing, hasPcf: true }, changes), { title: 'Edited' });
  assert.deepEqual(editableDrawingUpdates(drawing, changes), { version: '2', manualCommentsCount: 99, manualOpenCommentsCount: 98, title: 'Edited' });
  assert.equal(changes.currentRound, 'ZZ');
});

test('drawing status edit shares round and calendar rules and logs at the supplied time', () => {
  const input = { ...drawing, status: 'Waiting Reply' as const, currentRound: 'AA' };
  const result = applyDrawingUpdates(input, { status: 'Reviewing' }, conf, at, 'log');
  assert.equal(result.currentRound, 'AB');
  assert.equal(result.reviewDeadline, '2026-11-11T16:00:00.000Z');
  assert.deepEqual(result.statusHistory, [{ id: 'log', content: 'Status: Waiting Reply -> Reviewing | Round: AA -> AB', createdAt: at.toISOString() }]);
  assert.equal(input.status, 'Waiting Reply');
  assert.deepEqual(input.statusHistory, []);
});

test('comment count edits coalesce within two minutes keeping original start and latest end', () => {
  const first = applyDrawingUpdates(drawing, { manualCommentsCount: 2 }, conf, at, 'first');
  const second = applyDrawingUpdates(first, { manualCommentsCount: 12, manualOpenCommentsCount: 3 }, conf, new Date(at.getTime() + 119999), 'unused');
  assert.equal(second.statusHistory.length, 1);
  assert.equal(second.statusHistory[0].id, 'first');
  assert.equal(second.statusHistory[0].content, 'Comments: 0/0 -> 12/3');
  assert.equal(first.statusHistory[0].content, 'Comments: 0/0 -> 2/0');
  const third = applyDrawingUpdates(second, { manualCommentsCount: 13 }, conf, new Date(at.getTime() + 239999), 'third');
  assert.equal(third.statusHistory.length, 2);
  const statusAndComments = applyDrawingUpdates(first, { status: 'Approved', manualCommentsCount: 4 }, conf, new Date(at.getTime() + 1000), 'mixed');
  assert.equal(statusAndComments.statusHistory.length, 2);
});

test('write verification only describes confirmed mismatches, limiting displayed labels', () => {
  assert.equal(describeVerification(undefined), null);
  assert.equal(describeVerification({ ok: false, checked: 0, mismatched: [], error: 'offline' }), null);
  assert.equal(describeVerification({ ok: true, checked: 0, mismatched: [] }), null);
  const message = describeVerification({ ok: false, checked: 7, mismatched: Array.from({ length: 7 }, (_, i) => ({ id: 'd' + i, customId: 'Label' + i, fields: ['title'] })) });
  assert.ok(message?.includes('Label0, Label1, Label2, Label3, Label4'));
  assert.equal(message?.includes('Label5'), false);
});

test('review tracker clear includes approval, preserves untouched references and is idempotent', () => {
  const input = { d: { A: { done: true, doneAt: at.toISOString() }, __approved__: { done: true } }, untouched: { B: { done: false } } };
  const result = clearReviewTracker(input, ['d', 'd', 'missing', 'untouched']);
  assert.deepEqual(result.changedIds, ['d']);
  assert.deepEqual(result.tracker.d, { A: { done: false }, __approved__: { done: false } });
  assert.strictEqual(result.tracker.untouched, input.untouched);
  assert.equal(input.d.A.done, true);
  assert.strictEqual(clearReviewTracker(result.tracker, ['d']).tracker, result.tracker);
});

test('review tracker merge favors dirty local entries but accepts clean remote updates', () => {
  const local = { d: { A: { done: true } }, other: { B: { done: true } } };
  const remote = { d: { A: { done: false }, C: { done: true } }, other: { B: { done: false } } };
  const merged = mergeReviewTracker(local, remote, new Set(['d']));
  assert.deepEqual(merged.d, { A: { done: true }, C: { done: true } });
  assert.strictEqual(merged.other, remote.other);
  assert.equal(mergeReviewTracker(local, remote, new Set(), true).other.B.done, true);
});

test('Send All verification returns failed IDs once and labels status/check failures separately', () => {
  const expected = [{ id: 'd', customId: '001', status: 'Approved' as const }, { id: 'missing', status: 'Waiting Reply' as const }];
  assert.deepEqual(verifySentState(project, { d: { __approved__: { done: true } } }, expected), { ok: false, mismatchedDrawings: ['001', 'missing'], mismatchedTracker: ['001'], failedIds: ['d', 'missing'] });
  assert.equal(verifySentState({ ...project, drawings: [{ ...drawing, status: 'Approved' }] }, { d: { A: { done: false } } }, [expected[0]]).ok, true);
});

test('project merge preserves dirty additions, deletions, config and PCF authority', () => {
  const local = { ...project, drawings: [{ ...drawing, title: 'Local' }, { ...drawing, id: 'new' }] };
  const remote = { ...project, conf: { ...conf, roundACycle: 10 }, drawings: [{ ...drawing, title: 'Remote', hasPcf: true, manualCommentsCount: 10 }, { ...drawing, id: 'deleted' }] };
  const result = mergeProjectPreservingDirty(local, remote, new Set(['d', 'new']), new Set(['deleted']), true, {}, {}, new Set(), false, { d: new Set(['title', 'manualCommentsCount']) });
  assert.deepEqual(result.project.drawings.map(d => d.id), ['d', 'new']);
  assert.equal(result.project.drawings[0].title, 'Local');
  assert.equal(result.project.drawings[0].manualCommentsCount, 10);
  assert.strictEqual(result.project.conf, local.conf);
});
