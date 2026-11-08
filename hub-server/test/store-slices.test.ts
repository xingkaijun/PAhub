import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createProjectSlice } from '../../store/projectSlice';
import { createReviewTrackerSlice } from '../../store/reviewTrackerSlice';
import { createUiSlice } from '../../store/uiSlice';
import { createPresenceSlice } from '../../store/presenceSlice';
import { persistenceOptions } from '../../store/persistence';
import { appRepository } from '../../services/data/AppRepository';
import type { AppState } from '../../store/types';
import type { Drawing, Project } from '../../types';

function fixture() {
  const store = createStore<AppState>()((...args) => ({ ...createProjectSlice(...args), ...createReviewTrackerSlice(...args), ...createUiSlice(...args), ...createPresenceSlice(...args) }));
  const drawing = { id: 'd', customId: '001', title: 'Title', status: 'Reviewing', currentRound: 'A', assignees: ['A'], remarks: [], statusHistory: [] } as unknown as Drawing;
  const project = { id: 'p', name: 'Project', conf: store.getState().data.settings, drawings: [drawing] } as Project;
  store.setState({ activeProjectId: 'p', data: { ...store.getState().data, projects: [project, { ...project, id: 'other' }] } });
  return store;
}

test('four slices expose one compatible state while UI changes do not dirty project data', () => {
  const store = fixture();
  store.getState().setViewMode('board');
  store.getState().setFilterQuery('query');
  assert.equal(store.getState().viewMode, 'board');
  assert.equal(store.getState().filterQuery, 'query');
  assert.equal(store.getState().hasUnsavedChanges(), false);
  store.getState().clearTrackerForDrawings(['missing']);
  assert.equal(store.getState().hasUnsavedChanges(), false);
  store.getState().addRemark('d', 'Note');
  assert.equal(store.getState().data.projects[0].drawings[0].remarks[0].content, 'Note');
  assert.equal(store.getState().getUnsavedChangesCount(), 1);
});

test('persistence serializes Sets and active data only, never UI flags or live timers', () => {
  const store = fixture();
  store.setState({ _dirtyDrawingIds: new Set(['d']), _dirtyDrawingFields: { d: new Set(['title']) }, _deletedDrawingIds: new Set(['deleted']), _dirtyTrackerDrawingIds: new Set(['d']), _dirtyTracker: true, isEditMode: true });
  const serialized = persistenceOptions.partialize!(store.getState());
  assert.equal(persistenceOptions.name, 'pahub-storage');
  assert.equal(persistenceOptions.version, 2);
  assert.deepEqual(serialized._dirtyDrawingIds, ['d']);
  assert.deepEqual(serialized._dirtyDrawingFields, { d: ['title'] });
  assert.equal(serialized.data.projects[0].drawings.length, 1);
  assert.equal(serialized.data.projects[1].drawings.length, 0);
  for (const name of ['viewMode', 'isEditMode', 'adminPresence', '_heartbeatTimer', 'pcfPresence']) assert.equal(name in serialized, false);
  const restored = persistenceOptions.merge!(JSON.parse(JSON.stringify(serialized)), fixture().getState());
  assert.ok(restored._dirtyDrawingIds instanceof Set);
  assert.ok(restored._dirtyDrawingFields.d instanceof Set);
  assert.deepEqual([...restored._dirtyDrawingFields.d], ['title']);
  assert.ok(restored._deletedDrawingIds.has('deleted'));
  assert.ok(restored._dirtyTrackerDrawingIds.has('d'));
  assert.equal(restored.isEditMode, false);
  assert.equal(typeof restored.saveProject, 'function');
});

test('persistence migration and empty storage preserve defaults and legacy dirty tracker IDs', async () => {
  const store = fixture();
  const empty = persistenceOptions.merge!(undefined, store.getState());
  assert.strictEqual(empty.data, store.getState().data);
  assert.equal(empty._dirtyDrawingIds.size, 0);
  const legacy = { data: store.getState().data, _dirtyTrackerDrawingIds: ['d'] };
  const migrated = await persistenceOptions.migrate!(legacy, 1) as any;
  assert.ok(migrated._dirtyTrackerDrawingIds.has('d'));
  assert.ok(persistenceOptions.merge!(migrated, store.getState())._dirtyTrackerDrawingIds.has('d'));
});

test('presence slice owns one heartbeat timer and edit exit stops it', async () => {
  const store = fixture();
  const original = appRepository.sendHeartbeat;
  const ids: string[] = [];
  appRepository.sendHeartbeat = async id => { ids.push(id); };
  try {
    assert.equal(store.getState().toggleEditMode(), true);
    assert.equal(store.getState().isEditMode, true);
    assert.equal(store.getState().adminPresence.isOnline, true);
    const first = store.getState()._heartbeatTimer!;
    assert.ok(first);
    store.getState().startEditingPresence();
    assert.notStrictEqual(store.getState()._heartbeatTimer, first);
    assert.deepEqual(ids, ['p', 'p']);
    store.getState().toggleEditMode();
    assert.equal(store.getState().isEditMode, false);
    assert.equal(store.getState()._heartbeatTimer, null);
    assert.equal(store.getState().adminPresence.isOnline, false);
  } finally { store.getState().stopEditingPresence(); appRepository.sendHeartbeat = original; }
});

test('a delayed heartbeat lookup cannot overwrite another project or active edit presence', async () => {
  const store = fixture();
  const original = appRepository.getHeartbeat;
  let release!: (value: string | null) => void;
  appRepository.getHeartbeat = () => new Promise(resolve => { release = resolve; });
  try {
    const pending = store.getState().refreshAdminPresence('p');
    store.setState({ activeProjectId: 'other', adminPresence: { isOnline: false } });
    release(new Date().toISOString());
    await pending;
    assert.equal(store.getState().adminPresence.isOnline, false);
    const editing = store.getState().refreshAdminPresence('other');
    store.setState({ isEditMode: true, adminPresence: { isOnline: true } });
    release(null); await editing;
    assert.equal(store.getState().adminPresence.isOnline, true);
  } finally { appRepository.getHeartbeat = original; }
});

test('tracker verification failures re-dirty drawing and tracker for normal save retry', async () => {
  const store = fixture();
  const loadProject = appRepository.loadProject, loadTracker = appRepository.loadReviewTracker;
  appRepository.loadProject = async (_settings, project) => ({ ...project });
  appRepository.loadReviewTracker = async () => ({ d: { __approved__: { done: true } } });
  try {
    const result = await store.getState().verifySentDrawings('p', [{ id: 'd', customId: '001', status: 'Approved' }]);
    assert.deepEqual(result, { ok: false, mismatchedDrawings: ['001'], mismatchedTracker: ['001'] });
    assert.ok(store.getState()._dirtyDrawingIds.has('d'));
    assert.ok(store.getState()._dirtyTrackerDrawingIds.has('d'));
    assert.equal(store.getState()._dirtyTracker, true);
  } finally { appRepository.loadProject = loadProject; appRepository.loadReviewTracker = loadTracker; }
});
