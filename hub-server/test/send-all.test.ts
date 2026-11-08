import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/app.ts';
import { ROOT_DIR, SQL_DIR } from '../src/config.ts';
import { parseHTML } from '../src/pcf-storage.ts';
import { crc32 } from '../src/zip.ts';
import { openDatabase } from '../src/database.ts';
import { importData } from '../src/importer.ts';
import { normalizeLegacySql } from '../src/import-legacy.ts';
import { HubApiRepository } from '../../services/data/HubApiRepository';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { MessageChannel } from 'node:worker_threads';
import type { AppSettings, Project } from '../../types';

function unzip(buffer: Buffer) {
  const result = new Map<string, Buffer>(); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.ok(buffer.readUInt16LE(offset + 6) & 0x0800, 'UTF-8 flag bit 11');
    assert.equal(buffer.readUInt16LE(offset + 8), 8);
    const size = buffer.readUInt32LE(offset + 18), nameSize = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8'), start = offset + 30 + nameSize + extra;
    const data = inflateRawSync(buffer.subarray(start, start + size));
    assert.equal(crc32(data), buffer.readUInt32LE(offset + 14));
    assert.equal(data.length, buffer.readUInt32LE(offset + 22));
    result.set(name, data); offset = start + size;
  }
  let count = 0;
  while (buffer.readUInt32LE(offset) === 0x02014b50) {
    assert.ok(buffer.readUInt16LE(offset + 8) & 0x0800);
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32); count++;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x06054b50); assert.equal(count, result.size);
  return result;
}
function csv(text: string) {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (c === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  const header = rows.shift()!;
  return rows.map(values => Object.fromEntries(header.map((key, i) => [key, values[i]])));
}

test('ZIP CRC32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('Send All uses tracker APR only: PCF Approved without APR becomes Waiting Reply', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  // Browser-bundled React act() uses Node's MessageChannel fallback. Unlike
  // jsdom timers, these ports are not owned or closed by window.close().
  const channels: MessageChannel[] = [];
  const globals = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    MessageChannel: class extends MessageChannel {
      constructor() { super(); channels.push(this); }
    },
  };
  const descriptors = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalFetch = globalThis.fetch, originalAlert = Object.getOwnPropertyDescriptor(globalThis, 'alert');
  let root: any, reactAct: any;
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const result = await build({
      stdin: { contents: "export { ReviewTracker } from './components/ReviewTracker'; export { useStore } from './store'; export { act, createElement } from 'react'; export { createRoot } from 'react-dom/client';", resolveDir: ROOT_DIR, loader: 'tsx' },
      bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'import.meta.env': '{}' },
    });
    const { ReviewTracker, useStore, act, createElement, createRoot } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
    reactAct = act;
    let confirmation = '', indexCalls = 0, packed = false, saved = false;
    dom.window.confirm = (message?: string) => { confirmation = message || ''; return true; };
    Object.defineProperty(globalThis, 'alert', { value: (message: string) => assert.fail(message), configurable: true });
    globalThis.fetch = async (input: any) => {
      if (String(input).endsWith('/index')) {
        indexCalls++;
        return Response.json([{ drawing_id: 'with-apr', approval: 'Rejected' }, { drawing_id: 'without-apr', approval: 'Approved' }]);
      }
      assert.ok(saved, 'ZIP requested only after saving');
      packed = true;
      return new Response(new Blob(['zip']), { headers: { 'Content-Disposition': 'attachment; filename="test.zip"' } });
    };
    dom.window.HTMLAnchorElement.prototype.click = () => {};
    useStore.setState({
      activeProjectId: 'manual-only', isEditMode: true,
      data: { ...useStore.getState().data, projects: [{ id: 'manual-only', name: 'Manual APR', conf: {}, drawings: ['with-apr', 'without-apr'].map(id => ({ id, customId: id, title: id, status: 'Reviewing', assignees: ['Engineer'], statusHistory: [], remarks: [] })) }] },
      reviewTracker: { 'with-apr': { Engineer: { done: true }, __approved__: { done: true } }, 'without-apr': { Engineer: { done: true } } },
      loadReviewTracker: async () => {}, saveProject: async () => { saved = true; return true; },
      verifySentDrawings: async (_: string, expected: any[]) => {
        assert.deepEqual(expected.map(row => row.status), ['Approved', 'Waiting Reply']);
        return { ok: true, mismatchedDrawings: [], mismatchedTracker: [] };
      },
    });
    root = createRoot(dom.window.document.getElementById('root'));
    await act(async () => root.render(createElement(ReviewTracker)));
    assert.equal(Array.from(dom.window.document.querySelectorAll('button')).some(button => button.textContent?.includes('Import Builder Replies')), false);
    const send = Array.from(dom.window.document.querySelectorAll('button')).find(button => button.textContent?.includes('Send All'))!;
    assert.ok(send);
    await act(async () => { send.click(); });
    assert.equal(indexCalls, 1);
    assert.match(confirmation, /1 张 → Approved/);
    assert.match(confirmation, /1 张 → Waiting Reply/);
    assert.match(confirmation, /2 张图纸/);
    assert.equal(packed, true);
    assert.ok(Array.from(dom.window.document.querySelectorAll('button')).some(button => button.textContent?.includes('Download Again')));
    const state = useStore.getState();
    assert.deepEqual(state.data.projects[0].drawings.map((drawing: any) => drawing.status), ['Approved', 'Waiting Reply']);
    assert.deepEqual(state.reviewTracker, { 'with-apr': { Engineer: { done: false }, __approved__: { done: false } }, 'without-apr': { Engineer: { done: false } } });
    assert.equal('approval' in state, false);
  } finally {
    try {
      if (root) await reactAct(async () => root.unmount());
    } finally {
      for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    }
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of Object.entries({ ...descriptors, alert: originalAlert })) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test('Send All authenticated batch ZIP, latest rev, skipped/collision manifest, idempotency, project validation and atomic rollback', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-send-all-'));
  const keys = ['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: 'send-all-token', ADMIN_PASSWORD: 'send-all-admin' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    hub = await createHub(); const db = hub.db.sqlite;
    db.exec(await readFile(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
    const p = 'proj-test-001', origin = 'http://127.0.0.1:' + hub.port;
    const api = async (route: string, body?: any, auth = true) => fetch(origin + '/api/pcf/' + p + '/' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer send-all-token' } : {}) }, body: body ? JSON.stringify({ clientId: 'send-all-test', clientName: 'Reviewer', ...body }) : undefined });
    const json = async (route: string, body?: any) => { const r = await api(route, body); assert.equal(r.status, 200, await r.clone().text()); return r.json() as Promise<any>; };
    db.prepare('UPDATE drawings SET custom_id=?,drawing_no=?,title=? WHERE id IN (?,?)').run('ID-01', '中文/主图', 'Title, "quoted"', 'dwg-001', 'dwg-002');
    await json('dwg-001/create', {}); await json('dwg-002/create', {});
    for (const [id, approval] of [['dwg-001', 'Approved'], ['dwg-002', 'Under review']]) {
      const live = await json(id + '/data');
      await json(id + '/ops', { baseRev: live.rev, batchId: randomUUID(), ops: [{ type: 'project.set', field: 'approval', baseRev: 0, value: approval }, ...(id === 'dwg-002' ? [{ type: 'comment.add', id: 'open-comment', roundIdNew: 'open-round' }] : [])] });
    }
    const repository = new HubApiRepository(origin + '/api', 'send-all-token'), settings = {} as AppSettings;
    let project = await repository.loadProject(settings, { id: p } as Project);
    const manual = { 'dwg-001': { engineer_a: { done: true }, __approved__: { done: true } }, 'dwg-002': { engineer_b: { done: true } } };
    assert.equal((await repository.saveReviewTracker(settings, project, manual)).success, true);
    const tracker = await repository.loadReviewTracker(settings, project);
    const cleared = Object.fromEntries(Object.entries(tracker).map(([id, entries]) => [id,
      Object.fromEntries(Object.keys(entries).map(key => [key, { done: false }]))]));
    // Send All clears via the project save, not the single-check merge endpoint.
    project.drawings = project.drawings.map(d => d.id === 'dwg-001' || d.id === 'dwg-002' ? { ...d, status: tracker[d.id]?.__approved__?.done ? 'Approved' : 'Waiting Reply' } : d);
    assert.equal((await repository.saveProject(settings, project, cleared)).success, true);
    const savedTracker = await repository.loadReviewTracker(settings, project);
    assert.equal(Boolean(savedTracker['dwg-001'].__approved__.done), false);
    assert.equal(Boolean(savedTracker['dwg-001'].engineer_a.done), false);
    assert.equal(Boolean(savedTracker['dwg-002'].engineer_b.done), false);
    project = await repository.loadProject(settings, project);
    assert.equal(project.drawings.find(d => d.id === 'dwg-001')!.status, 'Approved');
    assert.equal(project.drawings.find(d => d.id === 'dwg-002')!.status, 'Waiting Reply');
    // Exporting must use the latest server document after Send All status updates.
    const latest = await json('dwg-002/data');
    const changed = await json('dwg-002/ops', { baseRev: latest.rev, batchId: randomUUID(), ops: [{ type: 'project.set', field: 'revision', baseRev: 0, value: 'Latest' }] });
    const drawingIds = ['dwg-001','dwg-002','dwg-003'], batchId = randomUUID();
    assert.equal((await api('exports/batch', { drawingIds, batchId }, false)).status, 401);
    db.exec("INSERT INTO projects(id,name) VALUES('other-project','Other'); INSERT INTO drawings(id,project_id,drawing_no,title,status) VALUES('foreign-drawing','other-project','Other','Other','Reviewing')");
    assert.equal((await api('exports/batch', { drawingIds: ['dwg-001','foreign-drawing'], batchId: randomUUID() })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pcf_exports').get()!.n, 0);
    const response = await api('exports/batch', { drawingIds, batchId }); assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Disposition')!, /PG-VLEC-H2684_SendAll_\d{8}-\d{4}\.zip/);
    const entries = unzip(Buffer.from(await response.arrayBuffer())); assert.equal(entries.size, 3);
    const names = [...entries.keys()].filter(x => x.endsWith('.html'));
    assert.equal(names[0], 'ID-01-中文-主图-Title, -quoted--A-A.html'); assert.equal(names[1], 'ID-01-中文-主图-Title, -quoted--A-A_2.html');
    const bytes = entries.get('manifest.csv')!; assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.toString('utf8').split('\r\n')[0].slice(1), 'drawingNo,title,round,approval,total,open,baseRev,exportId,file,status,reason');
    const manifest = csv(bytes.toString('utf8').slice(1));
    assert.equal(manifest[2].status, 'skipped'); assert.equal(manifest[2].reason, 'no PCF'); assert.equal(manifest[2].exportId, '');
    assert.equal(manifest[0].title, 'Title, "quoted"'); assert.equal(Number(manifest[1].baseRev), changed.rev);
    for (let i = 0; i < names.length; i++) {
      const html = entries.get(names[i])!.toString('utf8'), data = parseHTML(html);
      assert.equal(data.export.baseRev, Number(manifest[i].baseRev)); assert.equal(data.export.exportId, manifest[i].exportId);
      const preview = await json(drawingIds[i] + '/imports', { step: 'preview', html });
      assert.equal(preview.exportId, manifest[i].exportId); assert.equal(preview.ownerTampered, false);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pcf_exports').get()!.n, 2);
    assert.equal((await api('exports/batch', { drawingIds: ['dwg-001'], batchId })).status, 409);
    await hub.close(); hub = await createHub();
    const retry = await fetch('http://127.0.0.1:' + hub.port + '/api/pcf/' + p + '/exports/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer send-all-token' }, body: JSON.stringify({ drawingIds, batchId }) });
    assert.equal(retry.status, 200);
    const retryRows = csv(unzip(Buffer.from(await retry.arrayBuffer())).get('manifest.csv')!.toString('utf8').slice(1));
    assert.deepEqual(retryRows.map(row => row.exportId), manifest.map(row => row.exportId));
    assert.equal(hub.db.sqlite.prepare('SELECT COUNT(*) AS n FROM pcf_exports').get()!.n, 2);
    const baselines = await Promise.all(['dwg-001','dwg-002'].map(id => readdir(path.join(temp,'pcf',p,id,'exports'))));
    hub.db.sqlite.exec("CREATE TRIGGER fail_second_export BEFORE INSERT ON pcf_exports WHEN NEW.drawing_id='dwg-002' BEGIN SELECT RAISE(ABORT,'test batch failure'); END");
    const failed = await fetch('http://127.0.0.1:' + hub.port + '/api/pcf/' + p + '/exports/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer send-all-token' }, body: JSON.stringify({ drawingIds, batchId: randomUUID() }) });
    assert.equal(failed.status, 500); assert.equal(hub.db.sqlite.prepare('SELECT COUNT(*) AS n FROM pcf_exports').get()!.n, 2);
    assert.equal(hub.db.sqlite.prepare('SELECT COUNT(*) AS n FROM pcf_export_batches').get()!.n, 1);
    assert.deepEqual(await Promise.all(['dwg-001','dwg-002'].map(id => readdir(path.join(temp,'pcf',p,id,'exports')))), baselines);
  } finally {
    if (hub) await hub.close(); for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await rm(temp, { recursive: true, force: true });
  }
});

test('import-d1 and existing databases preserve legacy paths and APR without adding tracker columns', async () => {
  assert.equal(normalizeLegacySql("INSERT INTO projects(webdav_path) VALUES('webdav_path'); -- webdav_path"), "INSERT INTO projects(storage_path) VALUES('webdav_path'); -- webdav_path");
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-send-all-legacy-'));
  try {
    const schema = (await readFile(path.join(SQL_DIR,'init-local.sql'),'utf8')).split('-- ========== 兼容视图（Worker API 读取用） ==========')[0].replaceAll('storage_path','webdav_path');
    const seed = (await readFile(path.join(ROOT_DIR,'worker/sql/seed-test-data.sql'),'utf8')).replaceAll('storage_path','webdav_path');
    const legacy = schema + '\n' + seed + "\nINSERT INTO review_tracker(project_id,drawing_id,raw_drawing_ref,reviewer_id,done) VALUES('proj-test-001','dwg-001','dwg-001','__approved__',0);";
    const existingFile = path.join(temp,'existing.db'), sqlite = new DatabaseSync(existingFile); sqlite.exec(legacy); sqlite.close();
    const upgraded = openDatabase(existingFile);
    try { assert.equal(upgraded.sqlite.prepare('PRAGMA table_info(review_tracker)').all().some(row => row.name === 'source'), false); assert.equal(upgraded.sqlite.prepare("SELECT done FROM review_tracker WHERE reviewer_id='__approved__'").get()!.done, 0); } finally { upgraded.sqlite.close(); }
    const sqlFile = path.join(temp,'old-d1.sql'); await writeFile(sqlFile,legacy);
    assert.equal((await importData(sqlFile,path.join(temp,'imported.db'))).drawings,6);
    const imported = openDatabase(path.join(temp,'imported.db'));
    try { assert.equal(imported.sqlite.prepare('PRAGMA table_info(review_tracker)').all().some(row => row.name === 'source'), false); assert.equal(imported.sqlite.prepare("SELECT done FROM review_tracker WHERE reviewer_id='__approved__'").get()!.done,0); } finally { imported.sqlite.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('existing tracker source columns are ignored by reads, writes and verification', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-tracker-extra-column-'));
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    hub = await createHub();
    hub.db.sqlite.exec(await readFile(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
    hub.db.sqlite.exec("ALTER TABLE review_tracker ADD COLUMN source TEXT; UPDATE review_tracker SET source='ignored'; CREATE TRIGGER reject_source_update BEFORE UPDATE OF source ON review_tracker BEGIN SELECT RAISE(ABORT,'source must be ignored'); END;");
    await hub.close(); hub = await createHub();
    const repository = new HubApiRepository('http://127.0.0.1:' + hub.port + '/api'), settings = {} as AppSettings;
    const project = await repository.loadProject(settings, { id: 'proj-test-001' } as Project);
    let tracker = await repository.loadReviewTracker(settings, project);
    assert.equal('source' in tracker['dwg-001'].engineer_a, false);
    tracker['dwg-001'].engineer_a = { done: false };
    assert.equal((await repository.saveReviewTracker(settings, project, tracker)).success, true);
    assert.equal((await repository.saveProject(settings, project, tracker)).success, true);
    tracker = await repository.loadReviewTracker(settings, project);
    assert.equal(Boolean(tracker['dwg-001'].engineer_a.done), false); assert.equal(tracker['dwg-001'].engineer_a.doneAt ?? null, null);
    assert.ok(hub.db.sqlite.prepare('PRAGMA table_info(review_tracker)').all().some(row => row.name === 'source'));
  } finally {
    if (hub) await hub.close();
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await rm(temp, { recursive: true, force: true });
  }
});
