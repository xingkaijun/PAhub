import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const KEY_LENGTH = 64;
export const PASSWORD_TABLE = 'project_passwords';
export function hashProjectPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + scryptSync(password, salt, KEY_LENGTH).toString('hex');
}
export function verifyProjectPassword(password: string, hash: string): boolean {
  const [algorithm, salt, digest] = hash.split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(digest || '')) return false;
  const actual = scryptSync(password, salt, KEY_LENGTH), expected = Buffer.from(digest, 'hex');
  return timingSafeEqual(actual, expected);
}
export function passwordState(db: DatabaseSync, project: string) {
  const row = db.prepare('SELECT password_hash,version FROM project_passwords WHERE project_id=?').get(project);
  return { hash: String(row?.password_hash || ''), version: String(row?.version || '') };
}
export function setProjectPassword(db: DatabaseSync, project: string, password: unknown) {
  if (typeof password !== 'string' || password.length > 1024) throw Object.assign(new Error('Project password must be a string of at most 1024 characters'), { status: 400 });
  db.prepare('INSERT INTO project_passwords(project_id,password_hash,version) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET password_hash=excluded.password_hash,version=excluded.version').run(project, password ? hashProjectPassword(password) : '', randomBytes(16).toString('hex'));
  db.prepare("DELETE FROM project_settings WHERE project_id=? AND setting_key='password'").run(project);
}
// Called after schema initialization but before any listener exists. VACUUM INTO is a consistent
// SQLite backup, including committed WAL content. Fail closed if backup or migration fails.
export function migrateProjectPasswords(db: DatabaseSync, dataDir?: string): string | null {
  const legacy = db.prepare("SELECT project_id,setting_value FROM project_settings WHERE setting_key='password'").all();
  let backup: string | null = null;
  if (legacy.length && dataDir) {
    const directory = path.join(dataDir, 'backups'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    backup = path.join(directory, 'before-project-password-' + Date.now() + '-' + randomBytes(8).toString('hex') + '.db');
    db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
    console.log('[Project password migration] Private rollback database: ' + backup);
  }
  db.exec('PRAGMA secure_delete=ON');
  db.exec('SAVEPOINT project_password_migration');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS project_passwords (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,password_hash TEXT NOT NULL,version TEXT NOT NULL)');
    for (const row of legacy) {
      const project = String(row.project_id), value = String(row.setting_value || '');
      if (!db.prepare('SELECT 1 FROM project_passwords WHERE project_id=?').get(project)) setProjectPassword(db, project, value.trim() ? value : '');
      db.prepare("DELETE FROM project_settings WHERE project_id=? AND setting_key='password'").run(project);
    }
    db.exec('RELEASE project_password_migration');
  } catch (error) { db.exec('ROLLBACK TO project_password_migration; RELEASE project_password_migration'); throw error; }
  if (legacy.length) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return backup;
}
export const projectCookieName = (project: string) => 'pahub_project_' + createHash('sha256').update(project).digest('hex').slice(0, 24);
