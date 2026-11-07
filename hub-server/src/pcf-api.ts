import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PcfStorage, scriptJSON } from './pcf-storage.ts';
import { safeId, fail, type Actor } from './pcf-model.ts';

export class PcfApi {
  private secret: string;
  constructor(readonly storage: PcfStorage, private token?: string) { this.secret = token || randomBytes(32).toString('hex'); }
  private grant(p: string, d: string) {
    const payload = Buffer.from(JSON.stringify({ p, d, expires: Date.now() + 12 * 3600000 })).toString('base64url');
    return payload + '.' + createHmac('sha256', this.secret).update('pcf:' + payload).digest('base64url');
  }
  private valid(grant: string | null, p: string, d: string) {
    if (!grant) return false;
    try {
      const [payload, mac] = grant.split('.'), expected = createHmac('sha256', this.secret).update('pcf:' + payload).digest();
      const supplied = Buffer.from(mac, 'base64url'); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return value.p === p && value.d === d && value.expires > Date.now();
    } catch { return false; }
  }
  private bearer(request: Request) { return !this.token || request.headers.get('Authorization') === 'Bearer ' + this.token; }
  private cookieName(p: string, d: string) { return 'pcf_' + createHmac('sha256', this.secret).update(p + '/' + d).digest('hex').slice(0, 16); }
  private cookieGrant(request: Request, p: string, d: string) {
    const prefix = this.cookieName(p, d) + '=';
    return request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length) || null;
  }
  private actor(body: any, ip: string): Actor {
    return { clientId: safeId(body?.clientId || 'api-client'), clientName: typeof body?.clientName === 'string' ? body.clientName.slice(0, 100) : '', ip };
  }
  async handle(request: Request, ip: string): Promise<Response> {
    try { return await this.route(request, ip); } catch (e: any) {
      if (!e.status) console.error('PCF request failed', e);
      return Response.json({ error: e.status ? e.message : 'Internal server error' }, { status: e.status || 500, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  private async route(request: Request, ip: string): Promise<Response> {
    const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const page = parts[0] === 'pcf';
    const p = safeId(parts[page ? 1 : 2]), d = parts[page ? 2 : 3], tail = parts.slice(page ? 3 : 4).join('/');
    const json = (value: unknown, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
    if (!page && d === 'index' && !tail && request.method === 'GET') {
      if (!this.bearer(request)) return json({ error: 'Unauthorized' }, 401);
      return json(this.storage.index(p));
    }
    safeId(d);
    if (page) {
      if (tail || !['GET', 'HEAD'].includes(request.method)) fail('Not found', 404);
      if (!this.bearer(request) && !this.valid(this.cookieGrant(request, p, d), p, d)) {
        // The shared installation token is entered once per drawing/session, never in URL/storage/HTML.
        const endpoint = scriptJSON('/api/pcf/' + p + '/' + d + '/session');
        const html = '<!doctype html><html><head><meta charset="utf-8"><title>PCF access</title></head><body><h1>PCF access</h1><p>服务器已配置 API_TOKEN。请输入共享访问凭据（无需个人账号）。</p><form id="login"><input id="token" type="password" required autocomplete="off" aria-label="API token"><button>打开 PCF</button></form><p id="error"></p><script>document.getElementById("login").onsubmit=async e=>{e.preventDefault();const r=await fetch(' + endpoint + ',{method:"POST",headers:{Authorization:"Bearer "+document.getElementById("token").value}});if(r.ok)location.reload();else document.getElementById("error").textContent="凭据无效";};</script></body></html>';
        return new Response(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      return this.storage.serial(p, d, () => {
        this.storage.create(p, d, { clientId: 'page-create', clientName: '', ip });
        const { html, rev } = this.storage.load(p, d), grant = this.grant(p, d);
        const injection = '<script id="pahub-context">window.PAHUB=' + scriptJSON({ projectId: p, drawingId: d, rev, apiBase: '/api', credential: grant }) + '</script>';
        if (!/<\/head\s*>/i.test(html)) fail('Template missing head', 500);
        return new Response(html.replace(/<\/head\s*>/i, injection + '</head>'), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
      });
    }
    if (tail === 'session' && request.method === 'POST') {
      if (!this.bearer(request)) return json({ error: 'Unauthorized' }, 401);
      const cookie = this.cookieName(p, d) + '=' + this.grant(p, d) + '; Path=/pcf/' + p + '/' + d + '; HttpOnly; SameSite=Strict; Max-Age=43200' + (url.protocol === 'https:' ? '; Secure' : '');
      return json({ ok: true }, 200, { 'Set-Cookie': cookie });
    }
    if (!this.bearer(request) && !this.valid(request.headers.get('X-PCF-Token'), p, d)) return json({ error: 'Unauthorized' }, 401);
    let body: any = null;
    if (['POST', 'PUT'].includes(request.method)) {
      const text = await request.text();
      try { body = text ? JSON.parse(text) : {}; } catch { fail('Invalid JSON body'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid JSON body');
      if (tail === 'ops') safeId(body.clientId);
    }
    return this.storage.serial(p, d, () => {
      switch (request.method + ' ' + tail) {
        case 'GET meta': return json(this.storage.meta(p, d));
        case 'POST create': return json(this.storage.create(p, d, this.actor(body, ip)));
        case 'GET data': { const { rev, data } = this.storage.load(p, d); return json({ rev, data }); }
        case 'POST ops': return json(this.storage.ops(p, d, body, this.actor(body, ip)));
        case 'PUT document': return json(this.storage.replace(p, d, body, this.actor(body, ip)));
        case 'GET history': return json(this.storage.history(p, d));
        case 'GET download': return new Response(this.storage.load(p, d).html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + d + '.html"', 'Cache-Control': 'no-store' } });
        default: {
          const match = tail.match(/^history\/(\d+)\/restore$/);
          if (request.method === 'POST' && match) return json(this.storage.replace(p, d, body, this.actor(body, ip), Number(match[1])));
          fail('Not found', 404);
        }
      }
    });
  }
}
