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

test('field PATCH changes only submitted columns and relations, retaining concurrent edits', async () => {
  const f = await fixture(); try {
    const original = (await f.project()).drawings.find((d: any) => d.id === 'dwg-001');
    await f.request('/api/projects/proj-test-001', 'PATCH', { updatedDrawings: [{ id: original.id, changes: { title: 'First user title', remarks: [{ id: 'new-remark', content: 'internal', createdAt: new Date().toISOString() }] } }] });
    const saved = await f.request('/api/projects/proj-test-001', 'PATCH', { updatedDrawings: [{ id: original.id, changes: { discipline: 'Second user discipline' } }] });
    assert.equal(saved.verification.ok, true);
    assert.equal(saved.drawings[0].title, 'First user title');
    const after = (await f.project()).drawings.find((d: any) => d.id === original.id);
    assert.equal(after.title, 'First user title'); assert.equal(after.discipline, 'Second user discipline');
    assert.deepEqual(after.assignees, original.assignees); assert.equal(after.remarks[0].content, 'internal');
  } finally { await f.cleanup(); }
});

test('write verification still detects a requested field silently ignored by SQLite', async () => {
  const f = await fixture(); try {
    f.hub.db.sqlite.exec("CREATE TRIGGER ignore_title BEFORE UPDATE OF title ON drawings BEGIN SELECT RAISE(IGNORE); END");
    const result = await f.request('/api/projects/proj-test-001', 'PATCH', { updatedDrawings: [{ id: 'dwg-001', changes: { title: 'must be verified' } }] });
    assert.equal(result.verification.ok, false);
    assert.ok(result.verification.mismatched[0].fields.includes('title'));
    assert.equal('__expected' in result.drawings[0], false);
  } finally { await f.cleanup(); }
});

test('native status endpoint owns AA -> AB and repeated status requests do not advance twice', async () => {
  const f = await fixture(); try {
    f.hub.db.sqlite.prepare("UPDATE drawings SET status='Waiting Reply',current_round='AA' WHERE id='dwg-001'").run();
    const endpoint = '/api/projects/proj-test-001/drawings/dwg-001/status';
    const changed = await f.request(endpoint, 'POST', { status: 'Reviewing' });
    assert.equal(changed.currentRound, 'AB'); assert.ok(changed.reviewDeadline);
    assert.equal((await f.request(endpoint, 'POST', { status: 'Reviewing' })).currentRound, 'AB');
    const cleared = await f.request(endpoint, 'POST', { status: 'Waiting Reply' }); assert.equal(cleared.reviewDeadline, null);
  } finally { await f.cleanup(); }
});

test('native Reviewing transition and a simultaneous PCF edit share the same queue', async () => {
  const f = await fixture(); try {
    await f.create(); f.hub.db.sqlite.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run();
    await Promise.all([
      f.request('/api/projects/proj-test-001/drawings/dwg-001/status', 'POST', { status: 'Reviewing' }),
      f.ops([{ type: 'comment.add', id: 'concurrent-comment', roundIdNew: 'concurrent-reply' }]),
    ]);
    const live = await f.live();
    const d = (await f.project()).drawings.find((d: any) => d.id === 'dwg-001');
    assert.equal(live.data.project.currentRound, 2); assert.equal(d.currentRound, 'B'); assert.equal(d.manualCommentsCount, 2);
    const result = await f.request('/api/projects/proj-test-001', 'PATCH', { updatedDrawings: [{ id: d.id, changes: { version: 'override', manualCommentsCount: 999, currentRound: 'ZZ' } }] });
    assert.equal(result.verification.ok, true); assert.equal(result.drawings[0].manualCommentsCount, 2); assert.equal(result.drawings[0].currentRound, 'B');
  } finally { await f.cleanup(); }
});

test('field PATCH can create a project and drawing without falling back to a whole-project PUT', async () => {
  const f = await fixture(); try {
    await f.request('/api/projects/new-project', 'PATCH', { projectName: 'New project', updatedDrawings: [{ id: 'new-drawing', changes: { title: 'New drawing', manualCommentsCount: 3, version: '0', status: 'Reviewing' } }], conf: { roundACycle: 1 } });
    const project = await f.request('/api/projects/new-project', 'POST', {});
    assert.equal(project.name, 'New project'); assert.equal(project.drawings[0].status, 'Reviewing'); assert.equal(project.drawings[0].manualCommentsCount, 3);
  } finally { await f.cleanup(); }
});

test('failed PCF round write rolls back status, summary, metadata and document', async () => {
  const f = await fixture(); try {
    await f.create(); f.hub.db.sqlite.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run();
    const before = await f.live();
    f.hub.db.sqlite.exec("CREATE TRIGGER fail_transition BEFORE INSERT ON pcf_changes BEGIN SELECT RAISE(ABORT,'simulated transition failure'); END");
    const response = await fetch('http://127.0.0.1:' + f.hub.port + '/api/projects/proj-test-001', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updatedDrawings: [{ id: 'dwg-001', changes: { status: 'Reviewing', title: 'must roll back' } }] }) });
    assert.equal(response.status, 500);
    const row: any = f.hub.db.sqlite.prepare("SELECT * FROM drawings WHERE id='dwg-001'").get();
    assert.equal(row.status, 'Waiting Reply'); assert.equal(row.current_round, 'A'); assert.notEqual(row.title, 'must roll back');
    assert.deepEqual(await f.live(), before);
  } finally { await f.cleanup(); }
});

test('legacy full PUT cannot replace PCF counts, round or version', async () => {
  const f = await fixture(); try {
    await f.create(); const stale = await f.project();
    await f.ops([{ type: 'roundRegister.set', round: 2, baseRev: 0, value: { revision: 'B' } }, { type: 'project.set', field: 'currentRound', value: 2, baseRev: 0 }, { type: 'comment.add', id: 'comment2', roundIdNew: 'reply2' }]);
    const result = await f.request('/api/projects/proj-test-001', 'PUT', { project: stale, reviewTracker: {} });
    assert.equal(result.verification.ok, true);
    const d = (await f.project()).drawings.find((d: any) => d.id === 'dwg-001');
    assert.equal(d.manualCommentsCount, 2); assert.equal(d.manualOpenCommentsCount, 2); assert.equal(d.currentRound, 'B'); assert.equal(d.version, 'B');
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
    const batchId = randomUUID();
    const imported = await f.request(f.base + 'imports', 'POST', { step: 'apply', html, previewToken: preview.previewToken, batchId });
    assert.equal(imported.data.project.currentRound, 2);
    assert.equal((await f.project()).drawings.find((d: any) => d.id === 'dwg-001').currentRound, 'B');
    await f.ops([{ type: 'comment.status', commentId: 'comment1', baseRev: 0, value: 'closed' }]);
    assert.equal((await f.live()).data.project.currentRound, 2);
    assert.equal((await f.project()).drawings.find((d: any) => d.id === 'dwg-001').currentRound, 'B');
    assert.deepEqual(await f.request(f.base + 'imports', 'POST', { step: 'apply', html, previewToken: preview.previewToken, batchId }), imported);
  } finally { await f.cleanup(); }
});
