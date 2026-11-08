import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommentReport, commentAge, reportPercent, selectedReportComments } from '../../lib/activityReport.ts';
import type { ProjectComment } from '../../types/comments.ts';

const asOf = '2026-11-08T12:00:00.000Z';
const row = (id: string, age = 10, extra: Partial<ProjectComment> = {}): ProjectComment => ({
  drawingId: 'drawing-a', drawingNo: 'PLAN-001', drawingTitle: 'Arrangement', discipline: 'Hull', drawingStatus: 'Reviewing',
  commentId: id, number: 1, round: 1, status: 'open', tags: [], ownerName: '', ownerDate: '',
  ownerComment: 'Review item', builderReply: '', builderReplyDate: '',
  createdAt: new Date(Date.parse(asOf) - age * 86_400_000).toISOString(), updatedAt: asOf, openDays: age, hasImages: false,
  ...extra,
});

test('report counts threads per drawing, not replies or repeated identifiers on different drawings', () => {
  const a = row('a'), b = row('a', 40, { drawingId: 'drawing-b', drawingNo: 'PLAN-002', status: 'CLOSED' });
  const report = buildCommentReport([a, a, b], asOf);
  assert.equal(report.total, 2);
  assert.equal(report.open, 1);
  assert.equal(report.closed, 1);
  assert.equal(report.drawingsWithOpen, 1);
  assert.equal(reportPercent(report.closed, report.total), '50.0%');
});

test('ageing uses original creation and exact boundaries, unknown dates never enter recent bucket', () => {
  const rows = [0, 7, 8, 14, 15, 30, 31].map(age => row(String(age), age));
  rows.push(row('missing', 2, { createdAt: '' }), row('invalid', 2, { createdAt: 'not-a-date' }), row('future', -1));
  rows.push(row('closed', 100, { status: 'closed' }));
  const report = buildCommentReport(rows, asOf);
  assert.deepEqual(report.ageing.map(band => band.count), [2, 2, 2, 1, 3]);
  assert.equal(report.open, 10);
  assert.equal(report.olderThan30, 1);
  assert.equal(report.unknownAge, 3);
  assert.equal(commentAge(row('x', 99, { createdAt: undefined }), asOf), null);
  assert.equal(commentAge(row('x'), 'invalid'), null);
});

test('priority list sorts by age then latest round; unknown ages last, closed excluded', () => {
  const rows = [row('young', 1), row('old-low', 50), row('old-high', 50, { round: 4 }), row('unknown', 0, { createdAt: '' }), row('closed', 90, { status: 'closed' })];
  const report = buildCommentReport(rows, asOf);
  assert.deepEqual(report.priorityRows.map(item => item.commentId), ['old-high', 'old-low', 'young', 'unknown']);
});

test('disciplines rank by open count, paginate without dropping groups, retain actual source identity', () => {
  const rows = Array.from({ length: 18 }, (_, i) => row('c' + i, 20, { discipline: 'Discipline ' + i }));
  rows.push(row('extra', 40, { discipline: 'Discipline 17' }));
  const report = buildCommentReport(rows, asOf);
  assert.equal(report.overviewPages, 3);
  assert.equal(report.disciplines.length, 18);
  assert.equal(report.disciplines[0].name, 'Discipline 17');
  assert.equal(report.disciplines.reduce((sum, d) => sum + d.total, 0), report.total);
});

test('top drawings exclude closed-only drawings, cap at ten and calculate concentration on all open', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row('x' + i, 40, { drawingId: 'd' + i, drawingNo: 'PLAN-' + i }));
  rows.push(row('extra', 0, { drawingId: 'd11', drawingNo: 'PLAN-11' }), row('closed', 100, { drawingId: 'closed-only', status: 'closed' }));
  const report = buildCommentReport(rows, asOf);
  assert.equal(report.topDrawings.length, 10);
  assert.equal(report.topDrawings[0].id, 'd11');
  assert.equal(report.topDrawings[0].olderThan30, 1);
  assert.equal(report.topOpen, 11);
  assert.equal(report.open, 13);
});

test('chart selections use exact drawing and comment identifiers, age selections exclude closed', () => {
  const report = buildCommentReport([row('a', 40), row('a', 40, { drawingId: 'b' }), row('closed', 40, { status: 'closed' }), row('unknown', 0, { createdAt: '' })], asOf);
  assert.equal(selectedReportComments(report, { kind: 'drawing', value: 'drawing-a', label: '' }, asOf).length, 2);
  assert.equal(selectedReportComments(report, { kind: 'discipline', value: 'Hull', label: '' }, asOf).length, 4);
  assert.equal(selectedReportComments(report, { kind: 'age', value: '>30', label: '' }, asOf).length, 2);
  assert.equal(selectedReportComments(report, { kind: 'age', value: 'Unknown', label: '' }, asOf).length, 1);
  assert.equal(selectedReportComments(report, { kind: 'comment', value: 'a', drawingId: 'b', label: '' }, asOf).length, 1);
});

test('empty report preserves two-page shell without NaN or invented completion', () => {
  const report = buildCommentReport([], asOf);
  assert.equal(report.total, 0);
  assert.equal(report.overviewPages, 1);
  assert.equal(reportPercent(0, 0), '—');
  assert.equal(report.topDrawings.length, 0);
});
