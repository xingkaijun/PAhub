import { readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { currentTemplate } from './pcf-template.ts';
import { parseHTML } from './pcf-html.ts';
import { atomicWrite } from './atomic-write.ts';
export { parseHTML, replaceData, scriptJSON } from './pcf-html.ts';
export { atomicWrite } from './atomic-write.ts';
import { historyEntries, prepareHistory } from './pcf-history.ts';
import { PcfImageStore, mayHaveInlineImages } from './pcf-images.ts';
import * as modelV26 from './pcf-v26.ts';
import { validateJSON } from './pcf-schema.ts';
import { initData, reconcile, roundNumber, roundLabel, registerFields, fail, type PcfData, type Actor, type Op, applyOps } from './pcf-model.ts';

export class PcfStorage {
  private queues = new Map<string, Promise<unknown>>();
  readonly images: PcfImageStore;
  constructor(readonly db: DatabaseSync, readonly dataDir: string, private readonly now: () => number = Date.now) { this.images = new PcfImageStore(dataDir); }
  file(p: string, d: string) { return path.join(this.dataDir, 'pcf', p, d + '.json'); }
  historyDir(p: string, d: string) { return path.join(this.dataDir, 'pcf', p, '.history', d); }
  async serial<T>(p: string, d: string, task: () => T | Promise<T>): Promise<T> {
    const key = p + '/' + d, previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task); this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  // Holds the per-drawing locks of every id (sorted, so two batches cannot deadlock) while task runs.
  async serialMany<T>(p: string, ids: string[], task: () => T | Promise<T>): Promise<T> {
    const keys = [...new Set(ids)].sort();
    const run = (i: number): Promise<T> => i >= keys.length ? Promise.resolve().then(task) : this.serial(p, keys[i], () => run(i + 1));
    return run(0);
  }
  private drawing(p: string, d: string) {
    const row = this.db.prepare('SELECT d.*, p.name AS project_name FROM drawings d JOIN projects p ON p.id=d.project_id WHERE d.project_id=? AND d.id=? AND COALESCE(d._deleted,0)=0').get(p, d);
    if (!row) fail('Drawing not found', 404); return row;
  }
  meta(p: string, d: string) { this.load(p, d); return this.db.prepare('SELECT * FROM pcf_index WHERE project_id=? AND drawing_id=?').get(p, d)!; }
  index(p: string) {
    // Also repair a crash between file rename and SQLite commit on project listing.
    const dir = path.join(this.dataDir, 'pcf', p);
    if (existsSync(dir)) for (const name of readdirSync(dir)) if (/^[A-Za-z0-9_-]+\.json$/.test(name)) {
      const id = name.slice(0, -5); if (this.db.prepare('SELECT 1 FROM drawings WHERE project_id=? AND id=? AND COALESCE(_deleted,0)=0').get(p, id)) this.load(p, id);
    }
    return this.db.prepare("SELECT * FROM pcf_index WHERE project_id=? ORDER BY drawing_id").all(p);
  }
  load(p: string, d: string) {
    this.drawing(p, d); const file = this.file(p, d);
    if (!existsSync(file)) fail('PCF not found', 404);
    const text = readFileSync(file, 'utf8'), data: PcfData = JSON.parse(text), rev = Number(data.hub?.rev);
    if (!Number.isSafeInteger(rev) || rev < 1) fail('Invalid stored PCF revision', 500);
    // Legacy inline images (before hub:migrate-pcf-images) are served as references; the next save persists them.
    if (mayHaveInlineImages(text)) this.images.externalize(p, data);
    const meta = this.db.prepare('SELECT rev FROM pcf_index WHERE project_id=? AND drawing_id=?').get(p, d);
    if (meta?.rev !== rev) {
      if (meta && Number(meta.rev) > rev) fail('PCF file/index revision mismatch; restore backup', 500);
      this.transaction(() => this.indexWrite(p, d, data));
    }
    return { data, rev };
  }
  /** load() with every image reference re-inlined as a data URL, for self-contained offline copies. */
  loadHydrated(p: string, d: string) { const { data, rev } = this.load(p, d); return { data: this.images.hydrate(p, data), rev }; }
  create(p: string, d: string, actor: Actor) {
    if (existsSync(this.file(p, d))) return this.meta(p, d);
    if (existsSync(path.join(this.dataDir, 'pcf', p, d + '.html'))) fail('Legacy HTML storage: stop Hub and run hub:migrate-pcf-json', 503);
    const drawing = this.drawing(p, d), html = currentTemplate();
    const data = parseHTML(html), n = roundNumber(drawing.current_round);
    Object.assign(data, { documentId: randomUUID(), comments: [], deleted: [], circulation: [], approvalHistory: [], roundRegister: [], hub: { rev: 0, entities: {} } });
    data.project = { name: drawing.project_name, planNo: drawing.drawing_no, planTitle: drawing.title, revision: drawing.version || '', folder: '', currentRound: n, approval: drawing.status === 'Approved' ? 'Approved' : drawing.status === 'Pending' ? 'Not submitted' : 'Under review' };
    delete data.approvalControl; initData(data);
    this.save(p, d, data, actor, [{ type: 'document.create' }]); return this.meta(p, d);
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
  private save(p: string, d: string, data: PcfData, actor: Actor, ops: unknown[], commit?: () => void) {
    const file = this.file(p, d), old = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const oldRev = old ? JSON.parse(old).hub.rev : 0;
    // Images are stored once by content hash; the PCF JSON and its history keep references only.
    this.images.externalize(p, data, { verify: true }); this.images.externalize(p, ops);
    let snapshot = old;
    if (old && mayHaveInlineImages(old)) { const legacy = JSON.parse(old); this.images.externalize(p, legacy); snapshot = JSON.stringify(legacy); }
    const at = this.now();
    reconcile(data); data.hub.rev = oldRev + 1; data.updatedAt = new Date(at).toISOString();
    data.hub.lastChange = { ...actor, ops }; const next = JSON.stringify(data);
    const history = old ? prepareHistory(this.historyDir(p, d), oldRev, snapshot!, actor.clientId, at, atomicWrite) : undefined;
    // Synchronous section: Worker cannot interleave in an open SQLite transaction.
    let renamed = false;
    try { this.transaction(() => { this.indexWrite(p, d, data); commit?.(); atomicWrite(file, next); renamed = true; }); }
    catch (e) { if (renamed) { if (old) atomicWrite(file, old); else unlinkSync(file); } history?.rollback(); throw e; }
    // Retention is maintenance after a successful write; never reject an already committed save.
    try { history?.commit(data.hub.rev); } catch (error) { console.warn('PCF history retention deferred', error); }
    return data.hub.rev;
  }
  // Status transitions use the same document transaction, clocks and history as PCF edits.
  transitionRound(p: string, d: string, round: number, actor: Actor, commit: () => void) {
    const { data, rev } = this.load(p, d);
    const result = applyOps(data, [{ type: 'project.set', field: 'currentRound', value: round, baseRev: data.hub.entities['project:currentRound']?.rev || 0 }], actor, rev + 1);
    if (result.conflicts.length) fail('PCF round transition conflict', 409);
    const nextRev = this.save(p, d, data, actor, result.applied, commit);
    return { rev: nextRev, ...result, data: this.publicData(data) };
  }
  publicData(data: PcfData) { const copy = structuredClone(data); delete copy.hub.receipts; return copy; }
  ops(p: string, d: string, body: any, actor: Actor) { return this.opsBatch(p, d, body, actor).result; }
  opsBatch(p: string, d: string, body: any, actor: Actor) {
    if (!Number.isSafeInteger(body.baseRev) || body.baseRev < 1 || !Array.isArray(body.ops) || body.ops.length > 10000) fail('Invalid ops request');
    if (body.batchId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.batchId)) fail('batchId must be UUID');
    const { data, rev } = this.load(p, d);
    const hash = createHash('sha256').update(JSON.stringify({ clientId: actor.clientId, baseRev: body.baseRev, ops: body.ops })).digest('hex');
    const receipts = (data.hub.receipts || []).filter((r: any) => Date.now() - r.at < 86400000);
    const prior = body.batchId && receipts.find((r: any) => r.id === body.batchId);
    if (prior) {
      if (prior.hash !== hash) fail('batchId reused with different request', 409);
      const historical = prior.result.rev === rev ? data : this.historyData(p, d, prior.result.rev)?.data;
      if (!historical) fail('Replay revision no longer retained; reload current document', 409);
      return { replayed: true, result: { ...prior.result, data: this.publicData(historical) } };
    }
    if (body.baseRev > rev) fail('Future document revision', 409);
    const result = applyOps(data, body.ops as Op[], actor, rev + 1);
    if (body.batchId) data.hub.receipts = [...receipts, { id: body.batchId, hash, at: Date.now(), result: { rev: result.applied.length ? rev + 1 : rev, ...result } }].slice(-1000);
    const nextRev = result.applied.length ? this.save(p, d, data, actor, result.applied.map(({ entity: _e, entityRev: _r, ...summary }: any) => summary)) : rev;
    // Receipt-only acknowledgement stays in the authoritative JSON, never in SQLite body columns.
    if (!result.applied.length && body.batchId) atomicWrite(this.file(p, d), JSON.stringify(data));
    return { replayed: false, result: { rev: nextRev, ...result, data: this.publicData(data) } };
  }
  replacementReplay(p: string, d: string, id: string, hash: string) {
    const { data, rev } = this.load(p, d);
    const prior = (data.hub.receipts || []).find((r: any) => r.id === id && Date.now() - r.at < 86400000);
    if (!prior) return undefined;
    if (prior.hash !== hash || prior.kind !== 'complete-import') fail('batchId reused with different request', 409);
    const historical = prior.result.rev === rev ? data : this.historyData(p, d, prior.result.rev)?.data;
    if (!historical) fail('Replay revision no longer retained; reload current document', 409);
    return { ...prior.result, data: this.publicData(historical) };
  }
  replace(p: string, d: string, body: any, actor: Actor, historyRev?: number, receipt?: { id: string; hash: string }, commit?: () => void) {
    const latest = this.load(p, d); if (body.baseRev !== latest.rev) fail('Document revision conflict', 409);
    let data = body.data;
    if (historyRev !== undefined) { const restored = this.historyData(p, d, historyRev); if (!restored) fail('History not found', 404); data = restored.data; }
    else if (body.html) data = parseHTML(body.html);
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
    const result = { rev: latest.rev + 1, applied: [{ type: 'document.merge' }], conflicts: [], assigned: {} };
    if (receipt) data.hub.receipts = [...(data.hub.receipts || []).filter((r: any) => Date.now() - r.at < 86400000), { ...receipt, kind: 'complete-import', at: Date.now(), result }].slice(-1000);
    const rev = this.save(p, d, data, actor, [{ type: receipt ? 'document.merge' : historyRev === undefined ? 'document.replace' : 'history.restore' }], commit);
    return receipt ? { ...result, rev, data: this.publicData(data) } : { rev, data: this.publicData(data) };
  }
  private historyData(p: string, d: string, rev: number): { data: PcfData } | undefined {
    const entry = historyEntries(this.historyDir(p, d)).find(item => item.rev === rev);
    if (!entry) return undefined;
    try {
      const text = readFileSync(path.join(this.historyDir(p, d), entry.filename), 'utf8'), data = JSON.parse(text);
      if (mayHaveInlineImages(text)) this.images.externalize(p, data);
      return { data };
    }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  history(p: string, d: string) {
    this.load(p, d); return historyEntries(this.historyDir(p, d));
  }
}
