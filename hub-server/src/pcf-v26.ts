// Business functions transcribed from the immutable PCF v2.6 source. Parity tests execute the original in jsdom.
import { randomUUID } from 'node:crypto';
import { cleanContent, type PcfData } from './pcf-model.ts';
// PCF JSON is extensible; collection entries are validated below at the boundary.
type Entry = Record<string, any>;
const uid=()=>randomUUID(), now=()=>new Date().toISOString();
export function countOpen(data: PcfData){return data.comments.filter((c: Entry)=>c.status==='open').length;}
export function approvalAudit(data: PcfData,value: string,source: string,reason: string){data.approvalHistory??=[];data.approvalHistory.push({id:uid(),at:now(),round:data.project.currentRound,from:data.project.approval,to:value,source,reason});data.project.approval=value;data.approvalControl.source=source;data.approvalControl.reason=reason;}
export function reconcileApproval(data: PcfData){
  const open=countOpen(data),total=data.comments.length;
  if(!data.approvalControl){
    // Preserve explicit legacy drawing status; never approve merely on opening.
    data.approvalControl={lastOpen:open,source:total?'manual':'auto',reason:total?'Existing drawing status':'New drawing — not submitted'};
    if(!total&&data.project.approval==='Not submitted')return;
    if(!total)data.approvalControl.source='manual';
    return;
  }
  const control=data.approvalControl,previous=control.lastOpen;
  if(!total){
    // Manual selections still win, even on a drawing without comments.
    if(control.source==='auto'){
      if(data.project.approval!=='Not submitted')approvalAudit(data,'Not submitted','auto','No comments — not submitted');
      else control.reason='No comments — not submitted';
    }
  }else if(open===0&&previous>0){
    approvalAudit(data,'Approved','auto','All existing comments closed');
  }else if(open>0&&previous===0&&control.source==='auto'&&['Approved','Not submitted'].includes(data.project.approval)){
    approvalAudit(data,'Under review','auto','Open comments added or reopened');
  }
  control.lastOpen=open;
}
export function roundCleanupPlan(data: PcfData, comments: Entry[]){
  const used=comments.flatMap((c: Entry)=>c.rounds.map((r: Entry)=>r.number));
  const target=Math.max(1,...used);
  const upper=Math.max(target,Number(data.project.currentRound)||1,...data.roundRegister.map((r: Entry)=>Number(r.round)||0),...data.circulation.map((r: Entry)=>Number(r.round)||0),...data.approvalHistory.map((r: Entry)=>Number(r.round)||0));
  const affected=data.roundRegister.filter((r: Entry)=>r.round>target);
  const dates=affected.filter((r: Entry)=>r.ownerDate||r.replyDate||r.ownerRef||r.replyRef);
  const circulation=data.circulation.filter((r: Entry)=>Number(r.round)>target);
  const approvals=data.approvalHistory.filter((r: Entry)=>Number(r.round)>target);
  return {target,upper,affected,dates,circulation,approvals,protected:!!(dates.length||circulation.length||approvals.length)};
}
export function pruneRounds(data: PcfData,target: number){
  data.roundRegister=data.roundRegister.filter((r: Entry)=>r.round<=target);
  data.circulation=data.circulation.filter((r: Entry)=>Number(r.round)<=target||!Number(r.round));
  data.approvalHistory=data.approvalHistory.filter((r: Entry)=>Number(r.round)<=target||!Number(r.round));
  data.project.currentRound=target;
}
export function cleanupLegacyImport(data: PcfData){
  const deleted=data.deleted.length;data.deleted=[];
  const plan=roundCleanupPlan(data,data.comments);
  // Never discard dated or audited legacy drawing history during import.
  const protectedRounds=[...plan.dates.map((r: Entry)=>r.round),...plan.circulation.map((r: Entry)=>Number(r.round)),...plan.approvals.map((r: Entry)=>Number(r.round))];
  const target=Math.max(plan.target,...protectedRounds);
  const removed=data.roundRegister.filter((r: Entry)=>r.round>target).map((r: Entry)=>r.round);
  const before=data.project.currentRound;pruneRounds(data,target);
  return {deleted,removed,before,after:target,protected:target>plan.target};
}
export function nextCommentNumber(data: PcfData){return data.comments.length+1;}
const FILL_COLORS=['#fffefa','#f2eee4','#f2e2d4','#f5dfda','#f6edcc','#e6eddf','#e1edf2','#e6e7f3','#eee3f1','#f3e1e8','#e6e6df','#dcd3c5'];
export function validateJSON(data: PcfData){
  const fail=(path: string,message: string): never=>{throw Error(path+': '+message);};
  const obj=(x: unknown,p: string)=>{if(!x||typeof x!=='object'||Array.isArray(x))fail(p,'expected an object');};
  const arr=(x: unknown,p: string)=>{if(!Array.isArray(x))fail(p,'expected an array');};
  const str=(x: unknown,p: string)=>{if(typeof x!=='string')fail(p,'expected text');};
  const integer=(x: any,p: string,min=1)=>{if(!Number.isSafeInteger(x)||x<min||x>1000000)fail(p,'expected an integer between '+min+' and 1000000');};
  const optionalText=(x: Entry,keys: string[],p: string)=>{for(const k of keys)if(x[k]!=null)str(x[k],p+'.'+k);};
  // Reject prototype keys anywhere, including extension fields, before state replacement.
  const stack: [any,string,number][]=[[data,'PCF',0]];let nodes=0;
  while(stack.length){const [v,p,depth]=stack.pop()!;if(++nodes>2000000||depth>80)fail(p,'document is too complex');if(v&&typeof v==='object')for(const k of Object.keys(v)){if(['__proto__','prototype','constructor'].includes(k))fail(p,'unsafe property '+k);stack.push([v[k],p+'.'+k,depth+1]);}}
  obj(data,'PCF');if(data.schemaVersion!=='1.0')fail('schemaVersion','only PCF schema 1.0 is supported');
  const ids=new Set();
  function id(value: unknown,p: string){if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(value))fail(p,'invalid stable ID');if(ids.has(value))fail(p,'duplicate stable ID');ids.add(value);}
  id(data.documentId,'documentId');optionalText(data,['updatedAt'],'PCF');
  obj(data.project,'project');const p=data.project;
  for(const k of ['name','planTitle','planNo','revision','folder','approval'])str(p[k],'project.'+k);
  if(!['Not submitted','Under review','Approved','Approved with comments','Rejected'].includes(p.approval))fail('project.approval','unknown approval status');
  integer(p.currentRound,'project.currentRound');
  for(const k of ['comments','deleted','circulation'])arr(data[k],k);
  obj(data.settings,'settings');if(data.settings.theme!=null&&!['light','dark'].includes(data.settings.theme))fail('settings.theme','expected light or dark');
  if(!Number.isFinite(data.settings.fontSize)||data.settings.fontSize<12||data.settings.fontSize>22)fail('settings.fontSize','expected a size from 12 to 22');
  if(![0,30,60,120,300].includes(data.settings.autoSaveSeconds))fail('settings.autoSaveSeconds','unsupported auto-save interval');
  if(data.settings.participantDefaults!=null){obj(data.settings.participantDefaults,'settings.participantDefaults');optionalText(data.settings.participantDefaults,['initiator','responder'],'settings.participantDefaults');}
  const stats={comments:data.comments.length,rounds:0,images:0,deleted:data.deleted.length,sanitized:0};
  function content(x: Entry,path: string){
    obj(x,path);str(x.text,path+'.text');str(x.html,path+'.html');str(x.fill,path+'.fill');
    if(x.fill&&!FILL_COLORS.includes(x.fill))fail(path+'.fill','unsupported cell color');
    arr(x.images,path+'.images');
    const safe=cleanContent({...x,images:[]}).html;if(safe!==x.html){x.html=safe;stats.sanitized++;}
    for(const [i,im]of x.images.entries()){
      const q=path+'.images['+i+']';obj(im,q);id(im.id,q+'.id');str(im.name,q+'.name');str(im.data,q+'.data');
      if(!['image/png','image/jpeg','image/webp'].includes(im.mime))fail(q+'.mime','only PNG, JPEG and WebP images are supported');
      const prefix='data:'+im.mime+';base64,';
      if(!im.data.startsWith(prefix))fail(q+'.data','expected an embedded image matching its MIME type');
      const b64=im.data.slice(prefix.length);
      if(!b64.length||b64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(b64))fail(q+'.data','invalid base64 image');
      if(b64.length/4*3-(b64.endsWith('==')?2:b64.endsWith('=')?1:0)>15*1024*1024)fail(q+'.data','image exceeds 15 MB');
      for(const k of ['width','height'])if(!Number.isSafeInteger(im[k])||im[k]<1)fail(q+'.'+k,'invalid image dimensions');
      if(im.width*im.height>60000000)fail(q,'image resolution is too large');stats.images++;
    }
  }
  function round(r: Entry,path: string){
    obj(r,path);id(r.id,path+'.id');integer(r.number,path+'.number');
    optionalText(r,['initiator','responder','createdAt','updatedAt','ownerDate','replyDate'],path);
    if(!Number.isFinite(r.minHeight)||r.minHeight<0||r.minHeight>3000)fail(path+'.minHeight','invalid row height');
    content(r.owner,path+'.owner');content(r.reply,path+'.reply');stats.rounds++;
  }
  const parents=new Map(),roundNumbers=new Map();
  function comment(c: Entry,path: string,active: boolean){
    obj(c,path);id(c.id,path+'.id');integer(c.number,path+'.number');str(c.page,path+'.page');
    if(!['open','closed'].includes(c.status))fail(path+'.status','expected open or closed');
    arr(c.tags,path+'.tags');c.tags.forEach((t: string,i: number)=>str(t,path+'.tags['+i+']'));arr(c.rounds,path+'.rounds');
    optionalText(c,['createdAt','updatedAt'],path);const nums=new Set();
    for(const [i,r]of c.rounds.entries()){round(r,path+'.rounds['+i+']');if(nums.has(r.number))fail(path+'.rounds','duplicate round number');nums.add(r.number);}
    parents.set(c.id,c);roundNumbers.set(c.id,nums);
  }
  const commentNumbers=new Set();
  for(const [i,c]of data.comments.entries()){comment(c,'comments['+i+']',true);if(commentNumbers.has(c.number))fail('comments','duplicate active comment number');commentNumbers.add(c.number);}
  integer(data.nextCommentNumber,'nextCommentNumber');
  if(data.comments.some((c: Entry)=>c.number>=data.nextCommentNumber))fail('nextCommentNumber','must exceed every active comment number');
  for(const [i,d]of data.deleted.entries()){
    const q='deleted['+i+']';obj(d,q);id(d.id,q+'.id');str(d.deletedAt,q+'.deletedAt');integer(d.parentNumber,q+'.parentNumber');
    if(d.type==='comment')comment(d.data,q+'.data',false);
    else if(d.type==='round'){str(d.parentId,q+'.parentId');round(d.data,q+'.data');}
    else fail(q+'.type','unknown deleted record type');
  }
  for(const [i,d]of data.deleted.entries())if(d.type==='round'){
    const nums=roundNumbers.get(d.parentId);if(!nums)fail('deleted['+i+'].parentId','parent comment is missing');
    if(nums.has(d.data.number))fail('deleted['+i+']','round number already exists for this comment');nums.add(d.data.number);
  }
  for(const [i,r]of data.circulation.entries()){const q='circulation['+i+']';obj(r,q);id(r.id,q+'.id');if(r.round!=null)integer(r.round,q+'.round');optionalText(r,['revision','date','from','to','note','approval','ownerDate','replyDate','ownerRef','replyRef','kind','updatedAt'],q);}
  // v2's initBusinessState already supports these missing legacy collections.
  data.roundRegister??=[];data.approvalHistory??=[];
  arr(data.roundRegister,'roundRegister');const registered=new Set();
  for(const [i,r]of data.roundRegister.entries()){const q='roundRegister['+i+']';obj(r,q);id(r.id,q+'.id');integer(r.round,q+'.round');if(registered.has(r.round))fail(q,'duplicate drawing round');registered.add(r.round);optionalText(r,['revision','ownerDate','replyDate','ownerRef','replyRef','updatedAt'],q);}
  arr(data.approvalHistory,'approvalHistory');
  for(const [i,r]of data.approvalHistory.entries()){const q='approvalHistory['+i+']';obj(r,q);id(r.id,q+'.id');if(r.round!=null)integer(r.round,q+'.round');optionalText(r,['at','from','to','source','reason'],q);}
  if(data.approvalControl!=null){obj(data.approvalControl,'approvalControl');integer(data.approvalControl.lastOpen,'approvalControl.lastOpen',0);if(!['auto','manual'].includes(data.approvalControl.source))fail('approvalControl.source','unknown approval source');optionalText(data.approvalControl,['reason'],'approvalControl');if(data.approvalControl.lastOpen!==data.comments.filter((c: Entry)=>c.status==='open').length)fail('approvalControl.lastOpen','does not match the open comment count');}
  return {data,stats};
}
