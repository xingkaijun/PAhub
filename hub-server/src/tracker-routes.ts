import type { Router } from './router.ts';
import { safeId } from './pcf-model.ts';
import { getReviewTracker } from './project-read.ts';
import { conditionalJson } from './etag.ts';
import { writeTracker, verifyProjectWrite, type ProjectWriter } from './project-write.ts';

export function registerTrackerRoutes(router: Router, writer: ProjectWriter) {
  router.add({pattern:/^\/api\/projects\/([^/]+)\/review-tracker$/,methods:['GET','PUT'],handle:async ctx => {
    const p = safeId(ctx.params[0]);
    if (ctx.request.method === 'GET') return conditionalJson(ctx.request,getReviewTracker(writer.storage.db,p));
    const data = await ctx.json();
    writeTracker(writer.storage.db,p,data,false,writer.realtime);
    return Response.json({success:true,verification:verifyProjectWrite(writer.storage.db,p,[],data)});
  }});
}
