import type { DatabaseSync } from 'node:sqlite';

// One-time compatibility bridge for import-d1 SQL dumps and pre-Hub databases.
export function migrateLegacyProjectPath(db: DatabaseSync): void {
  const names = db.prepare('PRAGMA table_info(projects)').all().map(row => row.name);
  if (names.includes('webdav_path') && !names.includes('storage_path')) db.exec('ALTER TABLE projects RENAME COLUMN webdav_path TO storage_path');
}

export function normalizeLegacySql(sql: string): string {
  // Old data-only dumps must insert into the new local schema; full dumps migrate on startup.
  return sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|\bwebdav_path\b/g, token => token === 'webdav_path' ? 'storage_path' : token);
}

export function normalizeLegacyExport(data: any): void {
  for (const entry of data?.projects || []) {
    if (entry?.project?.webdavPath !== undefined) {
      entry.project.storagePath ??= entry.project.webdavPath;
      delete entry.project.webdavPath;
    }
  }
}
