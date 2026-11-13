/// <reference types="vite/client" />

export class ApiError extends Error {
  // data: parsed JSON error body when the server sent one (e.g. 409 conflict details).
  constructor(message: string, public readonly status: number, public readonly data?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  json?: unknown;
  body?: BodyInit;
}

export interface ApiClientConfig {
  baseUrl?: string;
  token?: string;
  origin?: string;
  fetch?: typeof fetch;
}

export function downloadFilename(headers: Headers, fallback: string): string {
  const disposition = headers.get('Content-Disposition') || '';
  let filename = disposition.match(/filename="([^"]+)"/i)?.[1]
    || disposition.match(/filename=([^;\s]+)/i)?.[1] || fallback;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { filename = decodeURIComponent(encoded); } catch { /* Keep the plain fallback. */ } }
  return filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

export function createApiClient(config: ApiClientConfig = {}) {
  const baseUrl = config.baseUrl?.trim() || '/api';
  const token = config.token?.trim() || '';
  const url = (resource: string) => {
    const origin = config.origin || globalThis.location?.origin || globalThis.window?.location?.origin;
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/', origin);
    return new URL(resource, base).toString();
  };
  const request = async (resource: string, options: ApiRequestOptions = {}): Promise<Response> => {
    const { json, body, headers: suppliedHeaders, ...init } = options;
    const headers = new Headers(suppliedHeaders);
    // With no token do not set Authorization: browsers retain their own Basic credentials.
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    const response = await (config.fetch || globalThis.fetch)(url(resource), {
      ...init, headers, body: json === undefined ? body : JSON.stringify(json),
    });
    // 304 only comes back when the caller sent its own If-None-Match; the caller then reuses what it holds.
    if (!response.ok && response.status !== 304) {
      const raw = await response.text();
      let message = raw;
      let data: any;
      try {
        data = JSON.parse(raw);
        message = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : '';
      } catch { /* Legacy APIs return text and reverse proxies may return HTML. */ }
      if (response.status === 401 && message === 'PASSWORD_REQUIRED' && typeof window !== 'undefined') {
        const pathname = new URL(url(resource)).pathname;
        const scope = pathname.match(/\/api\/(?:projects|pcf)\/([^/]+)(?:\/|$)/);
        if (scope && !pathname.endsWith('/unlock')) window.dispatchEvent(new CustomEvent('pahub:project-locked', { detail: { projectId: decodeURIComponent(scope[1]) } }));
      }
      throw new ApiError(message || 'API request failed: ' + response.status, response.status, data && typeof data === 'object' ? data : undefined);
    }
    return response;
  };
  return {
    url,
    hasToken: () => Boolean(token),
    request,
    async json<T>(resource: string, options: ApiRequestOptions = {}): Promise<T> {
      const response = await request(resource, options);
      return response.status === 204 ? undefined as T : response.json() as Promise<T>;
    },
    async download(resource: string, fallback: string, options: ApiRequestOptions = {}) {
      const response = await request(resource, options);
      return { blob: await response.blob(), filename: downloadFilename(response.headers, fallback) };
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
export const apiClient = createApiClient({
  baseUrl: import.meta.env.VITE_DATA_API_BASE_URL,
  token: import.meta.env.VITE_DATA_API_TOKEN,
});
