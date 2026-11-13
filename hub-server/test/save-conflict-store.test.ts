/// <reference types="vite/client" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectsApi } from '../../services/api/projectsApi';
import { ApiError } from '../../services/api/apiClient';
import type { Drawing, Project } from '../../types';

const remark = { id: 'r1', content: 'seed remark', createdAt: '2026-11-01T00:00:00.000Z', resolved: false };
const initial = { id: 'd', customId: '001', drawingNo: 'D1', title: 'original', discipline: 'Hull', assignees: ['A'], status: 'Reviewing', currentRound: 'A', version: 'A', manualCommentsCount: 0, manualOpenCommentsCount: 0, logs: [], remarks: [remark], statusHistory: [], rev: 'rev-1' } as Drawing;

async function storeFixture() {
  const { useStore } = await import('../../store');
  useStore.setState({ activeProjectId: 'p', isEditMode: false, saveConflict: null, error: null, data: { ...useStore.getState().data, projects: [{ id: 'p', name: 'P', conf: { reviewers: [], disciplineDefaults: {}, roundACycle: 14, otherRoundsCycle: 7, holidays: [] }, drawings: [{ ...initial }] } as Project] }, _dirtyDrawingIds: new Set(), _dirtyDrawingFields: {}, _dirtyDrawingBase: {}, _deletedDrawingIds: new Set(), _dirtyConf: false, _dirtyTracker: false, _dirtyTrackerDrawingIds: new Set(), isLoading: false, refreshProjectPreservingDirty: async () => 0 } as any);
  return useStore;
}

test('save sends only edited fields with baseRev, their pre-edit values and id-based remark ops', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let payload: any;
  projectsApi.saveDelta = async (_id, input) => { payload = input; return { success: true, verification: { ok: true, checked: 1, mismatched: [] }, drawings: [{ ...initial, title: 'mine', remarks: [{ ...remark, resolved: true }, { id: 'r2', content: 'new', createdAt: 'x', resolved: false }], rev: 'rev-2' }] } as any; };
  try {
    store.getState().updateDrawing('d', { title: 'first' });
    store.getState().updateDrawing('d', { title: 'mine' });
    store.getState().updateDrawing('d', { remarks: [{ ...remark, resolved: true }, { id: 'r2', content: 'new', createdAt: 'x', resolved: false }] });
    assert.equal(await store.getState().saveProject('p'), true);
    const sent = payload.updatedDrawings[0];
    assert.deepEqual(Object.keys(sent.changes), ['title'], 'no other fields, remarks travel as ops');
    assert.equal(sent.changes.title, 'mine');
    assert.equal(sent.baseRev, 'rev-1');
    assert.deepEqual(sent.base, { title: 'original' }, 'base is the value before the first edit');
    assert.deepEqual(sent.remarkOps.add.map((r: any) => r.id), ['r2']);
    assert.deepEqual(sent.remarkOps.update, [{ id: 'r1', content: 'seed remark', resolved: true, base: { content: 'seed remark', resolved: false } }]);
    assert.equal(sent.remarkOps.remove, undefined);
    const state = store.getState();
    assert.equal(state._dirtyDrawingIds.size, 0);
    assert.deepEqual(state._dirtyDrawingBase, {});
    assert.equal(state.data.projects[0].drawings[0].rev, 'rev-2', 'next save starts from the acknowledged revision');
  } finally { projectsApi.saveDelta = original; }
});

test('409 conflict: conflicting field takes the server value, other edits stay dirty, a clear notice is shown', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let refreshed = 0;
  store.setState({ refreshProjectPreservingDirty: async () => { refreshed++; return 0; } } as any);
  const current = { ...initial, title: 'B title', remarks: [remark, { id: 'rb', content: 'B remark', createdAt: 'y', resolved: false }], rev: 'rev-b' };
  projectsApi.saveDelta = async () => { throw new ApiError('Drawing changed on the server since it was loaded', 409, { code: 'DRAWING_CONFLICT', conflicts: [{ id: 'd', customId: '001', fields: ['title'], current }] }); };
  try {
    store.getState().updateDrawing('d', { title: 'A title', discipline: 'A discipline' });
    assert.equal(await store.getState().saveProject('p'), false);
    const state = store.getState();
    const d = state.data.projects[0].drawings[0];
    assert.equal(d.title, 'B title', 'no silent overwrite: server title shown');
    assert.equal(d.discipline, 'A discipline', 'non-conflicting local edit kept');
    assert.deepEqual([...state._dirtyDrawingFields.d], ['discipline']);
    assert.ok(state._dirtyDrawingIds.has('d'));
    assert.deepEqual(state._dirtyDrawingBase.d.values, { discipline: 'Hull' });
    assert.ok(state.saveConflict);
    assert.match(state.saveConflict!.message, /Save conflict: 001 \(Title\)/);
    assert.deepEqual(state.saveConflict!.drawingIds, ['d']);
    assert.equal(state.isLoading, false);
    assert.equal(refreshed, 1, 'latest data reloaded after the conflict');
    state.clearSaveConflict();
    assert.equal(store.getState().saveConflict, null);
  } finally { projectsApi.saveDelta = original; }
});

test('409 conflict where every edited field conflicts adopts the whole server row and clears the drawing', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  const current = { ...initial, title: 'B title', discipline: 'B discipline', rev: 'rev-b' };
  projectsApi.saveDelta = async () => { throw new ApiError('conflict', 409, { code: 'DRAWING_CONFLICT', conflicts: [{ id: 'd', customId: '001', fields: ['title'], current }] }); };
  try {
    store.getState().updateDrawing('d', { title: 'A title' });
    assert.equal(await store.getState().saveProject('p'), false);
    const state = store.getState();
    assert.equal(state._dirtyDrawingIds.has('d'), false);
    assert.equal(state.data.projects[0].drawings[0].discipline, 'B discipline');
    assert.equal(state.data.projects[0].drawings[0].rev, 'rev-b');
  } finally { projectsApi.saveDelta = original; }
});

test('ApiError keeps the parsed JSON body of a 409 response', async () => {
  const { createApiClient } = await import('../../services/api/apiClient');
  const client = createApiClient({ origin: 'http://x', fetch: (async () => new Response(JSON.stringify({ code: 'DRAWING_CONFLICT', conflicts: [{ id: 'd' }], error: 'changed' }), { status: 409 })) as any });
  await assert.rejects(client.request('projects/p', { method: 'PATCH' }), (e: any) => e instanceof ApiError && e.status === 409 && e.message === 'changed' && e.data.conflicts[0].id === 'd');
});
