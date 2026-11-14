import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestUser } from './identity.ts';
export type AuditActor = Pick<RequestUser, 'id' | 'name'>;
export const auditContext = new AsyncLocalStorage<{ actor?: AuditActor; source: string }>();
export type AuditRow = { table: string; rowId?: string | null; projectId?: string | null; action: string; detail?: unknown; createdAt?: string; opTypes?: string[]; source?: string };
export function initializeIdentitySchema(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS kjx_users(id TEXT PRIMARY KEY,username TEXT NOT NULL,name TEXT NOT NULL,title TEXT,disciplines TEXT NOT NULL DEFAULT '[]',role TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL)");
  const columns = db.prepare('PRAGMA table_info(audit_log)').all().map(row => row.name);
  for (const column of ['actor_id', 'actor_name', 'source', 'op_types']) if (!columns.includes(column)) db.exec('ALTER TABLE audit_log ADD COLUMN ' + column + ' TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_id)');
}
export function writeAudit(db: DatabaseSync, row: AuditRow, actor: AuditActor | null | undefined = auditContext.getStore()?.actor) {
  return db.prepare("INSERT INTO audit_log(table_name,row_id,project_id,action,detail,created_at,actor_id,actor_name,source,op_types) VALUES(?,?,?,?,?,COALESCE(?,datetime('now')),?,?,?,?)").run(
    row.table, row.rowId ?? null, row.projectId ?? null, row.action, row.detail === undefined ? null : JSON.stringify(row.detail), row.createdAt ?? null,
    actor?.id ?? null, actor?.name ?? null, row.source ?? auditContext.getStore()?.source ?? 'background/offline', row.opTypes ? JSON.stringify(row.opTypes) : null,
  );
}
