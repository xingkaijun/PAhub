import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteContext = { request: Request; url: URL; params: string[]; json: () => Promise<Record<string, any>> };
export type Route = { pattern: RegExp; methods?: string[]; auth?: 'none'; handle: (context: RouteContext) => Response | Promise<Response> };
export type RouterOptions = { API_TOKEN?: string; ALLOW_CORS_ORIGIN?: string };

export function errorResponse(message: string, status = 500, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', ...Object.fromEntries(new Headers(headers)) } });
}
export function caughtError(error: unknown): Response {
  const detail = error as { status?: number; message?: string };
  const status = error instanceof SyntaxError || error instanceof URIError ? 400 : detail?.status || 500;
  if (status >= 500) console.error('PAhub request failed:', error);
  return errorResponse(status >= 500 ? 'Internal server error' : detail.message || 'Invalid request', status);
}

export async function normalizeError(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.error === 'string') return Response.json(parsed, { status: response.status, headers });
  } catch { /* Legacy routes returned text, now consistently {error}. */ }
  headers.delete('Content-Type');
  return errorResponse(text || (response.status === 404 ? 'Not found' : 'Request failed'), response.status, headers);
}

export class Router {
  private routes: Route[] = [];
  constructor(readonly options: RouterOptions = {}) {}
  add(route: Route): this { this.routes.push(route); return this; }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (request.method === 'OPTIONS' && url.pathname.startsWith('/api')) response = new Response(null, { status: 204 });
      else {
        let matched: Route | undefined, params: string[] = [];
        for (const route of this.routes) {
          const match = url.pathname.match(route.pattern);
          if (match) { matched = route; params = match.slice(1).map(value => value === undefined ? '' : decodeURIComponent(value)); break; }
        }
        if (!matched) response = errorResponse('Not found', 404);
        else if (matched.auth !== 'none' && this.options.API_TOKEN && request.headers.get('Authorization') !== 'Bearer ' + this.options.API_TOKEN) response = errorResponse('Unauthorized', 401);
        else if (matched.methods && !matched.methods.includes(request.method)) response = errorResponse('Method not allowed', 405, { Allow: matched.methods.join(', ') });
        else {
          let body: Promise<Record<string, any>> | undefined;
          response = await matched.handle({ request, url, params, json: () => body ||= request.text().then(text => {
            const value = text ? JSON.parse(text) : {};
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Expected JSON object'), { status: 400 });
            return value;
          }) });
        }
      }
    } catch (error) { response = caughtError(error); }
    response = await normalizeError(response);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      response.headers.set('Access-Control-Allow-Origin', this.options.ALLOW_CORS_ORIGIN || '*');
      response.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PCF-Token');
    }
    return response;
  }
}

export function basicAuthResponse(header: string | undefined, expected: string): Response | undefined {
  if (!expected) return;
  const [scheme, encoded] = (header || '').split(' ');
  const credentials = scheme?.toLowerCase() === 'basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (credentials && timingSafeEqual(digest(credentials), digest(expected))) return;
  return errorResponse('Unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="PAhub", charset="UTF-8"' });
}

// Log paths without queries, headers or bodies: scoped tokens and passwords must not enter logs.
export function logRequest(req: IncomingMessage, res: ServerResponse): void {
  const start = performance.now();
  let logged = false;
  const log = () => {
    if (logged) return; logged = true;
    console.log(JSON.stringify({ method: req.method, path: (req.url || '/').split('?')[0], status: res.statusCode, durationMs: Math.round(performance.now() - start) }));
  };
  res.once('finish', log); res.once('close', log);
}
