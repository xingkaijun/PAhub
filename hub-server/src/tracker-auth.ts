import type {DatabaseSync} from 'node:sqlite';
import type {RequestUser} from './identity.ts';
import {requireProjectAccess} from './project-membership.ts';
import {getReviewTracker} from './project-read.ts';
import {writeAudit} from './audit.ts';
const deny=()=>{throw Object.assign(new Error('forbidden'),{status:403,body:{ok:false,capability:'tracker.edit'}});};
export function authorizeTracker(db:DatabaseSync,project:string,data:any,user:RequestUser|undefined,replace=false){
 requireProjectAccess(db,project,user);
 if(!data || typeof data!=='object' || Array.isArray(data))throw Object.assign(new Error('Invalid tracker'),{status:400});
 const elevated=user?.role==='admin'||user?.role==='manager';
 if(!elevated&&user?.role!=='reviewer')deny();
 const current=replace?getReviewTracker(db,project):{};
 for(const[drawing,entries]of Object.entries(data) as [string,any][]){
  if(!db.prepare('SELECT 1 FROM drawings WHERE project_id=? AND id=? AND COALESCE(_deleted,0)=0').get(project,drawing))deny();
  if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Object.assign(new Error('Invalid tracker entries'),{status:400});
  if(replace&&!elevated&&Object.keys(current[drawing]||{}).some(id=>!(id in entries)))deny();
  for(const[id,info]of Object.entries(entries) as [string,any][]){
   if(!info||typeof info!=='object'||Array.isArray(info)||Object.keys(info).some(key=>!['done','doneAt'].includes(key))||![true,false,0,1].includes(info.done)||info.doneAt!=null&&typeof info.doneAt!=='string')throw Object.assign(new Error('Invalid tracker value'),{status:400});
   if(id==='__approved__'){if(!elevated)deny();continue;}
   if(!db.prepare('SELECT 1 FROM drawing_assignees WHERE drawing_id=? AND reviewer_id=?').get(drawing,id))deny();
   if(!elevated&&(id!==user?.id||id.startsWith('manual-')))deny();
  }
 }
}
export function auditTracker(db:DatabaseSync,project:string,data:any,user:RequestUser){
 for(const[drawing,entries]of Object.entries(data))for(const[id,info]of Object.entries(entries as any))writeAudit(db,{table:'review_tracker',rowId:drawing,projectId:project,action:'TRACKER',detail:{subjectId:id,done:(info as any).done,delegated:id!==user.id}},user);
}
