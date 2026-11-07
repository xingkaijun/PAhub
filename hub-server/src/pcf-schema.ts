import type { DatabaseSync } from 'node:sqlite';
export { validateJSON } from './pcf-v26.ts';
export const PCF_SCHEMA_VERSION = '1.0';
export const PCF_APP_VERSION = '2.6';

export function initializePcfSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pcf_index (
      project_id TEXT NOT NULL, drawing_id TEXT NOT NULL, document_id TEXT NOT NULL,
      rev INTEGER NOT NULL, file_path TEXT NOT NULL, total_comments INTEGER NOT NULL,
      open_comments INTEGER NOT NULL, current_round INTEGER NOT NULL, approval TEXT NOT NULL,
      rounds_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_client TEXT, updated_by_name TEXT,
      PRIMARY KEY (project_id, drawing_id)
    );
    CREATE TABLE IF NOT EXISTS pcf_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, drawing_id TEXT NOT NULL,
      rev INTEGER NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL, ip TEXT NOT NULL,
      ops_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, drawing_id, rev)
    );
    CREATE INDEX IF NOT EXISTS pcf_changes_drawing ON pcf_changes(project_id, drawing_id, rev);
    CREATE TABLE IF NOT EXISTS pcf_exports (
      export_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, drawing_id TEXT NOT NULL,
      document_id TEXT NOT NULL, base_rev INTEGER NOT NULL, round INTEGER NOT NULL,
      exported_at TEXT NOT NULL, exported_by_name TEXT NOT NULL, exported_by_ip TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('exported','imported','void')),
      filename TEXT NOT NULL, file_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pcf_exports_drawing ON pcf_exports(project_id,drawing_id,exported_at);
    CREATE TABLE IF NOT EXISTS pcf_export_batches (
      project_id TEXT NOT NULL, batch_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      filename TEXT NOT NULL, manifest_json TEXT NOT NULL, PRIMARY KEY(project_id,batch_id)
    );
  `);
}
