/// <reference types="vite/client" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectsApi } from '../../services/api/projectsApi';
import { ApiError } from '../../services/api/apiClient';
import { mergeProjectPreservingDirty } from '../../lib/merge-project';
import type { Drawing, Project } from '../../types';

const remarks = [
  { id: 'r1', content: '#Hold', createdAt: '2026-11-01T00:00:00.000Z', resolved: false },
  { id: 'r2', content: '#Hold', createdAt: '2026-11-02T00:00:00.000Z', resolved: false },
];
const initial = { id: 'd', customId: '001', drawingNo: 'D1', title: 'original', discipline: 'Hull', assignees: ['A'], status: 'Pending', currentRound: 'A', version: 'A', manualCommentsCount: 0, manualOpenCommentsCount: 0, logs: [], remarks, statusHistory: [], rev: 'rev-1' } as Drawing;
const conf = () => ({ reviewers: [{ id: 'A', name: 'A' }], disciplineDefaults: { Hull: 'A', Piping: 'B' }, roundACycle: 14, otherRoundsCycle: 7, holidays: ['2026-01-01'], displayName: 'Ship' });

async function storeFixture() {
  const { useStore } = await import('../../store');
  useStore.setState({ activeProjectId: 'p', isEditMode: false, saveConflict: null, error: null, data: { ...useStore.getState().data, projects: [{ id: 'p', name: 'P', conf: conf(), drawings: [{ ...initial }] } as Project] }, _dirtyDrawingIds: new Set(), _dirtyDrawingFields: {}, _dirtyDrawingBase: {}, _deletedDrawingIds: new Set(), _dirtyConf: false, _dirtyConfKeys: new Set(), _dirtyConfBase: {}, _dirtyTracker: false, _dirtyTrackerDrawingIds: new Set(), isLoading: false, refreshProjectPreservingDirty: async () => 0 } as any);
  return useStore;
}

test('settings save sends only changed keys with their pre-edit values, then adopts the merged server settings', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let payload: any;
  projectsApi.saveDelta = async (_id, input) => { payload = input; return { success: true, verification: { ok: true, checked: 0, mismatched: [] }, drawings: [], conf: { ...conf(), displayName: 'Ship 2', disciplineDefaults: { Hull: 'A', Piping: 'C', Electrical: 'X' } } } as any; };
  try {
    store.getState().updateProjectConfig('p', { displayName: 'first' });
    store.getState().updateProjectConfig('p', { displayName: 'Ship 2', roundACycle: 14 }); // roundACycle unchanged: not dirty
    store.getState().updateProjectConfig('p', { disciplineDefaults: { Hull: 'A', Piping: 'C' } });
    assert.deepEqual([...store.getState()._dirtyConfKeys].sort(), ['disciplineDefaults', 'displayName']);
    assert.equal(await store.getState().saveProject('p'), true);
    assert.deepEqual(payload.conf, { displayName: 'Ship 2', disciplineDefaults: { Hull: 'A', Piping: 'C' } }, 'only changed keys, no reviewers or cycles');
    assert.deepEqual(payload.confBase, { displayName: 'Ship', disciplineDefaults: { Hull: 'A', Piping: 'B' } }, 'base is the value before the first edit');
    const state = store.getState();
    assert.equal(state._dirtyConf, false);
    assert.equal(state._dirtyConfKeys.size, 0);
    assert.deepEqual(state._dirtyConfBase, {});
    assert.deepEqual(state.data.projects[0].conf.disciplineDefaults, { Hull: 'A', Piping: 'C', Electrical: 'X' }, 'discipline added by someone else meanwhile is adopted');
  } finally { projectsApi.saveDelta = original; }
});

test('settings 409: conflicting key takes the server value, other changed keys stay dirty, notice shown', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let refreshed = 0;
  store.setState({ refreshProjectPreservingDirty: async () => { refreshed++; return 0; } } as any);
  projectsApi.saveDelta = async () => { throw new ApiError('Project settings changed on the server since they were loaded', 409, { code: 'CONFIG_CONFLICT', conflicts: [], confConflicts: [{ key: 'roundACycle', current: 21 }] }); };
  try {
    store.getState().updateProjectConfig('p', { roundACycle: 30, displayName: 'Mine' });
    assert.equal(await store.getState().saveProject('p'), false);
    const state = store.getState();
    assert.equal(state.data.projects[0].conf.roundACycle, 21, 'server value shown, no silent overwrite');
    assert.equal(state.data.projects[0].conf.displayName, 'Mine', 'non-conflicting local edit kept');
    assert.deepEqual([...state._dirtyConfKeys], ['displayName']);
    assert.deepEqual(state._dirtyConfBase, { displayName: 'Ship' });
    assert.equal(state._dirtyConf, true);
    assert.match(state.saveConflict!.message, /保存冲突：项目设置（A 轮周期）/);
    assert.equal(refreshed, 1);
  } finally { projectsApi.saveDelta = original; }
});

test('settings 409 on one discipline keeps the local change of another discipline', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  const payloads: any[] = [];
  let calls = 0;
  projectsApi.saveDelta = async (_id, input) => {
    payloads.push(JSON.parse(JSON.stringify(input)));
    if (calls++ === 0) throw new ApiError('conflict', 409, { code: 'CONFIG_CONFLICT', conflicts: [], confConflicts: [{ key: 'disciplineDefaults', entry: 'Piping', current: { Hull: 'A', Piping: 'Z' } }] });
    return { success: true, verification: { ok: true, checked: 0, mismatched: [] }, drawings: [], conf: { ...conf(), disciplineDefaults: { Hull: 'H2', Piping: 'Z' } } } as any;
  };
  try {
    store.getState().updateProjectConfig('p', { disciplineDefaults: { Hull: 'H2', Piping: 'C' } });
    assert.equal(await store.getState().saveProject('p'), false);
    assert.deepEqual(store.getState().data.projects[0].conf.disciplineDefaults, { Hull: 'H2', Piping: 'Z' });
    assert.ok(store.getState()._dirtyConfKeys.has('disciplineDefaults'), 'Hull change still pending');
    assert.equal(await store.getState().saveProject('p'), true);
    assert.deepEqual(payloads[1].conf, { disciplineDefaults: { Hull: 'H2', Piping: 'Z' } });
    assert.deepEqual(payloads[1].confBase, { disciplineDefaults: { Hull: 'A', Piping: 'Z' } }, 'retry is based on the server value of the conflicting discipline');
    assert.equal(store.getState()._dirtyConf, false);
  } finally { projectsApi.saveDelta = original; }
});

test('refresh while a setting is dirty keeps only that local key and takes other keys from the server', () => {
  const local = { id: 'p', name: 'P', drawings: [], conf: { ...conf(), displayName: 'Mine' } } as unknown as Project;
  const remote = { id: 'p', name: 'P', drawings: [], conf: { ...conf(), displayName: 'Theirs', roundACycle: 21 } } as unknown as Project;
  const merged = mergeProjectPreservingDirty(local, remote, new Set(), new Set(), new Set(['displayName']), {}, {}, new Set(), false);
  assert.equal(merged.project.conf.displayName, 'Mine');
  assert.equal(merged.project.conf.roundACycle, 21);
});

test('deleteRemark removes one remark by id even when another has the same text, and saves it as an id-based remove op', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let payload: any;
  projectsApi.saveDelta = async (_id, input) => { payload = input; return { success: true, verification: { ok: true, checked: 1, mismatched: [] }, drawings: [{ ...initial, remarks: [remarks[0]], rev: 'rev-2' }] } as any; };
  try {
    store.getState().deleteRemark('d', 'r2');
    assert.deepEqual(store.getState().data.projects[0].drawings[0].remarks.map(r => r.id), ['r1']);
    assert.equal(await store.getState().saveProject('p'), true);
    const sent = payload.updatedDrawings[0];
    assert.deepEqual(sent.remarkOps, { remove: [{ id: 'r2', base: { content: '#Hold', resolved: false } }] });
    assert.equal(payload.conf, undefined, 'settings not sent when untouched');
  } finally { projectsApi.saveDelta = original; }
});
