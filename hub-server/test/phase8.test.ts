import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../src/app.ts';
import { PcfRealtime } from '../src/pcf-realtime.ts';
import { currentTemplate, upgradeFile } from '../src/pcf-template.ts';
import { parseHTML } from '../src/pcf-storage.ts';
import { externalData, standaloneHTML } from '../src/pcf-exchange.ts';
import { mergeProjectPreservingDirty } from '../../services/data/mergeProject.ts';

const actor = (clientId: string) => ({ clientId, clientName: clientId, ip: '127.0.0.1' });
const eventState = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, { decoder: TextDecoder; buffer: string }>();
async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, type: string, timeoutMs = 1500) {
  const state = eventState.get(reader) || { decoder: new TextDecoder(), buffer: '' }; eventState.set(reader, state);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
      for (;;) {
        const end = state.buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = state.buffer.slice(0, end); state.buffer = state.buffer.slice(end + 2);
          if (frame.includes('event: ' + type + '\n')) return JSON.parse(frame.split('\ndata: ')[1]);
          continue;
        }
        const chunk = await reader.read(); if (chunk.done) throw Error('SSE closed');
        state.buffer += state.decoder.decode(chunk.value, { stream: true });
      }
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('Timed out waiting for ' + type)), timeoutMs); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}

test('phase 8: projects have isolated presence counts and drawing-changed events', async () => {
  const rt = new PcfRealtime();
  const a = new AbortController(), b = new AbortController();
  const ra = rt.projectStream('project-a', a.signal), rb = rt.projectStream('project-b', b.signal);
  const ar = ra.body!.getReader(), br = rb.body!.getReader();
  try {
    assert.deepEqual(await nextEvent(ar, 'presence'), { drawings: {} });
    assert.deepEqual(await nextEvent(br, 'presence'), { drawings: {} });
    rt.projectChanged('project-a', 'drawing-1', ['round:r1:owner']);
    assert.deepEqual(await nextEvent(ar, 'drawing-changed'), { drawingId: 'drawing-1', fields: ['round:r1:owner'] });
    assert.equal((rt as any).projectListeners.get('project-b').size, 1);
  } finally { a.abort(); b.abort(); rt.close(); }
  assert.equal((rt as any).projectConnections.size, 0);
});

test('phase 8: project event route requires configured Bearer token and cleans up closed streams', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-phase8-events-'));
  const old = Object.fromEntries(['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: 'phase8-secret' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    hub = await createHub(); const base = 'http://127.0.0.1:' + hub.port;
    assert.equal((await fetch(base + '/api/projects/project-a/events')).status, 401);
    const response = await fetch(base + '/api/projects/project-a/events', { headers: { Authorization: 'Bearer phase8-secret' } });
    assert.equal(response.status, 200); const reader = response.body!.getReader();
    assert.deepEqual(await nextEvent(reader, 'presence'), { drawings: {} });
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(hub.server.listening, true);
  } finally {
    await hub?.close();
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(temp, { recursive: true, force: true });
  }
});

test('phase 8: two PCF tabs count independently and closing one decrements presence', async () => {
  const rt = new PcfRealtime(), one = new AbortController(), two = new AbortController(), project = new AbortController();
  const p = rt.projectStream('p', project.signal), pr = p.body!.getReader(); await nextEvent(pr, 'presence');
  const first = rt.stream('p/d', actor('tab-one'), 0, 0, one.signal), second = rt.stream('p/d', actor('tab-two'), 0, 0, two.signal);
  const fr = first.body!.getReader(), sr = second.body!.getReader();
  try {
    await nextEvent(fr, 'hello'); await nextEvent(sr, 'hello');
    let counts = await nextEvent(pr, 'presence');
    while ((counts.drawings.d || 0) !== 2) counts = await nextEvent(pr, 'presence');
    one.abort(); await nextEvent(fr, 'presence').catch(() => null);
    counts = await nextEvent(pr, 'presence'); while ((counts.drawings.d || 0) !== 1) counts = await nextEvent(pr, 'presence');
  } finally { one.abort(); two.abort(); project.abort(); rt.close(); }
});

test('phase 8: presence timeout is swept and published within the two-second window', async () => {
  let now = 0; const rt = new PcfRealtime(undefined, () => now), controller = new AbortController();
  rt.update('p/d', actor('tab'), null); const response = rt.projectStream('p', controller.signal), reader = response.body!.getReader();
  try {
    await nextEvent(reader, 'presence'); now = 60000; rt.sweep();
    const expired = await nextEvent(reader, 'presence'); assert.deepEqual(expired, { drawings: {} });
  } finally { controller.abort(); rt.close(); }
});

test('phase 8: PAPC single-project save notification reports affected drawings', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-phase8-papc-'));
  const old = Object.fromEntries(['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db') });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    hub = await createHub();
    const sql = await readFile(path.resolve('worker/sql/seed-test-data.sql'), 'utf8'); hub.db.sqlite.exec(sql);
    const base = 'http://127.0.0.1:' + hub.port;
    const stream = await fetch(base + '/api/projects/proj-test-001/events'), reader = stream.body!.getReader();
    await nextEvent(reader, 'presence');
    const loaded = await fetch(base + '/api/projects/proj-test-001', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: null }) }).then(r => r.json());
    const drawing = loaded.drawings.find((row: any) => row.id === 'dwg-005');
    const saved = await fetch(base + '/api/projects/proj-test-001', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updatedDrawings: [{ ...drawing, title: drawing.title + ' realtime' }] }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(await nextEvent(reader, 'drawing-changed'), { drawingId: 'dwg-005', fields: ['project-data'] });
    await reader.cancel();
  } finally {
    await hub?.close();
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(temp, { recursive: true, force: true });
  }
});

test('phase 8: v5 template upgrade dry-run leaves source untouched', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-phase8-upgrade-'));
  try {
    const file = path.join(temp, 'legacy.html'); const source = currentTemplate().replace('content="6"', 'content="5"');
    await writeFile(file, source); const dry = upgradeFile(file, true);
    assert.equal(dry.from, 5); assert.equal(dry.to, 6); assert.equal(dry.status, 'would-upgrade'); assert.equal(await readFile(file, 'utf8'), source);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('phase 8: v5 template upgrade creates backup and atomically writes v6', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-phase8-upgrade-'));
  try {
    const file = path.join(temp, 'legacy.html'); const source = currentTemplate().replace('content="6"', 'content="5"');
    await writeFile(file, source); const result = upgradeFile(file);
    assert.equal(result.status, 'upgraded'); assert.equal(result.from, 5); assert.equal(result.to, 6);
    assert.equal((await readFile(result.backup!, 'utf8')), source);
    assert.match(await readFile(file, 'utf8'), /name="pahub-template-version" content="6"/);
    const upgradedData = parseHTML(await readFile(file, 'utf8')); delete upgradedData.hub;
    assert.deepEqual(upgradedData, parseHTML(source));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('phase 8: exported shipyard HTML omits hosted Export and Import controls', () => {
  const data = parseHTML(currentTemplate()); const output = standaloneHTML(externalData(data));
  assert.doesNotMatch(output, /id="pahub-export"|id="pahub-import"|id="pahub-context"/);
  assert.doesNotMatch(output, /credential/);
});

test('phase 8: project refresh updates clean drawings and protects dirty drawing, config and tracker', () => {
  const drawing = (id: string, title: string) => ({ id, title, drawingNo: id, status: 'Pending', currentRound: 'A', statusHistory: [], remarks: [] });
  const local = { id: 'merge-project', name: 'Project', conf: { password: '', marker: 'local config' }, snapshots: [], drawings: [drawing('clean', 'old'), drawing('dirty', 'local edit'), drawing('deleted', 'removed locally')] };
  const remote = { ...local, conf: { password: '', marker: 'remote config' }, drawings: [drawing('clean', 'remote update'), drawing('dirty', 'remote edit'), drawing('deleted', 'remote still present'), drawing('new', 'new remote drawing')] };
  const remoteTracker = { clean: { reviewer: { done: true } }, dirty: { reviewer: { done: false }, remoteOnly: { done: true } } };
  const localTracker = { dirty: { reviewer: { done: true, doneAt: 'local' } } };
  const merged = mergeProjectPreservingDirty(local as any, remote as any, new Set(['dirty']), new Set(['deleted']), true,
    localTracker as any, remoteTracker as any, new Set(['dirty']), true);
  assert.equal(merged.project.drawings.find(d => d.id === 'clean')?.title, 'remote update');
  assert.equal(merged.project.drawings.find(d => d.id === 'dirty')?.title, 'local edit');
  assert.equal(merged.project.drawings.some(d => d.id === 'deleted'), false);
  assert.equal(merged.project.drawings.find(d => d.id === 'new')?.title, 'new remote drawing');
  assert.equal((merged.project.conf as any).marker, 'local config');
  assert.deepEqual(merged.reviewTracker.dirty, { reviewer: { done: true, doneAt: 'local' }, remoteOnly: { done: true } });
});
