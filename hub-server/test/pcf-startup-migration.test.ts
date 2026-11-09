import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, cpSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { PcfStorage, parseHTML } from '../src/pcf-storage.ts';
import { renderTemplate } from '../src/pcf-template.ts';
import { legacyPcfFixture } from './fixtures/legacy-pcf.ts';

async function withHubFixture(task: (f: ReturnType<typeof legacyPcfFixture>, start: () => Promise<{ hub: Awaited<ReturnType<typeof createHub>>; base: string }>) => Promise<void>) {
  const f = legacyPcfFixture();
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'ADMIN_PASSWORD', 'PAHUB_BASIC_AUTH'];
  const previous = keys.map(key => [key, process.env[key]] as const);
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: f.dir, PAPC_DB_PATH: path.join(f.dir, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: '', PAHUB_BASIC_AUTH: '' });
  const hubs: Awaited<ReturnType<typeof createHub>>[] = [];
  const originalError = console.error, originalLog = console.log;
  try {
    await task(f, async () => {
      const hub = await createHub({ host: '127.0.0.1' }); hubs.push(hub);
      assert.ok(![8080, 8081, 8082].includes(hub.port));
      const close = hub.close; hub.close = async () => { if (hubs.includes(hub)) { await close(); hubs.splice(hubs.indexOf(hub), 1); } };
      return { hub, base: 'http://127.0.0.1:' + hub.port };
    });
  } finally {
    console.error = originalError; console.log = originalLog;
    for (const hub of [...hubs]) await hub.close();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.cleanup();
  }
}

async function readPcf(base: string, f: ReturnType<typeof legacyPcfFixture>) {
  const page = await fetch(`${base}/pcf/${f.p}/${f.d}`); assert.equal(page.status, 200);
  assert.match(await page.text(), /pahub-context/);
  const response = await fetch(`${base}/api/pcf/${f.p}/${f.d}/data`); assert.equal(response.status, 200);
  const current = await response.json();
  // The API intentionally omits private idempotency receipts.
  const expected = structuredClone(f.data); delete expected.hub.receipts;
  if (current.rev === expected.hub.rev) assert.deepEqual(current.data, expected);
  return current;
}
async function editPcf(base: string, f: ReturnType<typeof legacyPcfFixture>, current: any) {
  const response = await fetch(`${base}/api/pcf/${f.p}/${f.d}/ops`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'startup-test', baseRev: current.rev, batchId: randomUUID(), ops: [{ type: 'comment.add', id: 'startup-comment', roundIdNew: 'startup-round' }] }),
  });
  assert.equal(response.status, 200); const saved = await response.json();
  assert.equal(saved.rev, current.rev + 1); assert.ok(saved.data.comments.some((c: any) => c.id === 'startup-comment'));
  return saved;
}

for (const mixed of [false, true]) test(`startup auto-migrates ${mixed ? 'mixed version-2' : 'legacy HTML'} storage, backs up, saves and skips migration on restart`, async () => {
  await withHubFixture(async (f, start) => {
    if (mixed) {
      const db = openDatabase(path.join(f.dir, 'papc.db'));
      const storage = new PcfStorage(db, f.dir); storage.create(f.p, 'dwg-001', { clientId: 'fixture', clientName: '', ip: '' });
      // Include a duplicate HTML/JSON pair; identical JSON is safe to retain.
      writeFileSync(storage.file(f.p, f.d), JSON.stringify(f.data));
      db.exec('PRAGMA user_version=2'); db.close();
    }
    const { hub, base } = await start();
    const backups = readdirSync(path.join(f.dir, 'backups')).filter(n => n.startsWith('before-pcf-json-')); assert.equal(backups.length, 1);
    const backup = path.join(f.dir, 'backups', backups[0]);
    assert.equal(readFileSync(path.join(backup, 'pcf', f.p, f.d + '.html'), 'utf8'), f.html);
    const savedDb = new DatabaseSync(path.join(backup, 'papc.db'));
    try { assert.equal(savedDb.prepare('SELECT rev FROM pcf_index WHERE drawing_id=?').get(f.d)!.rev, f.data.hub.rev); } finally { savedDb.close(); }
    assert.equal(existsSync(path.join(f.dir, 'pcf', f.p, f.d + '.html')), false);
    await readPcf(base, f);
    assert.deepEqual(hub.writer.storage.load(f.p, f.d).data, f.data);
    assert.equal(hub.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.equal(hub.db.prepare('SELECT file_path FROM pcf_index WHERE drawing_id=?').get(f.d)!.file_path, `pcf/${f.p}/${f.d}.json`);
    const history = await fetch(`${base}/api/pcf/${f.p}/${f.d}/history`).then(r => r.json()); assert.equal(history.length, 1); assert.match(history[0].filename, /\.json$/);
    const saved = await editPcf(base, f, await readPcf(base, f));
    await hub.close();
    const restarted = await start(); assert.equal((await readPcf(restarted.base, f)).rev, saved.rev);
    assert.deepEqual(readdirSync(path.join(f.dir, 'backups')).filter(n => n.startsWith('before-pcf-json-')), backups);
  });
});

test('migration commit failure retains HTML, serves/edits fallback, then retries successfully on restart', async () => {
  await withHubFixture(async (f, start) => {
    const db = openDatabase(path.join(f.dir, 'papc.db'));
    db.exec("CREATE TRIGGER reject_json BEFORE UPDATE OF file_path ON pcf_index WHEN NEW.file_path LIKE '%.json' BEGIN SELECT RAISE(ABORT,'simulated JSON index failure'); END"); db.close();
    const errors: string[] = [], original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); original(...args); };
    const { hub, base } = await start(); console.error = original;
    assert.ok(errors.some(s => /Automatic migration failed.*legacy HTML fallback/.test(s) && s.includes('simulated JSON index failure')));
    const htmlFile = path.join(f.dir, 'pcf', f.p, f.d + '.html');
    assert.equal(readFileSync(htmlFile, 'utf8'), f.html); assert.equal(existsSync(htmlFile.replace(/\.html$/, '.json')), false);
    assert.equal(hub.db.prepare('PRAGMA user_version').get()!.user_version, 1);
    await readPcf(base, f);
    const history = await fetch(`${base}/api/pcf/${f.p}/${f.d}/history`).then(r => r.json()); assert.match(history[0].filename, /\.html$/);
    const saved = await editPcf(base, f, await readPcf(base, f));
    assert.equal(parseHTML(readFileSync(htmlFile, 'utf8')).hub.rev, saved.rev);
    assert.equal(existsSync(htmlFile.replace(/\.html$/, '.json')), false);
    const noOp = { clientId: 'startup-test', baseRev: saved.rev, batchId: randomUUID(), ops: [] };
    const endpoint = `${base}/api/pcf/${f.p}/${f.d}/ops`;
    for (let i = 0; i < 2; i++) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noOp) });
      assert.equal(response.status, 200); assert.equal((await response.json()).rev, saved.rev);
    }
    assert.equal(existsSync(htmlFile.replace(/\.html$/, '.json')), false);
    // Old HTML history remains restorable through the regular JSON API.
    const restored = await fetch(`${base}/api/pcf/${f.p}/${f.d}/history/1/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'restore', baseRev: saved.rev }),
    });
    assert.equal(restored.status, 200); const restoredData = await restored.json();
    assert.equal(restoredData.rev, saved.rev + 1); assert.equal(restoredData.data.comments.length, f.baseline.comments.length);
    hub.db.exec('DROP TRIGGER reject_json'); await hub.close();
    const restarted = await start(); assert.equal((await readPcf(restarted.base, f)).rev, restoredData.rev);
    assert.equal(existsSync(htmlFile), false); assert.equal(readdirSync(path.join(f.dir, 'backups')).filter(n => n.startsWith('before-pcf-json-')).length, 2);
  });
});

test('one invalid snapshot aborts automatic conversion but valid PCF still opens without changing the originals', async () => {
  await withHubFixture(async (f, start) => {
    const snapshot = path.join(f.dir, 'pcf', f.p, '.history', f.d, f.snapshot); writeFileSync(snapshot, '<html>broken</html>');
    const { base } = await start(); await readPcf(base, f);
    assert.equal(readFileSync(snapshot, 'utf8'), '<html>broken</html>');
    assert.equal(readFileSync(path.join(f.dir, 'pcf', f.p, f.d + '.html'), 'utf8'), f.html);
    assert.ok(existsSync(path.join(f.dir, 'backups')));
  });
});

test('legacy file arriving after startup is readable and saveable without creating a duplicate JSON', async () => {
  await withHubFixture(async (f, start) => {
    const { hub, base } = await start();
    const d = 'dwg-001', storage = new PcfStorage(hub.db, f.dir);
    storage.create(f.p, d, { clientId: 'late', clientName: '', ip: '' });
    const current = storage.load(f.p, d), file = storage.file(f.p, d);
    writeFileSync(file.replace(/\.json$/, '.html'), renderTemplate(current.data)); rmSync(file);
    const late = { ...f, d, data: current.data }; const loaded = await readPcf(base, late);
    assert.equal(loaded.rev, current.rev); await editPcf(base, late, loaded);
    assert.equal(existsSync(file), false); assert.ok(existsSync(file.replace(/\.json$/, '.html')));
  });
});

test('backup failure never converts original files and still serves HTML fallback', async () => {
  await withHubFixture(async (f, start) => {
    // A file occupying the backups directory deterministically simulates failure
    // without platform-specific permission tricks or touching live data.
    writeFileSync(path.join(f.dir, 'backups'), 'blocked');
    const { base } = await start(); await readPcf(base, f);
    assert.equal(readFileSync(path.join(f.dir, 'pcf', f.p, f.d + '.html'), 'utf8'), f.html);
    assert.equal(existsSync(path.join(f.dir, 'pcf', f.p, f.d + '.json')), false);
    assert.equal(readFileSync(path.join(f.dir, 'backups'), 'utf8'), 'blocked');
  });
});

test('startup backs up and migrates a database configured outside the data directory', async () => {
  await withHubFixture(async (f, start) => {
    const external = path.join(f.parent, 'external.db'); renameSync(path.join(f.dir, 'papc.db'), external);
    process.env.PAPC_DB_PATH = external;
    const { base } = await start(); await readPcf(base, f);
    const backups = readdirSync(path.join(f.dir, 'backups')); assert.equal(backups.length, 1);
    assert.ok(existsSync(path.join(f.dir, 'backups', backups[0], 'papc.db')));
    assert.equal(existsSync(path.join(f.dir, 'papc.db')), false);
  });
});

test('conflicting HTML/JSON copies are not overwritten and JSON remains authoritative', async () => {
  await withHubFixture(async (f, start) => {
    const jsonFile = path.join(f.dir, 'pcf', f.p, f.d + '.json');
    const data = structuredClone(f.data); data.project.planTitle = 'Authoritative JSON'; const json = JSON.stringify(data); writeFileSync(jsonFile, json);
    const { base } = await start(); await readPcf(base, { ...f, data });
    assert.equal(readFileSync(jsonFile, 'utf8'), json);
    assert.equal(readFileSync(jsonFile.replace(/\.json$/, '.html'), 'utf8'), f.html);
  });
});

test('interrupted mixed version-2 installation is recovered and migrated on startup', async () => {
  await withHubFixture(async (f, start) => {
    const db = openDatabase(path.join(f.dir, 'papc.db')); db.exec('PRAGMA user_version=2'); db.close();
    const backup = 'pcf-html-backup-test-' + randomUUID(), stage = '.pcf-json-stage-' + randomUUID();
    cpSync(path.join(f.dir, 'pcf'), path.join(f.dir, backup), { recursive: true }); mkdirSync(path.join(f.dir, stage));
    writeFileSync(path.join(f.dir, '.pcf-json-migration.json'), JSON.stringify({ stage, htmlBackup: backup, fromVersion: 2 }));
    const { base } = await start(); await readPcf(base, f);
    assert.equal(existsSync(path.join(f.dir, '.pcf-json-migration.json')), false);
  });
});
