import type { DatabaseSync } from 'node:sqlite';

export type KjxUser = { id: string; username: string; name: string; title: string | null; disciplines: string[]; role: string };

export function upsertKjxUser(db: DatabaseSync, user: KjxUser, at = new Date().toISOString()): void {
  db.prepare(`INSERT INTO kjx_users (id, username, name, title, disciplines, role, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username=excluded.username, name=excluded.name, title=excluded.title,
      disciplines=excluded.disciplines, role=excluded.role, last_seen=excluded.last_seen`)
    .run(user.id, user.username, user.name, user.title, JSON.stringify(user.disciplines), user.role, at, at);
}

export function getKjxUser(db: DatabaseSync, id: string): (KjxUser & { first_seen: string; last_seen: string }) | undefined {
  const row = db.prepare('SELECT * FROM kjx_users WHERE id=?').get(id);
  if (!row) return undefined;
  return { id: String(row.id), username: String(row.username), name: String(row.name), title: row.title === null ? null : String(row.title), disciplines: JSON.parse(String(row.disciplines)), role: String(row.role), first_seen: String(row.first_seen), last_seen: String(row.last_seen) };
}
