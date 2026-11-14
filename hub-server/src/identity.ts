import type { DatabaseSync } from 'node:sqlite';
import { createKjxVerifier, type KjxVerifier } from './kjx-auth-client.ts';
import { upsertKjxUser, type KjxUser } from './kjx-users.ts';

export type AuthMode = 'legacy' | 'kjx';
export const PAHUB_ROLES = ['admin', 'manager', 'reviewer', 'viewer'] as const;
export type RequestUser = KjxUser & { role: typeof PAHUB_ROLES[number]; sid: string };
const users = new WeakMap<Request, RequestUser>();
export const requestUser = (request: Request) => users.get(request);
export const KJX_ENFORCE_PROJECT_PASSWORD = false;
export function readAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  const value = (env.AUTH_MODE ?? 'legacy').trim();
  if (value !== 'legacy' && value !== 'kjx') throw new Error('AUTH_MODE must be legacy or kjx');
  return value;
}
export function identityConfig(env: NodeJS.ProcessEnv) {
  const mode = readAuthMode(env);
  const config = { mode, jwksUrl: env.KJX_JWKS_URL ?? 'http://127.0.0.1:8090/.well-known/jwks.json', issuer: env.KJX_ISSUER ?? 'https://auth.kjxing.com', audience: env.KJX_AUDIENCE ?? 'pahub', publicUrl: env.KJX_PUBLIC_URL ?? 'https://auth.kjxing.com', publicOrigin: env.PAHUB_PUBLIC_ORIGIN ?? 'https://pahub.kjxing.com' };
  if (mode === 'kjx') {
    for (const raw of [config.jwksUrl, config.issuer, config.publicUrl, config.publicOrigin]) {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid kjx URL configuration');
    }
    if (!config.audience.trim() || new URL(config.publicOrigin).origin !== config.publicOrigin) throw new Error('Invalid kjx audience or public origin');
  }
  return config;
}
export function createProductionVerifier(config: ReturnType<typeof identityConfig>) {
  return createKjxVerifier({ jwksUrl: config.jwksUrl, issuer: config.issuer, audience: config.audience, onError: () => console.warn('kjx token verification failed') });
}
export function createIdentity(verifier: KjxVerifier, db: DatabaseSync) {
  const lastWrite = new Map<string, number>();
  return async (request: Request): Promise<Response | undefined> => {
    const u = await verifier.verify(request.headers.get('X-Auth-Token'));
    if (!u) return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    if (!(PAHUB_ROLES as readonly string[]).includes(u.role)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    const user: RequestUser = { id: u.id, username: u.username, name: u.name, title: u.title, disciplines: u.disciplines, role: u.role as RequestUser['role'], sid: u.sid };
    users.set(request, user);
    const now = Date.now();
    if (!lastWrite.has(u.id) || now - lastWrite.get(u.id)! >= 60000) {
      const at = new Date(now).toISOString();
      upsertKjxUser(db, user, at);
      lastWrite.set(u.id, now);
      if (lastWrite.size > 10000) for (const [id, seen] of lastWrite) if (now - seen >= 60000) lastWrite.delete(id);
    }
  };
}
export function validOrigin(request: Request, expected: string): boolean {
  try {
    const origin = request.headers.get('Origin');
    if (origin) return origin === expected;
    const referer = request.headers.get('Referer');
    return Boolean(referer && new URL(referer).origin === expected);
  } catch { return false; }
}
