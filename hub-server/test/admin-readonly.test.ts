import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../src/app.ts';

const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'PAPC_DIST_DIR', 'API_TOKEN', 'ADMIN_PASSWORD'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const dir = await mkdtemp(path.join(tmpdir(), 'pahub-admin-'));
Object.assign(process.env, {
  PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'),
  PAPC_DIST_DIR: path.join(process.cwd(), 'dist'), API_TOKEN: '',
});

async function withAdminPassword<T>(password: string | undefined, run: (base: string) => Promise<T>): Promise<T> {
  if (password === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = password;
  const hub = await createHub();
  try { return await run('http://127.0.0.1:' + hub.port); } finally { await hub.close(); }
}

async function login(base: string, password: string): Promise<string> {
  const response = await fetch(base + '/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  return (await response.json() as { token: string }).token;
}

test('without ADMIN_PASSWORD the admin console is disabled with no default password', async () => {
  await withAdminPassword(undefined, async base => {
    const page = await fetch(base + '/api/admin');
    assert.equal(page.status, 404);
    for (const candidate of ['papc-admin-2026', '', 'admin']) {
      assert.equal((await fetch(base + '/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: candidate }) })).status, 403);
    }
    assert.equal((await fetch(base + '/api/admin/api/tables')).status, 403);
  });
  await withAdminPassword('   ', async base => {
    assert.equal((await fetch(base + '/api/admin')).status, 404);
  });
});

test('with ADMIN_PASSWORD the admin console works and the old default is rejected', async () => {
  await withAdminPassword('phase0-admin', async base => {
    assert.equal((await fetch(base + '/api/admin')).status, 200);
    assert.equal((await fetch(base + '/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'papc-admin-2026' }) })).status, 401);
    const token = await login(base, 'phase0-admin');
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    const sql = async (query: string) => {
      const response = await fetch(base + '/api/admin/api/sql', { method: 'POST', headers, body: JSON.stringify({ query }) });
      return { status: response.status, body: await response.json() as { results?: unknown[]; error?: string } };
    };
    const read = await sql('SELECT COUNT(*) AS n FROM projects');
    assert.equal(read.status, 200);
    assert.ok(Array.isArray(read.body.results));
    for (const write of [
      'DELETE FROM projects',
      'INSERT INTO projects (id, name) VALUES (\'x\', \'x\')',
      'UPDATE projects SET name = \'x\'',
      'CREATE TABLE pahub_should_not_exist (id TEXT)',
      'DROP TABLE projects',
      `ATTACH DATABASE '${path.join(dir, 'attached.db').replace(/\\/g, '/')}' AS extra`,
      `/* hidden attach */ ATTACH DATABASE '${path.join(dir, 'papc.db').replace(/\\/g, '/')}' AS original`,
      'PRAGMA query_only=OFF',
      '-- SELECT is not a shield\nDELETE FROM projects',
    ]) {
      const attempt = await sql(write);
      assert.equal(attempt.status, 400, write);
      assert.match(attempt.body.error || '', /readonly|read-only|unable to open/i, write);
    }
    // An attached in-memory database is read-only too, so it cannot be used as a scratch write target.
    assert.equal((await sql("ATTACH DATABASE ':memory:' AS scratch")).status, 200);
    assert.equal((await sql('CREATE TABLE scratch.pahub_should_not_exist (id TEXT)')).status, 400);
    const stillThere = await sql('SELECT COUNT(*) AS n FROM projects');
    assert.equal(stillThere.status, 200);
    const objects = await sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'pahub_should_not_exist'");
    assert.deepEqual(objects.body.results, [{ n: 0 }]);
  });
});

test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
