import type { Router } from './router.ts';
import { errorResponse } from './router.ts';
import type { DatabaseSync } from 'node:sqlite';
import { safeId } from './pcf-model.ts';

export function registerActivityRoutes(router: Router, db: DatabaseSync) {
  router.add({pattern:/^\/api\/projects\/([^/]+)\/audit$/,methods:['GET'],handle:ctx => {
    const p=safeId(ctx.params[0]),from=ctx.url.searchParams.get('from') || '',to=ctx.url.searchParams.get('to') || '';
    if (!from || !to) return errorResponse('Both `from` and `to` (ISO timestamps) are required.',400);
    const rows=db.prepare("SELECT id,row_id,action,detail,created_at FROM audit_log WHERE project_id=? AND action IN ('STATUS','COMMENTS','BUILDER_REPLY') AND created_at>=? AND created_at<? ORDER BY created_at DESC,id DESC LIMIT 2000").all(p,from,to);
    const entries=rows.map(row => {
      let detail: Record<string,unknown> = {}; try {detail=JSON.parse(String(row.detail || '{}'));} catch {}
      return {id:String(row.id || ''),drawingId:String(row.row_id || ''),action:String(row.action || ''),createdAt:String(row.created_at || ''),customId:String(detail.customId || ''),drawingNo:String(detail.drawingNo || ''),source:String(detail.source || 'app'),detail};
    });
    return Response.json({entries,truncated:rows.length>=2000});
  }});
  // Last-seen is an administrative presence marker: recording it is reserved for administrators.
  router.add({pattern:/^\/api\/projects\/([^/]+)\/heartbeat$/,methods:['GET','PUT'],handle:ctx => {
    const p=safeId(ctx.params[0]);
    if (ctx.request.method === 'GET') return Response.json({adminLastSeen:db.prepare("SELECT setting_value FROM project_settings WHERE project_id=? AND setting_key='admin_last_seen'").get(p)?.setting_value || null});
    if (router.options.adminSession && !router.options.adminSession.isAdmin(ctx.request)) return errorResponse('Administrator permission required',403);
    db.prepare("INSERT INTO project_settings(project_id,setting_key,setting_value) VALUES(?,'admin_last_seen',?) ON CONFLICT(project_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value").run(p,new Date().toISOString());
    return Response.json({success:true});
  }});
}
