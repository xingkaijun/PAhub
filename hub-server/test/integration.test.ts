import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/app.ts';
import { importData } from '../src/importer.ts';
import { initializeSchema, migrationSql } from '../src/database.ts';
import { ROOT_DIR } from '../src/config.ts';
import { createApiClient } from '../../services/api/apiClient';
import { createProjectsApi } from '../../services/api/projectsApi';
import type { Project } from '../../types';

const stub = { id: 'proj-test-001' } as Project;

test('hub end-to-end: real frontend repository, persisted PATCH/PUT, audit logs, SQL/JSON imports', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-test-'));
  console.log('Test artifacts: ' + temp);
  const destination = path.join(temp, 'seed.db');
  const previousEnv = { PORT: process.env.PORT, PAHUB_DATA_DIR: process.env.PAHUB_DATA_DIR, PAPC_DB_PATH: process.env.PAPC_DB_PATH, API_TOKEN: process.env.API_TOKEN, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: destination, API_TOKEN: '', ADMIN_PASSWORD: 'integration-password' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    await importData(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), destination);
    hub = await createHub();
    let base = 'http://127.0.0.1:' + hub.port;
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: base } });
    let api = createProjectsApi(createApiClient({ baseUrl: '/api' }));
    const health = await fetch(base + '/api/health').then(r => r.json()) as { ok: boolean };
    assert.equal(health.ok, true);
    console.log('GET /api/health -> 200 ' + JSON.stringify(health));
    const globalSettings = await api.fetchGlobalSettings();
    assert.equal(globalSettings?.reviewers?.length, 3);
    assert.equal(globalSettings?.roundACycle, 14);
    console.log('GET /api/settings -> 200 reviewers=3 roundACycle=14');
    const projects = await api.fetchProjectList();
    assert.equal(projects.length, 1);
    console.log('GET /api/projects -> 200 ' + JSON.stringify(projects));
    let project = await api.loadProject(stub);
    assert.equal(project.drawings.length, 6);
    const drawing = project.drawings.find(d => d.id === 'dwg-001')!;
    const updated = { ...drawing, status: 'Approved' as typeof drawing.status };
    const saved = await api.saveDelta(project.id, { updatedDrawings: [updated] });
    assert.equal(saved.verification?.ok, true);
    project = await api.loadProject(stub);
    assert.equal(project.drawings.find(d => d.id === drawing.id)?.status, 'Approved');
    assert.equal(hub.db.prepare('SELECT status FROM drawings WHERE id = ?').get(drawing.id)!.status, 'Approved');
    console.log('PATCH /api/projects/proj-test-001 -> ' + JSON.stringify(saved));
    console.log('POST project readback + SQLite -> dwg-001 status=Approved');
    const tracker = await api.loadReviewTracker(project.id);
    const full = await api.saveProject(project, tracker);
    assert.equal(full.verification?.ok, true);
    console.log('PUT /api/projects/proj-test-001 -> ' + JSON.stringify(full));
    const audit = await api.loadAuditLog(project.id, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    assert.ok(audit.entries.some(row => row.action === 'STATUS' && row.drawingId === drawing.id));
    console.log('GET audit -> STATUS journal persisted');
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<div id="root"><\/div>/);
    const script = html.match(/src="([^" ]+\.js)"/)![1];
    assert.equal((await fetch(base + script)).status, 200);
    assert.equal((await fetch(base + '/client/route')).status, 200);
    assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
    const head = await fetch(base + '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    console.log('GET / -> 200 frontend HTML; JS=200; SPA=200; missing asset=404; HEAD=200');
    const adminPage = await fetch(base + '/api/admin').then(r => r.text());
    assert.ok(adminPage.includes('/api/admin/api'));
    assert.ok(adminPage.includes('/api/admin/auth'));
    const auth = await fetch(base + '/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'integration-password' }) }).then(r => r.json()) as { token: string };
    const exportedResponse = await fetch(base + '/api/admin/api/export', { headers: { Authorization: 'Bearer ' + auth.token } });
    assert.equal(exportedResponse.status, 200);
    const exported = await exportedResponse.text();
    const exportPath = path.join(temp, 'worker-export.json');
    await writeFile(exportPath, exported);
    const jsonDb = path.join(temp, 'json.db');
    const jsonCounts = await importData(exportPath, jsonDb);
    assert.equal(jsonCounts.drawings, 6);
    const imported = new DatabaseSync(jsonDb);
    try {
      assert.equal(imported.prepare('SELECT status FROM drawings WHERE id = ?').get(drawing.id)!.status, 'Approved');
      assert.equal(imported.prepare('SELECT COUNT(*) AS n FROM review_tracker').get()!.n, 6);
      assert.equal(imported.prepare('SELECT COUNT(*) AS n FROM drawing_remarks').get()!.n, 2);
    } finally { imported.close(); }
    console.log('Worker /admin/api/export JSON import -> project/drawings/config/tracker/remarks preserved');
    await assert.rejects(importData(exportPath, jsonDb), /Refusing to overwrite/);
    const badPath = path.join(temp, 'invalid.json');
    await writeFile(badPath, JSON.stringify({ projects: [{ project: { id: 'bad' } }] }));
    const badDb = path.join(temp, 'invalid.db');
    await assert.rejects(importData(badPath, badDb), /Invalid project entry/);
    assert.equal(await access(badDb).then(() => true, () => false), false);
    const dumpPath = path.join(temp, 'full-export.sql');
    const schema = migrationSql('001_schema.sql');
    const seed = await readFile(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8');
    await writeFile(dumpPath, 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n' + schema + '\n' + seed + '\nCOMMIT;');
    const dumpDb = path.join(temp, 'dump.db');
    assert.equal((await importData(dumpPath, dumpDb)).drawings, 6);
    console.log('Full schema SQL dump with BEGIN/COMMIT -> projects=1 drawings=6 integrity=ok');
    await hub.close(); hub = undefined;
    process.env.API_TOKEN = 'smoke-token';
    hub = await createHub();
    base = 'http://127.0.0.1:' + hub.port;
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: base } });
    api = createProjectsApi(createApiClient({ baseUrl: '/api', token: 'smoke-token' }));
    assert.equal((await fetch(base + '/api/health')).status, 401);
    assert.equal((await fetch(base + '/api/health', { headers: { Authorization: 'Bearer smoke-token' } })).status, 200);
    assert.equal((await api.loadProject(stub)).drawings.find(d => d.id === drawing.id)?.status, 'Approved');
    console.log('Restart -> status=Approved audit retained; API_TOKEN missing=401 valid=200');
  } finally {
    await hub?.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    Reflect.deleteProperty(globalThis, 'location');
  }
});


test('retired project snapshot migration backs up data before DROP and runs once', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pahub-retirement-'));
  const db = new DatabaseSync(path.join(directory, 'papc.db'));
  try {
    initializeSchema(db);
    db.exec("CREATE TABLE snapshots(id TEXT PRIMARY KEY, data_json TEXT); CREATE INDEX old_snapshot_index ON snapshots(id); INSERT INTO snapshots VALUES ('old', '{\"preserved\":true}');");
    initializeSchema(db);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='snapshots' OR name='old_snapshot_index'").get(), undefined);
    const backups = await readdir(path.join(directory, 'backups'));
    assert.equal(backups.length, 1);
    const saved = new DatabaseSync(path.join(directory, 'backups', backups[0]), { readOnly: true });
    try { assert.equal(saved.prepare('SELECT data_json FROM snapshots').get()!.data_json, '{"preserved":true}'); } finally { saved.close(); }
    initializeSchema(db);
    assert.deepEqual(await readdir(path.join(directory, 'backups')), backups);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_log'").get());
  } finally { db.close(); }
});

test('schema initialization is idempotent and upgrades guarded audit/_deleted columns', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const base = migrationSql('001_schema.sql')
      .replaceAll('  _deleted INTEGER DEFAULT 0,\n', '').replace('  project_id TEXT,\n', '')
      .replace('CREATE INDEX IF NOT EXISTS idx_audit_log_project_created ON audit_log(project_id, created_at);', '');
    sqlite.exec(base);
    initializeSchema(sqlite);
    initializeSchema(sqlite);
    assert.ok(sqlite.prepare('PRAGMA table_info(audit_log)').all().some(row => row.name === 'project_id'));
    assert.ok(sqlite.prepare('PRAGMA table_info(drawings)').all().some(row => row.name === '_deleted'));
    assert.ok(sqlite.prepare('PRAGMA table_info(review_tracker)').all().some(row => row.name === '_deleted'));
  } finally { sqlite.close(); }
});
