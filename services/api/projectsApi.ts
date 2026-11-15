import type { AppSettings, AuditEntry, Drawing, Project, ReviewTrackerData, DeltaPayload, SaveResult } from '../../types';
import { apiClient, ApiError, type ApiClient, type ApiRequestOptions } from './apiClient';

export interface ProjectListItem { id: string; name: string; storagePath?: string; passwordProtected?: boolean }
export interface AuditLogPage { entries: AuditEntry[]; truncated: boolean }
export const projectResource = (projectId: string, resource = '') => 'projects/' + encodeURIComponent(projectId) + (resource ? '/' + resource : '');
export interface DrawingsByIdResult { drawings: Drawing[]; missing: string[]; reviewTracker: ReviewTrackerData }
/** null when the server answered 304: nothing changed since the copy this client already holds. */
export type IfChanged<T> = T | null;
/** The server has no project with this id (404): it was deleted, or never reached the server. */
export class ProjectNotFoundError extends Error {
  readonly code = 'PROJECT_NOT_FOUND';
  constructor(readonly projectId: string, readonly projectName?: string) { super('PROJECT_NOT_FOUND'); this.name = 'ProjectNotFoundError'; }
}
export const isProjectNotFound = (error: unknown): error is ProjectNotFoundError => error instanceof ProjectNotFoundError || (error as { code?: string } | null)?.code === 'PROJECT_NOT_FOUND';
const notFound = (project: Project, error: unknown): never => {
  if (error instanceof ApiError && error.status === 404) throw new ProjectNotFoundError(project.id, project.name);
  throw error;
};

export function createProjectsApi(client: ApiClient) {
  // Last body + ETag per read, so a refresh can ask "changed?" and get a bodyless 304 back.
  const cached = new Map<string, { etag: string; text: string }>();
  // Identical reads already on the wire are shared instead of sent twice.
  const inflight = new Map<string, Promise<{ changed: boolean; text: string }>>();
  // share=false for catch-up reads: one already on the wire may predate the change being caught up on.
  // A caller's AbortSignal is honoured; such a read is never shared (aborting it must not cancel others).
  const conditional = (key: string, resource: string, init: ApiRequestOptions, share = true) => {
    if (init.signal) share = false;
    const running = inflight.get(key);
    if (share && running) return running;
    const promise = (async () => {
      // A catch-up read must be newer, but wait for an existing cold read to establish
      // its ETag first rather than racing it with a second unconditional body request.
      if (!share && !init.signal && running) await running.catch(() => undefined);
      const held = cached.get(key), headers = new Headers(init.headers);
      if (held) headers.set('If-None-Match', held.etag);
      const response = await client.request(resource, { ...init, headers, cache: 'no-store' });
      if (response.status === 304 && held) return { changed: false, text: held.text };
      const text = await response.text(), etag = response.headers.get('ETag');
      if (etag) cached.set(key, { etag, text }); else cached.delete(key);
      return { changed: true, text };
    })().finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
    if (share) inflight.set(key, promise);
    return promise;
  };
  // The optional legacy argument is ignored: only the unlock endpoint accepts a password.
  const projectRead = (project: Project, _legacyPassword?: string, share = true, signal?: AbortSignal) =>
    conditional('project:' + project.id, projectResource(project.id), { method: 'POST', json: {}, signal }, share);
  const trackerRead = (projectId: string, share = true, signal?: AbortSignal) => conditional('tracker:' + projectId, projectResource(projectId, 'review-tracker'), { signal }, share);
  return {
    fetchGlobalSettings: (signal?: AbortSignal) => client.json<Partial<AppSettings> | null>('settings', { signal }),
    fetchProjectList: (signal?: AbortSignal) => client.json<ProjectListItem[]>('projects', { signal }),
    unlockProject: (projectId: string, password: string, signal?: AbortSignal) => client.json<{ success: boolean }>(projectResource(projectId, 'unlock'), { method: 'POST', json: { password }, signal }),
    // Always a fresh object (parsed from the held body on 304), so callers may keep and normalise it.
    async loadProject(project: Project, _legacyPassword?: string, signal?: AbortSignal): Promise<Project> {
      // A 404 throws ProjectNotFoundError: handing back the local copy would show a deleted project as if it existed.
      try { return JSON.parse((await projectRead(project, undefined, true, signal)).text) as Project; }
      catch (error) { return notFound(project, error); }
    },
    /** Like loadProject, but null when the server copy is the one this client last read (304). */
    async loadProjectIfChanged(project: Project, _legacyPassword?: string): Promise<IfChanged<Project>> {
      try { const read = await projectRead(project, undefined, false); return read.changed ? JSON.parse(read.text) as Project : null; }
      catch (error) { return notFound(project, error); }
    },
    /** Only these drawings and their review-tracker rows; ids the server no longer has come back in missing. */
    loadDrawings: (projectId: string, ids: string[], _legacyPassword?: string | null, signal?: AbortSignal) => client.json<DrawingsByIdResult>(
      projectResource(projectId, 'drawings') + '?' + new URLSearchParams({ ids: ids.join(',') }),
      { cache: 'no-store', signal }),
    deleteReviewer: (projectId: string, id: string) => client.json<{ok:boolean}>(projectResource(projectId, 'reviewers/' + encodeURIComponent(id)), {method:'DELETE'}),
    saveDelta: (projectId: string, payload: DeltaPayload, signal?: AbortSignal) => client.json<SaveResult>(projectResource(projectId), { method: 'PATCH', json: payload, signal }),
    loadReviewTracker: async (projectId: string, signal?: AbortSignal): Promise<ReviewTrackerData> => JSON.parse((await trackerRead(projectId, true, signal)).text),
    async loadReviewTrackerIfChanged(projectId: string): Promise<IfChanged<ReviewTrackerData>> {
      const read = await trackerRead(projectId, false); return read.changed ? JSON.parse(read.text) : null;
    },
    saveReviewTracker: (projectId: string, data: ReviewTrackerData, signal?: AbortSignal) => client.json<SaveResult>(projectResource(projectId, 'review-tracker'), { method: 'PUT', json: data, signal }),
    loadAuditLog: (projectId: string, fromISO: string, toISO: string, signal?: AbortSignal) => client.json<AuditLogPage>(projectResource(projectId, 'audit') + '?' + new URLSearchParams({ from: fromISO, to: toISO }), { signal }),
    async sendHeartbeat(projectId: string, signal?: AbortSignal): Promise<void> { await client.request(projectResource(projectId, 'heartbeat'), { method: 'PUT', signal }); },
    async getHeartbeat(projectId: string, signal?: AbortSignal): Promise<string | null> { return (await client.json<{ adminLastSeen: string | null }>(projectResource(projectId, 'heartbeat'), { signal })).adminLastSeen; },
    async testConnection(signal?: AbortSignal) { await client.request('health', { signal }); return { success: true, message: 'Connected to PAPC API' }; },
    eventsUrl: (projectId: string) => client.url(projectResource(projectId, 'events')),
    openEvents: (projectId: string, signal?: AbortSignal) => client.request(projectResource(projectId, 'events'), { headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal }),
  };
}

export const projectsApi = createProjectsApi(apiClient);
