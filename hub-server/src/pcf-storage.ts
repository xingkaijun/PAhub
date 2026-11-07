import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, unlinkSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT_DIR } from './config.ts';
import * as modelV26 from './pcf-v26.ts';
import { validateJSON } from './pcf-schema.ts';
import { initData, reconcile, roundNumber, roundLabel, registerFields, fail, type PcfData, type Actor, type Op, applyOps } from './pcf-model.ts';

// Locate exactly one JSON script by attributes; independent of whitespace/attribute order.
function dataBlock(html: string) {
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(m => /\bid\s*=\s*(['"])pcf-data\1/i.test(m[1]));
  if (matches.length !== 1 || !/\btype\s*=\s*(['"])application\/json\1/i.test(matches[0][1])) fail('Expected one #pcf-data JSON script');
  return matches[0];
}
export function parseHTML(html: string): PcfData {
  try { return JSON.parse(dataBlock(html)[2]); } catch (e: any) { if (e.status) throw e; fail('Invalid pcf-data JSON'); }
}
export const scriptJSON = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
export function replaceData(html: string, data: PcfData) {
  const m = dataBlock(html), start = m.index! + m[0].indexOf('>') + 1;
  return html.slice(0, start) + scriptJSON(data) + html.slice(start + m[2].length);
}
export function atomicWrite(file: string, html: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, html, { encoding: 'utf8', flag: 'wx' });
    const fd = openSync(temp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export class PcfStorage {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly db: DatabaseSync, readonly dataDir: string) {}
  file(p: string, d: string) { return path.join(this.dataDir, 'pcf', p, d + '.html'); }
  historyDir(p: string, d: string) { return path.join(this.dataDir, 'pcf', p, '.history', d); }
  async serial<T>(p: string, d: string, task: () => T | Promise<T>): Promise<T> {
    const key = p + '/' + d, previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task); this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  private drawing(p: string, d: string) {
    const row = this.db.prepare('SELECT d.*, p.name AS project_name FROM drawings d JOIN projects p ON p.id=d.project_id WHERE d.project_id=? AND d.id=? AND COALESCE(d._deleted,0)=0').get(p, d);
    if (!row) fail('Drawing not found', 404); return row;
  }
  meta(p: string, d: string) { this.load(p, d); return this.db.prepare('SELECT * FROM pcf_index WHERE project_id=? AND drawing_id=?').get(p, d)!; }
  index(p: string) {
    // Also repair a crash between file rename and SQLite commit on project listing.
    const dir = path.join(this.dataDir, 'pcf', p);
    if (existsSync(dir)) for (const name of readdirSync(dir)) if (/^[A-Za-z0-9_-]+\.html$/.test(name)) {
      const id = name.slice(0, -5); if (this.db.prepare('SELECT 1 FROM drawings WHERE project_id=? AND id=? AND COALESCE(_deleted,0)=0').get(p, id)) this.load(p, id);
    }
    return this.db.prepare("SELECT i.*, (SELECT json_object('exportId',e.export_id,'round',e.round,'status',e.status,'exportedAt',e.exported_at) FROM pcf_exports e WHERE e.project_id=i.project_id AND e.drawing_id=i.drawing_id ORDER BY e.exported_at DESC,e.export_id DESC LIMIT 1) AS latest_export FROM pcf_index i WHERE project_id=? ORDER BY drawing_id").all(p);
  }
  load(p: string, d: string) {
    this.drawing(p, d); const file = this.file(p, d);
    if (!existsSync(file)) fail('PCF not found', 404);
    const html = readFileSync(file, 'utf8'), data = parseHTML(html), rev = Number(data.hub?.rev);
    if (!Number.isSafeInteger(rev) || rev < 1) fail('Invalid stored PCF revision', 500);
    const meta = this.db.prepare('SELECT rev FROM pcf_index WHERE project_id=? AND drawing_id=?').get(p, d);
    if (meta?.rev !== rev) {
      if (meta && Number(meta.rev) > rev) fail('PCF file/index revision mismatch; restore backup', 500);
      this.transaction(() => this.indexWrite(p, d, data));
    }
    return { html, data, rev };
  }
  create(p: string, d: string, actor: Actor) {
    if (existsSync(this.file(p, d))) return this.meta(p, d);
    const drawing = this.drawing(p, d), html = readFileSync(path.join(ROOT_DIR, 'pcf/template/PG-PCF-hub.html'), 'utf8');
    const data = parseHTML(html), n = roundNumber(drawing.current_round);
    Object.assign(data, { documentId: randomUUID(), comments: [], deleted: [], circulation: [], approvalHistory: [], roundRegister: [], hub: { rev: 0, entities: {} } });
    data.project = { name: drawing.project_name, planNo: drawing.drawing_no, planTitle: drawing.title, revision: drawing.version || '', folder: '', currentRound: n, approval: drawing.status === 'Approved' ? 'Approved' : drawing.status === 'Pending' ? 'Not submitted' : 'Under review' };
    delete data.approvalControl; initData(data);
    this.save(p, d, html, data, actor, [{ type: 'document.create' }]); return this.meta(p, d);
  }
  private transaction(task: () => void) {
    this.db.exec('SAVEPOINT pcf_write');
    try { task(); this.db.exec('RELEASE pcf_write'); } catch (e) { this.db.exec('ROLLBACK TO pcf_write; RELEASE pcf_write'); throw e; }
  }
  private indexWrite(p: string, d: string, data: PcfData) {
    const before = this.drawing(p, d), open = data.comments.filter((c: any) => c.status === 'open').length, total = data.comments.length;
    const n = data.project.currentRound, row = data.roundRegister.find((r: any) => r.round === n), change = data.hub.lastChange;
    const rounds = data.roundRegister.map((r: any) => Object.fromEntries(['id', 'round', ...registerFields].map(k => [k, r[k] ?? ''])));
    this.db.prepare('INSERT INTO pcf_index (project_id,drawing_id,document_id,rev,file_path,total_comments,open_comments,current_round,approval,rounds_json,updated_at,updated_by_client,updated_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,drawing_id) DO UPDATE SET document_id=excluded.document_id,rev=excluded.rev,file_path=excluded.file_path,total_comments=excluded.total_comments,open_comments=excluded.open_comments,current_round=excluded.current_round,approval=excluded.approval,rounds_json=excluded.rounds_json,updated_at=excluded.updated_at,updated_by_client=excluded.updated_by_client,updated_by_name=excluded.updated_by_name')
      .run(p, d, data.documentId, data.hub.rev, path.relative(this.dataDir, this.file(p, d)).split(path.sep).join('/'), total, open, n, String(data.project.approval), JSON.stringify(rounds), data.updatedAt, change.clientId, change.clientName);
    this.db.prepare('UPDATE drawings SET manual_comments_count=?,manual_open_comments_count=?,current_round=?,version=? WHERE project_id=? AND id=?').run(total, open, roundLabel(n), row?.revision || before.version || '', p, d);
    this.db.prepare('UPDATE projects SET last_updated=? WHERE id=?').run(data.updatedAt, p);
    const inserted = this.db.prepare('INSERT OR IGNORE INTO pcf_changes(project_id,drawing_id,rev,client_id,client_name,ip,ops_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(p, d, data.hub.rev, change.clientId, change.clientName, change.ip, JSON.stringify(change.ops), data.updatedAt);
    if (inserted.changes) this.db.prepare("INSERT INTO audit_log(table_name,row_id,project_id,action,detail,created_at) VALUES('drawings',?,?,'COMMENTS',?,?)").run(d, p, JSON.stringify({ customId: before.custom_id, drawingNo: before.drawing_no, from: { total: before.manual_comments_count, open: before.manual_open_comments_count }, to: { total, open }, source: 'PCF', rev: data.hub.rev, round: { from: before.current_round, to: roundLabel(n) }, version: row?.revision || before.version }), data.updatedAt);
  }
  private save(p: string, d: string, html: string, data: PcfData, actor: Actor, ops: unknown[]) {
    const file = this.file(p, d), old = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const oldRev = old ? parseHTML(old).hub.rev : 0;
    reconcile(data); data.hub.rev = oldRev + 1; data.updatedAt = new Date().toISOString();
    data.hub.lastChange = { ...actor, ops }; const next = replaceData(html, data);
    if (old) atomicWrite(path.join(this.historyDir(p, d), oldRev + '-' + Date.now() + '-' + randomUUID() + '.html'), old);
    // Synchronous section: Worker cannot interleave in an open SQLite transaction.
    let renamed = false;
    try { this.transaction(() => { this.indexWrite(p, d, data); atomicWrite(file, next); renamed = true; }); }
    catch (e) { if (renamed) { if (old) atomicWrite(file, old); else unlinkSync(file); } throw e; }
    return data.hub.rev;
  }
  publicData(data: PcfData) { const copy = structuredClone(data); delete copy.hub.receipts; return copy; }
  ops(p: string, d: string, body: any, actor: Actor) { return this.opsBatch(p, d, body, actor).result; }
  opsBatch(p: string, d: string, body: any, actor: Actor) {
    if (!Number.isSafeInteger(body.baseRev) || body.baseRev < 1 || !Array.isArray(body.ops) || body.ops.length > 10000) fail('Invalid ops request');
    if (body.batchId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.batchId)) fail('batchId must be UUID');
    const { html, data, rev } = this.load(p, d);
    const hash = createHash('sha256').update(JSON.stringify({ clientId: actor.clientId, baseRev: body.baseRev, ops: body.ops })).digest('hex');
    const receipts = (data.hub.receipts || []).filter((r: any) => Date.now() - r.at < 86400000);
    const prior = body.batchId && receipts.find((r: any) => r.id === body.batchId);
    if (prior) {
      if (prior.hash !== hash) fail('batchId reused with different request', 409);
      const historical = prior.result.rev === rev ? data : parseHTML(readFileSync(path.join(this.historyDir(p, d), this.history(p, d).find(x => x.rev === prior.result.rev)!.filename), 'utf8'));
      return { replayed: true, result: { ...prior.result, data: this.publicData(historical) } };
    }
    if (body.baseRev > rev) fail('Future document revision', 409);
    const result = applyOps(data, body.ops as Op[], actor, rev + 1);
    if (body.batchId) data.hub.receipts = [...receipts, { id: body.batchId, hash, at: Date.now(), result: { rev: result.applied.length ? rev + 1 : rev, ...result } }].slice(-1000);
    const nextRev = result.applied.length ? this.save(p, d, html, data, actor, result.applied.map(({ entity: _e, entityRev: _r, ...summary }: any) => summary)) : rev;
    // Receipt-only acknowledgement stays in the authoritative HTML, never in SQLite body columns.
    if (!result.applied.length && body.batchId) atomicWrite(this.file(p, d), replaceData(html, data));
    return { replayed: false, result: { rev: nextRev, ...result, data: this.publicData(data) } };
  }
  replace(p: string, d: string, body: any, actor: Actor, historyRev?: number) {
    const latest = this.load(p, d); if (body.baseRev !== latest.rev) fail('Document revision conflict', 409);
    let html = body.html || latest.html, data = body.data;
    if (historyRev !== undefined) { const h = this.history(p, d).find(x => x.rev === historyRev); if (!h) fail('History not found', 404); html = readFileSync(path.join(this.historyDir(p, d), h.filename), 'utf8'); data = parseHTML(html); }
    else if (body.html) data = parseHTML(body.html);
    // Imported/migrated HTML must not retain a live page's capability.
    html = html.replace(/<script\b[^>]*\bid\s*=\s*(['"])pahub-context\1[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    if (!data) fail('Expected data or html');
    if (body.importJSON) { validateJSON(data); const { cleanupLegacyImport } = modelV26; cleanupLegacyImport(data); }
    data = initData(data);
    if (data.documentId !== latest.data.documentId) fail('documentId mismatch', 409);
    // Full replacement invalidates ALL editable entity clocks, including tombstones.
    data.hub = structuredClone(latest.data.hub);
    const keys = new Set(Object.keys(data.hub.entities));
    for (const field of Object.keys(data.project)) keys.add('project:' + field);
    for (const field of Object.keys(data.settings)) keys.add('settings:' + field);
    for (const row of data.roundRegister) keys.add('register:' + row.round);
    keys.add('history:circulation'); keys.add('history:approvalHistory');
    data.hub.tombstones ??= [];
    for (const c of latest.data.comments) {
      const live = data.comments.find((x: any) => x.id === c.id);
      for (const record of [c, ...c.rounds]) if (record === c ? !live : !live?.rounds.some((r: any) => r.id === record.id)) data.hub.tombstones.push({ id: record.id, type: record === c ? 'comment' : 'round', parentId: record === c ? null : c.id, clock: latest.rev + 1, at: new Date().toISOString() });
    }
    for (const t of data.deleted) keys.add('deleted:' + t.id);
    for (const c of data.comments) {
      for (const field of ['status', 'meta', 'record']) keys.add('comment:' + c.id + ':' + field);
      c.rev = c.statusRev = c.metaRev = latest.rev + 1;
      for (const r of c.rounds) { for (const field of ['owner', 'reply', 'record', 'initiator', 'responder', 'minHeight']) keys.add('round:' + r.id + ':' + field); r.rev = r.ownerRev = r.replyRev = latest.rev + 1; }
    }
    for (const key of keys) data.hub.entities[key] = { rev: latest.rev + 1, clientId: actor.clientId, clientName: actor.clientName, at: new Date().toISOString() };
    const rev = this.save(p, d, html, data, actor, [{ type: historyRev === undefined ? 'document.replace' : 'history.restore' }]); return { rev, data: this.publicData(data) };
  }
  history(p: string, d: string) {
    this.load(p, d); const dir = this.historyDir(p, d); if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap(filename => { const m = filename.match(/^(\d+)-(\d+)-[a-f0-9-]+\.html$/); return m ? [{ rev: Number(m[1]), savedAt: new Date(Number(m[2])).toISOString(), filename }] : []; }).sort((a, b) => b.rev - a.rev);
  }
}
