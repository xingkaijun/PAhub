import { AppSettings, AuditEntry, Project, ReviewTrackerData, DeltaPayload, SaveResult } from '../../types';

export interface ProjectListItem {
  id: string;
  name: string;
  storagePath?: string;
}

export interface AuditLogPage {
  entries: AuditEntry[];
  truncated: boolean;
}

export interface DataRepository {
  fetchGlobalSettings(settings: AppSettings): Promise<Partial<AppSettings> | null>;
  fetchProjectList(settings: AppSettings): Promise<ProjectListItem[]>;
  loadProject(settings: AppSettings, project: Project, passwordInput?: string): Promise<Project>;
  saveProject(settings: AppSettings, project: Project, reviewTracker: ReviewTrackerData): Promise<SaveResult>;
  saveDelta(settings: AppSettings, projectId: string, payload: DeltaPayload): Promise<SaveResult>;
  loadReviewTracker(settings: AppSettings, project: Project): Promise<ReviewTrackerData>;
  saveReviewTracker(settings: AppSettings, project: Project, data: ReviewTrackerData): Promise<SaveResult>;
  loadAuditLog(settings: AppSettings, project: Project, fromISO: string, toISO: string): Promise<AuditLogPage>;
  testConnection(settings: AppSettings, options?: { url?: string; user?: string; pass?: string; proxyUrl?: string }): Promise<{ success: boolean; message: string }>;
}
