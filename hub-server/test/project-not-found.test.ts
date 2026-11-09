/// <reference types="vite/client" />
// Round 5: a project read that the server answers with 404 must not hand back the local copy.
// loadProject / loadProjectIfChanged throw ProjectNotFoundError, the store raises projectNotice and does not
// open the project (unless it was created locally and never reached the server), Send All read-back reports the
// project as missing, and the whole-project PUT is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../../services/api/apiClient';
import { createProjectsApi, isProjectNotFound, ProjectNotFoundError, projectsApi } from '../../services/api/projectsApi';

const fakeFetch = (status: number) => (async (input: RequestInfo | URL) => {
  const body = status === 200 ? { id: 'p', name: 'P', drawings: [{ id: 'd1' }] } : { error: status === 404 ? 'Project not found: p' : 'boom' };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

test('projects api: 404 throws ProjectNotFoundError for loadProject and loadProjectIfChanged; other errors pass through', async () => {
  const stub = { id: 'p', name: 'P-LOCAL', drawings: [{ id: 'local-only' }] } as any;
  const missing = createProjectsApi(createApiClient({ baseUrl: 'http://hub.test/api', fetch: fakeFetch(404) }));
  await assert.rejects(missing.loadProject(stub), (error: unknown) => {
    assert.ok(error instanceof ProjectNotFoundError); assert.equal(isProjectNotFound(error), true);
    assert.equal((error as ProjectNotFoundError).projectId, 'p'); assert.equal((error as ProjectNotFoundError).projectName, 'P-LOCAL');
    return true;
  });
  await assert.rejects(missing.loadProjectIfChanged(stub), (error: unknown) => isProjectNotFound(error));
  const failing = createProjectsApi(createApiClient({ baseUrl: 'http://hub.test/api', fetch: fakeFetch(500) }));
  await assert.rejects(failing.loadProject(stub), (error: unknown) => error instanceof ApiError && error.status === 500 && !isProjectNotFound(error));
  const ok = createProjectsApi(createApiClient({ baseUrl: 'http://hub.test/api', fetch: fakeFetch(200) }));
  assert.deepEqual((await ok.loadProject(stub)).drawings, [{ id: 'd1' }]);
  assert.equal('saveProject' in ok, false, 'whole-project PUT client method removed');
});

async function storeWith(projects: any[], activeProjectId: string | null) {
  const { useStore } = await import('../../store');
  useStore.setState({ activeProjectId, projectNotice: null, error: null, isLoading: false, reviewTracker: {},
    data: { ...useStore.getState().data, projects } } as any);
  return useStore;
}

test('store loadProject: 404 sets projectNotice, keeps the active project and the local entry, does not open it', async () => {
  const original = projectsApi.loadProject;
  projectsApi.loadProject = async (project: any) => { throw new ProjectNotFoundError(project.id, project.name); };
  try {
    const local = { id: 'gone', name: 'PG-GONE', conf: {}, drawings: [{ id: 'kept' }], };
    const useStore = await storeWith([{ id: 'open', name: 'OPEN', conf: {}, drawings: [] }, local], 'open');
    await assert.rejects(useStore.getState().loadProject('gone'), (error: unknown) => isProjectNotFound(error));
    const state = useStore.getState();
    assert.equal(state.activeProjectId, 'open');
    assert.equal(state.isLoading, false);
    assert.match(state.projectNotice!.message, /Project "PG-GONE" does not exist on the server/);
    assert.equal(state.projectNotice!.projectId, 'gone');
    assert.deepEqual(state.data.projects.find(p => p.id === 'gone')!.drawings, [{ id: 'kept' }], 'local entry untouched');
    state.clearProjectNotice();
    assert.equal(useStore.getState().projectNotice, null);
  } finally { projectsApi.loadProject = original; }
});

test('store refresh of the open project: 404 shows the "no longer exists" notice', async () => {
  const original = projectsApi.loadProjectIfChanged, originalTracker = projectsApi.loadReviewTrackerIfChanged;
  projectsApi.loadProjectIfChanged = async (project: any) => { throw new ProjectNotFoundError(project.id, project.name); };
  projectsApi.loadReviewTrackerIfChanged = async () => null;
  try {
    const useStore = await storeWith([{ id: 'open', name: 'OPEN', conf: {}, drawings: [], }], 'open');
    await assert.rejects(useStore.getState().refreshProjectPreservingDirty('open'), (error: unknown) => isProjectNotFound(error));
    assert.match(useStore.getState().projectNotice!.message, /Project "OPEN" no longer exists on the server/);
  } finally { projectsApi.loadProjectIfChanged = original; projectsApi.loadReviewTrackerIfChanged = originalTracker; }
});

test('store: a project made with New project that is not on the server yet still opens locally, without a notice', async () => {
  const original = projectsApi.loadProject, originalIfChanged = projectsApi.loadProjectIfChanged, originalTracker = projectsApi.loadReviewTrackerIfChanged;
  projectsApi.loadProject = async (project: any) => { throw new ProjectNotFoundError(project.id, project.name); };
  projectsApi.loadProjectIfChanged = async (project: any) => { throw new ProjectNotFoundError(project.id, project.name); };
  projectsApi.loadReviewTrackerIfChanged = async () => null;
  try {
    const fresh = { id: 'fresh', name: 'PG-NEW-H0001', localOnly: true, conf: { roundACycle: 14 }, drawings: [] }; // made with New project, first save not on the server yet
    const useStore = await storeWith([fresh], null);
    await useStore.getState().loadProject('fresh');
    assert.equal(useStore.getState().activeProjectId, 'fresh');
    assert.equal(useStore.getState().projectNotice, null);
    assert.equal(await useStore.getState().refreshProjectPreservingDirty('fresh'), 0);
    assert.equal(useStore.getState().projectNotice, null);
    // addProject marks new projects localOnly
    useStore.getState().addProject('PG-NEW-H0002');
    assert.equal(useStore.getState().data.projects.find(p => p.name === 'PG-NEW-H0002')!.localOnly, true);
  } finally { projectsApi.loadProject = original; projectsApi.loadProjectIfChanged = originalIfChanged; projectsApi.loadReviewTrackerIfChanged = originalTracker; }
});

test('Send All read-back: a project missing on the server is reported as missing, not compared against the local copy', async () => {
  const original = projectsApi.loadProject;
  projectsApi.loadProject = async (project: any) => { throw new ProjectNotFoundError(project.id, project.name); };
  try {
    const useStore = await storeWith([{ id: 'open', name: 'OPEN', conf: {}, drawings: [{ id: 'd1', status: 'Waiting Reply' }] }], 'open');
    const result = await useStore.getState().verifySentDrawings('open', [{ drawingId: 'd1', status: 'Waiting Reply' } as any]);
    assert.equal(result.ok, false); assert.equal(result.error, 'Project missing on server');
  } finally { projectsApi.loadProject = original; }
});
