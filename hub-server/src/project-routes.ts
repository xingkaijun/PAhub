import type { Router } from './router.ts';
import { errorResponse } from './router.ts';
import { safeId } from './pcf-model.ts';
import { getProjectDetail, getProjectList } from './project-read.ts';
import type { ProjectWriter } from './project-write.ts';

export function registerProjectRoutes(router: Router, writer: ProjectWriter) {
  router.add({pattern:/^\/api\/projects$/,methods:['GET'],handle:() => Response.json(getProjectList(writer.storage.db))});
  router.add({pattern:/^\/api\/projects\/([^/]+)$/,methods:['POST','PUT','PATCH'],handle:async ctx => {
    const p = safeId(ctx.params[0]), body = await ctx.json();
    if (ctx.request.method === 'POST') {
      const project = getProjectDetail(writer.storage.db,p);
      if (!project) return errorResponse('Project not found: ' + p,404);
      const password = project.conf.password;
      if (typeof password === 'string' && password.trim()) {
        if (!body.password) return errorResponse('PASSWORD_REQUIRED',401);
        if (body.password !== password) return errorResponse('INVALID_PASSWORD',401);
      }
      return Response.json(project);
    }
    if (ctx.request.method === 'PUT') return Response.json({success:true,verification:await writer.save(p,body.project,body.reviewTracker)});
    return Response.json(await writer.patch(p,body));
  }});
}
