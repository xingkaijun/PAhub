import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkLoadText, splitBulkLoadLine } from '../../lib/bulk-load';
import { buildReviewTrackerCsv } from '../../lib/tracker-csv';
import { confirmAndDeleteDrawing, deleteDrawingPrompt } from '../../lib/drawing-delete';
import type { Drawing } from '../../types';

// ---------- Bulk Load：标题是最后一列，含逗号不再被截断 ----------

test('Bulk Load keeps commas inside the title (last column takes the rest of the line)', () => {
  const { rows, skipped } = parseBulkLoadText([
    '001, H2684-110-001, HULL, Midship section, frames 50-80, rev. A',
    '002,H2684-210-002,MACH,Fuel oil system,  diagram',
    '003，H2684-310-003，ELEC，主配电板，布置图',
  ].join('\n'));
  assert.deepEqual(skipped, []);
  assert.deepEqual(rows, [
    { customId: '001', drawingNo: 'H2684-110-001', discipline: 'HULL', title: 'Midship section, frames 50-80, rev. A' },
    { customId: '002', drawingNo: 'H2684-210-002', discipline: 'MACH', title: 'Fuel oil system,  diagram' },
    { customId: '003', drawingNo: 'H2684-310-003', discipline: 'ELEC', title: '主配电板，布置图' },
  ]);
});

test('Bulk Load accepts CSV quoting, tab-separated rows from Excel, CRLF and skips short lines', () => {
  const { rows, skipped } = parseBulkLoadText([
    '"004","H2684-120-004","HULL","Hatch cover, ""No. 1"", details"\r',
    '005,"H2684, 130-005",OUTF,Mooring arrangement',
    '006\tH2684-140-006\tHULL\tBilge keel, welding detail, 2 pcs',
    '',
    '   ',
    '007, H2684-150-007, HULL',
    '008,"H2684-160-008",HULL,"Engine room, ""aft"" part"',
  ].join('\n'));
  assert.deepEqual(rows, [
    { customId: '004', drawingNo: 'H2684-120-004', discipline: 'HULL', title: 'Hatch cover, "No. 1", details' },
    { customId: '005', drawingNo: 'H2684, 130-005', discipline: 'OUTF', title: 'Mooring arrangement' },
    { customId: '006', drawingNo: 'H2684-140-006', discipline: 'HULL', title: 'Bilge keel, welding detail, 2 pcs' },
    { customId: '008', drawingNo: 'H2684-160-008', discipline: 'HULL', title: 'Engine room, "aft" part' },
  ]);
  assert.deepEqual(skipped, ['007, H2684-150-007, HULL']);
  assert.deepEqual(splitBulkLoadLine('a,b,c,'), ['a', 'b', 'c', '']);
});

// ---------- Tracker Export CSV：Drawing No 列是图号 ----------

const drawing = (over: Partial<Drawing>): Drawing => ({
  id: 'dwg-x', customId: 'X', drawingNo: 'NO-X', title: 'T', discipline: 'HULL', assignees: [], status: 'Reviewing',
  logs: [], remarks: [], statusHistory: [], currentRevision: 'A', version: '1', currentRound: 'A',
  manualCommentsCount: 0, manualOpenCommentsCount: 0, ...over,
} as Drawing);

test('Tracker CSV puts the drawing number in Drawing No and the custom id in ID', () => {
  const rows = [
    // Explicit local wall-clock timestamps match this CSV's date-fns local-calendar contract;
    // bare YYYY-MM-DD is parsed as UTC and shifts to the previous date on negative-offset hosts.
    drawing({ id: 'dwg-001', customId: '001', drawingNo: 'H2684-110-001', title: 'Midship section, frames 50-80', assignees: ['Zhang', 'Li'], reviewDeadline: '2026-11-12T12:00:00' }),
    drawing({ id: 'dwg-002', customId: '002', drawingNo: 'H2684-210-"002"', title: 'Fuel oil', assignees: ['Li'], reviewDeadline: '2026-11-05T12:00:00' }),
  ];
  const csv = buildReviewTrackerCsv(rows, { 'dwg-001': { Zhang: { done: true } as any }, 'dwg-002': { Li: { done: true } as any } }, new Date('2026-11-10T08:00:00'));
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'No,ID,Drawing No,Title,Discipline,Status,Overdue,Deadline,Li,Zhang');
  assert.equal(lines[1], '1,001,H2684-110-001,"Midship section, frames 50-80",HULL,Reviewing 1/2,2d left,2026-11-12,Pending,Done');
  assert.equal(lines[2], '2,002,"H2684-210-""002""",Fuel oil,HULL,Ready,Overdue 5d,2026-11-05,Done,');
  assert.ok(!csv.includes('dwg-001') && !csv.includes('dwg-002'), 'internal drawing ids are not exported');
  assert.equal(lines.length, 3);
});

// ---------- 删图纸前先确认 ----------

test('deleting a drawing asks first, names its drawing number and title, and cancel keeps it', () => {
  const target = { id: 'dwg-007', customId: '007', drawingNo: 'H2684-410-007', title: 'Steering gear room' };
  const prompts: string[] = [];
  const deleted: string[] = [];
  assert.equal(confirmAndDeleteDrawing(target, id => deleted.push(id), msg => { prompts.push(msg); return false; }), false);
  assert.equal(deleted.length, 0, 'cancel deletes nothing');
  assert.match(prompts[0], /Drawing No: H2684-410-007/);
  assert.match(prompts[0], /Title: Steering gear room/);
  assert.match(prompts[0], /ID: 007/);
  assert.equal(confirmAndDeleteDrawing(target, id => deleted.push(id), () => true), true);
  assert.deepEqual(deleted, ['dwg-007']);
  assert.match(deleteDrawingPrompt({ customId: '009', drawingNo: '', title: '' }), /Drawing No: 009\nTitle: \(untitled\)/);
});
