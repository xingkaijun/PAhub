import { apiClient, type ApiClient } from './apiClient';
import { projectResource } from './projectsApi';

export interface BuilderReplyRow {
  id: string; fileName: string; importSetId?: string; drawingId?: string; drawingNo?: string; title?: string;
  tags?: string[]; round?: number | string; newReplies?: number; automatic?: number; conflicts?: number;
  papcStatus?: string; statusNote?: string; category: string; reason?: string; ownerTampered?: boolean;
}
export interface BuilderReplyResult { id: string; category: string; conflicts?: number; status?: string; reason?: string }
const resource = (projectId: string, action: string) => projectResource(projectId, 'builder-replies/' + action);

export function createBuilderRepliesApi(client: ApiClient) {
  return {
    pending: (projectId: string, signal?: AbortSignal) => client.json<BuilderReplyRow[]>(resource(projectId, 'pending'), { signal }),
    preview(projectId: string, files: File[], signal?: AbortSignal) {
      const form = new FormData(); files.forEach(file => form.append('files', file));
      return client.json<{ importSetId: string; files: BuilderReplyRow[] }>(resource(projectId, 'preview'), { method: 'POST', body: form, signal });
    },
    apply: (projectId: string, importSetId: string, fileIds: string[], batchId: string, signal?: AbortSignal) => client.json<{ results: BuilderReplyResult[] }>(resource(projectId, encodeURIComponent(importSetId) + '/apply'), { method: 'POST', json: { fileIds, batchId }, signal }),
    skip: (projectId: string, importSetId: string, fileId: string, signal?: AbortSignal) => client.json<unknown>(resource(projectId, encodeURIComponent(importSetId) + '/skip'), { method: 'POST', json: { fileId }, signal }),
  };
}

export const builderRepliesApi = createBuilderRepliesApi(apiClient);
