import type { Router } from './router.ts';
import { errorResponse } from './router.ts';
import { safeId } from './pcf-model.ts';
import { getProjectDetail, getProjectDrawings, getProjectList, MAX_DRAWING_IDS } from './project-read.ts';
import { conditionalJson } from './etag.ts';
import type { ProjectWriter } from './project-write.ts';

export function registerProjectRoutes(router: Router, writer: ProjectWriter) {
  router.add({pattern:/^\/api\/projects\/([^/]+)\/unlock$/,methods:['POST'],handle:ctx => router.options.projectSession ? router.options.projectSession.unlock(ctx.request,safeId(ctx.params[0])) : errorResponse('Project sessions unavailable',503)});
  router.add({pattern:/^\/api\/projects$/,methods:['GET'],handle:() => Response.json(getProjectList(writer.storage.db))});
  // POST reads the project; PATCH saves field deltas with revision checks. The old whole-project PUT had no
  // caller left in the app and could overwrite concurrent edits; whole-project replacement is import-only
  // (importer.ts and the admin JSON import call ProjectWriter.save directly). Project-level writes require
  // an administrator; reviewers only read.
  router.add({pattern:/^\/api\/projects\/([^/]+)$/,methods:['POST','PATCH'],handle:async ctx => {
    const p = safeId(ctx.params[0]), body = await ctx.json();
    if (ctx.request.method === 'POST') {
      const project = getProjectDetail(writer.storage.db,p);
      if (!project) return errorResponse('Project not found: ' + p,404);
      // ETag + 304: a refresh that finds nothing new costs a header instead of the whole project.
      return conditionalJson(ctx.request,project);
    }
    if (router.options.adminSession && !router.options.adminSession.isAdmin(ctx.request)) return errorResponse('Administrator permission required',403);
    return Response.json(await writer.patch(p,body));
  }});
  // Only the named drawings (ids=a,b or repeated ids=), with their review-tracker rows, for drawing-changed events.
  // The shared router project guard covers both reads, all child routes and PCF routes.
  router.add({pattern:/^\/api\/projects\/([^/]+)\/drawings$/,methods:['GET'],handle:ctx => {
    const p = safeId(ctx.params[0]);
    const ids = ctx.url.searchParams.getAll('ids').flatMap(value => value.split(',')).map(id => id.trim()).filter(Boolean);
    if (!ids.length) return errorResponse('ids is required',400);
    if (new Set(ids).size > MAX_DRAWING_IDS) return errorResponse('Too many ids (max ' + MAX_DRAWING_IDS + ')',400);
    const db = writer.storage.db;
    const result = getProjectDrawings(db,p,ids);
    if (!result) return errorResponse('Project not found: ' + p,404);
    return conditionalJson(ctx.request,result);
  }});
}
