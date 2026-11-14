CREATE TABLE IF NOT EXISTS kjx_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  disciplines TEXT NOT NULL DEFAULT '[]',
  role TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
