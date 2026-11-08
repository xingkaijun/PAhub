import type { CommentsFilters, CommentsResponse, CommentsStreamState } from '../types/comments';

const apiBaseUrl = import.meta.env.VITE_DATA_API_BASE_URL?.trim() || '/api';
const apiToken = import.meta.env.VITE_DATA_API_TOKEN?.trim() || '';

function projectUrl(projectId: string, resource: string): string {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  return new URL('projects/' + encodeURIComponent(projectId) + '/' + resource, new URL(base, location.origin)).toString();
}

function authHeaders(accept: string): HeadersInit {
  return { Accept: accept, ...(apiToken ? { Authorization: 'Bearer ' + apiToken } : {}) };
}

/** Shared by list and XLSX export. Pagination and sorting are local only. */
export function commentsQuery(filters: CommentsFilters): string {
  const query = new URLSearchParams();
  const keys: Array<keyof CommentsFilters> = [
    'discipline', 'drawingStatus', 'commentStatus', 'round', 'tag', 'q', 'openOlderThanDays',
  ];
  for (const key of keys) {
    const value = filters[key];
    if (value !== undefined && String(value).trim() !== '') query.set(key, String(value).trim());
  }
  return query.toString();
}

function filteredUrl(projectId: string, resource: string, filters: CommentsFilters): string {
  const query = commentsQuery(filters);
  return projectUrl(projectId, resource) + (query ? '?' + query : '');
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  let message = '';
  try {
    const body = await response.json();
    if (typeof body.error === 'string') message = body.error;
    else if (typeof body.message === 'string') message = body.message;
  } catch { /* A proxy may return HTML rather than an API error. */ }
  throw new Error(message || (response.status === 401
    ? 'Unauthorized. Check the configured API token.'
    : 'Comments request failed (' + response.status + ').'));
}

export async function fetchComments(
  projectId: string, filters: CommentsFilters = {}, signal?: AbortSignal,
): Promise<CommentsResponse> {
  const response = await fetch(filteredUrl(projectId, 'comments', filters), {
    headers: authHeaders('application/json'), cache: 'no-store', signal,
  });
  await checkResponse(response);
  const data = await response.json() as CommentsResponse;
  if (!Array.isArray(data.comments) || !data.statistics || !data.options || !Array.isArray(data.warnings)) {
    throw new Error('The server returned an invalid comments register. Check Phase 9 API availability.');
  }
  return data;
}

export async function exportCommentsXlsx(
  projectId: string, filters: CommentsFilters, signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(filteredUrl(projectId, 'comments.xlsx', filters), {
    headers: authHeaders('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    cache: 'no-store', signal,
  });
  await checkResponse(response);
  if (/text\/html|application\/json/i.test(response.headers.get('Content-Type') || '')) {
    throw new Error('The server did not return an XLSX file. Check Phase 9 export availability.');
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  let filename = disposition.match(/filename="([^"]+)"/i)?.[1]
    || disposition.match(/filename=([^;\s]+)/i)?.[1]
    || 'comments.xlsx';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encodedName) { try { filename = decodeURIComponent(encodedName); } catch { /* Use fallback. */ } }
  filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!/\.xlsx$/i.test(filename)) filename += '.xlsx';
  return { blob: await response.blob(), filename };
}

/** Only invalidates the register; never fetches comments or project data. */
export function subscribeToCommentChanges(
  projectId: string, onStale: () => void, onState: (state: CommentsStreamState) => void,
): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let connectedBefore = false;

  const connect = async () => {
    controller = new AbortController();
    onState('connecting');
    try {
      const response = await fetch(projectUrl(projectId, 'events'), {
        headers: authHeaders('text/event-stream'), cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('Project event stream unavailable');
      if (stopped) { await response.body.cancel(); return; }
      // Changes may have been missed while disconnected. Still only mark stale.
      if (connectedBefore) onStale();
      connectedBefore = true;
      retryDelay = 1000;
      onState('live');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const lines = frame.split(/\r?\n/);
            const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
            if (event !== 'drawing-changed') continue;
            const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            try {
              if (typeof JSON.parse(payload)?.drawingId === 'string' && !stopped) onStale();
            } catch { /* Ignore malformed frames. */ }
          }
        }
      } finally { reader.releaseLock(); }
      if (!stopped) throw new Error('Project event stream ended');
    } catch {
      if (stopped) return;
      onState('offline');
      if (connectedBefore) onStale();
      retryTimer = setTimeout(() => { retryTimer = undefined; void connect(); }, retryDelay);
      retryDelay = Math.min(30000, retryDelay * 2);
    }
  };
  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    if (retryTimer) clearTimeout(retryTimer);
  };
}
