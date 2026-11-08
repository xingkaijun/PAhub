import { AppSettings, Project, ReviewTrackerData, DeltaPayload, SaveResult } from '../../types';
import { AuditLogPage, DataRepository, ProjectListItem } from './types';

interface RequestOptions {
  method?: string;
  body?: unknown;
}

// Hub persistence client.
export class HubApiRepository implements DataRepository {
  constructor(private readonly baseUrl: string, private readonly authToken?: string) { }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    // Resolve requests against the Hub same-origin API.
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(path, new URL(base, globalThis.location?.origin));
    const res = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!res.ok) {
      const raw = await res.text();
      let message = raw;
      try { const parsed = JSON.parse(raw); if (typeof parsed.error === 'string') message = parsed.error; } catch { /* Older servers returned text. */ }
      const error = new Error(message || `API request failed: ${res.status}`);
      (error as any).status = res.status;
      throw error;
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  fetchGlobalSettings(_settings: AppSettings): Promise<Partial<AppSettings> | null> {
    return this.request<Partial<AppSettings> | null>('settings');
  }

  fetchProjectList(_settings: AppSettings): Promise<ProjectListItem[]> {
    return this.request<ProjectListItem[]>('projects');
  }

  async loadProject(_settings: AppSettings, project: Project, passwordInput?: string): Promise<Project> {
    try {
      const data = await this.request<Project>(`projects/${encodeURIComponent(project.id)}`, {
        method: 'POST',
        body: { password: passwordInput || null },
      });
      return data;
    } catch (error: any) {
      // If the project doesn't exist on the server yet (new local project), return the stub project
      if (error && error.status === 404) {
        return project;
      }
      throw error;
    }
  }

  async saveProject(_settings: AppSettings, project: Project, reviewTracker: ReviewTrackerData): Promise<SaveResult> {
    return this.request<SaveResult>(`projects/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      body: { project, reviewTracker },
    });
  }

  async saveDelta(_settings: AppSettings, projectId: string, payload: DeltaPayload): Promise<SaveResult> {
    return this.request<SaveResult>(`projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: payload,
    });
  }

  loadReviewTracker(_settings: AppSettings, project: Project): Promise<ReviewTrackerData> {
    return this.request<ReviewTrackerData>(`projects/${encodeURIComponent(project.id)}/review-tracker`);
  }

  async saveReviewTracker(_settings: AppSettings, project: Project, data: ReviewTrackerData): Promise<SaveResult> {
    return this.request<SaveResult>(`projects/${encodeURIComponent(project.id)}/review-tracker`, {
      method: 'PUT',
      body: data,
    });
  }

  // from / to 为完整 ISO 时刻：调用方把「本地日」边界折算成 UTC 后传入，
  // 否则 +08:00 的一天会被 UTC 日边界从早上 8 点切开
  loadAuditLog(_settings: AppSettings, project: Project, fromISO: string, toISO: string): Promise<AuditLogPage> {
    const query = `?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
    return this.request<AuditLogPage>(`projects/${encodeURIComponent(project.id)}/audit${query}`);
  }

  async sendHeartbeat(projectId: string): Promise<void> {
    await this.request(`projects/${encodeURIComponent(projectId)}/heartbeat`, { method: 'PUT' });
  }

  async getHeartbeat(projectId: string): Promise<string | null> {
    const res = await this.request<{ adminLastSeen: string | null }>(`projects/${encodeURIComponent(projectId)}/heartbeat`);
    return res.adminLastSeen;
  }

  async testConnection(_settings: AppSettings): Promise<{ success: boolean; message: string }> {
    await this.request('health');
    return { success: true, message: 'Connected to PAPC API' };
  }
}
