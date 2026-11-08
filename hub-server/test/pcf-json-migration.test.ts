import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, renameSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase } from '../src/database.ts';
import { ROOT_DIR } from '../src/config.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { renderTemplate } from '../src/pcf-template.ts';
import { migratePcfJson } from '../src/pcf-json-migration.ts';

function tree(dir: string): string {
  const rows: string[] = [];
  function walk(base: string) { for (const e of readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = path.join(base, e.name); if (e.isDirectory()) walk(rel);
    else rows.push(rel + ':' + createHash('sha256').update(readFileSync(path.join(dir, rel))).digest('hex'));
  } }
  walk(''); return rows.sort().join('\n');
}
function fixture() {
  const parent = mkdtempSync(path.join(tmpdir(), 'pahub-migrate-json-test-')), dir = path.join(parent, 'data'); mkdirSync(dir);
  const db = openDatabase(path.join(dir, 'papc.db'));
  db.sqlite.exec(readFileSync(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
  const p = 'proj-test-001', d = 'dwg-005', storage = new PcfStorage(db.sqlite, dir), actor = { clientId: 'fixture', clientName: '', ip: '127.0.0.1' };
  storage.create(p, d, actor); const baseline = storage.load(p, d).data;
  storage.ops(p, d, { baseRev: 1, batchId: randomUUID(), ops: [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }] }, actor);
  const data = storage.load(p, d).data;
  const html = renderTemplate(data); writeFileSync(storage.file(p, d).replace(/\.json$/, '.html'), html, 'utf8'); rmSync(storage.file(p, d));
  const h = storage.historyDir(p, d);
  const snapshot = readdirSync(h).find(n => n.endsWith('.json') && !n.startsWith('.'))!;
  const historyFile = path.join(h, snapshot);
  writeFileSync(historyFile.replace(/\.json$/, '.html'), renderTemplate(JSON.parse(readFileSync(historyFile, 'utf8'))), 'utf8'); rmSync(historyFile);
  const manifest = path.join(h, '.retention.json'), value = JSON.parse(readFileSync(manifest, 'utf8')); value.filename = value.filename.replace(/\.json$/, '.html'); writeFileSync(manifest, JSON.stringify(value));
  db.sqlite.prepare("UPDATE pcf_index SET file_path=replace(file_path,'.json','.html')").run();
  db.sqlite.exec('PRAGMA user_version=1'); db.sqlite.close();
  const exportDir = path.join(dir, 'pcf', p, d, 'exports'); mkdirSync(exportDir, { recursive: true }); writeFileSync(path.join(exportDir, 'baseline.html'), html);
  return { parent, dir, p, d, data, baseline, snapshot: snapshot.replace(/\.json$/, '.html'), html, cleanup() { rmSync(parent, { recursive: true, force: true }); } };
}

test('migration dry-run validates documents and snapshots without changing any supplied file', () => {
  const f = fixture(); try {
    const before = tree(f.dir), report = migratePcfJson({ dataDir: f.dir, dryRun: true });
    assert.equal(report.documents, 1); assert.equal(report.snapshots, 1); assert.equal(report.toVersion, 2);
    assert.equal(report.status, 'would-migrate'); assert.ok(report.jsonBytes < report.htmlBytes / 10);
    assert.equal(tree(f.dir), before); assert.deepEqual(readdirSync(f.parent), ['data']);
  } finally { f.cleanup(); }
});

test('migration preserves exact JSON, revision, history manifest, HTML exchange and whole-directory backup', () => {
  const f = fixture(); try {
    const before = tree(f.dir); assert.throws(() => migratePcfJson({ dataDir: f.dir }), /Stop Hub/);
    const report = migratePcfJson({ dataDir: f.dir, hubStopped: true });
    assert.equal(tree(report.fullBackup), before); assert.equal(report.documents, 1); assert.equal(report.snapshots, 1);
    assert.equal(readFileSync(path.join(report.htmlBackup, f.p, f.d + '.html'), 'utf8'), f.html);
    const db = openDatabase(path.join(f.dir, 'papc.db'));
    try {
      assert.equal(db.sqlite.prepare('PRAGMA user_version').get()!.user_version, 2);
      const storage = new PcfStorage(db.sqlite, f.dir);
      assert.deepEqual(storage.load(f.p, f.d).data, f.data);
      assert.equal(storage.meta(f.p, f.d).file_path, 'pcf/' + f.p + '/' + f.d + '.json');
      const history = storage.history(f.p, f.d); assert.equal(history.length, 1); assert.ok(history[0].filename.endsWith('.json'));
      assert.deepEqual(JSON.parse(readFileSync(path.join(storage.historyDir(f.p, f.d), history[0].filename), 'utf8')), f.baseline);
      const m = JSON.parse(readFileSync(path.join(storage.historyDir(f.p, f.d), '.retention.json'), 'utf8')); assert.equal(m.filename, history[0].filename);
      assert.equal(readFileSync(path.join(f.dir, 'pcf', f.p, f.d, 'exports', 'baseline.html'), 'utf8'), f.html);
    } finally { db.sqlite.close(); }
    const after = tree(f.dir); assert.equal(migratePcfJson({ dataDir: f.dir, hubStopped: true }).status, 'already-migrated'); assert.equal(tree(f.dir), after);
  } finally { f.cleanup(); }
});

test('invalid HTML or an index ahead of its document aborts before any writes', () => {
  const f = fixture(); try {
    const file = path.join(f.dir, 'pcf', f.p, f.d + '.html');
    writeFileSync(file, '<html>broken</html>'); const before = tree(f.dir);
    assert.throws(() => migratePcfJson({ dataDir: f.dir, hubStopped: true }), /pcf-data/); assert.equal(tree(f.dir), before);
    writeFileSync(file, f.html);
    const db = openDatabase(path.join(f.dir, 'papc.db')); db.sqlite.exec('UPDATE pcf_index SET rev=999'); db.sqlite.close();
    const indexed = tree(f.dir); assert.throws(() => migratePcfJson({ dataDir: f.dir, hubStopped: true }), /Index ahead/); assert.equal(tree(f.dir), indexed);
  } finally { f.cleanup(); }
});

test('interrupted directory installation rolls back to HTML before retrying conversion', () => {
  const f = fixture(); try {
    const base = path.join(f.dir, 'pcf'), backupName = 'pcf-html-backup-test-' + randomUUID(), stageName = '.pcf-json-stage-' + randomUUID();
    cpSync(base, path.join(f.dir, stageName), { recursive: true }); renameSync(base, path.join(f.dir, backupName)); renameSync(path.join(f.dir, stageName), base);
    rmSync(path.join(base, f.p, f.d + '.html'));
    writeFileSync(path.join(f.dir, '.pcf-json-migration.json'), JSON.stringify({ stage: stageName, htmlBackup: backupName }));
    assert.throws(() => migratePcfJson({ dataDir: f.dir, dryRun: true }), /interrupted/);
    const report = migratePcfJson({ dataDir: f.dir, hubStopped: true }); assert.equal(report.recovered, true); assert.equal(report.documents, 1);
    assert.deepEqual(JSON.parse(readFileSync(path.join(base, f.p, f.d + '.json'), 'utf8')), f.data);
    assert.equal(existsSync(path.join(f.dir, '.pcf-json-migration.json')), false);
  } finally { f.cleanup(); }
});
