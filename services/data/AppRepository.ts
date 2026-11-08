import { AppSettings, Project, ReviewTrackerData, DeltaPayload, SaveResult } from '../../types';
import { HubApiRepository } from './HubApiRepository';
import { AuditLogPage, ProjectListItem } from './types';

const apiBaseUrl = import.meta.env.VITE_DATA_API_BASE_URL?.trim() || '/api';
const apiToken = import.meta.env.VITE_DATA_API_TOKEN?.trim() || '';

const apiRepository = new HubApiRepository(apiBaseUrl, apiToken);

export const appRepository = {
  isHubApiConfigured(): boolean {
    return Boolean(apiBaseUrl);
  },

  fetchGlobalSettings(settings: AppSettings): Promise<Partial<AppSettings> | null> {
    return apiRepository.fetchGlobalSettings(settings);
  },

  fetchProjectList(settings: AppSettings): Promise<ProjectListItem[]> {
    return apiRepository.fetchProjectList(settings);
  },

  loadProject(settings: AppSettings, project: Project, passwordInput?: string): Promise<Project> {
    return apiRepository.loadProject(settings, project, passwordInput);
  },

  saveProject(settings: AppSettings, project: Project, reviewTracker: ReviewTrackerData): Promise<SaveResult> {
    return apiRepository.saveProject(settings, project, reviewTracker);
  },

  saveDelta(settings: AppSettings, projectId: string, payload: DeltaPayload): Promise<SaveResult> {
    return apiRepository.saveDelta(settings, projectId, payload);
  },

  loadReviewTracker(settings: AppSettings, project: Project): Promise<ReviewTrackerData> {
    return apiRepository.loadReviewTracker(settings, project);
  },

  saveReviewTracker(settings: AppSettings, project: Project, data: ReviewTrackerData): Promise<SaveResult> {
    return apiRepository.saveReviewTracker(settings, project, data);
  },

  loadAuditLog(settings: AppSettings, project: Project, fromISO: string, toISO: string): Promise<AuditLogPage> {
    return apiRepository.loadAuditLog(settings, project, fromISO, toISO);
  },

  testConnection(settings: AppSettings, options?: { url?: string; user?: string; pass?: string; proxyUrl?: string }): Promise<{ success: boolean; message: string }> {
    return apiRepository.testConnection(settings);
  },

  sendHeartbeat(projectId: string): Promise<void> {
    return apiRepository.sendHeartbeat(projectId);
  },

  getHeartbeat(projectId: string): Promise<string | null> {
    return apiRepository.getHeartbeat(projectId);
  },
};
