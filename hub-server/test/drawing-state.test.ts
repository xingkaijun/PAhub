import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData } from '../src/pcf-storage.ts';
import { blankContent } from '../src/pcf-model.ts';
import { mergeProjectPreservingDirty } from '../../services/data/mergeProject';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-drawing-state-'));
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'PAHUB_BASIC_AUTH'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), API_TOKEN: '', PAHUB_BASIC_AUTH: '' });
  const hub = await createHub({ host: '127.0.0.1', middleware: (_req, _res, next) => next() });
  hub.db.sqlite.exec(await readFile(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
  const base = '/api/pcf/proj-test-001/dwg-001/';
  const request = async (url: string, method = 'GET', body?: any) => {
    const r = await fetch('http://127.0.0.1:' + hub.port + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(r.status, 200, await r.clone().text()); return await r.json() as any;
  };
  const project = () => request('/api/projects/proj-test-001', 'POST', {});
  const live = () => request(base + 'data');
  const ops = async (operations: any[]) => request(base + 'ops', 'POST', { clientId: 'test', baseRev: (await live()).rev, ops: operations });
  const create = async () => {
    await request(base + 'create', 'POST', {});
    await ops([{ type: 'comment.add', id: 'comment1', roundIdNew: 'reply1' }]);
  };
  return { hub, request, project, live, ops, create, base, cleanup: async () => { await hub.close(); for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; await rm(dir, { recursive: true, force: true }); } };
}

test('scenario A: dirty legacy row cannot overwrite a newer PCF summary', async () => {
  const f = await fixture(); try {
    await f.create();
    const stale = await f.project();
    const local = { ...stale, drawings: stale.drawings.map((d: any) => d.id === 'dwg-001' ? { ...d, title: 'Unsaved title' } : d) };
    await f.ops([{ type: 'comment.add', id: 'comment2', roundIdNew: 'reply2' }, { type: 'roundRegister.set', round: 1, baseRev: 0, value: { revision: 'PCF revision' } }]);
    const merged = mergeProjectPreservingDirty(local, await f.project(), new Set(['dwg-001']), new Set(), false, {}, {}, new Set(), false);
    const saved = await f.request('/api/projects/proj-test-001', 'PATCH', { updatedDrawings: [merged.project.drawings.find(d => d.id === 'dwg-001')] });
    assert.equal(saved.verification.ok, true);
    const drawing = (await f.project()).drawings.find((d: any) => d.id === 'dwg-001');
    assert.equal(drawing.title, 'Unsaved title');
    assert.equal(drawing.manualCommentsCount, 2);
    assert.equal(drawing.manualOpenCommentsCount, 2);
    assert.equal(drawing.version, 'PCF revision');
  } finally { await f.cleanup(); }
});

test('scenario B: legacy Waiting Reply -> Reviewing advances PCF and survives a PCF save', async () => {
  const f = await fixture(); try {
    await f.create(); f.hub.db.sqlite.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run();
    const drawing = (await f.project()).drawings.find((d: any) => d.id === 'dwg-001');
    const saved = await f.request('/api/projects/proj-test-001', 'PATCH', { updatedDrawings: [{ ...drawing, status: 'Reviewing', currentRound: 'B' }] });
    assert.equal(saved.verification.ok, true);
    await f.ops([{ type: 'comment.status', commentId: 'comment1', baseRev: 0, value: 'closed' }]);
    assert.equal((await f.live()).data.project.currentRound, 2);
    assert.equal((await f.project()).drawings.find((d: any) => d.id === 'dwg-001').currentRound, 'B');
  } finally { await f.cleanup(); }
});

test('scenario C: importing a Builder reply then closing a comment retains the new round', async () => {
  const f = await fixture(); try {
    await f.create(); await f.ops([{ type: 'content.set', commentId: 'comment1', roundId: 'reply1', side: 'owner', baseRev: 0, value: { ...blankContent(), text: 'Owner note' } }]);
    const exported = await f.request(f.base + 'exports', 'POST', {});
    const download = await fetch('http://127.0.0.1:' + f.hub.port + f.base + 'exports/' + exported.exportId + '/download').then(r => r.text());
    const reply = parseHTML(download); reply.comments[0].rounds[0].reply = { ...blankContent(), text: 'Builder reply' };
    const html = replaceData(download, reply);
    f.hub.db.sqlite.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run();
    const preview = await f.request(f.base + 'imports', 'POST', { step: 'preview', html });
    await f.request(f.base + 'imports', 'POST', { step: 'apply', html, previewToken: preview.previewToken, batchId: randomUUID() });
    assert.equal((await f.project()).drawings.find((d: any) => d.id === 'dwg-001').currentRound, 'B');
    await f.ops([{ type: 'comment.status', commentId: 'comment1', baseRev: 0, value: 'closed' }]);
    assert.equal((await f.live()).data.project.currentRound, 2);
    assert.equal((await f.project()).drawings.find((d: any) => d.id === 'dwg-001').currentRound, 'B');
  } finally { await f.cleanup(); }
});
