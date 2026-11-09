import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { errorResponse, type Router } from './router.ts';

export const ADMIN_COOKIE = 'pahub_admin';
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
// Failed logins are throttled per client address; the window is short enough that a
// mistyped password costs a few seconds, not an account lockout.
export const ADMIN_FAILURE_LIMIT = 5;
export const ADMIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;

export type AdminSessionOptions = {
  password?: string;
  apiToken?: string;
  now?: () => number;
  ttlMs?: number;
  secure?: (request: Request) => boolean;
};

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const cookieValue = (request: Request, name: string) => {
  const prefix = name + '=';
  return request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) || null;
};
const bearer = (request: Request) => {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};

// ADMIN_PASSWORD is the only administrator credential. With it unset every visitor is an
// administrator (local development convenience); startup logs a warning so exposure is obvious.
export function createAdminSession(options: AdminSessionOptions = {}) {
  const password = options.password?.trim() || '';
  const enabled = Boolean(password);
  const expected = enabled ? sha256(password) : undefined;
  const apiToken = options.apiToken?.trim() || '';
  const expectedToken = apiToken ? sha256(apiToken) : undefined;
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs || ADMIN_SESSION_MS;
  // In-memory key: a restart invalidates live sessions, which is the intended behaviour.
  const secret = randomBytes(32);
  const failures = new Map<string, number[]>();
  const signature = (expires: string) => createHmac('sha256', secret).update('admin:' + expires).digest('base64url');
  const address = (request: Request) => request.headers.get('X-Hub-Remote-Address') || 'local';
  const same = (left: Buffer, right: Buffer) => left.length === right.length && timingSafeEqual(left, right);
  const secure = (request: Request) => {
    if (options.secure) return options.secure(request);
    const proto = request.headers.get('X-Forwarded-Proto')?.split(',')[0].trim().toLowerCase();
    return new URL(request.url).protocol === 'https:' || proto === 'https';
  };
  const cookie = (request: Request, value: string, maxAge: number) =>
    ADMIN_COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure(request) ? '; Secure' : '');

  const sessionExpiry = (request: Request) => {
    const value = cookieValue(request, ADMIN_COOKIE);
    if (!value) return null;
    const [expires, mac] = value.split('.');
    if (!expires || !mac || !/^\d+$/.test(expires)) return null;
    const expectedMac = Buffer.from(signature(expires));
    const supplied = Buffer.from(mac);
    if (!same(supplied, expectedMac)) return null;
    return Number(expires) > now() ? Number(expires) : null;
  };
  // API_TOKEN is a machine credential, not a personal account: it counts as administrator.
  const isAdmin = (request: Request) => {
    if (!enabled) return true;
    if (expectedToken && same(sha256(bearer(request)), expectedToken)) return true;
    return sessionExpiry(request) !== null;
  };
  const retryAfter = (client: string) => {
    const recent = (failures.get(client) || []).filter(at => now() - at < ADMIN_FAILURE_WINDOW_MS);
    if (recent.length) failures.set(client, recent); else failures.delete(client);
    return recent.length >= ADMIN_FAILURE_LIMIT ? Math.ceil((recent[0] + ADMIN_FAILURE_WINDOW_MS - now()) / 1000) : 0;
  };
  const recordFailure = (client: string) => {
    const recent = (failures.get(client) || []).filter(at => now() - at < ADMIN_FAILURE_WINDOW_MS);
    recent.push(now());
    failures.set(client, recent);
  };

  return {
    enabled,
    isAdmin,
    /** POST /api/session */
    async login(request: Request): Promise<Response> {
      if (!enabled) return Response.json({ admin: true, requiresPassword: false }, { headers: { 'Cache-Control': 'no-store' } });
      const client = address(request);
      const wait = retryAfter(client);
      if (wait) return errorResponse('Too many failed login attempts; try again later', 429, { 'Retry-After': String(wait) });
      let submitted = '';
      try {
        const value = await request.json() as { password?: unknown };
        submitted = typeof value?.password === 'string' ? value.password : '';
      } catch { submitted = ''; }
      if (!same(sha256(submitted), expected!)) {
        recordFailure(client);
        return errorResponse('Invalid administrator password', 401);
      }
      failures.delete(client);
      const expires = String(now() + ttlMs);
      return Response.json({ admin: true, requiresPassword: true, expiresAt: Number(expires) }, {
        headers: { 'Cache-Control': 'no-store', 'Set-Cookie': cookie(request, expires + '.' + signature(expires), Math.floor(ttlMs / 1000)) },
      });
    },
    /** DELETE /api/session */
    logout(request: Request): Response {
      return Response.json({ admin: !enabled, requiresPassword: enabled }, {
        headers: { 'Cache-Control': 'no-store', 'Set-Cookie': cookie(request, '', 0) },
      });
    },
    /** GET /api/session */
    status(request: Request): Response {
      return Response.json({ admin: isAdmin(request), requiresPassword: enabled }, { headers: { 'Cache-Control': 'no-store' } });
    },
  };
}

export function registerAdminSessionRoutes(router: Router, session: AdminSession) {
  // One route for all verbs: the router matches on path first, so three same-pattern entries would shadow each other.
  router.add({
    pattern: /^\/api\/session$/, methods: ['GET', 'POST', 'DELETE'], auth: 'none',
    handle: ctx => ctx.request.method === 'POST' ? session.login(ctx.request) : ctx.request.method === 'DELETE' ? session.logout(ctx.request) : session.status(ctx.request),
  });
}

export type AdminSession = ReturnType<typeof createAdminSession>;
