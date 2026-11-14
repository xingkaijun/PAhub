import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT_DIR, SQL_DIR } from './config.ts';
import { migrateLegacyProjectPath } from './import-legacy.ts';
import { initializeIdentitySchema } from './audit.ts';

// Numbered migrations live next to the source. The build copies them to dist so
// the bundled hub and standalone scripts resolve the same files.
const SOURCE_MIGRATION_DIR = path.join(ROOT_DIR, 'hub-server/sql/migrations');
const BUNDLED_MIGRATION_DIR = path.join(SQL_DIR, 'migrations');

export function migrationSql(name: string): string {
  for (const directory of [BUNDLED_MIGRATION_DIR, SOURCE_MIGRATION_DIR]) {
    const file = path.join(directory, name);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  throw new Error('Migration file not found: ' + name);
}

// Version 1 is the baseline schema, applied automatically to every database.
export const BASELINE_SCHEMA_VERSION = 1;
// Version 2 records PCF HTML -> JSON conversion. The startup/offline converter
// verifies the files and backs them up before applying this step; schema
// initialization alone must never mark legacy files as converted.
export const PCF_JSON_STORAGE_VERSION = 2;
export const KNOWN_SCHEMA_VERSION = PCF_JSON_STORAGE_VERSION;

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare('PRAGMA table_info("' + table + '")').all().map(row => String(row.name));
}

export function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()!.user_version);
}

// Pre-baseline databases (D1 dumps, old local files) predate these columns.
// Only runs while the database is below version 1; fresh and current databases
// never see a runtime ALTER.
function adoptLegacySchema(db: DatabaseSync): void {
  const expected: Record<string, string[]> = {
    projects: ['id', 'name', 'storage_path', 'last_updated'],
    drawings: ['id', 'project_id', 'custom_id', 'drawing_no', 'discipline', 'title', 'status', 'version',
      'current_round', 'review_deadline', 'manual_comments_count', 'manual_open_comments_count',
      'checked', 'checked_synced', 'received_date', 'category', 'deadline'],
    review_tracker: ['project_id', 'drawing_id', 'raw_drawing_ref', 'reviewer_id', 'done', 'done_at'],
  };
  for (const [table, required] of Object.entries(expected)) {
    const found = columns(db, table);
    if (found.length && required.some(column => !found.includes(column))) {
      throw new Error('Unsupported legacy schema in ' + table + '; use /admin/api/export JSON instead.');
    }
  }
  for (const [table, column, type] of [
    ['audit_log', 'project_id', 'TEXT'],
    ['drawings', '_deleted', 'INTEGER DEFAULT 0'],
    ['review_tracker', '_deleted', 'INTEGER DEFAULT 0'],
  ]) {
    const found = columns(db, table);
    if (found.length && !found.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
  }
}

type Migration = { version: number; name: string; prepare?: (db: DatabaseSync) => void };

const MIGRATIONS: Migration[] = [
  { version: 1, name: '001_schema.sql', prepare: adoptLegacySchema },
];

function applyMigration(db: DatabaseSync, migration: Migration): void {
  db.exec('SAVEPOINT pahub_migration');
  try {
    migration.prepare?.(db);
    db.exec(migrationSql(migration.name));
    db.exec('PRAGMA user_version = ' + migration.version);
    db.exec('RELEASE pahub_migration');
  } catch (error) {
    db.exec('ROLLBACK TO pahub_migration; RELEASE pahub_migration');
    throw error;
  }
}

// Reject databases written by a newer Hub before any destructive legacy step.
function assertSupportedVersion(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current > KNOWN_SCHEMA_VERSION) {
    throw new Error('Database schema version ' + current + ' is newer than this Hub supports (' + KNOWN_SCHEMA_VERSION + ').');
  }
}

function migrate(db: DatabaseSync): number {
  assertSupportedVersion(db);
  let current = schemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    applyMigration(db, migration);
    current = migration.version;
  }
  return current;
}

// Explicit PCF HTML -> JSON conversion step. Runs inside the caller's
// transaction (e.g. BEGIN EXCLUSIVE) and uses a savepoint, never BEGIN.
// The conversion script must have written and verified the JSON files before
// calling this; renaming .html pointers is the final, atomic index step.
export function applyPcfJsonMigration(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current < BASELINE_SCHEMA_VERSION) {
    throw new Error('PCF JSON migration requires schema version ' + BASELINE_SCHEMA_VERSION + '; open the database once first.');
  }
  if (current > PCF_JSON_STORAGE_VERSION) throw new Error('Database is newer than this migration tool');
  db.exec('SAVEPOINT pahub_pcf_json_migration');
  try {
    db.exec(migrationSql('002_pcf_json_storage.sql'));
    db.exec('PRAGMA user_version = ' + PCF_JSON_STORAGE_VERSION);
    db.exec('RELEASE pahub_pcf_json_migration');
  } catch (error) {
    db.exec('ROLLBACK TO pahub_pcf_json_migration; RELEASE pahub_pcf_json_migration');
    throw error;
  }
}

// Legacy project snapshots are retired. Back up before deleting, outside a transaction.
function removeLegacySnapshots(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshots'").get()) return;
  const databaseFile = String(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || '');
  const backupDir = databaseFile ? path.join(path.dirname(databaseFile), 'backups') : path.join(process.env.TEMP || '.', 'pahub-backups');
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, 'before-snapshot-removal-' + Date.now() + '-' + randomUUID() + '.db');
  db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
  db.exec('DROP TABLE snapshots'); // SQLite also removes indexes belonging to this table.
  console.log('Removed legacy project snapshots; database backup: ' + backup);
}

export function initializeSchema(db: DatabaseSync): void {
  // Check first: snapshot backup/removal and column renames must not touch a
  // database this Hub cannot safely read.
  assertSupportedVersion(db);
  removeLegacySnapshots(db);
  migrateLegacyProjectPath(db);
  migrate(db);
  initializeIdentitySchema(db);
  db.exec('CREATE TABLE IF NOT EXISTS project_passwords (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,password_hash TEXT NOT NULL,version TEXT NOT NULL)');
  // Retire legacy read views for either storage version (1=HTML, 2=JSON).
  // Do not advance user_version here; the PCF converter owns version 2.
  for (const view of ['api_settings', 'api_projects', 'api_project_details', 'api_review_trackers']) db.exec('DROP VIEW IF EXISTS ' + view);
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error('Foreign-key violations: ' + JSON.stringify(violations.slice(0, 5)));
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
    initializeSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
