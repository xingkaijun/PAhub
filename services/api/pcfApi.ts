import { apiClient, type ApiClient } from './apiClient';

export interface PcfIndexEntry { drawing_id: string; [key: string]: unknown }
export interface PcfPresence { drawings: Record<string, unknown[]> }
export interface BatchExport { drawingIds: string[]; batchId: string; clientId: string; clientName: string }
const projectResource = (projectId: string) => 'pcf/' + encodeURIComponent(projectId);

export function createPcfApi(client: ApiClient) {
  return {
    refreshPresence: (projectId: string, signal?: AbortSignal) => client.json<PcfPresence>(projectResource(projectId) + '/presence', { signal }),
    getIndex: (projectId: string, signal?: AbortSignal) => client.json<PcfIndexEntry[]>(projectResource(projectId) + '/index', { signal }),
    async ensureSession(projectId: string, drawingId: string, signal?: AbortSignal): Promise<void> {
      if (!client.hasToken()) return;
      await client.request(projectResource(projectId) + '/' + encodeURIComponent(drawingId) + '/session', { method: 'POST', signal });
    },
    exportBatch: (projectId: string, payload: BatchExport, signal?: AbortSignal) => client.download(projectResource(projectId) + '/exports/batch', 'PAhub_SendAll.zip', { method: 'POST', json: payload, signal }),
  };
}

export const pcfApi = createPcfApi(apiClient);
