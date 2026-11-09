import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../src/app.ts';
import { ADMIN_COOKIE, createAdminSession } from '../src/admin-session.ts';

const PASSWORD = 'permissions-admin-password';
const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'PAPC_DIST_DIR', 'API_TOKEN', 'ADMIN_PASSWORD', 'PAHUB_BASIC_AUTH'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));

type Hub = Awaited<ReturnType<typeof createHub>>;

async function fixture(options: { password?: string; apiToken?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-permissions-'));
  Object.assign(process.env, {
    PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'),
    PAPC_DIST_DIR: path.join(process.cwd(), 'dist'), API_TOKEN: options.apiToken || '', ADMIN_PASSWORD: options.password || '', PAHUB_BASIC_AUTH: '',
  });
  const hub = await createHub();
  hub.db.exec(await readFile(path.join(process.cwd(), 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const origin = 'http://127.0.0.1:' + hub.port;
  const request = async (url: string, init: RequestInit = {}) => fetch(origin + url, init);
  const login = async (password = PASSWORD) => {
    const response = await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const cookie = response.headers.get('set-cookie') || '';
    return { status: response.status, response, header: cookie.split(';')[0] };
  };
  const cleanup = async () => {
    await hub.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
  return { hub, origin, request, login, cleanup };
}

const jsonPost = (value: unknown, cookie?: string): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(value),
});

test('without ADMIN_PASSWORD everyone is an administrator (local development convenience)', async () => {
  process.env.ADMIN_PASSWORD = '';
  const f = await fixture();
  try {
    assert.equal(((await (await f.request('/api/session')).json()) as any).admin, true);
    const patch = await f.request('/api/projects/proj-test-001', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updatedDrawings: [{ id: 'dwg-001', changes: { title: 'Dev edit' } }] }) });
    assert.equal(patch.status, 200);
    assert.equal((await f.request('/api/projects/proj-test-001/review-tracker', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).status, 200);
  } finally { await f.cleanup(); }
});

test('session status, sign-in and sign-out set an httpOnly SameSite=Strict cookie', async () => {
  const f = await fixture({ password: PASSWORD });
  try {
    const anonymous = await (await f.request('/api/session')).json() as any;
    assert.deepEqual(anonymous, { admin: false, requiresPassword: true });
    const signedIn = await f.login();
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.response.headers.get('set-cookie') || '';
    assert.match(cookie, new RegExp('^' + ADMIN_COOKIE + '='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Max-Age=43200/);
    assert.deepEqual(await (await f.request('/api/session', { headers: { Cookie: signedIn.header } })).json(), { admin: true, requiresPassword: true });
    const out = await f.request('/api/session', { method: 'DELETE', headers: { Cookie: signedIn.header } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/);
    assert.equal(((await (await f.request('/api/session', { headers: { Cookie: signedIn.header } })).json()) as any).admin, true, 'logout clears the browser cookie; the stale value is still a valid signature until expiry');
  } finally { await f.cleanup(); }
});

test('anonymous callers get 403 on every administrator write and 200 after sign-in', async () => {
  const f = await fixture({ password: PASSWORD });
  try {
    const writes: Array<[string, RequestInit]> = [
      ['/api/projects/proj-test-001', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updatedDrawings: [{ id: 'dwg-001', changes: { title: 'Nope' } }] }) }],
      ['/api/projects/proj-test-001/review-tracker', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 'dwg-001': { engineer_a: { done: true } } }) }],
      ['/api/projects/proj-test-001/drawings/dwg-001/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Reviewing' }) }],
      ['/api/projects/proj-test-001/heartbeat', { method: 'PUT' }],
    ];
    for (const [url, init] of writes) {
      const denied = await f.request(url, init);
      assert.equal(denied.status, 403, url + ' anonymous');
      assert.match(((await denied.json()) as any).error, /Administrator permission required/);
    }
    // Reads stay open to reviewers.
    for (const url of ['/api/projects', '/api/projects/proj-test-001/review-tracker', '/api/projects/proj-test-001/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z']) {
      assert.equal((await f.request(url)).status, 200, url + ' read');
    }
    // Builder reply import is administrative, including its read-only status probe.
    const form = new FormData();
    form.append('files', new Blob(['not html']), 'notes.txt');
    assert.equal((await f.request('/api/projects/proj-test-001/builder-replies/preview', { method: 'POST', body: form })).status, 403);
    assert.equal((await f.request('/api/projects/proj-test-001/builder-replies/pending')).status, 403);

    const { header } = await f.login();
    for (const [url, init] of writes) {
      const allowed = await f.request(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: header } });
      assert.equal(allowed.status, 200, url + ' signed in');
    }
    assert.equal((await f.request('/api/projects/proj-test-001/builder-replies/pending', { headers: { Cookie: header } })).status, 200);
  } finally { await f.cleanup(); }
});

test('wrong passwords are rejected and repeated failures are rate limited per client address', async () => {
  const f = await fixture({ password: PASSWORD });
  try {
    for (let i = 0; i < 4; i++) {
      const attempt = await f.login('wrong-' + i);
      assert.equal(attempt.status, 401);
      assert.equal(attempt.response.headers.get('set-cookie'), null);
    }
    assert.equal((await f.login()).status, 200, 'a correct password still works before the limit');
    const failing = await fixture({ password: PASSWORD });
    try {
      let last = 0;
      for (let i = 0; i < 6; i++) last = (await failing.login('wrong-' + i)).status;
      assert.equal(last, 429);
      const limited = await failing.login();
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
    } finally { await failing.cleanup(); }
  } finally { await f.cleanup(); }
});

test('API_TOKEN still reaches the APIs and counts as administrator for the new checks', async () => {
  const f = await fixture({ password: PASSWORD, apiToken: 'machine-token' });
  try {
    assert.equal((await f.request('/api/projects')).status, 401, 'API_TOKEN still gates the API');
    const headers = { Authorization: 'Bearer machine-token', 'Content-Type': 'application/json' };
    assert.equal((await f.request('/api/projects/proj-test-001', { method: 'PATCH', headers, body: JSON.stringify({ updatedDrawings: [{ id: 'dwg-001', changes: { title: 'Machine edit' } }] }) })).status, 200);
  } finally { await f.cleanup(); }
});

test('PCF document edits are open to reviewers; JSON replacement and reply/import apply need an administrator', async () => {
  const f = await fixture({ password: PASSWORD });
  try {
    const base = '/api/pcf/proj-test-001/dwg-005';
    assert.equal((await f.request(base + '/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    const live = await (await f.request(base + '/data')).json() as any;
    const reviewerOps = await f.request(base + '/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'reviewer', baseRev: live.rev, batchId: '11111111-1111-4111-8111-111111111111', ops: [{ type: 'project.set', field: 'approval', baseRev: 0, value: 'Under review' }] }) });
    assert.equal(reviewerOps.status, 200, 'reviewers may edit the PCF document itself');

    const session = await (await f.request('/api/session')).json() as any;
    assert.equal(session.admin, false);

    // Plain document saves (no importJSON) stay open; replacement imports do not.
    const imported = await f.request(base + '/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'reviewer', baseRev: live.rev, data: live.data, importJSON: true }) });
    assert.equal(imported.status, 403);
    assert.equal((await f.request(base + '/imports', jsonPost({ step: 'preview', html: '' }))).status, 403);
    assert.equal((await f.request('/api/pcf/proj-test-001/exports/batch', jsonPost({ drawingIds: ['dwg-005'], batchId: '22222222-2222-4222-8222-222222222222' }))).status, 403);

    const { header } = await f.login();
    const adminPreview = await f.request(base + '/imports', { ...jsonPost({ step: 'preview', html: '' }), headers: { 'Content-Type': 'application/json', Cookie: header } });
    assert.notEqual(adminPreview.status, 403, 'administrators pass the permission check');
    assert.equal((await f.request('/api/pcf/proj-test-001/exports/batch', { ...jsonPost({ drawingIds: ['dwg-005'], batchId: '33333333-3333-4333-8333-333333333333' }), headers: { 'Content-Type': 'application/json', Cookie: header } })).status, 200);
    const page = await f.request('/pcf/proj-test-001/dwg-005').then(r => r.text());
    assert.match(page, /"admin":false/, 'the page tells the reviewer-only UI what it may show');
    const adminPage = await f.request('/pcf/proj-test-001/dwg-005', { headers: { Cookie: header } }).then(r => r.text());
    assert.match(adminPage, /"admin":true/);
  } finally { await f.cleanup(); }
});

test('sessions expire after 12 hours, tampering fails and a server restart invalidates them', async () => {
  let now = 1000;
  const clock = createAdminSession({ password: 'secret', now: () => now, apiToken: '' });
  const response = await clock.login(new Request('http://local/api/session', { method: 'POST', body: JSON.stringify({ password: 'secret' }) }));
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const request = (value: string) => new Request('http://local/api/session', { headers: { Cookie: value } });
  assert.equal(clock.isAdmin(request(cookie)), true);
  now = 1000 + 12 * 3600000 - 1;
  assert.equal(clock.isAdmin(request(cookie)), true, 'still valid just before expiry');
  now = 1000 + 12 * 3600000 + 1;
  assert.equal(clock.isAdmin(request(cookie)), false, 'expired');
  assert.equal(clock.isAdmin(request(cookie.replace(/\.(\w)/, '.x'))), false, 'tampered signature');
  // A new process has a new signing key: sessions do not survive a restart.
  const restarted = createAdminSession({ password: 'secret', now: () => 1000, apiToken: '' });
  assert.equal(restarted.isAdmin(request(cookie)), false);
});
