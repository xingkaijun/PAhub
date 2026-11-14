import type { Router } from './router.ts';
import type { KjxDirectory } from './kjx-directory.ts';
export function registerTeamDirectoryRoutes(router: Router, directory: KjxDirectory) {
  if (!router.kjx) return;
  router.add({ pattern: /^\/api\/team\/directory$/, methods: ['GET'], policies: [{ method: 'GET', capability: 'team.setup' }], handle: async ctx => Response.json(await directory.list(ctx.url.searchParams.get('discipline') || ''), { headers: { 'Cache-Control': 'no-store' } }) });
}
