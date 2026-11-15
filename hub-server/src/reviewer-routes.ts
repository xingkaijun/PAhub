import type {Router} from './router.ts';
import {errorResponse} from './router.ts';
import type {ProjectWriter} from './project-write.ts';
import {transaction} from './project-write.ts';
import {safeId} from './pcf-model.ts';
import {requestUser} from './identity.ts';
import {requireProjectAccess,projectRoster} from './project-membership.ts';
import {writeAudit} from './audit.ts';

export function registerReviewerRoutes(router: Router, writer: ProjectWriter) {
  if(!router.kjx)return;
  router.add({pattern:/^\/api\/projects\/([^/]+)\/reviewers\/([^/]+)$/,methods:['DELETE'],policies:[{method:'DELETE',capability:'team.setup'}],handle:async ctx=>{
    const p=safeId(ctx.params[0]),id=ctx.params[1];
    if(!id || id.length>256)return errorResponse('Invalid reviewer',400);
    const db=writer.storage.db;
    const drawings=db.prepare('SELECT id FROM drawings WHERE project_id=?').all(p).map(row=>String(row.id));
    const result=await writer.storage.serialMany(p,drawings,()=>transaction(db,'delete_project_reviewer',()=>{
      requireProjectAccess(db,p,requestUser(ctx.request));
      const person=db.prepare('SELECT display_name FROM reviewers WHERE id=?').get(id);
      const name=String(person?.display_name || '');
      if(id===requestUser(ctx.request)?.id)throw Object.assign(new Error('You cannot remove yourself from this project'),{status:400});
      // Pre-kjx assignment names are aliases, not identities. Only clean an
      // unambiguous alias that cannot be another reviewer's actual ID.
      const unique=id.startsWith('manual-') && name && !db.prepare('SELECT 1 FROM reviewers WHERE display_name=? AND id<>?').get(name,id) && !db.prepare('SELECT 1 FROM reviewers WHERE id=? AND id<>?').get(name,id);
      const keys=unique && name!==id ? [id,name] : [id];
      const cleared:Record<string,number>={};
      for(const key of keys){
        for(const table of ['discipline_defaults','discipline_default_assignees','project_team_reviewers'])cleared[table]=(cleared[table] || 0)+Number(db.prepare('DELETE FROM '+table+' WHERE project_id=? AND reviewer_id=?').run(p,key).changes);
        cleared.drawing_assignees=(cleared.drawing_assignees || 0)+Number(db.prepare('DELETE FROM drawing_assignees WHERE reviewer_id=? AND drawing_id IN (SELECT id FROM drawings WHERE project_id=?)').run(key,p).changes);
      }
      // Preserve tracker/audit history and other projects. A globally shared
      // name snapshot is retained until every project reference is gone.
      const references=db.prepare(`SELECT 1 FROM discipline_defaults WHERE reviewer_id=? UNION ALL SELECT 1 FROM discipline_default_assignees WHERE reviewer_id=? UNION ALL SELECT 1 FROM project_team_reviewers WHERE reviewer_id=? UNION ALL SELECT 1 FROM drawing_assignees WHERE reviewer_id=? LIMIT 1`).get(id,id,id,id);
      if(!references)db.prepare('DELETE FROM reviewers WHERE id=?').run(id);
      writeAudit(db,{table:'reviewers',projectId:p,rowId:id,action:'REVIEWER_DELETE',detail:{name,cleared}});
      return{ok:true,reviewers:projectRoster(db,p)};
    }));
    writer.realtime.recheckProject(p);
    for(const drawing of drawings)writer.realtime.projectChanged(p,drawing,['project-data']);
    return Response.json(result);
  }});
}
