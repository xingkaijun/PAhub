import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../src/app.ts';

const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'PAPC_DIST_DIR', 'API_TOKEN', 'ADMIN_PASSWORD', 'PAHUB_BASIC_AUTH'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const dir = await mkdtemp(path.join(tmpdir(), 'pahub-basic-auth-'));
Object.assign(process.env, {
  PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'),
  PAPC_DIST_DIR: path.join(process.cwd(), 'dist'), API_TOKEN: '', ADMIN_PASSWORD: '',
});

const credentials = (value: string) => ({ Authorization: 'Basic ' + Buffer.from(value).toString('base64') });

test('PAHUB_BASIC_AUTH unset: requests need no credentials', async () => {
  delete process.env.PAHUB_BASIC_AUTH;
  const hub = await createHub();
  try {
    const origin = 'http://127.0.0.1:' + hub.port;
    assert.equal((await fetch(origin + '/')).status, 200);
    assert.equal((await fetch(origin + '/api/health')).status, 200);
    assert.equal((await fetch(origin + '/api/projects')).status, 200);
  } finally { await hub.close(); }
});

test('PAHUB_BASIC_AUTH set: static, API and SSE require Basic credentials', async () => {
  process.env.PAHUB_BASIC_AUTH = 'pahub:s3cret';
  const hub = await createHub();
  try {
    const origin = 'http://127.0.0.1:' + hub.port;
    for (const url of ['/', '/api/health', '/api/projects', '/api/projects/proj-test-001/events', '/api/pcf/proj-test-001/index']) {
      const refused = await fetch(origin + url);
      assert.equal(refused.status, 401, 'unauthenticated ' + url);
      assert.match(refused.headers.get('www-authenticate') || '', /^Basic realm="PAhub"/);
      assert.deepEqual(await refused.json(), { error: 'Unauthorized' });
      assert.equal((await fetch(origin + url, { headers: credentials('pahub:wrong') })).status, 401, 'wrong password ' + url);
      assert.equal((await fetch(origin + url, { headers: credentials('other:s3cret') })).status, 401, 'wrong user ' + url);
      assert.equal((await fetch(origin + url, { headers: { Authorization: 'Bearer s3cret' } })).status, 401, 'bearer is not basic ' + url);
    }
    assert.equal((await fetch(origin + '/', { headers: credentials('pahub:s3cret') })).status, 200);
    assert.equal((await fetch(origin + '/api/health', { headers: credentials('pahub:s3cret') })).status, 200);
    assert.equal((await fetch(origin + '/api/projects', { headers: credentials('pahub:s3cret') })).status, 200);
    const abort = new AbortController();
    const events = await fetch(origin + '/api/projects/proj-test-001/events', { headers: credentials('pahub:s3cret'), signal: abort.signal });
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type') || '', /text\/event-stream/);
    abort.abort();
  } finally { await hub.close(); }
});

test('PAHUB_BASIC_AUTH without a colon is rejected at startup', async () => {
  process.env.PAHUB_BASIC_AUTH = 'missing-colon';
  await assert.rejects(createHub(), /PAHUB_BASIC_AUTH must be <username>:<password>/);
  process.env.PAHUB_BASIC_AUTH = '';
});

test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
