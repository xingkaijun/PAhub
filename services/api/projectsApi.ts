import type { AppSettings, AuditEntry, Project, ReviewTrackerData, DeltaPayload, SaveResult } from '../../types';
import { apiClient, ApiError, type ApiClient } from './apiClient';

export interface ProjectListItem { id: string; name: string; storagePath?: string }
export interface AuditLogPage { entries: AuditEntry[]; truncated: boolean }
export const projectResource = (projectId: string, resource = '') => 'projects/' + encodeURIComponent(projectId) + (resource ? '/' + resource : '');

export function createProjectsApi(client: ApiClient) {
  return {
    fetchGlobalSettings: (signal?: AbortSignal) => client.json<Partial<AppSettings> | null>('settings', { signal }),
    fetchProjectList: (signal?: AbortSignal) => client.json<ProjectListItem[]>('projects', { signal }),
    async loadProject(project: Project, passwordInput?: string, signal?: AbortSignal): Promise<Project> {
      try { return await client.json<Project>(projectResource(project.id), { method: 'POST', json: { password: passwordInput || null }, signal }); }
      catch (error) { if (error instanceof ApiError && error.status === 404) return project; throw error; }
    },
    saveProject: (project: Project, reviewTracker: ReviewTrackerData, signal?: AbortSignal) => client.json<SaveResult>(projectResource(project.id), { method: 'PUT', json: { project, reviewTracker }, signal }),
    saveDelta: (projectId: string, payload: DeltaPayload, signal?: AbortSignal) => client.json<SaveResult>(projectResource(projectId), { method: 'PATCH', json: payload, signal }),
    loadReviewTracker: (projectId: string, signal?: AbortSignal) => client.json<ReviewTrackerData>(projectResource(projectId, 'review-tracker'), { signal }),
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
