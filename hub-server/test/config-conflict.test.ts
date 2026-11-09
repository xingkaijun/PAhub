import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';

const PROJECT = '/api/projects/proj-test-001';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-config-conflict-'));
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
  const conf = async () => (await ok(PROJECT, 'POST', {})).conf as any;
  const patchConf = (c: any, confBase?: any) => raw(PROJECT, 'PATCH', { conf: c, ...(confBase ? { confBase } : {}) });
  return { hub, raw, ok, load, conf, patchConf, cleanup: async () => { await hub.close(); for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; await rm(dir, { recursive: true, force: true }); } };
}


test('settings: two people change different keys from the same snapshot, both kept', async () => {
  const f = await fixture(); try {
    const opened = await f.conf();
    assert.equal(opened.roundACycle, 14);
    const b = await f.patchConf({ roundACycle: 21 }, { roundACycle: opened.roundACycle });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.conf.roundACycle, 21, 'save returns the stored settings');
    const a = await f.patchConf({ displayName: 'A name' }, { displayName: opened.displayName });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const after = await f.conf();
    assert.equal(after.roundACycle, 21, 'B change survives A save');
    assert.equal(after.displayName, 'A name');
    assert.equal(after.otherRoundsCycle, 7, 'keys nobody sent untouched');
    assert.deepEqual(after.holidays, ['2026-01-01', '2026-05-01']);
    assert.deepEqual(after.disciplineDefaults, { Structure: 'engineer_a', Piping: 'engineer_b', Electrical: 'senior_eng_c' });
  } finally { await f.cleanup(); }
});

test('settings: same key changed by someone else returns 409 CONFIG_CONFLICT and writes nothing in the batch', async () => {
  const f = await fixture(); try {
    const opened = await f.conf();
    const drawingsBefore = (await f.load()).find((d: any) => d.id === 'dwg-002');
    assert.equal((await f.patchConf({ roundACycle: 21 }, { roundACycle: opened.roundACycle })).status, 200);
    const stale = await f.raw(PROJECT, 'PATCH', { conf: { roundACycle: 30, displayName: 'A name' }, confBase: { roundACycle: opened.roundACycle, displayName: opened.displayName },
      updatedDrawings: [{ id: 'dwg-002', baseRev: drawingsBefore.rev, base: { title: drawingsBefore.title }, changes: { title: 'A title' } }] });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, 'CONFIG_CONFLICT');
    assert.deepEqual(stale.body.conflicts, []);
    assert.deepEqual(stale.body.confConflicts, [{ key: 'roundACycle', current: 21 }]);
    const after = await f.conf();
    assert.equal(after.roundACycle, 21);
    assert.equal(after.displayName, null, 'non-conflicting key in the same batch rolled back');
    assert.equal((await f.load()).find((d: any) => d.id === 'dwg-002').title, drawingsBefore.title, 'drawing in the same batch rolled back');
  } finally { await f.cleanup(); }
});

test('settings: re-sending a value that already matches the server is not a conflict', async () => {
  const f = await fixture(); try {
    const opened = await f.conf();
    assert.equal((await f.patchConf({ holidays: ['2026-10-01'] }, { holidays: opened.holidays })).status, 200);
    const again = await f.patchConf({ holidays: ['2026-10-01'] }, { holidays: opened.holidays });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual((await f.conf()).holidays, ['2026-10-01']);
  } finally { await f.cleanup(); }
});

test('settings: discipline maps merge per discipline; same discipline conflicts', async () => {
  const f = await fixture(); try {
    const opened = await f.conf();
    const base = { disciplineDefaults: opened.disciplineDefaults };
    const b = await f.patchConf({ disciplineDefaults: { ...opened.disciplineDefaults, Piping: 'senior_eng_c' } }, base);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const { Electrical: _removed, ...withoutElectrical } = opened.disciplineDefaults;
    const a = await f.patchConf({ disciplineDefaults: { ...withoutElectrical, Hull: 'engineer_a' } }, base);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual((await f.conf()).disciplineDefaults, { Structure: 'engineer_a', Piping: 'senior_eng_c', Hull: 'engineer_a' }, 'B Piping kept, A added Hull and removed Electrical');
    const c = await f.patchConf({ disciplineDefaults: { ...opened.disciplineDefaults, Piping: 'engineer_a' } }, base);
    assert.equal(c.status, 409, JSON.stringify(c.body));
    assert.equal(c.body.confConflicts.length, 1);
    assert.equal(c.body.confConflicts[0].key, 'disciplineDefaults');
    assert.equal(c.body.confConflicts[0].entry, 'Piping');
    assert.deepEqual((await f.conf()).disciplineDefaults, { Structure: 'engineer_a', Piping: 'senior_eng_c', Hull: 'engineer_a' }, 'nothing written');
    const d = await f.patchConf({ defaultAssignees: { ...opened.defaultAssignees, Piping: ['engineer_b', 'engineer_a'] } }, { defaultAssignees: opened.defaultAssignees });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual([...(await f.conf()).defaultAssignees.Piping].sort(), ['engineer_a', 'engineer_b']);
    const e = await f.patchConf({ defaultAssignees: { ...opened.defaultAssignees, Piping: ['engineer_a', 'engineer_b'] } }, { defaultAssignees: { ...opened.defaultAssignees, Piping: ['engineer_b', 'engineer_a'] } });
    assert.equal(e.status, 200, 'assignee order alone is not a conflict');
    assert.deepEqual([...(await f.conf()).defaultAssignees.Structure].sort(), ['engineer_a', 'senior_eng_c']);
  } finally { await f.cleanup(); }
});

test('settings: legacy save without confBase is written as sent (backup restore, old pages)', async () => {
  const f = await fixture(); try {
    assert.equal((await f.patchConf({ roundACycle: 21 }, { roundACycle: 14 })).status, 200);
    const legacy = await f.patchConf({ roundACycle: 9, otherRoundsCycle: 3 });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    const after = await f.conf();
    assert.equal(after.roundACycle, 9);
    assert.equal(after.otherRoundsCycle, 3);
  } finally { await f.cleanup(); }
});

test('settings conflict is reported together with a drawing conflict', async () => {
  const f = await fixture(); try {
    const opened = await f.conf();
    const d = (await f.load()).find((x: any) => x.id === 'dwg-001');
    assert.equal((await f.raw(PROJECT, 'PATCH', { conf: { roundACycle: 21 }, confBase: { roundACycle: 14 }, updatedDrawings: [{ id: 'dwg-001', baseRev: d.rev, base: { title: d.title }, changes: { title: 'B' } }] })).status, 200);
    const stale = await f.raw(PROJECT, 'PATCH', { conf: { roundACycle: 30 }, confBase: { roundACycle: opened.roundACycle }, updatedDrawings: [{ id: 'dwg-001', baseRev: d.rev, base: { title: d.title }, changes: { title: 'A' } }] });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'DRAWING_CONFLICT');
    assert.deepEqual(stale.body.conflicts.map((c: any) => [c.id, c.fields]), [['dwg-001', ['title']]]);
    assert.deepEqual(stale.body.confConflicts, [{ key: 'roundACycle', current: 21 }]);
  } finally { await f.cleanup(); }
});
