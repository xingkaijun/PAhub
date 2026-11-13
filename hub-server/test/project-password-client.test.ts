import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createProjectSlice } from '../../store/projectSlice';
import { createReviewTrackerSlice } from '../../store/reviewTrackerSlice';
import { createUiSlice } from '../../store/uiSlice';
import { createPresenceSlice } from '../../store/presenceSlice';
import { persistenceOptions } from '../../store/persistence';
import { withoutProjectSecrets } from '../../lib/project';
import { parseProjectBackup, downloadProjectBackup } from '../../services/data/localProjectFile';
import { createProjectsApi, projectsApi } from '../../services/api/projectsApi';
import { createApiClient } from '../../services/api/apiClient';
import type { AppState } from '../../store/types';
import type { Drawing, Project } from '../../types';

const storeFixture = () => {
  const store = createStore<AppState>()((...args) => ({ ...createProjectSlice(...args), ...createReviewTrackerSlice(...args), ...createUiSlice(...args), ...createPresenceSlice(...args) }));
  const project = { id: 'p', name: 'Test project', drawings: [], conf: { ...store.getState().data.settings, passwordSet: true, passwordVersion: 'public-version' } } as Project;
  store.setState({ activeProjectId: 'p', data: { ...store.getState().data, projects: [project] } });
  return store;
};

test('project reads rely on cookies; only unlock sends password and honours cancellation', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createApiClient({ baseUrl: 'https://example.test/api', fetch: async (url, init) => { calls.push({ url: String(url), init: init || {} }); return Response.json({}); } });
  const api = createProjectsApi(client), signal = new AbortController().signal;
  await api.loadProject({ id: 'p' } as Project, 'fictional-legacy-value', signal);
  await api.loadDrawings('p', ['d'], 'fictional-legacy-value', signal);
  await api.unlockProject('p', 'fictional-test-only', signal);
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {});
  assert.equal(new Headers(calls[1].init.headers).has('X-Project-Password'), false);
  assert.match(calls[2].url, /\/projects\/p\/unlock$/);
  assert.deepEqual(JSON.parse(calls[2].init.body as string), { password: 'fictional-test-only' });
  calls.forEach(call => assert.strictEqual(call.init.signal, signal));
});

test('expired project access notifies the browser to return to the hall, but unlock failures do not', async () => {
  const originalWindow = globalThis.window;
  const events: Event[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent(event: Event) { events.push(event); return true; } } });
  try {
    const client = createApiClient({ baseUrl: 'https://example.test/api', fetch: async () => Response.json({ error: 'PASSWORD_REQUIRED' }, { status: 401 }) });
    await assert.rejects(client.request('projects/project%20one/drawings'), /PASSWORD_REQUIRED/);
    await assert.rejects(client.request('pcf/project%20two/presence'), /PASSWORD_REQUIRED/);
    await assert.rejects(client.request('projects/project%20one/unlock'), /PASSWORD_REQUIRED/);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => ({ type: event.type, detail: (event as CustomEvent).detail })), [
      { type: 'pahub:project-locked', detail: { projectId: 'project one' } },
      { type: 'pahub:project-locked', detail: { projectId: 'project two' } },
    ]);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});

test('legacy credentials disappear from hydration, dirty settings, persistence and imported backups', () => {
  const store = storeFixture();
  const project = { ...store.getState().data.projects[0], conf: { ...store.getState().data.projects[0].conf, password: 'fictional-legacy-value', passwordHash: 'fictional-hash', passwordSalt: 'fictional-salt' } };
  const persisted = { data: { ...store.getState().data, projects: [project] }, _dirtyConf: true, _dirtyConfKeys: ['password'], _dirtyConfBase: { password: 'fictional-legacy-base' } };
  const restored = persistenceOptions.merge!(persisted, store.getState());
  const serialized = persistenceOptions.partialize!(restored);
  for (const value of [restored.data, serialized, parseProjectBackup(JSON.stringify(project)), parseProjectBackup(JSON.stringify({ project }))]) {
    const text = JSON.stringify(value);
    assert.equal(text.includes('fictional-legacy'), false);
    assert.equal(text.includes('fictional-hash'), false);
    assert.equal(text.includes('fictional-salt'), false);
  }
  assert.equal(restored._dirtyConf, false);
  assert.equal(restored._dirtyConfKeys.size, 0);
  assert.equal(restored.data.projects[0].conf.passwordSet, true);
  assert.equal(restored.data.projects[0].conf.passwordVersion, 'public-version');
  store.getState().updateProjectConfig('p', { password: 'fictional-draft' });
  assert.equal(store.getState().data.projects[0].conf.password, undefined);
  assert.equal(store.getState()._dirtyConf, false);
  assert.deepEqual(withoutProjectSecrets({ passwordHash: 'hidden', passwordSet: true }), { passwordSet: true });
});

test('JSON backup strips legacy credentials even when handed an unsanitized project', async () => {
  const project = { ...storeFixture().getState().data.projects[0], conf: { ...storeFixture().getState().data.projects[0].conf, password: 'fictional-backup-value' } };
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  let blob: Blob | undefined;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ click() {} }) } });
  URL.createObjectURL = value => { blob = value as Blob; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  try {
    downloadProjectBackup(project);
    assert.ok(blob);
    assert.equal((await blob.text()).includes('fictional-backup-value'), false);
  } finally {
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  }
});

test('re-unlocking the active project preserves unsaved drawings, configuration, tracker and conflict bases', async () => {
  const store = storeFixture(), original = projectsApi.loadProject;
  const before = store.getState().data.projects[0];
  const drawing = { id: 'd', title: 'Unsaved local title', discipline: 'Hull', currentRound: 'A', statusHistory: [], remarks: [] } as unknown as Drawing;
  const base = { rev: 'original-revision', values: { title: 'Original title' } };
  store.setState({ data: { ...store.getState().data, projects: [{ ...before, drawings: [drawing], conf: { ...before.conf, displayName: 'Unsaved display' } }] },
    _dirtyDrawingIds: new Set(['d']), _dirtyDrawingFields: { d: new Set(['title']) }, _dirtyDrawingBase: { d: base },
    _deletedDrawingIds: new Set(['deleted']), _dirtyConf: true, _dirtyConfKeys: new Set(['displayName']), _dirtyConfBase: { displayName: 'Original display' },
    reviewTracker: { d: { Reviewer: { done: true } } }, _dirtyTracker: true, _dirtyTrackerDrawingIds: new Set(['d']),
  });
  const dirty = store.getState();
  let expired = true;
  projectsApi.loadProject = async () => {
    if (expired) throw new Error('PASSWORD_REQUIRED');
    return { ...before, drawings: [{ ...drawing, title: 'Server title', discipline: 'Electrical' }, { ...drawing, id: 'deleted' }],
      conf: { ...before.conf, displayName: 'Server display', autoSyncInterval: 9 } };
  };
  try {
    await assert.rejects(store.getState().loadProject('p'), /PASSWORD_REQUIRED/);
    expired = false; // The lobby has now exchanged the password for a new unlock cookie.
    await store.getState().loadProject('p');
    const state = store.getState(), project = state.data.projects[0];
    assert.equal(project.drawings[0].title, 'Unsaved local title');
    assert.equal(project.drawings[0].discipline, 'Electrical');
    assert.equal(project.drawings.some(d => d.id === 'deleted'), false);
    assert.equal(project.conf.displayName, 'Unsaved display');
    assert.equal(project.conf.autoSyncInterval, 9);
    assert.deepEqual(state.reviewTracker, dirty.reviewTracker);
    for (const key of ['_dirtyDrawingIds', '_dirtyDrawingFields', '_dirtyDrawingBase', '_deletedDrawingIds', '_dirtyConfKeys', '_dirtyConfBase', '_dirtyTrackerDrawingIds'] as const)
      assert.strictEqual(state[key], dirty[key], key + ' must remain unchanged');
    assert.equal(state._dirtyConf, true); assert.equal(state._dirtyTracker, true);
    assert.equal(state.hasUnsavedChanges(), true);
  } finally { projectsApi.loadProject = original; }
});

test('an aborted project load cannot commit a late response', async () => {
  const store = storeFixture(), original = projectsApi.loadProject;
  let release!: (project: Project) => void;
  projectsApi.loadProject = () => new Promise(resolve => { release = resolve; });
  const before = store.getState().data.projects[0], controller = new AbortController();
  try {
    const pending = store.getState().loadProject('p', undefined, controller.signal);
    controller.abort();
    release({ ...before, name: 'Should not be committed' });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.strictEqual(store.getState().data.projects[0], before);
    assert.equal(store.getState().error, null);
  } finally { projectsApi.loadProject = original; }
});
