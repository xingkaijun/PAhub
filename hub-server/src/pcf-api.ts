import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PcfStorage, scriptJSON, parseHTML } from './pcf-storage.ts';
import { safeId, fail, type Actor } from './pcf-model.ts';
import { PcfRealtime } from './pcf-realtime.ts';
import { PcfExchange } from './pcf-exchange.ts';
import { TEMPLATE_VERSION, renderTemplate } from './pcf-template.ts';
import { completeBuilderReplyImport } from './pcf-builder-replies.ts';
import { commentFocusHTML } from './pcf-comment-focus.ts';
import { bannerToolbarHTML } from './pcf-banner-toolbar.ts';
import type { AdminSession } from './admin-session.ts';
import type { ProjectSession } from './project-session.ts';
import { requestUser, KJX_ENFORCE_PROJECT_PASSWORD, type AuthMode } from './identity.ts';
import { PCF_POLICIES, forbidden, requirePermission, permissionsFor, hasPermission } from './capabilities.ts';
import { authorizeOps } from './pcf-op-auth.ts';
import { auditContext } from './audit.ts';
import { KJX_PCF_ADAPTER } from './pcf-kjx-adapter.ts';
import { kjxDiscipline } from './discipline-map.ts';
import type { KjxDirectory } from './kjx-directory.ts';
import { resolveInitiatorOps } from './pcf-initiator.ts';

export class PcfApi {
  readonly realtime = new PcfRealtime();
  private secret: string;
  readonly exchange: PcfExchange;
  constructor(readonly storage: PcfStorage, private token?: string, private admin?: AdminSession, private projectSession?: ProjectSession, private auth: { mode: AuthMode; grantSecret?: string; directory?: KjxDirectory } = { mode: 'legacy' }) { this.secret = auth.grantSecret ?? (token || randomBytes(32).toString('hex')); this.exchange = new PcfExchange(storage); }
  private get kjx() { return this.auth.mode === 'kjx'; }
  private requiresAdmin(request: Request) { return Boolean(this.admin && !this.admin.isAdmin(request)); }
  private grant(p: string, d: string, userId?: string) {
    const payload = Buffer.from(JSON.stringify({ p, d, ...(this.kjx ? { userId } : {}), expires: Date.now() + 12 * 3600000 })).toString('base64url');
    return payload + '.' + createHmac('sha256', this.secret).update('pcf:' + payload).digest('base64url');
  }
  validScopedCredential(grant: string | null, p: string, d: string, userId?: string) {
    if (!grant) return false;
    try {
      const [payload, mac] = grant.split('.'), expected = createHmac('sha256', this.secret).update('pcf:' + payload).digest();
      const supplied = Buffer.from(mac, 'base64url'); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return value.p === p && value.d === d && value.expires > Date.now() && (!this.kjx || Boolean(userId && value.userId === userId));
    } catch { return false; }
  }
  private bearer(request: Request) { return this.kjx ? Boolean(requestUser(request)) : !this.token || request.headers.get('Authorization') === 'Bearer ' + this.token; }
  private cookieName(p: string, d: string) { return 'pcf_' + createHmac('sha256', this.secret).update(p + '/' + d).digest('hex').slice(0, 16); }
  private cookieGrant(request: Request, p: string, d: string) {
    const prefix = this.cookieName(p, d) + '=';
    return request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length) || null;
  }
  private actor(body: any, ip: string): Actor {
    return { clientId: safeId(body?.clientId || 'api-client'), clientName: this.kjx ? auditContext.getStore()?.actor?.name || '' : typeof body?.clientName === 'string' ? body.clientName.slice(0, 100) : '', ip };
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
    if (this.kjx) {
      const policy = PCF_POLICIES.find(policy => policy.method === request.method && policy.pattern!.test(url.pathname));
      if (!policy) return forbidden('route.unregistered');
      const denied = requirePermission(requestUser(request),policy.capability); if (denied) return denied;
    }
    const challenge = (!this.kjx || KJX_ENFORCE_PROJECT_PASSWORD) ? this.projectSession?.challenge(request,p) : undefined; if (challenge) return challenge;
    if (this.kjx) {
      const supplied = [request.headers.get('X-PCF-Token'), url.searchParams.get('credential'), this.cookieGrant(request,p,d)].filter(value => value !== null);
      if (supplied.some(value => !this.validScopedCredential(value,p,d,requestUser(request)?.id))) return Response.json({ok:false,error:'unauthenticated'}, {status:401});
    }
    const json = (value: unknown, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
    if (!page && ['index', 'presence'].includes(d) && !tail && request.method === 'GET') {
      if (!this.bearer(request)) return json({ error: 'Unauthorized' }, 401);
      return json(d === 'index' ? this.storage.index(p) : this.realtime.project(p));
    }
    if (!page && d === 'exports' && tail === 'batch' && request.method === 'POST') {
      if (!this.bearer(request)) return json({ error: 'Unauthorized' }, 401);
      if (!this.kjx && !this.kjx && this.requiresAdmin(request)) return json({ error: 'Administrator permission required' }, 403);
      const text = await request.text();
      let body: any;
      try { body = text ? JSON.parse(text) : {}; } catch { fail('Invalid JSON body'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid JSON body');
      const bundle = this.exchange.batch(p, body.drawingIds, body.batchId, this.actor(body, ip));
      const match = bundle.filename.match(/_(\d{8}-\d{4})\.zip$/);
      if (!match) fail('Invalid batch archive name', 500);
      const ascii = 'PAhub_SendAll_' + match[1] + '.zip';
      return new Response(bundle.buffer, { headers: {
        'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(bundle.filename),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    }
    safeId(d);
    if (page) {
      const imageMatch = tail.match(/^images\/([a-f0-9]{64})$/);
      if (imageMatch && ['GET', 'HEAD'].includes(request.method)) {
        // Content-addressed PCF image (pcf-images.ts). Same access as the page (bearer or page cookie) or the
        // page's scoped X-PCF-Token; the bytes behind a hash never change, so it can be cached for a year.
        if (!this.bearer(request) && !this.validScopedCredential(this.cookieGrant(request, p, d), p, d) && !this.validScopedCredential(request.headers.get('X-PCF-Token'), p, d)) return json({ error: 'Unauthorized' }, 401);
        const image = this.storage.images.read(p, imageMatch[1]);
        if (!image) fail('Not found', 404);
        return new Response(request.method === 'HEAD' ? null : image!.bytes, { headers: {
          'Content-Type': image!.mime, 'Content-Length': String(image!.bytes.length), 'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer',
        } });
      }
      if (tail || !['GET', 'HEAD'].includes(request.method)) fail('Not found', 404);
      if (!this.bearer(request) && !this.validScopedCredential(this.cookieGrant(request, p, d), p, d)) {
        // The shared installation token is entered once per drawing/session, never in URL/storage/HTML.
        const endpoint = scriptJSON('/api/pcf/' + p + '/' + d + '/session');
        const html = '<!doctype html><html><head><meta charset="utf-8"><title>PCF access</title></head><body><h1>PCF access</h1><p>This server requires an API token. Enter the shared credential (no personal account required).</p><form id="login"><input id="token" type="password" required autocomplete="off" aria-label="API token"><button>Open PCF</button></form><p id="error"></p><script>document.getElementById("login").onsubmit=async e=>{e.preventDefault();const r=await fetch(' + endpoint + ',{method:"POST",headers:{Authorization:"Bearer "+document.getElementById("token").value}});if(r.ok)location.reload();else document.getElementById("error").textContent="Invalid credential";};</script></body></html>';
        return new Response(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      return this.storage.serial(p, d, () => {
        this.storage.create(p, d, { clientId: 'page-create', clientName: '', ip });
        const { data, rev } = this.storage.load(p, d), grant = this.grant(p, d, requestUser(request)?.id);
        const version = TEMPLATE_VERSION, html = renderTemplate(data);
        const replySet = url.searchParams.get('builderReplySet'), replyFile = url.searchParams.get('builderReplyFile');
        const handoff = replySet && replyFile ? '<script id="pahub-builder-reply-handoff">document.addEventListener("DOMContentLoaded",async()=>{const nativeFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const init=args[1]||{},response=await nativeFetch(...args);try{if(String(args[0]).includes("/imports")&&init.method==="POST"&&JSON.parse(init.body).step==="apply"&&response.ok)window.opener?.postMessage({type:"builder-reply-applied",fileId:' + scriptJSON(replyFile) + '},location.origin);}catch{}return response;};try{const input=document.getElementById("pahub-import-file");if(!input)return;const url="/api/projects/"+' + scriptJSON(encodeURIComponent(p)) + '+"/builder-replies/"+' + scriptJSON(encodeURIComponent(replySet)) + '+"/file/"+' + scriptJSON(encodeURIComponent(replyFile)) + ';const response=await nativeFetch(url,{headers:{"X-PCF-Token":window.PAHUB.credential}});if(!response.ok)throw Error("Unable to load saved Builder reply ("+response.status+")");const blob=await response.blob(),file=new File([blob],"builder-reply.html",{type:"text/html"}),transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));}catch(error){alert(error.message);}});</script>' : '';
        const injection = '<script id="pahub-context">window.PAHUB=' + scriptJSON({ projectId: p, drawingId: d, rev, apiBase: '/api', credential: grant, admin: this.kjx ? hasPermission(requestUser(request),'pcf.replace') : !this.requiresAdmin(request), templateVersion: version, currentTemplateVersion: TEMPLATE_VERSION, ...(this.kjx ? { mode: 'kjx', user: requestUser(request), permissions: permissionsFor(requestUser(request)!) } : {}) }) + '</script>' + handoff + (this.kjx ? KJX_PCF_ADAPTER : '');
        if (!/<\/head\s*>/i.test(html)) fail('Template missing head', 500);
        return new Response(bannerToolbarHTML(commentFocusHTML(html.replace(/<\/head\s*>/i, injection + '</head>'))), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
      });
    }
    if (tail === 'session' && request.method === 'POST') {
      if (!this.bearer(request)) return json({ error: 'Unauthorized' }, 401);
      const cookie = this.cookieName(p, d) + '=' + this.grant(p, d, requestUser(request)?.id) + '; Path=/pcf/' + p + '/' + d + '; HttpOnly; SameSite=Strict; Max-Age=43200' + (url.protocol === 'https:' ? '; Secure' : '');
      return json({ ok: true }, 200, { 'Set-Cookie': cookie });
    }
    const eventGrant = tail === 'events' ? url.searchParams.get('credential') : null;
    if (!this.bearer(request) && !this.validScopedCredential(request.headers.get('X-PCF-Token'), p, d) && !this.validScopedCredential(eventGrant, p, d)) return json({ error: 'Unauthorized' }, 401);
    // Reviewers edit the PCF through POST ops. PUT document replaces the whole document (the PCF page uses it
    // only for Import JSON), so it is a project-level write reserved for administrators whatever the body says:
    // otherwise a plain PUT could bypass admin-only actions such as voiding an export or restoring history.
    if (request.method === 'PUT' && tail === 'document' && !this.kjx && this.requiresAdmin(request)) return json({ error: 'Administrator permission required' }, 403);
    if (request.method === 'POST' && tail === 'imports' && !this.kjx && this.requiresAdmin(request)) return json({ error: 'Administrator permission required' }, 403);
    // Voiding a shipyard export and restoring a history snapshot change the project's correspondence record
    // or replace the whole document: administrator-only, like the other project-level writes.
    if (request.method === 'POST' && (/^exports\/[a-f0-9-]+\/void$/i.test(tail) || /^history\/\d+\/restore$/.test(tail)) && !this.kjx && this.requiresAdmin(request)) return json({ error: 'Administrator permission required' }, 403);
    if (tail === 'events' && request.method === 'GET') {
      return this.storage.serial(p, d, () => {
        const { rev } = this.storage.load(p, d);
        const actor = this.actor({ clientId: url.searchParams.get('clientId'), clientName: url.searchParams.get('clientName') }, ip);
        const from = Number(request.headers.get('Last-Event-ID') || url.searchParams.get('rev') || 0);
        const expires = eventGrant && this.validScopedCredential(eventGrant, p, d, requestUser(request)?.id) ? JSON.parse(Buffer.from(eventGrant.split('.')[0], 'base64url').toString()).expires : Infinity;
        return this.realtime.stream(p + '/' + d, actor, rev, from, request.signal, expires, () => !this.projectSession || this.projectSession.allowed(request,p));
      });
    }
    let body: any = null;
    if (['POST', 'PUT'].includes(request.method)) {
      const text = await request.text();
      try { body = text ? JSON.parse(text) : {}; } catch { fail('Invalid JSON body'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid JSON body');
      if (tail === 'ops') safeId(body.clientId);
    }
    return this.storage.serial(p, d, async () => {
      switch (request.method + ' ' + tail) {
        case 'GET initiators': {
          if (!this.kjx) fail('Not found', 404);
          this.storage.load(p, d);
          return json(await this.auth.directory?.list() || { ok: false, fallback: true });
        }
        case 'GET meta': return json(this.storage.meta(p, d));
        case 'POST create': return json(this.storage.create(p, d, this.actor(body, ip)));
        case 'GET data': { const { rev, data } = this.storage.load(p, d); return json({ rev, data: this.storage.publicData(data) }); }
        case 'GET presence': { this.storage.load(p, d); return json({ online: this.realtime.list(p + '/' + d) }); }
        case 'POST presence': {
          const { data } = this.storage.load(p, d), actor = this.actor(body, ip);
          if (body.entity != null && (typeof body.entity !== 'string' || !data.comments.some((c: any) => c.rounds.some((r: any) => ['round:' + r.id + ':owner', 'round:' + r.id + ':reply'].includes(body.entity))))) fail('Invalid presence entity');
          this.realtime.update(p + '/' + d, actor, body.entity || null, body.leave === true);
          return json({ online: this.realtime.list(p + '/' + d) });
        }
        case 'POST ops': {
          if (this.kjx && Array.isArray(body.ops)) {
            const discipline = this.storage.db.prepare('SELECT discipline FROM drawings WHERE project_id=? AND id=?').get(p,d)?.discipline;
            if (!kjxDiscipline(String(discipline || '')) && !hasPermission(requestUser(request),'pcf.comment.edit_any')) return forbidden('pcf.comment.edit_any');
            const authorized = authorizeOps(requestUser(request),body.ops,this.storage.load(p,d).data);
            if (authorized.ok === false) return forbidden(authorized.capability,authorized.opIndex);
          }
          const user = this.kjx ? requestUser(request) : undefined;
          const initiators = user && Array.isArray(body.ops) ? await resolveInitiatorOps(this.storage.db, this.auth.directory, p, user, body.ops) : undefined;
          const requestActor = user ? { sub: user.id, name: user.name, ...(initiators ? { initiators } : {}) } : undefined;
          const actor = this.actor(body, ip), outcome = this.storage.opsBatch(p, d, body, actor, requestActor);
          if (!outcome.replayed && outcome.result.applied.length) this.realtime.changed(p + '/' + d, outcome.result, actor);
          return json(outcome.result);
        }
        case 'PUT document': {
          const imported = body.html ? parseHTML(body.html) : body.data;
          if (imported?.export) fail('Exported copies must use baseline three-way import, not document replacement', 409);
          const actor = this.actor(body, ip);
          if (body.importJSON && this.realtime.list(p + '/' + d).some(x => x.clientId !== actor.clientId && x.entity)) fail('JSON import blocked: another editor is editing', 409);
          const result = this.storage.replace(p, d, body, actor);
          this.realtime.changed(p + '/' + d, result, actor, true); return json(result);
        }
        case 'GET exports': return json(this.exchange.list(p, d));
        case 'POST exports': {
          if (body.mode !== undefined && !['builder', 'complete'].includes(body.mode)) fail('Export mode must be builder or complete');
          return json(body.mode === 'complete' ? this.exchange.createComplete(p, d, this.actor(body, ip)) : this.exchange.create(p, d, this.actor(body, ip)));
        }
        case 'POST imports': {
          if (body.step === 'preview') return json(this.exchange.preview(p, d, body));
          if (body.step !== 'apply') fail('Import step must be preview or apply');
          const metadata = (body.html ? parseHTML(body.html) : body.json)?.export;
          const outcome = this.exchange.apply(p, d, body, this.actor(body, ip), applied => { if (metadata?.mode === 'builder' && metadata.exportId) completeBuilderReplyImport(this.storage, this.realtime, p, d, applied, 'pcf'); });
          if (!outcome.replayed && (outcome.result.applied?.length || metadata?.mode === 'complete')) this.realtime.changed(p + '/' + d, outcome.result, outcome.actor, metadata?.mode === 'complete');
          return json(outcome.result);
        }
        case 'GET history': return json(this.storage.history(p, d));
        case 'GET download': {
          if (url.searchParams.has('format') && !['html', 'json'].includes(url.searchParams.get('format')!)) fail('Download format must be html or json');
          const exported = this.exchange.createComplete(p, d, this.actor({}, ip));
          if (url.searchParams.get('format') === 'json') {
            const { data, record } = this.exchange.downloadCompleteJSON(p, d, exported.exportId);
            return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': "attachment; filename=\"PCF.json\"; filename*=UTF-8''" + encodeURIComponent(String(record.filename).replace(/\.html$/, '.json')), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
          }
          const { html, record } = this.exchange.download(p, d, exported.exportId);
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': "attachment; filename=\"PCF.html\"; filename*=UTF-8''" + encodeURIComponent(String(record.filename)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        default: {
          const exportMatch = tail.match(/^exports\/([a-f0-9-]+)\/(download|void)$/i);
          if (exportMatch?.[2] === 'void' && request.method === 'POST') return json(this.exchange.void(p, d, exportMatch[1]));
          if (exportMatch?.[2] === 'download' && request.method === 'GET') {
            if (url.searchParams.has('format') && !['html', 'json'].includes(url.searchParams.get('format')!)) fail('Download format must be html or json');
            if (url.searchParams.get('format') === 'json') {
              const { data, record } = this.exchange.downloadCompleteJSON(p, d, exportMatch[1]);
              return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': "attachment; filename=\"PCF.json\"; filename*=UTF-8''" + encodeURIComponent(String(record.filename).replace(/\.html$/, '.json')), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
            }
            const { html, record } = this.exchange.download(p, d, exportMatch[1]);
            return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': "attachment; filename=\"PCF.html\"; filename*=UTF-8''" + encodeURIComponent(record.filename), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
          }
          const match = tail.match(/^history\/(\d+)\/restore$/);
          if (request.method === 'POST' && match) { const actor = this.actor(body, ip), result = this.storage.replace(p, d, body, actor, Number(match[1])); this.realtime.changed(p + '/' + d, result, actor, true); return json(result); }
          fail('Not found', 404);
        }
      }
    });
  }
}
