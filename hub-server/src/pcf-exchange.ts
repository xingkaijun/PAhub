import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PcfStorage, parseHTML, atomicWrite } from './pcf-storage.ts';
import { createZip } from './zip.ts';
import { renderTemplate } from './pcf-template.ts';
import { cleanContent, entity, applyOps, fail, safeId, type Actor, type PcfData, type Op } from './pcf-model.ts';

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
    schemaVersion: source.schemaVersion, documentId: source.documentId, updatedAt: source.updatedAt,
    project: { ...pick(source.project, ['name','planTitle','planNo','revision','approval','currentRound']), folder: '' },
    comments: source.comments.map((c: any) => ({ ...pick(c, ['id','number','page','tags','status','createdAt','updatedAt']),
      rounds: c.rounds.map((r: any) => ({ ...pick(r, ['id','number','initiator','responder','minHeight','createdAt','updatedAt']), owner: cleanContent(r.owner), reply: cleanContent(r.reply) })) })),
    nextCommentNumber: source.nextCommentNumber, deleted: [], circulation: [], approvalHistory: [],
    roundRegister: source.roundRegister.map((r: any) => pick(r, ['id','round','revision','ownerRef','ownerDate','replyRef','replyDate'])),
    approvalControl: pick(source.approvalControl, ['lastOpen','source','reason']), settings: pick(source.settings, ['fontSize','autoSaveSeconds']),
  };
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
  download(p: string, d: string, id: string) { const record = this.record(p, d, id); return { record, html: readFileSync(path.join(this.dir(p, d), id + '.html'), 'utf8') }; }
  void(p: string, d: string, id: string) { this.record(p, d, id); this.storage.db.prepare("UPDATE pcf_exports SET status='void' WHERE export_id=?").run(id); return { exportId: id, status: 'void' }; }
  create(p: string, d: string, actor: Actor, exportId = randomUUID()) {
    const { data, rev } = this.storage.load(p, d), exportedAt = new Date().toISOString(), round = data.project.currentRound;
    const external = externalData(data);
    external.export = { exportId, documentId: data.documentId, baseRev: rev, round, exportedAt, mode: 'builder' };
    external.export.ownerHmac = this.mac(readonlyPart(external, round));
    // Remove the complete hosted adapter, not merely its live credential injection.
    const html = renderTemplate(external).replace(/\/\/ PAhub adapter:[\s\S]*?(?=const TEXT_COLORS=)/, 'const hubMode=false,hubBase=null;function hubMark(){}\n').replace(/root\.querySelectorAll\('#pahub-context[^']*'\)\.forEach\(el=>el\.remove\(\)\);/, '');
    const filename = String(data.project.planNo || d).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '_R' + String(round).padStart(2, '0') + '_PCF_' + exportedAt.slice(0, 10) + '.html';
    const file = path.join(this.dir(p, d), exportId + '.html'); atomicWrite(file, html);
    this.storage.db.prepare('INSERT INTO pcf_exports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(exportId, p, d, data.documentId, rev, round, exportedAt, actor.clientName, actor.ip, 'exported', filename, path.relative(this.storage.dataDir, file).split(path.sep).join('/'));
    return { exportId, filename, baseRev: rev, round, exportedAt, status: 'exported' };
  }
  batch(p: string, rawIds: unknown, rawBatchId: unknown, actor: Actor) {
    const batchId = uuid(rawBatchId);
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 500) fail('drawingIds must contain 1 to 500 drawings');
    const ids = rawIds.map(value => safeId(value));
    if (new Set(ids).size !== ids.length) fail('drawingIds must be unique');
    const drawings = this.storage.db.prepare(
      'SELECT d.id,d.drawing_no,d.title,d.current_round,p.name AS project_name FROM drawings d JOIN projects p ON p.id=d.project_id WHERE d.project_id=? AND COALESCE(d._deleted,0)=0'
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
          const base = safeName(drawing.drawing_no, id) + '_R' + String(record.round).padStart(2, '0') + '_PCF_' + date;
          let file = base + '.html', suffix = 2;
          while (used.has(file.toLowerCase())) file = base + '_' + suffix++ + '.html';
          used.add(file.toLowerCase());
          rows.push({ drawingId: id, drawingNo: drawing.drawing_no, title: drawing.title, round: record.round, approval: data.project.approval, total: data.comments.length, open: data.comments.filter((c: any) => c.status === 'open').length, baseRev: record.baseRev, exportId, file, status: 'exported', reason: '' });
        }
      }
      for (const row of rows) if (row.status === 'exported') entries.push({ name: row.file, data: this.download(p, row.drawingId, row.exportId).html });
      const columns = ['drawingNo','title','round','approval','total','open','baseRev','exportId','file','status','reason'] as const;
      entries.push({ name: 'manifest.csv', data: '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n' });
      const buffer = createZip(entries, stamp);
      if (!previous) this.storage.db.prepare('INSERT INTO pcf_export_batches(project_id,batch_id,request_hash,filename,manifest_json) VALUES(?,?,?,?,?)').run(p, batchId, requestHash, filename, JSON.stringify(rows));
      this.storage.db.exec('RELEASE pcf_export_batch');
      return { filename, buffer };
    } catch (error) {
      this.storage.db.exec('ROLLBACK TO pcf_export_batch; RELEASE pcf_export_batch');
      for (const file of files) if (existsSync(file)) unlinkSync(file);
      throw error;
    }
  }  preview(p: string, d: string, body: any) {
    if (typeof body.html !== 'string') fail('Expected returned HTML');
    const returned = parseHTML(body.html), live = this.storage.load(p, d);
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
    for (const bc of base.comments) for (const br of bc.rounds) {
      if (br.number !== round || bc.status !== 'open') continue;
      const rr = returned.comments.find((c: any) => c.id === bc.id)?.rounds.find((r: any) => r.id === br.id);
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
  apply(p: string, d: string, body: any, requestedBy: Actor) {
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
      if (preview.ownerTampered) {
        if (body.ignoreOwner !== true) fail('Read-only content changed; administrator confirmation required', 409);
        if (body.adminPassword !== (process.env.ADMIN_PASSWORD || 'papc-admin-2026')) fail('Administrator password required to ignore tampered Owner content', 403);
      }
      const choices = body.choices || {}, valid = new Set(preview.conflicts.map(x => x.id));
      if (Object.keys(choices).some(k => !valid.has(k))) fail('Unknown conflict choice');
      const selected = [...preview.automatic.map(item => ({ item, value: item.builder })), ...preview.conflicts.flatMap(item => {
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
      const actor = { clientId: requestedBy.clientId, clientName: '船厂导入（' + preview.exportId + '）', ip: requestedBy.ip };
      const check = applyOps(structuredClone(live.data), ops, actor, live.rev + 1);
      if (check.conflicts.length) fail('Import cannot be applied atomically; preview again or restore/reopen the record first', 409);
      prepared = { hash: requestHash, exportId: preview.exportId, actor, body: { baseRev: live.rev, batchId, ops } };
      atomicWrite(file, JSON.stringify(prepared));
    }
    const outcome = this.storage.opsBatch(p, d, prepared.body, prepared.actor);
    if (outcome.result.conflicts.length) fail('Server changed while recovering import; manual recovery required', 409);
    this.storage.db.prepare("UPDATE pcf_exports SET status='imported' WHERE export_id=? AND status!='void'").run(prepared.exportId);
    prepared.result = outcome.result; atomicWrite(file, JSON.stringify(prepared));
    return { ...outcome, actor: prepared.actor };
  }
}
