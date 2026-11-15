import type { Router } from './router.ts';
import { errorResponse } from './router.ts';
import { safeId } from './pcf-model.ts';
import { getReviewTracker } from './project-read.ts';
import {requestUser} from './identity.ts';
import {authorizeTracker,auditTracker} from './tracker-auth.ts';
import { conditionalJson } from './etag.ts';
import { writeTracker, verifyProjectWrite, transaction, type ProjectWriter } from './project-write.ts';

export function registerTrackerRoutes(router: Router, writer: ProjectWriter) {
  // Reading the tracker is open to reviewers; changing or sending it is administrative.
  router.add({pattern:/^\/api\/projects\/([^/]+)\/review-tracker$/,methods:['GET','PUT'],policies:[{method:'GET',capability:'view'},{method:'PUT',capability:'tracker.edit'}],handle:async ctx => {
    const p = safeId(ctx.params[0]);
    if (ctx.request.method === 'GET') return conditionalJson(ctx.request,getReviewTracker(writer.storage.db,p));
    if (!router.kjx && router.options.adminSession && !router.options.adminSession.isAdmin(ctx.request)) return errorResponse('Administrator permission required',403);
    const data = await ctx.json();
    if(router.kjx)return writer.storage.serialMany(p,Object.keys(data),()=>transaction(writer.storage.db,'tracker_authorized',()=>{const user=requestUser(ctx.request)!;authorizeTracker(writer.storage.db,p,data,user);writeTracker(writer.storage.db,p,data,false,writer.realtime);auditTracker(writer.storage.db,p,data,user);return Response.json({success:true,verification:verifyProjectWrite(writer.storage.db,p,[],data)});}));
    writeTracker(writer.storage.db,p,data,false,writer.realtime);
    return Response.json({success:true,verification:verifyProjectWrite(writer.storage.db,p,[],data)});
  }});
}
