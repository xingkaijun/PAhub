import { createKjxServiceTokenClient } from './kjx-auth-client.ts';
import { kjxDiscipline } from './discipline-map.ts';

export type DirectoryPerson = { id: string; username: string; name: string; title: string | null; disciplines: string[]; role: 'admin' | 'manager' | 'reviewer' };
export type DirectoryResult = { ok: true; users: DirectoryPerson[] } | { ok: false; fallback: true };
export type DirectoryOptions = { internalUrl?: string; clientId?: string; clientSecret?: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number; warn?: () => void };
export class KjxDirectory {
  private cached?: { until: number; users: DirectoryPerson[] };
  private pending?: Promise<DirectoryResult>;
  private retryAt = 0;
  private tokens?: ReturnType<typeof createKjxServiceTokenClient>;
  private internal?: string;
  private deadline = 0;
  private readonly now: () => number;
  constructor(private options: DirectoryOptions) {
    this.now = options.now || Date.now;
    if (!options.clientId || !options.clientSecret) return;
    try {
      const url = new URL(options.internalUrl || 'http://127.0.0.1:8090');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
      this.internal = url.toString().replace(/\/$/, '');
      this.tokens = createKjxServiceTokenClient({ tokenUrl: this.internal + '/oauth/token', clientId: options.clientId, clientSecret: options.clientSecret, audience: 'kjx-auth', fetch: (url, init) => this.timedFetch(url, init), now: this.now });
    } catch { /* Directory configuration never prevents Hub startup. */ }
  }
  private async timedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Directory timeout')); }, Math.max(1, this.deadline ? this.deadline - Date.now() : this.options.timeoutMs ?? 5000)); });
    try {
      // Include body consumption in the timeout, not merely response headers.
      return await Promise.race([(async () => {
        const response = await (this.options.fetch || fetch)(input, { ...init, signal: controller.signal, redirect: 'error' });
        const body = await response.text();
        return new Response(body, { status: response.status, headers: response.headers });
      })(), timeout]);
    } finally { clearTimeout(timer); }
  }
  private async refresh(): Promise<DirectoryResult> {
    this.deadline = Date.now() + (this.options.timeoutMs ?? 5000);
    try {
      const token = await this.tokens!.getToken();
      if (typeof token !== 'string' || !token) throw new Error('Invalid token response');
      const response = await this.timedFetch(this.internal + '/api/directory/users?app=pahub&active=1', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      if (!response.ok) throw new Error('Directory request failed');
      const data = await response.json();
      if (!Array.isArray(data) || data.length > 1000) throw new Error('Invalid directory response');
      const users: DirectoryPerson[] = [];
      const seen = new Set<string>();
      for (const person of data) {
        if (!person || person.active !== true || !['admin', 'manager', 'reviewer'].includes(person.role)) continue;
        if (typeof person.id !== 'string' || !person.id || typeof person.name !== 'string' || !person.name || typeof person.username !== 'string' || !Array.isArray(person.disciplines) || person.disciplines.some((x: unknown) => typeof x !== 'string') || seen.has(person.id)) throw new Error('Invalid directory person');
        seen.add(person.id);
        users.push({ id: person.id, username: person.username, name: person.name, title: typeof person.title === 'string' ? person.title : null, disciplines: [...person.disciplines], role: person.role });
      }
      this.cached = { users, until: this.now() + 300000 };
      return { ok: true, users };
    } catch {
      this.retryAt = this.now() + 60000;
      // Never log upstream bodies, token errors, URLs, credentials, or tokens.
      (this.options.warn || (() => console.warn('User directory unavailable; retry deferred')))();
      return { ok: false, fallback: true };
    }
  }
  async list(discipline = ''): Promise<DirectoryResult> {
    if (!this.tokens) return { ok: false, fallback: true };
    let result: DirectoryResult;
    if (this.cached && this.cached.until > this.now()) result = { ok: true, users: this.cached.users };
    else if (this.retryAt > this.now()) return { ok: false, fallback: true };
    else {
      if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = undefined; });
      result = await this.pending;
    }
    if (!result.ok) return result;
    const mapped = kjxDiscipline(discipline);
    return { ok: true, users: structuredClone(result.users.filter(person => !mapped || person.disciplines.includes(mapped))) };
  }
}
