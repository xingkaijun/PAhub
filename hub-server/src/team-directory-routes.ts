import type { Router } from './router.ts';
import type { KjxDirectory } from './kjx-directory.ts';
import {requestUser} from './identity.ts';
import {projectRequestDenied} from './project-membership.ts';
import type {DatabaseSync} from 'node:sqlite';
export function registerTeamDirectoryRoutes(router: Router, directory: KjxDirectory, db: DatabaseSync) {
  if (!router.kjx) return;
  router.add({ pattern: /^\/api\/team\/directory$/, methods: ['GET'], policies: [{ method: 'GET', capability: 'team.setup' }], handle: async ctx => {
    const denied=projectRequestDenied(db,ctx.request,requestUser(ctx.request));if(denied)return denied;
    const result=await directory.list(ctx.url.searchParams.get('discipline') || '');
    return projectRequestDenied(db,ctx.request,requestUser(ctx.request)) || Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } });
}
