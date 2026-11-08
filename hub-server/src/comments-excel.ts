import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createContext, Script } from 'node:vm';
import { ROOT_DIR } from './config.ts';
import { roundToLetters } from '../../lib/rounds.ts';

type Sheet = { add(values: string[]): void };
type Writer = {
  makeSheet(name: string, headers: string[]): Sheet;
  workbook(sheets: Sheet[]): Promise<Blob>;
};

let writer: Writer | undefined;

function trustedWriter(): Writer {
  if (writer) return writer;
  // Only this repository-owned, immutable source is executable. Never pass drawing
  // HTML, result data, or hostedHTML to vm. vm is isolation, not a security sandbox.
  const filename = path.join(ROOT_DIR, 'pcf/template/PG-PCF-v2.6-source.html');
  const html = readFileSync(filename, 'utf8');
  const scripts = [...html.matchAll(/<script>\s*(\/\* PCF single HTML v1\b[\s\S]*?)<\/script>/g)];
  const boundary = '  root.PCFExport = Object.freeze({ build, zip: storedZip });';
  if (scripts.length !== 1 || scripts[0][1].split(boundary).length !== 2) {
    throw new Error('Comments Excel: trusted PCF XLSX exporter boundary changed');
  }
  // Expose closure-local helpers in the in-memory copy only. No template edits,
  // duplicated ZIP/SpreadsheetML writer, business scripts, or export build() call.
  const source = scripts[0][1].replace(boundary,
    '  root.__commentsXlsx = Object.freeze({ makeSheet, workbook });');
  const context = createContext(Object.assign(Object.create(null), { TextEncoder, Blob }), {
    name: 'trusted-pcf-comments-xlsx', codeGeneration: { strings: false, wasm: false },
  });
  new Script(source, { filename: filename + ':comments-xlsx-adapter' }).runInContext(context, { timeout: 1000 });
  const exposed = context.__commentsXlsx as Writer | undefined;
  if (typeof exposed?.makeSheet !== 'function' || typeof exposed.workbook !== 'function') {
    throw new Error('Comments Excel: trusted workbook helpers unavailable');
  }
  writer = exposed;
  return writer;
}

// Do not stringify arbitrary objects: credentials, PCF HTML, image bodies and
// internal query/cache metadata are deliberately not part of this export.
function scalar(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const roundLabel = (value: unknown) => roundToLetters(scalar(value));
function tags(value: unknown): string {
  return Array.isArray(value) ? JSON.stringify(value.filter(tag => typeof tag === 'string')) : scalar(value);
}

/** Export the complete supplied filtered result, not just its visible UI page. */
export async function exportCommentsExcel(result: any): Promise<Buffer> {
  const { makeSheet, workbook } = trustedWriter();
  const comments = makeSheet('Comments', [
    'Drawing ID', 'Drawing number', 'Drawing title', 'Discipline', 'Drawing status',
    'Comment ID', 'Comment number', 'Round', 'Comment status', 'Tags JSON',
    'Owner name', 'Owner date', 'Owner comment text', 'Builder reply text',
    'Builder reply date', 'Updated at', 'Open days', 'Has images',
  ]);
  for (const comment of array(result?.comments)) {
    const c = comment ?? {};
    comments.add([
      scalar(c.drawingId), scalar(c.drawingNo), scalar(c.drawingTitle), scalar(c.discipline), scalar(c.drawingStatus),
      scalar(c.commentId), scalar(c.number), roundLabel(c.round), scalar(c.status), tags(c.tags),
      scalar(c.ownerName), scalar(c.ownerDate), scalar(c.ownerComment), scalar(c.builderReply),
      scalar(c.builderReplyDate), scalar(c.updatedAt), scalar(c.openDays), scalar(c.hasImages),
    ]);
  }

  const statistics = makeSheet('Statistics', [
    'Section', 'Discipline', 'Comment status', 'Round', 'Drawing status', 'Ageing band',
    'Drawing ID', 'Drawing number', 'Total', 'Open', 'Closed', 'Count', 'Warning text',
  ]);
  const s = result?.statistics ?? {};
  statistics.add(['Summary', '', '', '', '', '', '', '', scalar(s.total), scalar(s.open), scalar(s.closed), '', '']);
  for (const row of array(s.byDiscipline)) {
    statistics.add(['By discipline', scalar(row?.discipline), scalar(row?.status), '', '', '', '', '', '', '', '', scalar(row?.count), '']);
  }
  for (const row of array(s.byRound)) {
    statistics.add(['By round', '', '', roundLabel(row?.round), '', '', '', '', '', '', '', scalar(row?.count), '']);
  }
  for (const row of array(s.byDrawingStatus)) {
    statistics.add(['By drawing status', '', '', '', scalar(row?.drawingStatus), '', '', '', '', '', '', scalar(row?.count), '']);
  }
  for (const row of array(s.ageing)) {
    statistics.add(['Ageing', '', '', '', '', scalar(row?.band), '', '', '', '', '', scalar(row?.count), '']);
  }
  for (const row of array(s.topDrawings)) {
    statistics.add(['Top drawings', '', '', '', '', '', scalar(row?.drawingId), scalar(row?.drawingNo), scalar(row?.total), scalar(row?.open), scalar(row?.closed), '', '']);
  }
  for (const row of array(result?.warnings)) {
    statistics.add(['Warnings', '', '', '', '', '', scalar(row?.drawingId), scalar(row?.drawingNo), '', '', '', '', scalar(row?.message)]);
  }
  // makeSheet adds Record key / Part / Parts, splitting every long value at
  // 32767 UTF-16 units without cutting a surrogate pair. Cells remain inlineStr
  // (including =, +, -, @ prefixes); no formulas or raw JSON/attachment export.
  const blob = await workbook([comments, statistics]);
  return Buffer.from(await blob.arrayBuffer());
}
