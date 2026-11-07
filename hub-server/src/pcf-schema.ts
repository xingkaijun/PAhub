import type { DatabaseSync } from 'node:sqlite';

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
  `);
}
