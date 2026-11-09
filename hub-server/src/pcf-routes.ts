import type { Router } from './router.ts';
import { errorResponse } from './router.ts';
import { safeId } from './pcf-model.ts';
import { transitionDrawingStatus } from './drawing-status.ts';
import type { PcfApi } from './pcf-api.ts';
import { PcfBuilderReplies } from './pcf-builder-replies.ts';
import { ProjectComments } from './comments-register.ts';
import { exportCommentsExcel } from './comments-excel.ts';

export function registerPcfRoutes(router: Router, pcf: PcfApi, adminPassword?: string) {
  const replies = new PcfBuilderReplies(pcf.storage, pcf.exchange, pcf.realtime, adminPassword);
  const comments = new ProjectComments(pcf.storage);
  router.add({ pattern: /^\/api\/projects\/([^/]+)\/drawings\/([^/]+)\/status$/, methods: ['POST'], admin: true, handle: async ctx => {
    const [p,d] = ctx.params.map(safeId), input = await ctx.json();
    const result = await pcf.storage.serial(p,d,() => transitionDrawingStatus(pcf.storage,pcf.realtime,p,d,input.status));
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } });
  router.add({ pattern: /^\/api\/projects\/([^/]+)\/comments(\.xlsx)?$/, methods: ['GET'], handle: async ctx => {
    const p = safeId(ctx.params[0]), result = comments.query(p,ctx.url.searchParams);
    if (ctx.params[1]) return new Response(await exportCommentsExcel(result), { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="Comments-' + p + '.xlsx"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
    const { body, etag } = comments.json(result);
    const unchanged = (ctx.request.headers.get('if-none-match') || '').split(',').some(value => value.trim().replace(/^W[/]/,'') === etag || value.trim() === '*');
    return new Response(unchanged ? null : body, { status: unchanged ? 304 : 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' } });
  } });
  router.add({ pattern: /^\/api\/projects\/([^/]+)\/events$/, methods: ['GET'], handle: ctx => pcf.realtime.projectStream(safeId(ctx.params[0]),ctx.request.signal) });
  router.add({ pattern: /^\/api\/projects\/([^/]+)\/builder-replies(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/, auth: 'none', handle: async ctx => {
    const [rawP,action,setId,fileId] = ctx.params, p = safeId(rawP), request = ctx.request;
    // The API token remains the machine credential; every builder-reply operation is administrative
    // (upload, preview, apply, skip) and requires the administrator session as well.
    if (router.options.adminSession && !router.options.adminSession.isAdmin(request)) return errorResponse('Administrator permission required', 403);
    const authorized = !router.options.API_TOKEN || request.headers.get('Authorization') === 'Bearer ' + router.options.API_TOKEN;
    if (request.method === 'GET' && setId === 'file' && action && fileId) {
      const reply = replies.getFile(p,action,fileId);
      if (!authorized && !pcf.validScopedCredential(request.headers.get('X-PCF-Token'),p,reply.drawingId)) return errorResponse('Unauthorized',401);
      return new Response(reply.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (!authorized) return errorResponse('Unauthorized',401);
    let payload: unknown;
    if (request.method === 'POST' && action === 'preview' && !setId) payload = await replies.preview(p,await request.formData());
    else if (request.method === 'GET' && action === 'pending' && !setId) payload = replies.pending(p);
    else if (request.method === 'POST' && setId === 'skip' && !fileId) payload = replies.skip(p,action,(await ctx.json()).fileId);
    else if (request.method === 'POST' && setId === 'apply' && !fileId) { const body = await ctx.json(); payload = await replies.apply(p,action,body.fileIds,body.batchId); }
    else return errorResponse('Not found',404);
    return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } });
  router.add({ pattern: /^(?:\/api\/pcf\/|\/pcf\/)/, auth: 'none', handle: ctx => pcf.handle(ctx.request,ctx.request.headers.get('X-Hub-Remote-Address') || '') });
}
