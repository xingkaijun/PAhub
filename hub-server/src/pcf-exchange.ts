import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PcfStorage, parseHTML, atomicWrite } from './pcf-storage.ts';
import { createZip } from './zip.ts';
import { renderTemplate } from './pcf-template.ts';
import { comparableImages } from './pcf-images.ts';
import { cleanContent, entity, applyOps, fail, safeId, cleanupLegacyImport, initData, type Actor, type PcfData, type Op } from './pcf-model.ts';
import { validateJSON } from './pcf-schema.ts';
import { completeData, completeExport, mergeComplete, restoreServerClocks } from './pcf-complete-merge.ts';
import { roundToLetters } from '../../lib/rounds.ts';

function canonical(v: any): string {
  return JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
}
const equal = (a: any, b: any) => canonical(a) === canonical(b);
const hash = (v: any) => createHash('sha256').update(canonical(v)).digest('hex');
const bodyPart = (v: any) => ({ text: v.text, html: v.html, fill: v.fill || '' });
const uuid = (v: any) => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) fail('Expected UUID'); return v as string; };
export function externalData(source: PcfData): PcfData {
  // Explicit allowlist: no hub clocks, receipts, clients, IPs, paths or internal audit history.
  const pick = (v: any, keys: string[]) => Object.fromEntries(keys.map(k => [k, structuredClone(v[k] ?? '')]));
  return {
    schemaVersion: source.schemaVersion, appVersion: '2.6', documentId: source.documentId, updatedAt: source.updatedAt,
    project: { ...pick(source.project, ['name','planTitle','planNo','revision','approval','currentRound']), folder: '' },
    comments: source.comments.map((c: any) => ({ ...pick(c, ['id','number','page','tags','status','createdAt','updatedAt']),
      rounds: c.rounds.map((r: any) => ({ ...pick(r, ['id','number','initiator','responder','minHeight','createdAt','updatedAt']), ...Object.fromEntries(['initiatorId','responderId'].filter(k => r[k] !== undefined).map(k => [k, structuredClone(r[k])])), owner: cleanContent(r.owner), reply: cleanContent(r.reply) })) })),
    nextCommentNumber: source.nextCommentNumber, deleted: [], circulation: [], approvalHistory: [],
    roundRegister: source.roundRegister.map((r: any) => pick(r, ['id','round','revision','ownerRef','ownerDate','replyRef','replyDate'])),
    approvalControl: pick(source.approvalControl, ['lastOpen','source','reason']), settings: pick(source.settings, ['fontSize','autoSaveSeconds']),
  };
}
export function standaloneHTML(data: PcfData) {
  const html = renderTemplate(data).replace(/\/\/ PAhub adapter:[\s\S]*?(?=^const TEXT_COLORS=)/m, 'const hubMode=false,hubBase=null;function hubMark(){}\n');
  const start = html.indexOf('if(hubMode){data=hubExternal(data);'), end = html.indexOf("root.querySelector('#pcf-data')", start);
  return start < 0 ? html : html.slice(0,start) + html.slice(end);
}
function readonlyPart(data: PcfData, round: number) {
  const copy = structuredClone(data); delete copy.updatedAt;
  if (copy.export) delete copy.export.ownerHmac;
  for (const c of copy.comments || []) {
    delete c.updatedAt;
    for (const r of c.rounds || []) { delete r.updatedAt; if (r.number === round && c.status === 'open') delete r.reply; }
  }
  return copy;
}
function ignoredDiff(base: any, returned: any, prefix = ''): string[] {
  if (equal(base, returned)) return [];
  if (!base || !returned || typeof base !== 'object' || typeof returned !== 'object') return [prefix];
  return [...new Set([...Object.keys(base), ...Object.keys(returned)])].flatMap(k => ignoredDiff(base[k], returned[k], prefix ? prefix + '.' + k : k)).slice(0, 500);
}
export type MergeItem = { id: string; commentId: string; roundId: string; commentNumber: number; field: 'body'|'images'|'deleted'; base: any; builder: any; server: any; reason: string };
// What a Builder reply apply wrote, for callers that log or react to it (status, audit).
export type BuilderApplyInfo = { exportId: string; batchId: string; ops: any[] };

export class PcfExchange {
  private secret: string;
  constructor(readonly storage: PcfStorage) {
    mkdirSync(storage.dataDir, { recursive: true });
    const file = path.join(storage.dataDir, '.pcf-export-key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    this.secret = readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(this.secret)) throw Error('Invalid persistent PCF export key');
  }
  private mac(v: any) { return createHmac('sha256', this.secret).update('pcf-export-v1:' + canonical(v)).digest('hex'); }
  private matches(a: string, b: string) { return /^[a-f0-9]{64}$/.test(a || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  list(p: string, d: string) { this.storage.load(p, d); return this.storage.db.prepare('SELECT * FROM pcf_exports WHERE project_id=? AND drawing_id=? ORDER BY exported_at DESC,export_id DESC').all(p, d); }
  private record(p: string, d: string, id: string) {
    uuid(id); const row: any = this.storage.db.prepare('SELECT * FROM pcf_exports WHERE export_id=? AND project_id=? AND drawing_id=?').get(id, p, d);
    if (!row) fail('exportId does not belong to this drawing', 409); return row;
  }
  private dir(p: string, d: string) { return path.join(this.storage.dataDir, 'pcf', p, d, 'exports'); }
  private file(p: string, d: string, id: string) { return path.join(this.dir(p, d), id + '.html'); }
  download(p: string, d: string, id: string) { const record = this.record(p, d, id); return { record, html: readFileSync(this.file(p, d, id), 'utf8') }; }
  void(p: string, d: string, id: string) { this.record(p, d, id); this.storage.db.prepare("UPDATE pcf_exports SET status='void' WHERE export_id=?").run(id); return { exportId: id, status: 'void' }; }
  // Completes the caller's own transaction: removes an unimported or void baseline.
  discard(p: string, d: string, id: string) {
    const record = this.record(p, d, id);
    if (record.status === 'imported') fail('Imported exports cannot be discarded', 409);
    this.storage.db.prepare('DELETE FROM pcf_exports WHERE export_id=?').run(id);
    const file = this.file(p, d, id);
    if (existsSync(file)) unlinkSync(file);
    return { exportId: id, status: 'discarded' };
  }
  create(p: string, d: string, actor: Actor, exportId = randomUUID()) {
    // Offline copies are self-contained: image references are re-inlined as data URLs.
    const { data, rev } = this.storage.loadHydrated(p, d), exportedAt = new Date().toISOString(), round = data.project.currentRound;
    const external = externalData(data);
    external.export = { exportId, documentId: data.documentId, baseRev: rev, round, exportedAt, mode: 'builder' };
    external.export.ownerHmac = this.mac(readonlyPart(external, round));
    // Remove the complete hosted adapter, not merely its live credential injection.
    const html = standaloneHTML(external);
    const filename = String(data.project.planNo || d).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '_' + roundToLetters(round) + '_PCF_' + exportedAt.slice(0, 10) + '.html';
    const file = this.file(p, d, exportId); atomicWrite(file, html);
    this.storage.db.prepare('INSERT INTO pcf_exports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(exportId, p, d, data.documentId, rev, round, exportedAt, actor.clientName, actor.ip, 'exported', filename, path.relative(this.storage.dataDir, file).split(path.sep).join('/'));
    return { exportId, filename, baseRev: rev, round, exportedAt, status: 'exported' };
  }
  // Complete offline copy: every business field is preserved; Hub clocks,
  // receipts, client IDs and IPs are removed. The baseline is kept under the
  // ordinary pcf_exports row so a return can be merged three ways.
  createComplete(p: string, d: string, actor: Actor, exportId = randomUUID()) {
    uuid(exportId);
    if (this.storage.db.prepare('SELECT 1 FROM pcf_exports WHERE export_id=?').get(exportId)) fail('exportId already exists', 409);
    const { data, rev } = this.storage.loadHydrated(p, d), exportedAt = new Date().toISOString(), round = data.project.currentRound;
    const complete = completeExport(data, { exportId, documentId: data.documentId, baseRev: rev, round, exportedAt, mode: 'complete' });
    const html = standaloneHTML(complete);
    const filename = String(data.project.planNo || d).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '_' + roundToLetters(round) + '_PCF_' + exportedAt.slice(0, 10) + '_complete.html';
    const file = this.file(p, d, exportId);
    if (existsSync(file)) fail('exportId already exists', 409);
    atomicWrite(file, html);
    try {
      this.storage.db.prepare('INSERT INTO pcf_exports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(exportId, p, d, data.documentId, rev, round, exportedAt, actor.clientName, actor.ip, 'exported', filename, path.relative(this.storage.dataDir, file).split(path.sep).join('/'));
    } catch (error) {
      // Do not leave a baseline file without its export row.
      if (existsSync(file)) unlinkSync(file);
      throw error;
    }
    return { exportId, filename, baseRev: rev, round, exportedAt, status: 'exported', mode: 'complete' };
  }
  downloadCompleteJSON(p: string, d: string, id: string) {
    const { record, html } = this.download(p, d, id);
    return { record, data: parseHTML(html) };
  }
  completeHTML(p: string, d: string, actor: Actor) {
    const record = this.createComplete(p, d, actor);
    return { record, html: this.download(p, d, record.exportId).html };
  }
  batch(p: string, rawIds: unknown, rawBatchId: unknown, actor: Actor) {
    const batchId = uuid(rawBatchId);
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 500) fail('drawingIds must contain 1 to 500 drawings');
    const ids = rawIds.map(value => safeId(value));
    if (new Set(ids).size !== ids.length) fail('drawingIds must be unique');
    const drawings = this.storage.db.prepare(
      'SELECT d.id,d.custom_id,d.drawing_no,d.title,d.current_round,p.name AS project_name FROM drawings d JOIN projects p ON p.id=d.project_id WHERE d.project_id=? AND COALESCE(d._deleted,0)=0'
    ).all(p) as any[];
    const byId = new Map(drawings.map(row => [String(row.id), row]));
    // Validate the entire selection before creating even the first export.
    for (const id of ids) if (!byId.has(id)) fail('Drawing does not belong to this project: ' + id, 400);
    const requestHash = hash(ids);
    const previous: any = this.storage.db.prepare('SELECT * FROM pcf_export_batches WHERE project_id=? AND batch_id=?').get(p, batchId);
    if (previous && previous.request_hash !== requestHash) fail('batchId already used with different drawingIds', 409);
    type Row = { drawingNo: string; title: string; round: number | string; approval: string; total: number | string; open: number | string; baseRev: number | string; exportId: string; file: string; status: string; reason: string; drawingId: string };
    const safeName = (value: unknown, fallback: string) => String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim() || fallback;
    const csvCell = (value: unknown) => { const s = String(value ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const stamp = new Date();
    const date = stamp.getFullYear() + String(stamp.getMonth() + 1).padStart(2, '0') + String(stamp.getDate()).padStart(2, '0');
    const filename = previous?.filename || safeName(drawings[0]?.project_name, p) + '_SendAll_' + date + '-' + String(stamp.getHours()).padStart(2, '0') + String(stamp.getMinutes()).padStart(2, '0') + '.zip';
    const rows: Row[] = previous ? JSON.parse(previous.manifest_json) : [];
    const files: string[] = [];
    const entries: Array<{ name: string; data: string }> = [];
    this.storage.db.exec('SAVEPOINT pcf_export_batch');
    try {
      if (!previous) {
        const used = new Set<string>();
        for (const id of ids) {
          const drawing = byId.get(id)!;
          if (!existsSync(this.storage.file(p, id))) {
            rows.push({ drawingId: id, drawingNo: drawing.drawing_no, title: drawing.title, round: drawing.current_round, approval: '', total: '', open: '', baseRev: '', exportId: '', file: '', status: 'skipped', reason: 'no PCF' });
            continue;
          }
          // load repairs the index from the authoritative HTML; never export a browser rev.
          const { data } = this.storage.load(p, id);
          const exportId = randomUUID();
          files.push(path.join(this.dir(p, id), exportId + '.html'));
          const record = this.create(p, id, actor, exportId);
          const current: any = this.storage.db.prepare('SELECT version,current_round FROM drawings WHERE project_id=? AND id=?').get(p, id);
          const base = [drawing.custom_id || id, drawing.drawing_no, drawing.title, current.version, current.current_round].map(value => safeName(value, '')).join('-');
          let file = base + '.html', suffix = 2;
          while (used.has(file.toLowerCase())) file = base + '_' + suffix++ + '.html';
          used.add(file.toLowerCase());
          rows.push({ drawingId: id, drawingNo: drawing.drawing_no, title: drawing.title, round: record.round, approval: data.project.approval, total: data.comments.length, open: data.comments.filter((c: any) => c.status === 'open').length, baseRev: record.baseRev, exportId, file, status: 'exported', reason: '' });
        }
      }
      for (const row of rows) if (row.status === 'exported') entries.push({ name: row.file, data: this.download(p, row.drawingId, row.exportId).html });
      const columns = ['drawingNo','title','round','approval','total','open','baseRev','exportId','file','status','reason'] as const;
      entries.push({ name: 'manifest.csv', data: '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(key => csvCell(key === 'round' ? roundToLetters(row.round) : row[key])).join(','))].join('\r\n') + '\r\n' });
      const buffer = createZip(entries, stamp);
      if (!previous) this.storage.db.prepare('INSERT INTO pcf_export_batches(project_id,batch_id,request_hash,filename,manifest_json) VALUES(?,?,?,?,?)').run(p, batchId, requestHash, filename, JSON.stringify(rows));
      this.storage.db.exec('RELEASE pcf_export_batch');
      return { filename, buffer };
    } catch (error) {
      this.storage.db.exec('ROLLBACK TO pcf_export_batch; RELEASE pcf_export_batch');
      for (const file of files) if (existsSync(file)) unlinkSync(file);
      throw error;
    }
  }
  private returned(body: any): PcfData {
    if (typeof body.html === 'string') return parseHTML(body.html);
    if (body.json && typeof body.json === 'object' && !Array.isArray(body.json)) return structuredClone(body.json);
    fail('Expected returned HTML or complete JSON');
  }
  private returnedHash(body: any) { return hash(body.html ?? body.json); }
  preview(p: string, d: string, body: any): any {
    const returned = this.returned(body);
    if (returned.export?.mode === 'complete') return this.previewComplete(p, d, returned, this.returnedHash(body));
    if (typeof body.html !== 'string') fail('Expected returned HTML');
    const live = this.storage.load(p, d);
    // Legacy trash is not part of the reply exchange; do not change signed read-only round history.
    const cleaned = structuredClone(returned); cleaned.deleted ??= []; cleaned.roundRegister ??= []; cleaned.circulation ??= []; cleaned.approvalHistory ??= []; cleanupLegacyImport(cleaned); returned.deleted = cleaned.deleted;
    if (returned.documentId !== live.data.documentId) fail('documentId does not match this drawing', 409);
    if (!returned.export || returned.export.documentId !== live.data.documentId || returned.export.mode !== 'builder') fail('Missing or mismatched builder export metadata', 409);
    const record = this.record(p, d, returned.export.exportId);
    if (record.document_id !== live.data.documentId) fail('Export documentId no longer matches this drawing', 409);
    if (record.status === 'void') fail('This export has been voided', 409);
    const base = parseHTML(this.download(p, d, record.export_id).html), round = Number(record.round);
    if (!Array.isArray(returned.comments)) fail('Invalid returned comments');
    const ids = new Set();
    for (const c of returned.comments) { safeId(c.id); if (ids.has(c.id) || !Array.isArray(c.rounds)) fail('Invalid or duplicate comment ID'); ids.add(c.id); for (const r of c.rounds) { safeId(r.id); if (ids.has(r.id)) fail('Duplicate round ID'); ids.add(r.id); } }
    const expected = this.mac(readonlyPart(base, round));
    if (!this.matches(base.export.ownerHmac, expected)) fail('Stored export baseline integrity check failed', 500);
    const ownerTampered = !this.matches(returned.export.ownerHmac, expected) || !this.matches(this.mac(readonlyPart(returned, round)), expected);
    const ignored = ignoredDiff(readonlyPart(base, round), readonlyPart(returned, round)).map(path => ({ path, reason: 'Read-only change ignored' }));
    if (!this.matches(returned.export.ownerHmac, expected)) ignored.push({ path: 'export.ownerHmac', reason: 'Signature changed or missing' });
    const automatic: MergeItem[] = [], conflicts: MergeItem[] = [];
    // Signatures above are over the offline (inline) form both copies share. Business comparisons with the
    // stored document use the reference form, so an inline image equals the stored reference of the same bytes.
    const baseRefs = comparableImages(base), returnedRefs = comparableImages(returned);
    for (const bc of baseRefs.comments) for (const br of bc.rounds) {
      if (br.number !== round || bc.status !== 'open') continue;
      const rr = returnedRefs.comments.find((c: any) => c.id === bc.id)?.rounds.find((r: any) => r.id === br.id);
      if (!rr) continue;
      const builder = cleanContent(rr.reply), sc = live.data.comments.find((c: any) => c.id === bc.id), sr = sc?.rounds.find((r: any) => r.id === br.id);
      if (!sr) {
        if (!equal(br.reply, builder)) conflicts.push({ id: br.id + ':deleted', commentId: bc.id, roundId: br.id, commentNumber: bc.number, field: 'deleted', base: br.reply, builder, server: null, reason: 'Server deleted this record; choosing Builder restores it' });
        continue;
      }
      for (const field of ['body','images'] as const) {
        const part = (x: any) => field === 'images' ? x.images : bodyPart(x), b = part(br.reply), mine = part(builder), server = part(sr.reply);
        if (equal(b, mine) || equal(server, mine)) continue;
        const item: MergeItem = { id: br.id + ':' + field, commentId: bc.id, roundId: br.id, commentNumber: sc.number, field, base: b, builder: mine, server, reason: sc.status === 'closed' ? 'Server closed this comment; reopen it before accepting Builder' : 'Both sides changed this reply' };
        (equal(b, server) && sc.status === 'open' ? automatic : conflicts).push(item);
      }
    }
    const payload = { p, d, exportId: record.export_id, rev: live.rev, hash: hash(body.html), expires: Date.now() + 30 * 60000 };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { exportId: record.export_id, baseRev: record.base_rev, serverRev: live.rev, round, ownerTampered, repeated: record.status === 'imported', automatic, conflicts, ignored, previewToken: token + '.' + this.mac(payload) };
  }
  private completeBaseline(p: string, d: string, returned: PcfData, live: { data: PcfData; rev: number }) {
    if (returned.documentId !== live.data.documentId) fail('documentId does not match this drawing', 409);
    const exportId = returned.export?.exportId;
    if (!exportId || returned.export.mode !== 'complete' || returned.export.documentId !== live.data.documentId) fail('Missing or mismatched complete export metadata', 409);
    const record = this.record(p, d, exportId);
    if (record.document_id !== live.data.documentId) fail('Export documentId no longer matches this drawing', 409);
    if (record.status === 'void') fail('This export has been voided', 409);
    const base = parseHTML(this.download(p, d, record.export_id).html);
    if (base.export?.mode !== 'complete') fail('Stored baseline is not a complete copy', 500);
    return { record, base };
  }
  // Returns a complete copy merged three ways against its baseline. Local and
  // server sides are compared without Hub internals so clocks never register
  // as business changes. Server tombstones are applied afterwards.
  private completeResult(p: string, d: string, returned: PcfData, choices?: Record<string, any>) {
    const live = this.storage.load(p, d);
    const { record, base: inlineBase } = this.completeBaseline(p, d, returned, live);
    // The baseline and the returned copy are offline (inline images); the stored document holds references.
    const base = comparableImages(inlineBase);
    const local = completeData(comparableImages(this.validateComplete(returned)));
    const server = completeData(live.data);
    const tombstones: any[] = (live.data.hub?.tombstones || []);
    const tombstoned = new Set<string>();
    for (const t of tombstones) {
      tombstoned.add(t.id);
      if (t.type === 'comment') for (const round of (t.data?.rounds || [])) tombstoned.add(round.id);
    }
    // Server tombstones are final. Any difference touching one is resolved to
    // the server copy instead of asking the user to resurrect the record.
    const decisions = { ...(choices || {}) };
    const preliminary = mergeComplete({ base: completeData(base), local, server });
    for (const conflict of preliminary.conflicts) {
      if (tombstoned.has(conflict.commentId || '') || tombstoned.has(conflict.roundId || '')) decisions[conflict.id] = { choice: 'server' };
    }
    const result = mergeComplete({ base: completeData(base), local, server, ...(choices ? { choices: decisions } : {}) });
    // Deleted records must not come back through a stale complete copy.
    const stripDeleted = (value: any) => {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) if (value[i] && typeof value[i].id === 'string' && tombstoned.has(value[i].id)) value.splice(i, 1); else stripDeleted(value[i]);
      } else if (value && typeof value === 'object') for (const key of Object.keys(value)) stripDeleted(value[key]);
    };
    stripDeleted(result.data.comments || []);
    stripDeleted(result.data.deleted || []);
    return { result, record, live, tombstoned };
  }
  private validateComplete(returned: PcfData) {
    // Untrusted complete copies are validated before structural merging. No
    // cleanupLegacyImport: deleted records and empty-round history must survive.
    const copy = structuredClone(returned);
    delete copy.export;
    validateJSON(copy);
    return copy;
  }
  previewComplete(p: string, d: string, returned: PcfData, requestHash: string) {
    const { result, record, live, tombstoned } = this.completeResult(p, d, returned);
    // Tombstoned records are not business differences; the server copy wins.
    const conflicts = result.conflicts
      .filter(conflict => !tombstoned.has(conflict.commentId || '') && !tombstoned.has(conflict.roundId || ''))
      .map(conflict => ({ ...conflict, resolution: conflict.serverMissing ? null : conflict.server }));
    const payload = { p, d, exportId: record.export_id, rev: live.rev, hash: requestHash, expires: Date.now() + 30 * 60000 };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return {
      mode: 'complete', exportId: record.export_id, baseRev: record.base_rev, serverRev: live.rev, round: Number(record.round),
      ownerTampered: false, repeated: record.status === 'imported', automatic: [], conflicts, ignored: [],
      previewToken: token + '.' + this.mac(payload),
    };
  }
  private applyComplete(p: string, d: string, body: any, returned: PcfData, requestedBy: Actor, receipt: { id: string; hash: string }) {
    const { result, record } = this.completeResult(p, d, returned, body.choices || {});
    if (record.status === 'imported' && body.overwrite !== true) fail('This complete copy was already imported; explicitly allow another merge', 409);
    const live = this.storage.load(p, d);
    const data = restoreServerClocks(result.data, live.data);
    if (data.documentId !== live.data.documentId) fail('documentId mismatch', 409);
    // Reconcile derived numbering/approval before validating the combined document;
    // conflict choices are untrusted inputs too, not only the returned copy.
    initData(data);
    validateJSON(data);
    const actor = { clientId: requestedBy.clientId, clientName: 'Complete copy import (' + record.export_id + ')', ip: requestedBy.ip };
    const applied = this.storage.replace(p, d, { baseRev: live.rev, data: initData(data) }, actor, undefined, receipt, () => {
      this.storage.db.prepare("UPDATE pcf_exports SET status='imported' WHERE export_id=? AND status!='void'").run(record.export_id);
    });
    return { replayed: false, result: applied, actor };
  }
  // Complete-copy receipts are committed in authoritative JSON with the data.
  // A lost response or process crash never applies the same merge twice.
  private applyCompleteReceipt(p: string, d: string, body: any, returned: PcfData, requestedBy: Actor) {
    const batchId = uuid(body.batchId), file = path.join(this.storage.dataDir, 'pcf', p, d, 'imports', batchId + '.json');
    const { adminPassword: _password, ...safeBody } = body;
    const requestHash = hash({ body: safeBody, requestedBy: requestedBy.clientId });
    const replay = this.storage.replacementReplay(p, d, batchId, requestHash);
    if (replay) return { replayed: true, result: replay, actor: { ...requestedBy, clientName: 'Complete copy import (' + returned.export.exportId + ')' } };
    if (existsSync(file)) {
      const prepared = JSON.parse(readFileSync(file, 'utf8'));
      if (prepared.hash !== requestHash) fail('batchId reused with a different import', 409);
      if (prepared.result) return { replayed: true, result: prepared.result, actor: prepared.actor };
    }
    const preview = this.preview(p, d, body);
    try {
      const [value, signature] = String(body.previewToken || '').split('.'), payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (!this.matches(signature, this.mac(payload)) || payload.p !== p || payload.d !== d || payload.exportId !== preview.exportId || payload.hash !== this.returnedHash(body) || payload.rev !== preview.serverRev || payload.expires <= Date.now()) fail('Preview expired or server changed; preview again', 409);
    } catch (e: any) { if (e.status) throw e; fail('Invalid preview token', 409); }
    if (preview.repeated && body.overwrite !== true) fail('This complete copy was already imported; explicitly allow another merge', 409);
    this.storage.images.externalize(p, structuredClone(returned));
    return this.applyComplete(p, d, body, returned, requestedBy, { id: batchId, hash: requestHash });
  }
  apply(p: string, d: string, body: any, requestedBy: Actor, afterApply?: (applied: BuilderApplyInfo) => void) {
    const returned = this.returned(body);
    if (returned.export?.mode === 'complete') return this.applyCompleteReceipt(p, d, body, returned, requestedBy);
    const batchId = uuid(body.batchId), file = path.join(this.storage.dataDir, 'pcf', p, d, 'imports', batchId + '.json');
    // Do not persist the administrative password in the intent/receipt file.
    const { adminPassword: _password, ...safeBody } = body;
    const requestHash = hash({ body: safeBody, requestedBy: requestedBy.clientId });
    let prepared: any;
    if (existsSync(file)) {
      prepared = JSON.parse(readFileSync(file, 'utf8'));
      if (prepared.hash !== requestHash) fail('batchId reused with a different import', 409);
      if (prepared.result) return { replayed: true, result: prepared.result, actor: prepared.actor };
    } else {
      const preview = this.preview(p, d, body);
      try {
        const [value, signature] = String(body.previewToken || '').split('.'), payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!this.matches(signature, this.mac(payload)) || payload.p !== p || payload.d !== d || payload.exportId !== preview.exportId || payload.hash !== hash(body.html) || payload.rev !== preview.serverRev || payload.expires <= Date.now()) fail('Preview expired or server changed; preview again', 409);
      } catch (e: any) { if (e.status) throw e; fail('Invalid preview token', 409); }
      if (preview.repeated && body.overwrite !== true) fail('This export was already imported; explicitly allow another merge', 409);
      // Store the returned file's images (content addressed) so accepted references resolve.
      this.storage.images.externalize(p, structuredClone(returned));
      if (preview.ownerTampered) {
        if (body.ignoreOwner !== true) fail('Read-only content changed; administrator confirmation required', 409);
        const adminPassword = process.env.ADMIN_PASSWORD?.trim();
        if (!adminPassword) fail('Owner content overrides are disabled: ADMIN_PASSWORD is not set', 403);
        if (body.adminPassword !== adminPassword) fail('Administrator password required to ignore tampered Owner content', 403);
      }
      const choices = body.choices || {}, valid = new Set(preview.conflicts.map((x: any) => x.id));
      if (Object.keys(choices).some(k => !valid.has(k))) fail('Unknown conflict choice');
      const selected = [...preview.automatic.map((item: any) => ({ item, value: item.builder })), ...preview.conflicts.flatMap((item: any) => {
        const choice = choices[item.id]; if (!choice || !['builder','server','merge'].includes(choice.choice)) fail('Every conflict needs a decision');
        if (choice.choice === 'server') return [];
        return [{ item, value: choice.choice === 'merge' ? choice.value : item.builder }];
      })];
      const live = this.storage.load(p, d), ops: Op[] = [], restored = new Set(), updates = new Map<string, any>();
      for (const { item, value } of selected) {
        let c = live.data.comments.find((c: any) => c.id === item.commentId), r = c?.rounds.find((r: any) => r.id === item.roundId);
        if (item.field === 'deleted') {
          const t = live.data.deleted.find((t: any) => t.type === 'comment' ? t.data.id === item.commentId : t.parentId === item.commentId && t.data.id === item.roundId);
          if (!t) fail('Deleted record cannot be restored; choose Server or recover it separately', 409);
          if (!restored.has(t.id)) { ops.push({ type: 'record.restore', deleteId: t.id, baseRev: entity(live.data, 'deleted:' + t.id).rev }); restored.add(t.id); }
          if (t.type === 'comment') c = t.data;
          r = t.type === 'round' ? t.data : c.rounds.find((r: any) => r.id === item.roundId);
        }
        if (!c || !r || c.status === 'closed') fail('Reopen the server comment before accepting Builder', 409);
        const valueNow = updates.get(item.roundId) || structuredClone(r.reply);
        if (item.field === 'deleted') Object.assign(valueNow, cleanContent(value));
        else if (item.field === 'body') Object.assign(valueNow, bodyPart(value));
        else valueNow.images = value;
        updates.set(item.roundId, cleanContent(valueNow));
      }
      for (const [roundId, value] of updates) {
        const item = selected.find(x => x.item.roundId === roundId)!.item;
        ops.push({ type: 'content.set', commentId: item.commentId, roundId, side: 'reply', value, baseRev: entity(live.data, 'round:' + roundId + ':reply').rev });
      }
      const actor = { clientId: requestedBy.clientId, clientName: 'Builder import (' + preview.exportId + ')', ip: requestedBy.ip };
      const check = applyOps(structuredClone(live.data), ops, actor, live.rev + 1);
      if (check.conflicts.length) fail('Import cannot be applied atomically; preview again or restore/reopen the record first', 409);
      prepared = { hash: requestHash, exportId: preview.exportId, actor, body: { baseRev: live.rev, batchId, ops } };
      atomicWrite(file, JSON.stringify(prepared));
    }
    const outcome = this.storage.opsBatch(p, d, prepared.body, prepared.actor);
    if (outcome.result.conflicts.length) fail('Server changed while recovering import; manual recovery required', 409);
    if (outcome.result.applied.length && afterApply) {
      // Also reached when a prepared intent is recovered (opsBatch replays its receipt): callbacks must be idempotent.
      afterApply({ exportId: prepared.exportId, batchId: prepared.body.batchId, ops: prepared.body.ops });
      const latest = this.storage.load(p, d);
      outcome.result = { ...outcome.result, rev: latest.rev, data: this.storage.publicData(latest.data) };
    }
    this.storage.db.prepare("UPDATE pcf_exports SET status='imported' WHERE export_id=? AND status!='void'").run(prepared.exportId);
    prepared.result = outcome.result; atomicWrite(file, JSON.stringify(prepared));
    return { ...outcome, actor: prepared.actor };
  }
}
