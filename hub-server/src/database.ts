import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL_DIR } from './config.ts';
import { D1Adapter } from './d1.ts';
import { initializePcfSchema } from './pcf-schema.ts';
import { migrateLegacyProjectPath } from './import-legacy.ts';

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare('PRAGMA table_info("' + table + '")').all().map(row => String(row.name));
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
  removeLegacySnapshots(db);
  migrateLegacyProjectPath(db);
  const expected: Record<string, string[]> = {
    projects: ['id', 'name', 'storage_path', 'last_updated'],
    drawings: ['id', 'project_id', 'custom_id', 'drawing_no', 'discipline', 'title', 'status', 'version',
      'current_round', 'review_deadline', 'manual_comments_count', 'manual_open_comments_count',
      'checked', 'checked_synced', 'received_date', 'category', 'deadline'],
    review_tracker: ['project_id', 'drawing_id', 'raw_drawing_ref', 'reviewer_id', 'done', 'done_at'],
  };
  for (const [table, required] of Object.entries(expected)) {
    const found = columns(db, table);
    if (found.length && required.some(col => !found.includes(col))) {
      throw new Error('Unsupported legacy schema in ' + table + '; use /admin/api/export JSON instead.');
    }
  }
  db.exec('SAVEPOINT pahub_schema');
  try {
    for (const [table, column, type] of [
      ['audit_log', 'project_id', 'TEXT'],
      ['drawings', '_deleted', 'INTEGER DEFAULT 0'],
      ['review_tracker', '_deleted', 'INTEGER DEFAULT 0'],
    ]) {
      const found = columns(db, table);
      if (found.length && !found.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
    }
    const init = readFileSync(path.join(SQL_DIR, 'init-local.sql'), 'utf8');
    const marker = '-- ========== 兼容视图（Worker API 读取用） ==========';
    const split = init.indexOf(marker);
    if (split < 0) throw new Error('init-local.sql schema marker missing');
    db.exec(init.slice(0, split));
    db.exec(readFileSync(path.join(SQL_DIR, 'audit-journal.sql'), 'utf8')
      .replace(/^ALTER TABLE audit_log ADD COLUMN project_id TEXT;\s*$/m, ''));
    db.exec(init.slice(split));
    initializePcfSchema(db);
    for (const view of ['api_settings', 'api_projects', 'api_project_details', 'api_review_trackers']) {
      db.prepare('SELECT * FROM ' + view + ' LIMIT 1').all();
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('Foreign-key violations: ' + JSON.stringify(violations.slice(0, 5)));
    db.exec('RELEASE pahub_schema');
  } catch (error) {
    db.exec('ROLLBACK TO pahub_schema; RELEASE pahub_schema');
    throw error;
  }
}

export function openDatabase(dbPath: string): D1Adapter {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
    initializeSchema(db);
    return new D1Adapter(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
