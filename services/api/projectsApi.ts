import type { AppSettings, AuditEntry, Drawing, Project, ReviewTrackerData, DeltaPayload, SaveResult } from '../../types';
import { apiClient, ApiError, type ApiClient, type ApiRequestOptions } from './apiClient';

export interface ProjectListItem { id: string; name: string; storagePath?: string }
export interface AuditLogPage { entries: AuditEntry[]; truncated: boolean }
export const projectResource = (projectId: string, resource = '') => 'projects/' + encodeURIComponent(projectId) + (resource ? '/' + resource : '');
export interface DrawingsByIdResult { drawings: Drawing[]; missing: string[]; reviewTracker: ReviewTrackerData }
/** null when the server answered 304: nothing changed since the copy this client already holds. */
export type IfChanged<T> = T | null;

export function createProjectsApi(client: ApiClient) {
  // Last body + ETag per read, so a refresh can ask "changed?" and get a bodyless 304 back.
  const cached = new Map<string, { etag: string; text: string }>();
  // Identical reads already on the wire are shared instead of sent twice.
  const inflight = new Map<string, Promise<{ changed: boolean; text: string }>>();
  // share=false for catch-up reads: one already on the wire may predate the change being caught up on.
  // A caller's AbortSignal is honoured; such a read is never shared (aborting it must not cancel others).
  const conditional = (key: string, resource: string, init: ApiRequestOptions, share = true) => {
    if (init.signal) share = false;
    const running = share ? inflight.get(key) : undefined;
    if (running) return running;
    const promise = (async () => {
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
  const projectRead = (project: Project, passwordInput?: string, share = true, signal?: AbortSignal) =>
    conditional('project:' + project.id + ':' + (passwordInput || ''), projectResource(project.id), { method: 'POST', json: { password: passwordInput || null }, signal }, share);
  const trackerRead = (projectId: string, share = true, signal?: AbortSignal) => conditional('tracker:' + projectId, projectResource(projectId, 'review-tracker'), { signal }, share);
  return {
    fetchGlobalSettings: (signal?: AbortSignal) => client.json<Partial<AppSettings> | null>('settings', { signal }),
    fetchProjectList: (signal?: AbortSignal) => client.json<ProjectListItem[]>('projects', { signal }),
    // Always a fresh object (parsed from the held body on 304), so callers may keep and normalise it.
    async loadProject(project: Project, passwordInput?: string, signal?: AbortSignal): Promise<Project> {
      try { return JSON.parse((await projectRead(project, passwordInput, true, signal)).text) as Project; }
      catch (error) { if (error instanceof ApiError && error.status === 404) return project; throw error; }
    },
    /** Like loadProject, but null when the server copy is the one this client last read (304). */
    async loadProjectIfChanged(project: Project, passwordInput?: string): Promise<IfChanged<Project>> {
      try { const read = await projectRead(project, passwordInput, false); return read.changed ? JSON.parse(read.text) as Project : null; }
      catch (error) { if (error instanceof ApiError && error.status === 404) return project; throw error; }
    },
    /** Only these drawings and their review-tracker rows; ids the server no longer has come back in missing. */
    loadDrawings: (projectId: string, ids: string[], password?: string | null, signal?: AbortSignal) => client.json<DrawingsByIdResult>(
      projectResource(projectId, 'drawings') + '?' + new URLSearchParams({ ids: ids.join(',') }),
      { headers: password ? { 'X-Project-Password': encodeURIComponent(password) } : undefined, cache: 'no-store', signal }),
    saveProject: (project: Project, reviewTracker: ReviewTrackerData, signal?: AbortSignal) => client.json<SaveResult>(projectResource(project.id), { method: 'PUT', json: { project, reviewTracker }, signal }),
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
