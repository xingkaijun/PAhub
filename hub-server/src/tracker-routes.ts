import type { Router } from './router.ts';
import { errorResponse } from './router.ts';
import { safeId } from './pcf-model.ts';
import { getReviewTracker } from './project-read.ts';
import { conditionalJson } from './etag.ts';
import { writeTracker, verifyProjectWrite, type ProjectWriter } from './project-write.ts';

export function registerTrackerRoutes(router: Router, writer: ProjectWriter) {
  // Reading the tracker is open to reviewers; changing or sending it is administrative.
  router.add({pattern:/^\/api\/projects\/([^/]+)\/review-tracker$/,methods:['GET','PUT'],handle:async ctx => {
    const p = safeId(ctx.params[0]);
    if (ctx.request.method === 'GET') return conditionalJson(ctx.request,getReviewTracker(writer.storage.db,p));
    if (router.options.adminSession && !router.options.adminSession.isAdmin(ctx.request)) return errorResponse('Administrator permission required',403);
    const data = await ctx.json();
    writeTracker(writer.storage.db,p,data,false,writer.realtime);
    return Response.json({success:true,verification:verifyProjectWrite(writer.storage.db,p,[],data)});
  }});
}
