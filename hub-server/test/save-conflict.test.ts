import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';

const PROJECT = '/api/projects/proj-test-001';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-save-conflict-'));
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'PAHUB_BASIC_AUTH'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), API_TOKEN: '', PAHUB_BASIC_AUTH: '' });
  const hub = await createHub({ host: '127.0.0.1', middleware: (_req, _res, next) => next() });
  hub.db.exec(await readFile(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const raw = async (url: string, method = 'GET', body?: any) => {
    const r = await fetch('http://127.0.0.1:' + hub.port + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const ok = async (url: string, method = 'GET', body?: any) => {
    const r = await raw(url, method, body);
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
  };
  const load = async () => (await ok(PROJECT, 'POST', {})).drawings as any[];
  const drawing = async (id: string) => (await load()).find(d => d.id === id);
  const patch = (updatedDrawings: any[]) => raw(PROJECT, 'PATCH', { updatedDrawings });
  return { hub, raw, ok, load, drawing, patch, cleanup: async () => { await hub.close(); for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; await rm(dir, { recursive: true, force: true }); } };
}

test('A/B: stale save of another field keeps B title and remark (field-level merge, no silent overwrite)', async () => {
  const f = await fixture(); try {
    const opened = await f.drawing('dwg-001');                  // A and B open the same snapshot
    assert.match(opened.rev, /^[0-9a-f]{16}$/);
    const b = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, base: { title: opened.title }, changes: { title: 'B title' },
      remarkOps: { add: [{ id: 'remark-b', content: 'B remark', createdAt: '2026-11-09T00:00:00.000Z' }] } }]);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.notEqual(b.body.drawings[0].rev, opened.rev);
    const a = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, base: { discipline: opened.discipline }, changes: { discipline: 'A discipline' } }]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const after = await f.drawing('dwg-001');
    assert.equal(after.title, 'B title');
    assert.equal(after.discipline, 'A discipline');
    assert.deepEqual(after.remarks.map((r: any) => [r.id, r.content]).sort(), [['remark-b', 'B remark'], ['rmk-001', 'Check stiffener spacing'], ['rmk-002', 'Update material spec']], 'B remark added, seeded remarks untouched');
    assert.deepEqual([...after.assignees].sort(), [...opened.assignees].sort());
    assert.equal(after.rev, a.body.drawings[0].rev, 'write response and project load agree on rev');
  } finally { await f.cleanup(); }
});

test('A/B: old-style full-drawing save from stale data is rejected with 409 and changes nothing', async () => {
  const f = await fixture(); try {
    const opened = await f.drawing('dwg-001');
    await f.ok(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', baseRev: opened.rev, base: { title: opened.title }, changes: { title: 'B title' },
      remarkOps: { add: [{ id: 'remark-b', content: 'B remark', createdAt: '2026-11-09T00:00:00.000Z' }] } }] });
    const beforeA = await f.drawing('dwg-001');
    // Exactly what main 70a01e3 sent: every field of A's stale copy, only discipline edited.
    const { rev, hasPcf, logs, statusHistory, ...stale } = opened;
    const a = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, base: stale, changes: { ...stale, discipline: 'A discipline' } }]);
    assert.equal(a.status, 409, JSON.stringify(a.body));
    assert.equal(a.body.code, 'DRAWING_CONFLICT');
    assert.equal(a.body.conflicts[0].id, 'dwg-001');
    assert.deepEqual([...a.body.conflicts[0].fields].sort(), ['remarks', 'title']);
    assert.equal(a.body.conflicts[0].current.title, 'B title', '409 carries the latest server row');
    const after = await f.drawing('dwg-001');
    assert.deepEqual(after, beforeA, 'nothing from the rejected batch was written');
  } finally { await f.cleanup(); }
});

test('same-field conflict returns 409 and rolls back the whole batch', async () => {
  const f = await fixture(); try {
    const opened = await f.load();
    const d1 = opened.find(d => d.id === 'dwg-001'), d2 = opened.find(d => d.id === 'dwg-002');
    await f.ok(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', baseRev: d1.rev, base: { title: d1.title }, changes: { title: 'B title' } }] });
    const a = await f.patch([
      { id: 'dwg-002', baseRev: d2.rev, base: { title: d2.title }, changes: { title: 'A title on 002' } },
      { id: 'dwg-001', baseRev: d1.rev, base: { title: d1.title }, changes: { title: 'A title' } },
    ]);
    assert.equal(a.status, 409, JSON.stringify(a.body));
    assert.deepEqual(a.body.conflicts.map((c: any) => [c.id, c.fields]), [['dwg-001', ['title']]]);
    assert.equal((await f.drawing('dwg-001')).title, 'B title');
    assert.equal((await f.drawing('dwg-002')).title, d2.title, 'non-conflicting drawing in the same batch was rolled back');
  } finally { await f.cleanup(); }
});

test('saving the value the server already holds, or a patch without baseRev, is not a conflict', async () => {
  const f = await fixture(); try {
    const opened = await f.drawing('dwg-001');
    await f.ok(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', baseRev: opened.rev, base: { title: opened.title }, changes: { title: 'Same title' } }] });
    const a = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, base: { title: opened.title }, changes: { title: 'Same title' } }]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const legacy = await f.patch([{ id: 'dwg-001', changes: { discipline: 'No baseRev' } }]);
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    const created = await f.patch([{ id: 'dwg-new', changes: { customId: 'NEW-1', drawingNo: 'NEW-1', title: 'New drawing', status: 'Pending' } }]);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await f.drawing('dwg-new')).title, 'New drawing');
  } finally { await f.cleanup(); }
});

test('saving a drawing someone else deleted returns 409 instead of recreating it', async () => {
  const f = await fixture(); try {
    const opened = await f.drawing('dwg-002');
    await f.ok(PROJECT, 'PATCH', { deletedDrawingIds: ['dwg-002'] });
    const a = await f.patch([{ id: 'dwg-002', baseRev: opened.rev, base: { title: opened.title }, changes: { title: 'Edit after delete' } }]);
    assert.equal(a.status, 409, JSON.stringify(a.body));
    assert.deepEqual(a.body.conflicts[0].fields, ['deleted']);
    assert.equal(a.body.conflicts[0].current, null);
    assert.equal(await f.drawing('dwg-002'), undefined);
  } finally { await f.cleanup(); }
});

test('remark ops add, update and delete single rows; untouched remarks survive', async () => {
  const f = await fixture(); try {
    let d = await f.drawing('dwg-001');
    const add = (id: string, content: string) => ({ id, content, createdAt: '2026-11-09T0' + id.slice(-1) + ':00:00.000Z' });
    let r = await f.patch([{ id: 'dwg-001', baseRev: d.rev, changes: {}, remarkOps: { add: [add('r1', 'one'), add('r2', 'two'), add('r3', 'three')] } }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    d = await f.drawing('dwg-001');
    r = await f.patch([{ id: 'dwg-001', baseRev: d.rev, changes: {}, remarkOps: {
      update: [{ id: 'r2', content: 'two edited', resolved: true, base: { content: 'two', resolved: false } }],
      remove: [{ id: 'r3', base: { content: 'three', resolved: false } }],
      add: [add('r4', 'four')],
    } }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await f.drawing('dwg-001');
    const byId = Object.fromEntries(after.remarks.map((x: any) => [x.id, x]));
    assert.deepEqual(Object.keys(byId).sort(), ['r1', 'r2', 'r4', 'rmk-001', 'rmk-002']);
    assert.equal(byId.r1.content, 'one'); assert.equal(byId.r1.createdAt, '2026-11-09T01:00:00.000Z');
    assert.equal(byId.r2.content, 'two edited'); assert.equal(byId.r2.resolved, 1);
    assert.equal(byId.r4.content, 'four');
  } finally { await f.cleanup(); }
});

test('concurrent remark edits merge when they touch different remarks and conflict on the same one', async () => {
  const f = await fixture(); try {
    let d = await f.drawing('dwg-001');
    await f.ok(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', baseRev: d.rev, changes: {}, remarkOps: { add: [
      { id: 'r1', content: 'one', createdAt: '2026-11-09T01:00:00.000Z' }, { id: 'r2', content: 'two', createdAt: '2026-11-09T02:00:00.000Z' }] } }] });
    const opened = await f.drawing('dwg-001');
    // B adds a remark and edits r1; A (stale) deletes r2: both survive.
    await f.ok(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', baseRev: opened.rev, changes: {}, remarkOps: {
      add: [{ id: 'rb', content: 'B new', createdAt: '2026-11-09T03:00:00.000Z' }], update: [{ id: 'r1', content: 'one by B', base: { content: 'one', resolved: false } }] } }] });
    const a = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, changes: {}, remarkOps: { remove: [{ id: 'r2', base: { content: 'two', resolved: false } }] } }]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    d = await f.drawing('dwg-001');
    assert.deepEqual(d.remarks.map((x: any) => [x.id, x.content]).sort(), [['r1', 'one by B'], ['rb', 'B new'], ['rmk-001', 'Check stiffener spacing'], ['rmk-002', 'Update material spec']]);
    // A (still stale) edits r1, which B already changed: 409, B's text stays.
    const sameRemark = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, changes: {}, remarkOps: { update: [{ id: 'r1', content: 'one by A', base: { content: 'one', resolved: false } }] } }]);
    assert.equal(sameRemark.status, 409, JSON.stringify(sameRemark.body));
    assert.deepEqual(sameRemark.body.conflicts[0].fields, ['remarks']);
    // A deletes r1 that B edited meanwhile: 409 as well.
    const deleteEdited = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, changes: {}, remarkOps: { remove: [{ id: 'r1', base: { content: 'one', resolved: false } }] } }]);
    assert.equal(deleteEdited.status, 409, JSON.stringify(deleteEdited.body));
    // A edits r2, which was already deleted: 409.
    const editDeleted = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, changes: {}, remarkOps: { update: [{ id: 'r2', content: 'two by A', base: { content: 'two', resolved: false } }] } }]);
    assert.equal(editDeleted.status, 409, JSON.stringify(editDeleted.body));
    assert.deepEqual((await f.drawing('dwg-001')).remarks.map((x: any) => [x.id, x.content]).sort(), [['r1', 'one by B'], ['rb', 'B new'], ['rmk-001', 'Check stiffener spacing'], ['rmk-002', 'Update material spec']]);
  } finally { await f.cleanup(); }
});

test('legacy full remarks list deletes only missing rows instead of rewriting the set', async () => {
  const f = await fixture(); try {
    await f.ok(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', changes: { remarks: [
      { id: 'r1', content: 'one', createdAt: '2026-11-09T01:00:00.000Z' }, { id: 'r2', content: 'two', createdAt: '2026-11-09T02:00:00.000Z' }] } }] });
    await f.ok(PROJECT, 'PATCH', { updatedDrawings: [{ id: 'dwg-001', changes: { remarks: [{ id: 'r1', content: 'one', createdAt: 'ignored-on-update', resolved: true }] } }] });
    const after = await f.drawing('dwg-001');
    assert.deepEqual(after.remarks.map((x: any) => [x.id, x.createdAt, x.resolved]), [['r1', '2026-11-09T01:00:00.000Z', 1]], 'only rows missing from the list were deleted');
  } finally { await f.cleanup(); }
});

test('rev moves when other writers change the row, so stale app saves are still checked', async () => {
  const f = await fixture(); try {
    const opened = await f.drawing('dwg-001');
    f.hub.db.prepare("UPDATE drawings SET title='Changed by import' WHERE id='dwg-001'").run();
    const reloaded = await f.drawing('dwg-001');
    assert.notEqual(reloaded.rev, opened.rev);
    const a = await f.patch([{ id: 'dwg-001', baseRev: opened.rev, base: { title: opened.title }, changes: { title: 'A title' } }]);
    assert.equal(a.status, 409, JSON.stringify(a.body));
    assert.equal((await f.drawing('dwg-001')).title, 'Changed by import');
  } finally { await f.cleanup(); }
});
