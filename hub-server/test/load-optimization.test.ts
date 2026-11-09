/// <reference types="vite/client" />
// Round 3 load optimisation: ETag/304 on project reads, drawings-by-id, compression and cache headers,
// and the store side (conditional refresh, drawing-changed merging only the changed drawings).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import http from 'node:http';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { compressibleType, negotiateEncoding, staticCacheControl } from '../src/http.ts';
import { etagMatches } from '../src/etag.ts';
import { createProjectsApi, projectsApi } from '../../services/api/projectsApi';
import type { Drawing, Project } from '../../types';

const P = 'proj-test-001', PROJECT = '/api/projects/' + P;

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-load-'));
  const dist = path.join(dir, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-AbCd1234.js"></script></head><body>' + 'x'.repeat(4000) + '</body></html>');
  await writeFile(path.join(dist, 'assets', 'index-AbCd1234.js'), 'export const big = ' + JSON.stringify('abcdefgh'.repeat(5000)) + ';\n');
  await writeFile(path.join(dist, 'assets', 'logo-Zz9yX8wV.png'), Buffer.alloc(5000, 7));
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'PAHUB_BASIC_AUTH', 'PAPC_DIST_DIR'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), API_TOKEN: '', PAHUB_BASIC_AUTH: '', PAPC_DIST_DIR: dist });
  const hub = await createHub({ host: '127.0.0.1' });  // no middleware: static files come from the temp dist
  hub.db.exec(await readFile(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const base = 'http://127.0.0.1:' + hub.port;
  // Raw node:http so the test sees exactly what goes over the wire (fetch would decode it).
  const wire = (url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request(base + url, { method: opts.method || 'GET', headers, agent: false }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
  const json = async (url: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: r.status === 304 ? null : await r.json() as any };
  };
  return { hub, base, wire, json, cleanup: async () => { await hub.close(); for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; await rm(dir, { recursive: true, force: true }); } };
}

test('project read: ETag, 304 with no body on If-None-Match (strong or weak), 200 with a new ETag after a change', async () => {
  const f = await fixture(); try {
    const first = await f.json(PROJECT, 'POST', {});
    assert.equal(first.status, 200);
    const sentTag = first.headers.get('etag')!;
    assert.match(sentTag, /^"[A-Za-z0-9_-]{32}"$/);
    const etag = sentTag;
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    const again = await f.wire(PROJECT, { method: 'POST', body: {}, headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304); assert.equal(again.body.length, 0, '304 carries no body');
    assert.equal((await f.wire(PROJECT, { method: 'POST', body: {}, headers: { 'If-None-Match': 'W/' + etag } })).status, 304, 'weak form of the same tag');
    assert.equal((await f.wire(PROJECT, { method: 'POST', body: {}, headers: { 'If-None-Match': '"other", ' + etag } })).status, 304, 'tag list');
    assert.equal((await f.wire(PROJECT, { method: 'POST', body: {}, headers: { 'If-None-Match': '"stale"' } })).status, 200);
    const d = first.body.drawings.find((x: any) => x.id === 'dwg-001');
    assert.equal((await f.json(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', baseRev: d.rev, base: { title: d.title }, changes: { title: 'Changed for etag' } }] })).status, 200);
    const changed = await f.json(PROJECT, 'POST', {}, { 'If-None-Match': etag });
    assert.equal(changed.status, 200, 'changed project is sent in full');
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal(changed.body.drawings.find((x: any) => x.id === 'dwg-001').title, 'Changed for etag');
    // Review tracker read has the same validator.
    const tracker = await f.json(PROJECT + '/review-tracker');
    const tag = tracker.headers.get('etag')!; assert.ok(tag);
    assert.equal((await f.wire(PROJECT + '/review-tracker', { headers: { 'If-None-Match': tag } })).status, 304);
    assert.equal(etagMatches('*', '"x"'), true); assert.equal(etagMatches(null, '"x"'), false);
  } finally { await f.cleanup(); }
});

test('drawings by id: only the named drawings, same shape and rev as the full read, missing ids listed, tracker rows scoped', async () => {
  const f = await fixture(); try {
    const full = (await f.json(PROJECT, 'POST', {})).body;
    f.hub.db.prepare("INSERT INTO review_tracker (project_id, drawing_id, reviewer_id, done) VALUES (?, 'dwg-002', 'engineer_a', 1)").run(P);
    f.hub.db.prepare("INSERT INTO review_tracker (project_id, drawing_id, reviewer_id, done) VALUES (?, 'dwg-003', 'engineer_b', 1)").run(P);
    const r = await f.json(PROJECT + '/drawings?ids=dwg-002,dwg-001&ids=nope');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.drawings.map((d: any) => d.id).sort(), ['dwg-001', 'dwg-002']);
    for (const d of r.body.drawings) assert.deepEqual(d, full.drawings.find((x: any) => x.id === d.id), d.id + ' identical to the full read (incl. rev, remarks, history)');
    assert.deepEqual(r.body.missing, ['nope']);
    assert.ok(Object.keys(r.body.reviewTracker).every(id => ['dwg-001', 'dwg-002'].includes(id)), 'tracker rows only for requested drawings');
    assert.equal(r.body.reviewTracker['dwg-003'], undefined);
    const fullTracker = (await f.json(PROJECT + '/review-tracker')).body;
    for (const id of ['dwg-001', 'dwg-002']) assert.deepEqual(r.body.reviewTracker[id], fullTracker[id], id + ' tracker rows as in the full tracker read');
    assert.equal(r.body.reviewTracker['dwg-002'].engineer_a.done, 1);
    assert.ok(r.headers.get('etag'));
    assert.equal((await f.json(PROJECT + '/drawings')).status, 400, 'ids required');
    assert.equal((await f.json('/api/projects/no-such/drawings?ids=a')).status, 404);
    assert.equal((await f.json(PROJECT + '/drawings?ids=' + Array.from({ length: 501 }, (_, i) => 'x' + i).join(','))).status, 400, 'bounded');
    // Password-protected project: same rule as the full read.
    f.hub.db.prepare("INSERT OR REPLACE INTO project_settings (project_id, setting_key, setting_value) VALUES (?, 'password', ?)").run(P, '密码1');
    assert.equal((await f.json(PROJECT + '/drawings?ids=dwg-001')).status, 401);
    assert.equal((await f.json(PROJECT + '/drawings?ids=dwg-001', 'GET', undefined, { 'X-Project-Password': 'wrong' })).status, 401);
    assert.equal((await f.json(PROJECT + '/drawings?ids=dwg-001', 'GET', undefined, { 'X-Project-Password': encodeURIComponent('密码1') })).status, 200);
  } finally { await f.cleanup(); }
});

test('compression: br preferred, gzip fallback, identity without Accept-Encoding, small bodies untouched, Vary, ETag kept', async () => {
  const f = await fixture(); try {
    const plain = await f.wire(PROJECT, { method: 'POST', body: {} });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(String(plain.headers.vary), /Accept-Encoding/);
    const br = await f.wire(PROJECT, { method: 'POST', body: {}, headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(Number(br.headers['content-length']), br.body.length);
    assert.deepEqual(brotliDecompressSync(br.body), plain.body, 'decodes to the identical JSON');
    assert.ok(br.body.length < plain.body.length / 3, 'br ' + br.body.length + ' vs ' + plain.body.length);
    assert.equal(br.headers.etag, plain.headers.etag, 'same validator whatever the encoding');
    assert.equal((await f.wire(PROJECT, { method: 'POST', body: {}, headers: { 'Accept-Encoding': 'br', 'If-None-Match': String(br.headers.etag) } })).status, 304, 'tag validates on a compressed read');
    const gz = await f.wire(PROJECT, { method: 'POST', body: {}, headers: { 'Accept-Encoding': 'gzip, br;q=0' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(gz.body), plain.body);
    const small = await f.wire('/api/projects/' + P + '/heartbeat', { headers: { 'Accept-Encoding': 'br' } });
    assert.ok(small.body.length < 1024); assert.equal(small.headers['content-encoding'], undefined, 'tiny responses are not compressed');
    // Online PCF page compresses too.
    await f.json('/api/pcf/' + P + '/dwg-001/create', 'POST', { clientId: 'load-test', clientName: 'T' });
    const pcfPlain = await f.wire('/pcf/' + P + '/dwg-001');
    const pcf = await f.wire('/pcf/' + P + '/dwg-001', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(pcfPlain.status, 200); assert.equal(pcf.headers['content-encoding'], 'br');
    assert.ok(pcf.body.length < pcfPlain.body.length, 'pcf ' + pcf.body.length + ' < ' + pcfPlain.body.length);
    assert.equal(brotliDecompressSync(pcf.body).length, pcfPlain.body.length);
    assert.equal(negotiateEncoding('gzip;q=0, br;q=0'), null); assert.equal(negotiateEncoding('*'), 'br'); assert.equal(negotiateEncoding(undefined), null);
    for (const t of ['application/json; charset=utf-8', 'text/html', 'application/javascript', 'text/css', 'image/svg+xml']) assert.equal(compressibleType(t), true, t);
    for (const t of ['image/png', 'image/jpeg', 'application/zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'font/woff2', 'text/event-stream']) assert.equal(compressibleType(t), false, t);
  } finally { await f.cleanup(); }
});

test('static cache headers: hashed /assets/ immutable for a year and compressed, index.html no-cache, images never re-encoded', async () => {
  const f = await fixture(); try {
    const js = await f.wire('/assets/index-AbCd1234.js', { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(js.status, 200);
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(js.headers['content-encoding'], 'br'); assert.match(String(js.headers.vary), /Accept-Encoding/);
    assert.equal(brotliDecompressSync(js.body).toString(), await readFile(path.join(process.env.PAPC_DIST_DIR!, 'assets', 'index-AbCd1234.js'), 'utf8'));
    const gz = await f.wire('/assets/index-AbCd1234.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    const html = await f.wire('/', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(html.headers['cache-control'], 'no-cache'); assert.equal(html.headers['content-encoding'], 'gzip');
    const spa = await f.wire('/some/client/route');
    assert.equal(spa.headers['cache-control'], 'no-cache', 'SPA fallback is index.html');
    const png = await f.wire('/assets/logo-Zz9yX8wV.png', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(png.headers['content-encoding'], undefined); assert.equal(png.body.length, 5000);
    assert.equal(png.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(staticCacheControl('/r', '/r/assets/plain.js'), 'public, max-age=3600', 'unhashed names keep the short cache');
    assert.equal(staticCacheControl('/r', '/r/assets/sub/x-AbCd1234.js'), 'public, max-age=3600');
  } finally { await f.cleanup(); }
});

// ---- client side -------------------------------------------------------------------------------

const drawing = (id: string, extra: Partial<Drawing> = {}): Drawing => ({ id, customId: id, drawingNo: id.toUpperCase(), title: 'title ' + id, discipline: 'Hull', assignees: ['A'], status: 'Reviewing', currentRound: 'A', version: 'A', manualCommentsCount: 0, manualOpenCommentsCount: 0, logs: [], remarks: [], statusHistory: [], rev: 'rev-' + id, ...extra } as any);

async function storeFixture(drawings: Drawing[]) {
  const { useStore } = await import('../../store');
  useStore.setState({ activeProjectId: 'p', isEditMode: false, saveConflict: null, error: null, reviewTracker: {},
    _dirtyDrawingIds: new Set(), _deletedDrawingIds: new Set(), _dirtyDrawingFields: {}, _dirtyDrawingBase: {}, _dirtyTrackerDrawingIds: new Set(), _dirtyTracker: false, _dirtyConf: false, _dirtyConfKeys: new Set(),
    data: { ...useStore.getState().data, projects: [{ id: 'p', name: 'P', conf: { reviewers: [], disciplineDefaults: {}, roundACycle: 14, otherRoundsCycle: 7 } as any, drawings: structuredClone(drawings) }] } } as any);
  return useStore;
}

test('drawing-changed merge: only the fetched drawings change, unsaved fields survive, result equals a full refresh', async () => {
  const local = [drawing('d1'), drawing('d2'), drawing('d3')];
  const remoteD2 = drawing('d2', { title: 'server title', discipline: 'Piping', rev: 'rev-d2-new' } as any);
  const remoteD4 = drawing('d4');
  const origDrawings = projectsApi.loadDrawings, origProject = projectsApi.loadProjectIfChanged, origTracker = projectsApi.loadReviewTrackerIfChanged;
  const calls: string[][] = [];
  projectsApi.loadDrawings = async (_p, ids) => { calls.push(ids); return { drawings: [remoteD2, remoteD4], missing: ['d3'], reviewTracker: { d2: { A: { done: 1, doneAt: 'x' } } } } as any; };
  try {
    const store = await storeFixture(local);
    store.getState().updateDrawing('d2', { title: 'my unsaved title' });
    const changed = await store.getState().refreshDrawingsPreservingDirty('p', ['d2', 'd3', 'd4']);
    assert.deepEqual(calls, [['d2', 'd3', 'd4']], 'one request with only the changed ids');
    const byId = Object.fromEntries(store.getState().data.projects[0].drawings.map(d => [d.id, d]));
    assert.deepEqual(Object.keys(byId).sort(), ['d1', 'd2', 'd4'], 'deleted d3 removed, new d4 added');
    assert.equal(byId.d2.title, 'my unsaved title', 'unsaved local field kept');
    assert.equal(byId.d2.discipline, 'Piping', 'other server field merged');
    assert.ok(store.getState()._dirtyDrawingIds.has('d2'), 'still dirty for the next save');
    assert.deepEqual(byId.d1, local[0], 'untouched drawing is the same data');
    assert.equal(store.getState().reviewTracker.d2.A.done, 1);
    assert.ok(changed >= 1);
    const partial = structuredClone(store.getState().data.projects[0]);
    const partialBase = structuredClone(store.getState()._dirtyDrawingBase);

    // Same situation via a full refresh must give the same project + conflict base.
    projectsApi.loadProjectIfChanged = async () => ({ id: 'p', name: 'P', conf: store.getState().data.projects[0].conf, drawings: [drawing('d1'), remoteD2, remoteD4] } as any);
    projectsApi.loadReviewTrackerIfChanged = async () => ({ d2: { A: { done: 1, doneAt: 'x' } } } as any);
    const store2 = await storeFixture(local);
    store2.getState().updateDrawing('d2', { title: 'my unsaved title' });
    await store2.getState().refreshProjectPreservingDirty('p');
    const sort = (p: Project) => ({ ...p, drawings: [...p.drawings].sort((a, b) => a.id.localeCompare(b.id)) });
    assert.deepEqual(sort(partial).drawings, sort(store2.getState().data.projects[0]).drawings, 'by-id merge == full-refresh merge');
    assert.deepEqual(partialBase, store2.getState()._dirtyDrawingBase, 'same base values for the 409 check');
  } finally { projectsApi.loadDrawings = origDrawings; projectsApi.loadProjectIfChanged = origProject; projectsApi.loadReviewTrackerIfChanged = origTracker; }
});

test('conditional refresh: 304 on both reads merges nothing and leaves state untouched', async () => {
  const origProject = projectsApi.loadProjectIfChanged, origTracker = projectsApi.loadReviewTrackerIfChanged;
  projectsApi.loadProjectIfChanged = async () => null; projectsApi.loadReviewTrackerIfChanged = async () => null;
  try {
    const store = await storeFixture([drawing('d1')]);
    const before = store.getState().data;
    assert.equal(await store.getState().refreshProjectPreservingDirty('p'), 0);
    assert.equal(store.getState().data, before, 'same state object, no re-render');
  } finally { projectsApi.loadProjectIfChanged = origProject; projectsApi.loadReviewTrackerIfChanged = origTracker; }
});

test('projects api: sends If-None-Match, reuses the held body on 304, shares identical in-flight reads, catch-up reads are not shared', async () => {
  const sent: { resource: string; inm: string | null }[] = [];
  let status = 200; const waiting: (() => void)[] = [];
  const client = { request: async (resource: string, init: any) => {
    sent.push({ resource, inm: new Headers(init.headers).get('If-None-Match') });
    if (status === -1) await new Promise<void>(r => { waiting.push(r); });
    if (status === 304) return new Response(null, { status: 304, headers: { ETag: '"t1"' } });
    return new Response(JSON.stringify({ id: 'p', name: 'P', drawings: [{ id: 'd1' }] }), { status: 200, headers: { ETag: '"t1"', 'Content-Type': 'application/json' } });
  }, json: async () => { throw new Error('unused'); } } as any;
  const api = createProjectsApi(client);
  const stub = { id: 'p', name: 'P', drawings: [] } as any;
  const first = await api.loadProject(stub);
  assert.equal(first.drawings.length, 1); assert.equal(sent[0].inm, null);
  status = 304;
  assert.equal(await api.loadProjectIfChanged(stub), null, '304 -> null (unchanged)');
  assert.equal(sent[1].inm, '"t1"');
  const reused = await api.loadProject(stub);
  assert.deepEqual(reused, first); assert.notEqual(reused, first, 'fresh object from the held body');
  status = -1;
  const a = api.loadProject(stub), b = api.loadProject(stub), c = api.loadProjectIfChanged(stub);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sent.length, 5, 'two identical loads share one request; the catch-up read goes on its own');
  status = 304; waiting.splice(0).forEach(r => r());
  await Promise.all([a, b, c]);
});
