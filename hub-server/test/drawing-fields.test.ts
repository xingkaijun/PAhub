/// <reference types="vite/client" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectsApi } from '../../services/api/projectsApi';
import { startAutosave, AUTOSAVE_INTERVAL_MS } from '../../lib/auto-save';
import { mergeProjectPreservingDirty } from '../../lib/merge-project';
import type { Drawing, Project } from '../../types';

const initial = { id: 'd', customId: '001', drawingNo: 'D1', title: 'original', discipline: 'Hull', assignees: ['A'], status: 'Waiting Reply', currentRound: 'AA', version: 'old', manualCommentsCount: 1, manualOpenCommentsCount: 1, logs: [], remarks: [], statusHistory: [] } as Drawing;
async function storeFixture() {
  const { useStore } = await import('../../store');
  useStore.setState({ activeProjectId: 'p', isEditMode: false, data: { ...useStore.getState().data, projects: [{ id: 'p', name: 'P', conf: { reviewers: [], disciplineDefaults: {}, roundACycle: 14, otherRoundsCycle: 7, holidays: [] }, drawings: [{ ...initial }] } as Project] }, _dirtyDrawingIds: new Set(), _dirtyDrawingFields: {}, _deletedDrawingIds: new Set(), _dirtyConf: false, _dirtyTracker: false, _dirtyTrackerDrawingIds: new Set(), isLoading: false });
  return useStore;
}

test('store sends only edited fields and uses the authoritative server response', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let payload: any;
  projectsApi.saveDelta = async (_id, input) => {
    payload = input;
    return { success: true, verification: { ok: true, checked: 1, mismatched: [] }, drawings: [{ ...initial, status: 'Reviewing', currentRound: 'AB', reviewDeadline: '2026-12-01T16:00:00.000Z' }] };
  };
  try {
    store.getState().updateDrawing('d', { status: 'Reviewing' });
    assert.equal(store.getState().data.projects[0].drawings[0].currentRound, 'AB');
    assert.equal(await store.getState().saveProject('p'), true);
    assert.equal(payload.updatedDrawings[0].changes.status, 'Reviewing');
    assert.equal('manualCommentsCount' in payload.updatedDrawings[0].changes, false);
    assert.equal('currentRound' in payload.updatedDrawings[0].changes, false);
    assert.equal(store.getState().data.projects[0].drawings[0].reviewDeadline, '2026-12-01T16:00:00.000Z');
    assert.equal(store.getState()._dirtyDrawingIds.size, 0);
  } finally { projectsApi.saveDelta = original; }
});

test('server refresh during a pending save does not mark remote fields dirty', async () => {
  const store = await storeFixture();
  store.getState().updateDrawing('d', { title: 'local edit' });
  const remote = { ...store.getState().data.projects[0], drawings: [{ ...initial, discipline: 'remote discipline' }] };
  const state = store.getState();
  const merged = mergeProjectPreservingDirty(state.data.projects[0], remote, state._dirtyDrawingIds, state._deletedDrawingIds, false, {}, {}, new Set(), false, state._dirtyDrawingFields);
  store.setState({ data: { ...state.data, projects: [merged.project] } });
  assert.deepEqual([...store.getState()._dirtyDrawingFields.d], ['title']);
});

test('editing another field during an in-flight save preserves only the newer edit for the next PATCH', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let release!: () => void; let started!: () => void; const ready = new Promise<void>(r => started = r);
  projectsApi.saveDelta = async () => { started(); await new Promise<void>(r => release = r); return { success: true, drawings: [{ ...initial, title: 'first title' }] }; };
  try {
    store.getState().updateDrawing('d', { title: 'first title' });
    const pending = store.getState().saveProject('p'); await ready;
    store.getState().updateDrawing('d', { discipline: 'Electrical' }); release(); await pending;
    assert.deepEqual([...store.getState()._dirtyDrawingFields.d], ['discipline']);
    assert.equal(store.getState().data.projects[0].drawings[0].discipline, 'Electrical');
    let next: any;
    projectsApi.saveDelta = async (_p, payload) => { next = payload; return { success: true }; };
    await store.getState().saveProject('p');
    assert.deepEqual(next.updatedDrawings, [{ id: 'd', changes: { discipline: 'Electrical' } }]);
  } finally { projectsApi.saveDelta = original; }
});

test('a newer edit to the same field during a save is not acknowledged by the older response', async () => {
  const store = await storeFixture(); const original = projectsApi.saveDelta;
  let release!: () => void; let started!: () => void; const ready = new Promise<void>(r => started = r);
  projectsApi.saveDelta = async () => { started(); await new Promise<void>(r => release = r); return { success: true, drawings: [{ ...initial, title: 'old request' }] }; };
  try {
    store.getState().updateDrawing('d', { title: 'old request' });
    const pending = store.getState().saveProject('p'); await ready;
    store.getState().updateDrawing('d', { title: 'new edit' }); release(); await pending;
    assert.equal(store.getState().data.projects[0].drawings[0].title, 'new edit');
    assert.deepEqual([...store.getState()._dirtyDrawingFields.d], ['title']);
  } finally { projectsApi.saveDelta = original; }
});

test('dirty-field refresh retains the local title but accepts remote PCF summary and unrelated fields', () => {
  const local = { id: 'p', drawings: [{ ...initial, title: 'local edit' }] } as Project;
  const remote = { id: 'p', drawings: [{ ...initial, hasPcf: true, discipline: 'Remote discipline', manualCommentsCount: 12, currentRound: 'AB', version: 'PCF version' }] } as Project;
  const merged = mergeProjectPreservingDirty(local, remote, new Set(['d']), new Set(), false, {}, {}, new Set(), false, { d: new Set(['title']) });
  assert.equal(merged.project.drawings[0].title, 'local edit');
  assert.equal(merged.project.drawings[0].discipline, 'Remote discipline');
  assert.equal(merged.project.drawings[0].manualCommentsCount, 12);
  assert.equal(merged.project.drawings[0].currentRound, 'AB');
});

test('store ignores manual PCF field edits and batch status changes use the same transition rule', async () => {
  const store = await storeFixture();
  store.setState({ data: { ...store.getState().data, projects: [{ ...store.getState().data.projects[0], drawings: [{ ...initial, hasPcf: true }] }] } });
  store.getState().updateDrawing('d', { version: 'manual', currentRound: 'ZZ', manualCommentsCount: 999 });
  assert.equal(store.getState().hasUnsavedChanges(), false);
  store.getState().batchUpdateDrawings([{ id: 'd', changes: { status: 'Reviewing' } }]);
  assert.equal(store.getState().data.projects[0].drawings[0].currentRound, 'AB');
});

test('auto-save uses fixed fifteen-minute cadence and cancels on teardown', () => {
 let now=0,saves=0,interval=0,next=0,job:()=>void=()=>{},cancelled=false;
 const stop=startAutosave(()=>saves++,at=>next=at,()=>now,((fn:any,ms:number)=>{job=fn;interval=ms;return 1;}) as any,(()=>{cancelled=true;}) as any);
 assert.equal(interval,AUTOSAVE_INTERVAL_MS);assert.equal(next,900000);assert.equal(saves,0);
 now=900000;job();assert.equal(saves,1);assert.equal(next,1800000);
 stop();assert.equal(cancelled,true);assert.equal(next,0);
});
