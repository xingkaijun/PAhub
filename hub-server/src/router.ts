import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectFromPath, type ProjectSession } from './project-session.ts';
import { requestUser, validOrigin, KJX_ENFORCE_PROJECT_PASSWORD, type identityConfig } from './identity.ts';
import { forbidden, requirePermission, TRANSPORT_POLICIES, type RoutePolicy } from './capabilities.ts';
import { auditContext } from './audit.ts';

export type RouteContext = { request: Request; url: URL; params: string[]; json: () => Promise<Record<string, any>> };
export type Route = {
  pattern: RegExp; methods?: string[]; auth?: 'none'; admin?: boolean; policies?: RoutePolicy[];
  handle: (context: RouteContext) => Response | Promise<Response>;
};
export type RouterOptions = { API_TOKEN?: string; ALLOW_CORS_ORIGIN?: string; adminSession?: { isAdmin: (request: Request) => boolean }; projectSession?: ProjectSession; projectAccess?: (request: Request) => Response | undefined; identity?: ReturnType<typeof identityConfig>; authenticate?: (request: Request) => Promise<Response | undefined> };

export function errorResponse(message: string, status = 500, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', ...Object.fromEntries(new Headers(headers)) } });
}
export function caughtError(error: unknown): Response {
  const detail = error as { status?: number; message?: string; body?: Record<string, unknown> };
  const status = error instanceof SyntaxError || error instanceof URIError ? 400 : detail?.status || 500;
  if (status >= 500) console.error('PAhub request failed:', error);
  // Structured client errors (e.g. 409 DRAWING_CONFLICT) keep their details.
  if (status < 500 && detail?.body && typeof detail.body === 'object') return Response.json({ ...detail.body, error: detail.message || 'Invalid request' }, { status, headers: { 'Cache-Control': 'no-store' } });
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
  registeredRoutes(): readonly Route[] { return this.routes; }
  get kjx() { return this.options.identity?.mode === 'kjx'; }
  async authenticate(request: Request): Promise<Response | undefined> {
    if (!this.kjx || requestUser(request)) return;
    const url = new URL(request.url), config = this.options.identity!;
    if (request.method === 'GET' && url.pathname === '/api/health') return;
    const denied = await this.options.authenticate?.(request);
    if (!denied && requestUser(request)) return;
    if (denied?.status === 403) return denied;
    const base = config.publicUrl.replace(/\/$/, '');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return Response.json({ ok: false, error: 'unauthenticated', login: base + '/login' }, { status: 401 });
    return new Response(null, {status:302,headers:{Location:base + '/login?app=pahub&path=' + encodeURIComponent(url.pathname + url.search)}});
  }
  originDenied(request: Request): Response | undefined {
    if (this.kjx && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !validOrigin(request, this.options.identity!.publicOrigin)) return Response.json({ ok: false, error: 'bad_origin' }, { status: 403 });
  }
  transportDenied(request: Request): Response | undefined {
    if (!this.kjx) return;
    const path = new URL(request.url).pathname;
    const policy = TRANSPORT_POLICIES.find(p => p.method === request.method && p.pattern!.test(path));
    return policy ? requirePermission(requestUser(request),policy.capability) : forbidden('route.unregistered');
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const identityDenied = await this.authenticate(request);
    if (identityDenied) return this.finish(identityDenied, url);
    const originDenied = this.originDenied(request);
    if (originDenied) return this.finish(originDenied, url);
    let response: Response;
    try {
      const membershipDenied = this.kjx ? this.options.projectAccess?.(request) : undefined;
      if (membershipDenied) return this.finish(membershipDenied,url);
      if (request.method === 'OPTIONS' && url.pathname.startsWith('/api')) response = this.transportDenied(request) || new Response(null, { status: 204 });
      else {
        let matched: Route | undefined, params: string[] = [];
        for (const route of this.routes) {
          const match = url.pathname.match(route.pattern);
          if (match) { matched = route; params = match.slice(1).map(value => value === undefined ? '' : decodeURIComponent(value)); break; }
        }
        const policy = matched?.policies?.find(p => p.method === request.method && (!p.pattern || p.pattern.test(url.pathname)));
        const denied = this.kjx ? (!policy ? forbidden('route.unregistered') : request.method === 'GET' && url.pathname === '/api/health' ? undefined : requirePermission(requestUser(request), policy.capability)) : undefined;
        if (denied) response = denied;
        else if (!matched) response = errorResponse('Not found', 404);
        else if (!this.kjx && matched.auth !== 'none' && this.options.API_TOKEN && request.headers.get('Authorization') !== 'Bearer ' + this.options.API_TOKEN) response = errorResponse('Unauthorized', 401);
        else if (matched.methods && !matched.methods.includes(request.method)) response = errorResponse('Method not allowed', 405, { Allow: matched.methods.join(', ') });
        else if ((!this.kjx || KJX_ENFORCE_PROJECT_PASSWORD) && this.options.projectSession && projectFromPath(url.pathname) && !/^\/api\/projects\/[^/]+\/unlock$/.test(url.pathname) && !this.options.projectSession.allowed(request, projectFromPath(url.pathname)!)) response = this.options.projectSession.challenge(request, projectFromPath(url.pathname)!)!;
        else if (!this.kjx && matched.admin && this.options.adminSession && !this.options.adminSession.isAdmin(request)) response = errorResponse('Administrator permission required', 403);
        else {
          let body: Promise<Record<string, any>> | undefined;
          response = await auditContext.run({ actor: this.kjx ? requestUser(request) : undefined, source: this.kjx ? 'kjx' : 'legacy' }, () => matched!.handle({ request, url, params, json: () => body ||= request.text().then(text => {
            const value = text ? JSON.parse(text) : {};
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Expected JSON object'), { status: 400 });
            return value;
          }) }));
        }
      }
    } catch (error) { response = caughtError(error); }
    // The PCF credential-entry page is a deliberate HTML authentication challenge,
    // not an API error; keep it usable when optional API_TOKEN is enabled.
    if (!(url.pathname.startsWith('/pcf/') && response.status === 401 && response.headers.get('Content-Type')?.includes('text/html'))) response = await normalizeError(response);
    return this.finish(response, url);
  }
  private finish(response: Response, url: URL): Response {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!this.kjx || this.options.ALLOW_CORS_ORIGIN) response.headers.set('Access-Control-Allow-Origin', this.options.ALLOW_CORS_ORIGIN || '*');
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
