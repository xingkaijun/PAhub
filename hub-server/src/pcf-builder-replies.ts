import { writeAudit } from './audit.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { PcfStorage } from './pcf-storage.ts';
import type { PcfExchange, BuilderApplyInfo } from './pcf-exchange.ts';
import type { PcfRealtime } from './pcf-realtime.ts';
import { parseHTML } from './pcf-storage.ts';
import { transitionDrawingStatus } from './drawing-status.ts';
import { roundToLetters } from '../../lib/rounds.ts';

const MAX_FILES = Number(process.env.MAX_BUILDER_REPLY_FILES || 50);
const MAX_BYTES = Number(process.env.MAX_BUILDER_REPLY_BYTES || 50 * 1024 * 1024);
const MAX_UNPACKED = Number(process.env.MAX_BUILDER_REPLY_UNPACKED_BYTES || 200 * 1024 * 1024);
const validUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
type Input = { name: string; bytes: Buffer };

export function updateBuilderReplyPapcStatus(storage: PcfStorage, realtime: PcfRealtime, projectId: string, drawingId: string, exportId: string) {
  const row: any = storage.db.prepare('SELECT status FROM drawings WHERE project_id=? AND id=? AND COALESCE(_deleted,0)=0').get(projectId, drawingId);
  if (!row) throw Error('PAPC drawing no longer exists');
  if (row.status !== 'Waiting Reply') return `status unchanged (${row.status})`;
  transitionDrawingStatus(storage, realtime, projectId, drawingId, 'Reviewing', `Builder import (${exportId})`);
  return 'Reviewing';
}

// One BUILDER_REPLY audit row per applied Builder reply import, so the Daily Log (Server) shows imports that
// change no comment counts and no status. Status rule is unchanged: only Waiting Reply -> Reviewing.
// Idempotent per drawing + batchId + exportId: a replayed or recovered apply never writes a second row.
export function recordBuilderReplyImport(storage: PcfStorage, projectId: string, drawingId: string, info: BuilderApplyInfo, statusBefore: string, via: 'bulk' | 'pcf') {
  const db = storage.db;
  const exists = db.prepare("SELECT 1 FROM audit_log WHERE project_id=? AND row_id=? AND action='BUILDER_REPLY' AND json_extract(detail,'$.batchId')=? AND json_extract(detail,'$.exportId')=?").get(projectId, drawingId, info.batchId, info.exportId);
  if (exists) return false;
  const row: any = db.prepare('SELECT custom_id,drawing_no,status FROM drawings WHERE project_id=? AND id=?').get(projectId, drawingId) || {};
  const exported: any = db.prepare('SELECT round FROM pcf_exports WHERE project_id=? AND export_id=?').get(projectId, info.exportId);
  const replies = new Set((info.ops || []).filter((op: any) => op?.type === 'content.set' && op.side === 'reply').map((op: any) => op.roundId)).size;
  const statusAfter = String(row.status || statusBefore || '');
  const status = statusBefore !== statusAfter ? `${statusBefore} -> ${statusAfter}` : `unchanged (${statusAfter})`;
  const detail = {
    customId: row.custom_id || '', drawingNo: row.drawing_no || '', exportId: info.exportId, batchId: info.batchId,
    round: exported ? roundToLetters(Number(exported.round)) : '', replies, status, statusFrom: statusBefore, statusTo: statusAfter,
    via, source: via === 'bulk' ? 'Builder reply import (bulk)' : 'Builder reply import (PCF)',
  };
  writeAudit(db,{table:'drawings',rowId:drawingId,projectId,action:'BUILDER_REPLY',detail,createdAt:new Date().toISOString()});
  return true;
}

// Caller holds storage.serial(projectId, drawingId): status update and its audit row are written back to back
// with nothing interleaved. They are not wrapped in one SQL savepoint because a round change also rewrites the
// PCF JSON file, which a rollback could not undo.
export function completeBuilderReplyImport(storage: PcfStorage, realtime: PcfRealtime, projectId: string, drawingId: string, info: BuilderApplyInfo, via: 'bulk' | 'pcf') {
  const before: any = storage.db.prepare('SELECT status FROM drawings WHERE project_id=? AND id=? AND COALESCE(_deleted,0)=0').get(projectId, drawingId);
  const state = updateBuilderReplyPapcStatus(storage, realtime, projectId, drawingId, info.exportId);
  recordBuilderReplyImport(storage, projectId, drawingId, info, String(before?.status || ''), via);
  return state;
}

function zipEntries(bytes: Buffer): Array<{ name: string; bytes?: Buffer; error?: string }> {
  let eocd = -1;
  for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 22; i++) if (bytes.readUInt32LE(i) === 0x06054b50) eocd = i;
  if (eocd < 0) throw Error('Invalid ZIP: end record missing');
  const count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), centralOffset = bytes.readUInt32LE(eocd + 16);
  if (count > MAX_FILES * 20 || centralOffset + centralSize > eocd) throw Error('Invalid ZIP directory');
  const result = []; let cursor = centralOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), n = bytes.readUInt16LE(cursor + 28), x = bytes.readUInt16LE(cursor + 30), c = bytes.readUInt16LE(cursor + 32), external = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + n).toString(flags & 0x800 ? 'utf8' : 'latin1'); cursor += 46 + n + x + c;
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split(/[\\/]/).includes('..') || name.includes('\\')) { result.push({ name, error: 'Unsafe ZIP path rejected' }); continue; }
    if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) continue;
    if (name.endsWith('/')) continue;
    if (!name.toLowerCase().endsWith('.html')) continue;
    if (flags & 1) { result.push({ name, error: 'Encrypted ZIP entries are not supported' }); continue; }
    if (size > MAX_UNPACKED - total) { result.push({ name, error: 'ZIP expanded size exceeds configured limit' }); continue; }
    total += size;
    try {
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw Error('Invalid ZIP local entry');
      const ln = bytes.readUInt16LE(local + 26), lx = bytes.readUInt16LE(local + 28), start = local + 30 + ln + lx, packed = bytes.subarray(start, start + compressed);
      if (start + compressed > bytes.length) throw Error('Truncated ZIP entry');
      const file = method === 0 ? Buffer.from(packed) : method === 8 ? inflateRawSync(packed, { maxOutputLength: MAX_UNPACKED }) : undefined;
      if (!file || file.length !== size || crc32(file) !== crc) throw Error('ZIP entry data or CRC is invalid');
      result.push({ name, bytes: file });
    } catch (e: any) { result.push({ name, error: e.message || 'ZIP entry could not be unpacked' }); }
  }
  return result;
}
function crc32(buf: Buffer) { let c = -1; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; }

export class PcfBuilderReplies {
  constructor(private storage: PcfStorage, private exchange: PcfExchange, private realtime: PcfRealtime, private adminPassword?: string) {}
  private dir(projectId: string, setId: string) {
    if (!validUuid(setId)) throw Error('Invalid importSetId');
    return path.join(this.storage.dataDir, 'pcf', projectId, 'imports', setId);
  }
  async preview(projectId: string, form: FormData, authorize = () => {}) {
    const files: Input[] = [], failures: any[] = [], evidence: Input[] = []; let uploadBytes = 0;
    for (const item of form.getAll('files')) {
      if (!(item instanceof File)) continue;
      const bytes = Buffer.from(await item.arrayBuffer()); uploadBytes += bytes.length;
      if (uploadBytes > MAX_BYTES) throw Object.assign(Error('Upload exceeds configured 50 MB limit'), { status: 413 });
      evidence.push({ name: item.name, bytes });
      if (item.name.toLowerCase().endsWith('.zip')) {
        try { for (const entry of zipEntries(bytes)) entry.error ? failures.push({ fileName: entry.name, category: 'unmatched', reason: entry.error }) : entry.bytes && files.push({ name: entry.name, bytes: entry.bytes }); }
        catch (e: any) { failures.push({ fileName: item.name, category: 'unmatched', reason: e.message }); }
      } else if (item.name.toLowerCase().endsWith('.html')) files.push({ name: item.name, bytes });
    }
    authorize();
    if (files.length + failures.length > MAX_FILES) throw Object.assign(Error('Upload exceeds configured 50 file limit'), { status: 413 });
    const setId = randomUUID(), root = this.dir(projectId, setId); mkdirSync(root, { recursive: true });
    const evidenceDir = path.join(root, 'evidence'); mkdirSync(evidenceDir, { recursive: true });
    for (const source of evidence) {
      const extension = source.name.toLowerCase().endsWith('.zip') ? '.zip' : source.name.toLowerCase().endsWith('.html') ? '.html' : '.bin';
      writeFileSync(path.join(evidenceDir, randomUUID() + extension), source.bytes, { flag: 'wx' });
    }
    const rows = [...failures];
    for (const file of files) {
      const id = randomUUID(), html = file.bytes.toString('utf8'), target = path.join(root, id + '.html');
      writeFileSync(target, file.bytes, { flag: 'wx' });
      try {
        const data = parseHTML(html), exp = data.export;
        if (!exp?.documentId || !exp?.exportId) throw Error('Missing documentId/exportId metadata');
        const rec: any = this.storage.db.prepare('SELECT e.*,d.drawing_no,d.title,d.status AS papc_status FROM pcf_exports e JOIN drawings d ON d.project_id=e.project_id AND d.id=e.drawing_id WHERE e.project_id=? AND e.export_id=?').get(projectId, exp.exportId);
        if (!rec || rec.document_id !== exp.documentId || rec.document_id !== data.documentId) throw Error('No matching documentId/exportId in this project');
        const preview = this.exchange.preview(projectId, rec.drawing_id, { html });
        // Summary properties come from the authoritative document, not returned Owner metadata.
        const tags = [...new Set<string>(this.storage.load(projectId, rec.drawing_id).data.comments.flatMap((c: any) => c.tags || []))];
        const changed = [...preview.automatic, ...preview.conflicts];
        const replies = new Set(changed.map((item: any) => `${item.commentId}:${item.roundId}`)).size;
        const category = preview.repeated ? 'duplicate' : preview.conflicts.length ? 'conflict' : preview.ownerTampered && replies ? 'owner-tampered' : replies ? 'clean' : 'unchanged';
        rows.push({ id, fileName: file.name, drawingId: rec.drawing_id, drawingNo: rec.drawing_no, title: rec.title, tags, exportId: preview.exportId, round: roundToLetters(preview.round), newReplies: replies, automatic: preview.automatic.length, conflicts: preview.conflicts.length, papcStatus: rec.papc_status, statusNote: rec.papc_status === 'Waiting Reply' ? 'will change to Reviewing' : `status unchanged (${rec.papc_status})`, category, previewToken: preview.previewToken, ownerTampered: preview.ownerTampered, reason: '', htmlPath: path.basename(target) });
      } catch (e: any) { rows.push({ id, fileName: file.name, category: 'unmatched', reason: e.message || 'Invalid PCF reply', htmlPath: path.basename(target) }); }
    }
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ projectId, setId, rows }, null, 2));
    return { importSetId: setId, files: rows };
  }
  getFile(projectId: string, setId: string, fileId: string) {
    const root = this.dir(projectId, setId), manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (manifest.projectId !== projectId) throw Error('Import set does not belong to this project');
    const row = manifest.rows.find((r: any) => r.id === fileId && r.htmlPath === r.id + '.html');
    if (!row) throw Object.assign(Error('Builder reply not found'), { status: 404 });
    return { html: readFileSync(path.join(root, row.htmlPath), 'utf8'), drawingId: row.drawingId };
  }
  pending(projectId: string) {
    const root = path.join(this.storage.dataDir, 'pcf', projectId, 'imports');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).flatMap(x => { try { const m = JSON.parse(readFileSync(path.join(root, x.name, 'manifest.json'), 'utf8')); return m.rows.filter((r: any) => {
      if (!['conflict','skipped','owner-tampered'].includes(r.category)) return false;
      if (r.exportId && this.storage.db.prepare("SELECT status FROM pcf_exports WHERE export_id=? AND project_id=?").get(r.exportId, projectId)?.status === 'imported') return false;
      return true;
    }).map((r: any) => ({ ...r, importSetId: x.name })); } catch { return []; } });
  }
  async apply(projectId: string, setId: string, ids: string[], batchId: string, authorize = () => {}) {
    const file = path.join(this.dir(projectId, setId), 'manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.projectId !== projectId || !Array.isArray(ids) || ids.length > MAX_FILES) throw Error('Invalid import set or file list');
    const results = [];
    for (const id of ids) {
      const row = manifest.rows.find((r: any) => r.id === id);
      if (!row || !['clean','owner-tampered'].includes(row.category)) { results.push({ id, category: row?.category || 'unmatched', reason: row?.reason || 'File is not clean and cannot be applied automatically' }); continue; }
      if (row.htmlPath !== row.id + '.html') { results.push({ id, category: 'failed', reason: 'Invalid stored reply path' }); continue; }
      const html = readFileSync(path.join(this.dir(projectId, setId), row.id + '.html'), 'utf8');
      try {
        await this.storage.serial(projectId, row.drawingId, () => {
          authorize();
          const fresh = this.exchange.preview(projectId, row.drawingId, { html });
          if (fresh.repeated) throw Error('duplicate');
          if (fresh.conflicts.length) { row.category = 'conflict'; row.conflicts = fresh.conflicts.length; row.previewToken = fresh.previewToken; results.push({ id, category: 'conflict', conflicts: fresh.conflicts.length }); return; }
          let state = `status unchanged (${row.papcStatus})`;
          const outcome = this.exchange.apply(projectId, row.drawingId, { step: 'apply', html, previewToken: fresh.previewToken, batchId, ignoreOwner: true, adminPassword: this.adminPassword }, { clientId: 'builder-import', clientName: `Builder import (${fresh.exportId})`, ip: '127.0.0.1' }, applied => {
            state = completeBuilderReplyImport(this.storage, this.realtime, projectId, row.drawingId, applied, 'bulk');
        });
        if (!outcome.replayed && outcome.result.applied.length) {
          const latest = this.storage.load(projectId, row.drawingId);
          this.realtime.changed(projectId + '/' + row.drawingId, { ...outcome.result, rev: latest.rev, data: this.storage.publicData(latest.data) }, outcome.actor);
          this.realtime.projectChanged(projectId, row.drawingId, ['builder-reply', 'status']);
        }
        row.category = 'applied'; row.result = state; results.push({ id, category: 'applied', applied: outcome.result.applied.length, status: state });
        });
      } catch (e: any) { results.push({ id, category: e.message === 'duplicate' ? 'duplicate' : 'failed', reason: e.message || 'Apply failed' }); }
    }
    writeFileSync(file, JSON.stringify(manifest, null, 2)); return { results };
  }
  skip(projectId: string, setId: string, id: string) {
    const file = path.join(this.dir(projectId, setId), 'manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.projectId !== projectId) throw Error('Import set does not belong to this project');
    const row = manifest.rows.find((r: any) => r.id === id);
    if (!row || ['applied','duplicate','unmatched'].includes(row.category)) throw Error('This reply cannot be skipped');
    row.category = 'skipped'; writeFileSync(file, JSON.stringify(manifest, null, 2)); return { id, category: 'skipped' };
  }
}
