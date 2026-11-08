import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applyPcfJsonMigration, BASELINE_SCHEMA_VERSION, initializeSchema, KNOWN_SCHEMA_VERSION,
  migrationSql, PCF_JSON_STORAGE_VERSION, schemaVersion,
} from '../src/database.ts';

function seedIndex(db: DatabaseSync, filePath: string): void {
  db.exec(`INSERT INTO projects(id, name) VALUES ('p1', 'Project');
    INSERT INTO drawings(id, project_id) VALUES ('d1', 'p1');
    INSERT INTO pcf_index(project_id, drawing_id, document_id, rev, file_path, total_comments, open_comments, current_round, approval, rounds_json, updated_at)
    VALUES ('p1', 'd1', 'doc', 1, '${filePath}', 0, 0, 1, 'Under review', '[]', '2026-01-01T00:00:00.000Z');`);
}

test('fresh database starts at the baseline version and never applies PCF JSON conversion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    assert.equal(schemaVersion(db), BASELINE_SCHEMA_VERSION);
    assert.equal(KNOWN_SCHEMA_VERSION, PCF_JSON_STORAGE_VERSION);
    // Version 002 is an offline migration; startup must leave it pending.
    assert.ok(schemaVersion(db) < PCF_JSON_STORAGE_VERSION);
    for (const table of ['projects', 'drawings', 'review_tracker', 'audit_log', 'pcf_index', 'pcf_changes', 'pcf_exports', 'pcf_export_batches']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    }
    for (const view of ['api_settings', 'api_projects', 'api_project_details', 'api_review_trackers']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name=?").get(view), view);
    }
    seedIndex(db, 'pcf/p1/d1.html');
    initializeSchema(db);
    assert.equal(schemaVersion(db), BASELINE_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT file_path FROM pcf_index").get()!.file_path, 'pcf/p1/d1.html');
  } finally { db.close(); }
});

test('applyPcfJsonMigration rewrites HTML pointers once without owning the transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    seedIndex(db, 'pcf/p1/d1.html');
    db.exec('BEGIN EXCLUSIVE');
    try {
      applyPcfJsonMigration(db);
      applyPcfJsonMigration(db); // idempotent while the caller's transaction is open
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    assert.equal(schemaVersion(db), PCF_JSON_STORAGE_VERSION);
    assert.equal(db.prepare("SELECT file_path FROM pcf_index").get()!.file_path, 'pcf/p1/d1.json');
    initializeSchema(db);
    assert.equal(schemaVersion(db), PCF_JSON_STORAGE_VERSION);
    assert.equal(db.prepare("SELECT file_path FROM pcf_index").get()!.file_path, 'pcf/p1/d1.json');
  } finally { db.close(); }
});

test('an aborted PCF JSON migration leaves the version and index untouched', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    seedIndex(db, 'pcf/p1/d1.html');
    db.exec('BEGIN EXCLUSIVE');
    applyPcfJsonMigration(db);
    db.exec('ROLLBACK');
    assert.equal(schemaVersion(db), BASELINE_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT file_path FROM pcf_index").get()!.file_path, 'pcf/p1/d1.html');
  } finally { db.close(); }
});

test('legacy pre-baseline databases are adopted and stamped at version 1', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pahub-migrations-'));
  const file = path.join(directory, 'legacy.db');
  const db = new DatabaseSync(file);
  try {
    // Old local schema: no audit_log.project_id, no _deleted flags, webdav_path name.
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, webdav_path TEXT, last_updated TEXT);
      CREATE TABLE drawings(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, custom_id TEXT, drawing_no TEXT,
        discipline TEXT, title TEXT, status TEXT, version TEXT, current_round TEXT, review_deadline TEXT,
        manual_comments_count INTEGER, manual_open_comments_count INTEGER, checked INTEGER, checked_synced INTEGER,
        received_date TEXT, category TEXT, deadline TEXT);
      CREATE TABLE review_tracker(project_id TEXT, drawing_id TEXT, raw_drawing_ref TEXT, reviewer_id TEXT, done INTEGER, done_at TEXT);
      CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, row_id TEXT, action TEXT, detail TEXT, created_at TEXT);
      INSERT INTO projects(id, name, webdav_path) VALUES ('p1', 'Legacy', '/old');`);
    initializeSchema(db);
    assert.equal(schemaVersion(db), BASELINE_SCHEMA_VERSION);
    assert.ok(db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'storage_path'));
    assert.ok(!db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'webdav_path'));
    assert.ok(db.prepare('PRAGMA table_info(audit_log)').all().some(row => row.name === 'project_id'));
    assert.ok(db.prepare('PRAGMA table_info(drawings)').all().some(row => row.name === '_deleted'));
    assert.ok(db.prepare('PRAGMA table_info(review_tracker)').all().some(row => row.name === '_deleted'));
    assert.equal(db.prepare('SELECT storage_path FROM projects').get()!.storage_path, '/old');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a database from a future schema version is refused', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA user_version = ' + (KNOWN_SCHEMA_VERSION + 1));
    assert.throws(() => initializeSchema(db), /newer than this Hub supports/);
  } finally { db.close(); }
});

test('a future schema version is rejected before legacy snapshots or columns are touched', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pahub-future-schema-'));
  const db = new DatabaseSync(path.join(directory, 'papc.db'));
  try {
    // Legacy shape plus a retired snapshots table; both would otherwise be mutated.
    db.exec(`PRAGMA user_version = ${KNOWN_SCHEMA_VERSION + 1};
      CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, webdav_path TEXT, last_updated TEXT);
      CREATE TABLE snapshots(id TEXT PRIMARY KEY, data_json TEXT);
      INSERT INTO snapshots VALUES ('old', '{"preserved":true}');`);
    assert.throws(() => initializeSchema(db), /newer than this Hub supports/);
    assert.equal(schemaVersion(db), KNOWN_SCHEMA_VERSION + 1);
    assert.equal(db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'webdav_path'), true);
    assert.equal(db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'storage_path'), false);
    assert.equal(db.prepare("SELECT data_json FROM snapshots WHERE id='old'").get()!.data_json, '{"preserved":true}');
    assert.deepEqual(await readdir(path.join(directory, 'backups')).catch(() => []), []);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('migration SQL resolves from the bundled dist copy or the source tree', () => {
  assert.match(migrationSql('001_schema.sql'), /CREATE TABLE IF NOT EXISTS pcf_index/);
  assert.match(migrationSql('002_pcf_json_storage.sql'), /UPDATE pcf_index/);
  assert.throws(() => migrationSql('999_missing.sql'), /Migration file not found/);
});
