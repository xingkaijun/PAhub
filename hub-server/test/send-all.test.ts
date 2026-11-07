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
import { effectiveAprDone, isManualApr, clearedTracker, sentStatus, normalizePcfIndex, pcfApprovalTone, pcfApprovalVisible } from '../../lib/pcf';
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

test('APR effective value, legacy manual precedence, Send All statuses and next-round cleanup', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(effectiveAprDone(undefined, 'Approved'), true);
  assert.equal(effectiveAprDone(undefined, 'Approved with comments'), true);
  assert.equal(effectiveAprDone({ done: false, source: 'manual' }, 'Approved'), false);
  assert.equal(effectiveAprDone({ done: false }, 'Approved'), false);
  assert.equal(effectiveAprDone({ done: true }, 'Rejected'), true);
  assert.equal(isManualApr({ done: false }), true);
  assert.equal(isManualApr({ done: false, source: null } as any), true);
  assert.equal(effectiveAprDone(undefined, 'Rejected'), false);
  assert.equal(effectiveAprDone(undefined, undefined), false);
  assert.equal(sentStatus(undefined, 'Approved'), 'Approved');
  assert.equal(sentStatus({ done: false, source: 'manual' }, 'Approved'), 'Waiting Reply');
  assert.equal(sentStatus(undefined, 'Under review'), 'Waiting Reply');
  const cleared = clearedTracker({ Engineer: { done: true }, __approved__: { done: true, source: 'pcf' } });
  assert.deepEqual(cleared, { Engineer: { done: false } });
  assert.equal(effectiveAprDone(Object.getOwnPropertyDescriptor(cleared, '__approved__')?.value, 'Approved'), true);
  assert.deepEqual(clearedTracker({ __approved__: { done: false, source: 'manual' } }), {});
  assert.match(pcfApprovalTone('Approved with comments'), /cyan/);
  assert.equal(pcfApprovalVisible(undefined), false);
  assert.equal(pcfApprovalVisible('Not submitted'), false);
  assert.equal(pcfApprovalVisible('Approved'), true);
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
    db.prepare('UPDATE drawings SET drawing_no=?,title=? WHERE id IN (?,?)').run('中文/主图', 'Title, "quoted"', 'dwg-001', 'dwg-002');
    await json('dwg-001/create', {}); await json('dwg-002/create', {});
    for (const [id, approval] of [['dwg-001', 'Approved'], ['dwg-002', 'Under review']]) {
      const live = await json(id + '/data');
      await json(id + '/ops', { baseRev: live.rev, batchId: randomUUID(), ops: [{ type: 'project.set', field: 'approval', baseRev: 0, value: approval }, ...(id === 'dwg-002' ? [{ type: 'comment.add', id: 'open-comment', roundIdNew: 'open-round' }] : [])] });
    }
    const index = normalizePcfIndex(await json('index'));
    assert.equal(effectiveAprDone(undefined, index['dwg-001'].approval), true);
    const repository = new HubApiRepository(origin + '/api', 'send-all-token'), settings = {} as AppSettings;
    let project = await repository.loadProject(settings, { id: p } as Project);
    const manual = { 'dwg-001': { __approved__: { done: false, source: 'manual' as const } } };
    assert.equal((await repository.saveReviewTracker(settings, project, manual)).success, true);
    const tracker = await repository.loadReviewTracker(settings, project);
    assert.equal(sentStatus(tracker['dwg-001'].__approved__, index['dwg-001'].approval), 'Waiting Reply');
    assert.equal((await repository.loadReviewTracker(settings, project))['dwg-001'].__approved__.source, 'manual');
    const cleared = { 'dwg-001': clearedTracker(tracker['dwg-001']) };
    // Send All clears via the project save, not the single-check merge endpoint.
    project.drawings = project.drawings.map(d => d.id === 'dwg-001' || d.id === 'dwg-002' ? { ...d, status: sentStatus(undefined, index[d.id].approval) } : d);
    assert.equal((await repository.saveProject(settings, project, cleared)).success, true);
    assert.equal((await repository.loadReviewTracker(settings, project))['dwg-001']?.__approved__, undefined);
    project = await repository.loadProject(settings, project);
    assert.equal(project.drawings.find(d => d.id === 'dwg-001')!.status, 'Approved');
    assert.equal(project.drawings.find(d => d.id === 'dwg-002')!.status, 'Waiting Reply');
    // Edit after cached index: exporting must use the latest server document, not the cache.
    const latest = await json('dwg-002/data');
    const changed = await json('dwg-002/ops', { baseRev: latest.rev, batchId: randomUUID(), ops: [{ type: 'project.set', field: 'revision', baseRev: 0, value: 'Latest' }] });
    const drawingIds = ['dwg-001','dwg-002','dwg-003'], batchId = randomUUID();
    assert.equal((await api('exports/batch', { drawingIds, batchId }, false)).status, 401);
    db.exec("INSERT INTO projects(id,name) VALUES('other-project','Other'); INSERT INTO drawings(id,project_id,drawing_no,title,status) VALUES('foreign-drawing','other-project','Other','Other','Reviewing')");
    assert.equal((await api('exports/batch', { drawingIds: ['dwg-001','foreign-drawing'], batchId: randomUUID() })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pcf_exports').get()!.n, 0);
    const response = await api('exports/batch', { drawingIds, batchId }); assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Disposition')!, /filename\*=UTF-8''/);
    const entries = unzip(Buffer.from(await response.arrayBuffer())); assert.equal(entries.size, 3);
    const names = [...entries.keys()].filter(x => x.endsWith('.html'));
    assert.match(names[0], /^中文-主图_R01_PCF_\d{8}\.html$/); assert.match(names[1], /_2\.html$/);
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

test('import-d1 and existing databases without source upgrade automatically; legacy paths/manual APR survive', async () => {
  assert.equal(normalizeLegacySql("INSERT INTO projects(webdav_path) VALUES('webdav_path'); -- webdav_path"), "INSERT INTO projects(storage_path) VALUES('webdav_path'); -- webdav_path");
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-send-all-legacy-'));
  try {
    const schema = (await readFile(path.join(SQL_DIR,'init-local.sql'),'utf8')).split('-- ========== 兼容视图（Worker API 读取用） ==========')[0].replace('  source TEXT,\n','').replaceAll('storage_path','webdav_path');
    const seed = (await readFile(path.join(ROOT_DIR,'worker/sql/seed-test-data.sql'),'utf8')).replaceAll('storage_path','webdav_path');
    const legacy = schema + '\n' + seed + "\nINSERT INTO review_tracker(project_id,drawing_id,raw_drawing_ref,reviewer_id,done) VALUES('proj-test-001','dwg-001','dwg-001','__approved__',0);";
    const existingFile = path.join(temp,'existing.db'), sqlite = new DatabaseSync(existingFile); sqlite.exec(legacy); sqlite.close();
    const upgraded = openDatabase(existingFile);
    try { assert.ok(upgraded.sqlite.prepare('PRAGMA table_info(review_tracker)').all().some(row => row.name === 'source')); assert.equal(upgraded.sqlite.prepare("SELECT source FROM review_tracker WHERE reviewer_id='__approved__'").get()!.source, null); } finally { upgraded.sqlite.close(); }
    const sqlFile = path.join(temp,'old-d1.sql'); await writeFile(sqlFile,legacy);
    assert.equal((await importData(sqlFile,path.join(temp,'imported.db'))).drawings,6);
    const imported = openDatabase(path.join(temp,'imported.db'));
    try { assert.ok(imported.sqlite.prepare('PRAGMA table_info(review_tracker)').all().some(row => row.name === 'source')); assert.equal(imported.sqlite.prepare("SELECT done,source FROM review_tracker WHERE reviewer_id='__approved__'").get()!.done,0); } finally { imported.sqlite.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
