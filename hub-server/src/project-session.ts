import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AdminSession } from './admin-session.ts';
import { passwordState, projectCookieName, verifyProjectPassword } from './project-password.ts';
import { errorResponse } from './router.ts';

const TTL = 12 * 3600000, WINDOW = 10 * 60000, LIMIT = 5;
export function projectFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/(?:api\/projects\/|api\/pcf\/|pcf\/)([^/]+)(?:\/|$)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}
export function createProjectSession(db: DatabaseSync, admin: Pick<AdminSession, 'isAdmin'>, now = Date.now) {
  const secret = randomBytes(32), failures = new Map<string, number[]>();
  const sign = (project: string, version: string, expires: string) => createHmac('sha256', secret).update(JSON.stringify([project, version, expires])).digest('base64url');
  const allowed = (request: Request, project: string) => {
    if (admin.isAdmin(request)) return true;
    const state = passwordState(db, project);
    if (!state.hash) return true;
    const prefix = projectCookieName(project) + '=';
    const value = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length);
    if (!value) return false;
    const [version, expires, mac, extra] = value.split('.');
    if (extra || version !== state.version || !/^\d+$/.test(expires || '') || Number(expires) <= now() || !mac) return false;
    const expected = Buffer.from(sign(project, version, expires)), supplied = Buffer.from(mac);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  };
  return {
    allowed,
    async unlock(request: Request, project: string): Promise<Response> {
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(project)) return errorResponse('Project not found: ' + project, 404);
      const state = passwordState(db, project);
      if (!state.hash || admin.isAdmin(request)) return Response.json({ unlocked: true }, { headers: { 'Cache-Control': 'no-store' } });
      const key = JSON.stringify([request.headers.get('X-Hub-Remote-Address') || 'local', project]);
      // Drop expired entries as well as this client's: no permanent lockouts or unbounded stale IP entries.
      for (const [client, times] of failures) {
        const recent = times.filter(at => now() - at < WINDOW);
        if (recent.length) failures.set(client, recent); else failures.delete(client);
      }
      const attempts = failures.get(key) || [];
      if (attempts.length >= LIMIT) return errorResponse('Too many failed login attempts; try again later', 429, { 'Retry-After': String(Math.ceil((attempts[0] + WINDOW - now()) / 1000)) });
      let password: unknown;
      try { password = (await request.json())?.password; } catch { password = undefined; }
      if (typeof password !== 'string' || !password) return errorResponse('PASSWORD_REQUIRED', 401);
      if (password.length > 1024 || !verifyProjectPassword(password, state.hash)) {
        attempts.push(now()); failures.set(key, attempts);
        return errorResponse('INVALID_PASSWORD', 401);
      }
      failures.delete(key);
      const expires = String(now() + TTL), forwarded = request.headers.get('X-Forwarded-Proto')?.split(',')[0].trim().toLowerCase();
      const secure = new URL(request.url).protocol === 'https:' || forwarded === 'https';
      const cookie = projectCookieName(project) + '=' + state.version + '.' + expires + '.' + sign(project, state.version, expires) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' + (secure ? '; Secure' : '');
      return Response.json({ unlocked: true }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': cookie } });
    },
    challenge(request: Request, project: string): Response | undefined {
      if (allowed(request, project)) return;
      if (new URL(request.url).pathname.startsWith('/pcf/')) {
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Project locked</title><h1>Project password required</h1><p>Unlock this project in the Project Access Hall.</p><a href="/?project=' + encodeURIComponent(project) + '">Return to Project Access Hall</a></html>', { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      return errorResponse('PASSWORD_REQUIRED', 401);
    },
  };
}
export type ProjectSession = ReturnType<typeof createProjectSession>;
