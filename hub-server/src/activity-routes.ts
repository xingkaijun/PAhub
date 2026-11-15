import type { Router } from './router.ts';
import { errorResponse } from './router.ts';
import type { DatabaseSync } from 'node:sqlite';
import { safeId } from './pcf-model.ts';

export function registerActivityRoutes(router: Router, db: DatabaseSync) {
  router.add({pattern:/^\/api\/projects\/([^/]+)\/audit$/,methods:['GET'],policies:[{method:'GET',capability:'view'}],handle:ctx => {
    const p=safeId(ctx.params[0]),from=ctx.url.searchParams.get('from') || '',to=ctx.url.searchParams.get('to') || '';
    if (!from || !to) return errorResponse('Both `from` and `to` (ISO timestamps) are required.',400);
    const actorColumns=router.kjx ? ',actor_id,actor_name' : '';
    // Keyset pagination avoids skipped rows when new records arrive.
    const cursor=ctx.url.searchParams.get('cursor');
    let before: [string,string] | undefined;
    if(cursor) { try { const value=JSON.parse(cursor); if(!Array.isArray(value)||value.length!==2||value.some(v=>typeof v!=='string'))throw Error(); before=value as [string,string]; } catch { return errorResponse('Invalid audit cursor',400); } }
    const rows=db.prepare("SELECT id,row_id,action,detail,created_at"+actorColumns+" FROM audit_log WHERE project_id=? AND action IN ('STATUS','COMMENTS','BUILDER_REPLY') AND created_at>=? AND created_at<?"+(before?" AND (created_at<? OR (created_at=? AND id<?))":"")+" ORDER BY created_at DESC,id DESC LIMIT 501").all(p,from,to,...(before?[before[0],before[0],before[1]]:[]));
    const more=rows.length>500; if(more)rows.pop();
    const last=rows.at(-1);
    const entries=rows.map(row => {
      let detail: Record<string,unknown> = {}; try {detail=JSON.parse(String(row.detail || '{}'));} catch {}
      return {id:String(row.id || ''),drawingId:String(row.row_id || ''),action:String(row.action || ''),createdAt:String(row.created_at || ''),customId:String(detail.customId || ''),drawingNo:String(detail.drawingNo || ''),source:String(detail.source || 'app'),...(router.kjx ? {actorId:row.actor_id ?? null,actorName:row.actor_name ?? null} : {}),detail};
    });
    return Response.json({entries,truncated:more,nextCursor:more&&last?JSON.stringify([String(last.created_at),String(last.id)]):undefined});
  }});
  // Last-seen is an administrative presence marker: recording it is reserved for administrators.
  router.add({pattern:/^\/api\/projects\/([^/]+)\/heartbeat$/,methods:['GET','PUT'],policies:[{method:'GET',capability:'view'},{method:'PUT',capability:'admin.only'}],handle:ctx => {
    const p=safeId(ctx.params[0]);
    if (ctx.request.method === 'GET') return Response.json({adminLastSeen:db.prepare("SELECT setting_value FROM project_settings WHERE project_id=? AND setting_key='admin_last_seen'").get(p)?.setting_value || null});
    if (router.options.adminSession && !router.options.adminSession.isAdmin(ctx.request)) return errorResponse('Administrator permission required',403);
    db.prepare("INSERT INTO project_settings(project_id,setting_key,setting_value) VALUES(?,'admin_last_seen',?) ON CONFLICT(project_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value").run(p,new Date().toISOString());
    return Response.json({success:true});
  }});
}
