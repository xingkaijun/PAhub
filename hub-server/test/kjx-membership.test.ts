import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../src/app.ts';
import {createKjxTestSigner,createKjxVerifier} from '../src/kjx-auth-client.ts';
import {createStore} from 'zustand/vanilla';
import {createProjectSlice} from '../../store/projectSlice';
import {createReviewTrackerSlice} from '../../store/reviewTrackerSlice';
import {createUiSlice} from '../../store/uiSlice';
import {createPresenceSlice} from '../../store/presenceSlice';
import {projectsApi} from '../../services/api/projectsApi';
import type {AppState} from '../../store/types';
const P='proj-test-001',D='dwg-001';
async function fixture(mode:'kjx'|'legacy'='kjx'){
 const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));const dir=await mkdtemp(path.join(tmpdir(),'membership-'));
 Object.assign(process.env,{PORT:'0',AUTH_MODE:mode,PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
 const signer=createKjxTestSigner(),hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch})});hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));hub.db.prepare('INSERT INTO projects(id,name) VALUES(?,?)').run('secret','Hidden Project');
 const request=(url:string,role='reviewer',body?:unknown,method=body?'POST':'GET',id=role)=>fetch('http://127.0.0.1:'+hub.port+url,{method,headers:{'X-Auth-Token':signer.signUser('pahub',{sub:id,username:id,name:'Name '+id,role}),Origin:'https://pahub.kjxing.com','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const team=(users:string[])=>request('/api/projects/'+P,'admin',{conf:{reviewers:users.map(id=>({id,name:'Name '+id})),disciplineDefaults:{},defaultAssignees:{}}},'PATCH');
 return{hub,request,team,close:async()=>{await hub.close();await rm(dir,{recursive:true,force:true});for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}};
}

test('membership: project list refresh removes stale selectable projects but preserves local recovery',async()=>{
 const original=projectsApi.fetchProjectList;projectsApi.fetchProjectList=async()=>[];
 try{for(const mode of ['kjx','legacy'] as const){
  const store=createStore<AppState>()((...args)=>({...createProjectSlice(...args),...createReviewTrackerSlice(...args),...createUiSlice(...args),...createPresenceSlice(...args)}));
  const project={id:'old',name:'Old Project',conf:store.getState().data.settings,drawings:[]} as any;
  store.setState({session:{mode,admin:false,requiresPassword:false},activeProjectId:'old',data:{...store.getState().data,projects:[project]}});
  await store.getState().fetchProjectList();
  assert.equal(store.getState().data.projects.length,mode==='kjx'?0:1);
  if(mode==='kjx'){assert.equal(store.getState().activeProjectId,null);assert.equal(store.getState().membershipRecovery.old.project.name,'Old Project');}
 }}finally{projectsApi.fetchProjectList=original;}
});

test('membership: reviewer/manager list grant revoke and admin visibility follow only project Team Setup links',async()=>{
 const f=await fixture();try{
  for(const role of ['reviewer','manager'])assert.deepEqual(await(await f.request('/api/projects',role)).json(),[]);
  assert.equal((await(await f.request('/api/projects','admin')).json()).length,2);
  assert.equal((await f.team(['reviewer','manager','manual-fake'])).status,200);
  for(const role of ['reviewer','manager']){const list=await(await f.request('/api/projects',role)).json();assert.deepEqual(list.map((p:any)=>p.id),[P]);assert.equal((await f.request('/api/projects/'+P,role,{})).status,200);}
  assert.equal((await f.request('/api/projects/'+P,'reviewer',{},'POST','manual-fake')).status,403);
  assert.equal((await f.team([])).status,200);
  for(const role of ['reviewer','manager']){assert.deepEqual(await(await f.request('/api/projects',role)).json(),[]);assert.equal((await f.request('/api/projects/'+P,role,{})).status,403);}
  f.hub.db.prepare('INSERT INTO reviewers VALUES(?,?)').run('global-only','Global Person');f.hub.db.prepare('INSERT INTO drawing_assignees VALUES(?,?)').run(D,'global-only');
  assert.equal((await f.request('/api/projects/'+P,'reviewer',{},'POST','global-only')).status,403);
  f.hub.db.prepare('INSERT INTO discipline_defaults VALUES(?,?,?)').run(P,'Hull','lead');
  assert.equal((await f.request('/api/projects/'+P,'reviewer',{},'POST','lead')).status,200);
  f.hub.db.prepare('DELETE FROM discipline_defaults WHERE project_id=?').run(P);
  assert.equal((await f.request('/api/projects/'+P,'reviewer',{},'POST','lead')).status,403);
 }finally{await f.close();}
});

test('membership: every project route family rejects nonmembers before data, writes, errors, or SSE',async()=>{
 const f=await fixture();try{
  const paths:[string,string][]=[['POST','/api/projects/'+P],['PATCH','/api/projects/'+P],['POST','/api/projects/'+P+'/unlock'],['GET','/api/projects/'+P+'/drawings?ids='+D],['POST','/api/projects/'+P+'/drawings/'+D+'/status'],['GET','/api/projects/'+P+'/review-tracker'],['PUT','/api/projects/'+P+'/review-tracker'],['GET','/api/projects/'+P+'/comments'],['GET','/api/projects/'+P+'/comments.xlsx'],['GET','/api/projects/'+P+'/audit?from=2000&to=2100'],['GET','/api/projects/'+P+'/heartbeat'],['PUT','/api/projects/'+P+'/heartbeat'],['GET','/api/projects/'+P+'/events'],['GET','/api/projects/'+P+'/builder-replies/pending'],['POST','/api/projects/'+P+'/builder-replies/preview'],['POST','/api/projects/'+P+'/builder-replies/set/apply'],['POST','/api/projects/'+P+'/builder-replies/set/skip'],['GET','/api/projects/'+P+'/builder-replies/set/file/file'],['GET','/api/pcf/'+P+'/index'],['GET','/api/pcf/'+P+'/presence'],['POST','/api/pcf/'+P+'/exports/batch'],['GET','/pcf/'+P+'/'+D],['HEAD','/pcf/'+P+'/'+D],['GET','/pcf/'+P+'/'+D+'/images/'+'a'.repeat(64)],['GET','/api/team/directory?projectId='+P]];
  for(const tail of ['data','meta','presence','events','exports','history','download','initiators','exports/aaaa/download'])paths.push(['GET','/api/pcf/'+P+'/'+D+'/'+tail]);
  for(const tail of ['session','create','presence','ops','exports','imports','exports/aaaa/void','history/1/restore'])paths.push(['POST','/api/pcf/'+P+'/'+D+'/'+tail]);paths.push(['PUT','/api/pcf/'+P+'/'+D+'/document']);
  for(const role of ['reviewer','manager'])for(const[method,url]of paths){const response=await f.request(url,role,['POST','PATCH','PUT'].includes(method)?{}:undefined,method);assert.equal(response.status,403,role+' '+method+' '+url);if(method!=='HEAD')assert.doesNotMatch(await response.text(),/Hidden Project|PG-VLEC/);}
  assert.equal(f.hub.db.prepare('SELECT COUNT(*) AS n FROM pcf_index').get()!.n,0);
  assert.equal((await f.request('/api/team/directory','manager')).status,403);
 }finally{await f.close();}
});

test('membership: manager can create and manage team only within their project; creator survives initial empty roster',async()=>{
 const f=await fixture();try{
  const response=await f.request('/api/projects/new','manager',{projectName:'My Workspace',conf:{reviewers:[],disciplineDefaults:{},holidays:[],roundACycle:10,otherRoundsCycle:5}},'PATCH');assert.equal(response.status,200);
  assert.ok(f.hub.db.prepare('SELECT 1 FROM project_team_reviewers WHERE project_id=? AND reviewer_id=?').get('new','manager'));
  assert.equal((await f.request('/api/projects/new','manager',{})).status,200);
  assert.equal((await f.request('/api/projects/new','manager',{conf:{reviewers:[{id:'manager',name:'Manager'},{id:'reviewer',name:'Reviewer'}]}},'PATCH')).status,200);
  assert.equal((await f.request('/api/projects/new','reviewer',{})).status,200);
  assert.equal((await f.request('/api/projects/'+P,'manager',{conf:{reviewers:[{id:'manager',name:'Manager'}]}},'PATCH')).status,403);
 }finally{await f.close();}
});

test('membership: kjx ignores stored password while legacy retains its challenge and lists all projects',async()=>{
 const f=await fixture();try{
  await f.team(['reviewer']);const {setProjectPassword}=await import('../src/project-password.ts');setProjectPassword(f.hub.db,P,'temporary-test-password');
  const stored=f.hub.db.prepare('SELECT password_hash FROM project_passwords WHERE project_id=?').get(P)!.password_hash;
  const list=await(await f.request('/api/projects')).json();assert.equal(list[0].passwordProtected,false);
  assert.equal((await f.request('/pcf/'+P+'/'+D)).status,200);assert.equal((await f.request('/api/projects/'+P, 'reviewer',{})).status,200);
  assert.equal(f.hub.db.prepare('SELECT password_hash FROM project_passwords WHERE project_id=?').get(P)!.password_hash,stored);
 }finally{await f.close();}
 const legacy=await fixture('legacy');try{assert.equal((await(await legacy.request('/api/projects')).json()).length,2);}finally{await legacy.close();}
});

test('membership: open project and drawing SSE terminate immediately on Team Setup removal',async()=>{
 const f=await fixture();const abort=new AbortController();try{
  await f.team(['reviewer']);await f.request('/pcf/'+P+'/'+D);
  const authorized=()=>!!f.hub.db.prepare('SELECT 1 FROM project_team_reviewers WHERE project_id=? AND reviewer_id=?').get(P,'reviewer');
  const project=f.hub.pcf.realtime.projectStream(P,abort.signal,authorized);
  const drawing=f.hub.pcf.realtime.stream(P+'/'+D,{clientId:'member',clientName:'Member',ip:''},1,0,abort.signal,Infinity,authorized);
  const reader=project.body!.getReader(),drawingReader=drawing.body!.getReader();await reader.read();await drawingReader.read();await f.team([]);
  for(const source of [reader,drawingReader]){let ended=false;for(let i=0;i<100;i++){if((await source.read()).done){ended=true;break;}}assert.equal(ended,true);}
 }finally{abort.abort();await f.close();}
});

test('tracker: reviewer own assigned sub only; manager/admin delegated writes are audited and atomic',async()=>{
 const f=await fixture();try{
  await f.team(['reviewer','manager','other']);
  const db=f.hub.db;db.prepare('INSERT INTO drawing_assignees VALUES(?,?)').run(D,'reviewer');db.prepare('INSERT INTO drawing_assignees VALUES(?,?)').run(D,'other');
  const url='/api/projects/'+P+'/review-tracker';
  assert.equal((await f.request(url,'reviewer',{[D]:{reviewer:{done:true}}},'PUT')).status,200);
  const row=db.prepare("SELECT actor_id,detail FROM audit_log WHERE action='TRACKER' ORDER BY id DESC LIMIT 1").get()!;assert.equal(row.actor_id,'reviewer');assert.equal(JSON.parse(String(row.detail)).subjectId,'reviewer');
  assert.equal((await f.request(url,'reviewer',{[D]:{other:{done:true}}},'PUT')).status,403);
  assert.equal((await f.request(url,'reviewer',{[D]:{reviewer:{done:false},other:{done:true}}},'PUT')).status,403);
  assert.equal(db.prepare('SELECT done FROM review_tracker WHERE project_id=? AND drawing_id=? AND reviewer_id=?').get(P,D,'reviewer')!.done,1);
  assert.equal((await f.request(url,'manager',{[D]:{other:{done:true}}},'PUT')).status,200);
  const delegated=db.prepare("SELECT actor_id,detail FROM audit_log WHERE action='TRACKER' ORDER BY id DESC LIMIT 1").get()!;assert.equal(delegated.actor_id,'manager');assert.equal(JSON.parse(String(delegated.detail)).subjectId,'other');assert.equal(JSON.parse(String(delegated.detail)).delegated,true);
  assert.equal((await f.request(url,'admin',{[D]:{other:{done:false}}},'PUT')).status,200);
  assert.equal((await f.request(url,'reviewer',{[D]:{'manual-test':{done:true}}},'PUT','manual-test')).status,403);
  assert.equal((await f.request('/api/projects/'+P,'reviewer',{reviewTracker:{[D]:{other:{done:true}}}},'PATCH')).status,403);
 }finally{await f.close();}
});

test('reviewer deletion cleans project references atomically and retains tracker history and other projects',async()=>{
 const f=await fixture();try{
  await f.team(['manager','engineer_a']);const db=f.hub.db;
  db.prepare('INSERT OR REPLACE INTO discipline_defaults VALUES(?,?,?)').run(P,'Hull','engineer_a');
  db.prepare('INSERT OR IGNORE INTO discipline_default_assignees VALUES(?,?,?)').run(P,'Hull','engineer_a');
  const oldTracker=Number(db.prepare('SELECT COUNT(*) AS n FROM review_tracker WHERE reviewer_id=?').get('engineer_a')!.n);
  db.prepare('INSERT INTO discipline_defaults VALUES(?,?,?)').run('secret','Hull','engineer_a');
  assert.equal((await f.request('/api/projects/'+P+'/reviewers/engineer_a','reviewer',undefined,'DELETE')).status,403);
  assert.equal((await f.request('/api/projects/'+P+'/reviewers/engineer_a','manager',undefined,'DELETE')).status,200);
  for(const table of ['project_team_reviewers','discipline_defaults','discipline_default_assignees'])assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE project_id=? AND reviewer_id=?').get(P,'engineer_a')!.n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drawing_assignees WHERE reviewer_id=? AND drawing_id IN (SELECT id FROM drawings WHERE project_id=?)').get('engineer_a',P)!.n,0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM review_tracker WHERE reviewer_id=?').get('engineer_a')!.n),oldTracker);
  assert.ok(db.prepare('SELECT 1 FROM discipline_defaults WHERE project_id=? AND reviewer_id=?').get('secret','engineer_a'));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='REVIEWER_DELETE' AND actor_id='manager'").get());
 }finally{await f.close();}
});

test('reviewer view: member manager can write regular project Config but cannot write global/admin settings',async()=>{
 const f=await fixture();try{
  await f.team(['reviewer','manager']);
  const conf={displayName:'Manager report',holidays:['2030-01-01'],roundACycle:12,otherRoundsCycle:6,autoSyncInterval:2};
  assert.equal((await f.request('/api/projects/'+P,'manager',{conf},'PATCH')).status,200);
  const stored=await(await f.request('/api/projects/'+P,'manager',{})).json();assert.equal(stored.conf.displayName,conf.displayName);assert.equal(stored.conf.roundACycle,12);
  assert.equal((await f.request('/api/projects/secret','manager',{conf},'PATCH')).status,403);
  assert.equal((await f.request('/api/projects/'+P,'reviewer',{conf:{displayName:'Forbidden'}},'PATCH')).status,403);
  assert.equal((await f.request('/api/projects/'+P,'manager',{conf:{password:'forbidden'}},'PATCH')).status,403);
  assert.equal((await f.request('/api/projects/'+P,'manager',{deletedDrawingIds:[D]},'PATCH')).status,403);
 }finally{await f.close();}
});

test('reviewer view: member read supplies names for drawing-only assigned IDs without directory privilege',async()=>{
 const f=await fixture();try{
  await f.team(['reviewer']);const id='569b807f-73c4-4ba2-9623-818be3e97523';
  f.hub.db.prepare('INSERT INTO reviewers VALUES(?,?)').run(id,'Assigned Snapshot');f.hub.db.prepare('INSERT INTO drawing_assignees VALUES(?,?)').run(D,id);
  const project=await(await f.request('/api/projects/'+P,'reviewer',{})).json();assert.equal(project.assigneeNames[id],'Assigned Snapshot');assert.equal(project.conf.reviewers.some((p:any)=>p.id===id),false);
  const subset=await(await f.request('/api/projects/'+P+'/drawings?ids='+D)).json();assert.equal(subset.assigneeNames[id],'Assigned Snapshot');
 }finally{await f.close();}
});

test('reviewer view: unauthorized store edits never create dirty state; manager 403 restores snapshot offline',async()=>{
 const {ApiError}=await import('../../services/api/apiClient');
 const store=createStore<AppState>()((...args)=>({...createProjectSlice(...args),...createReviewTrackerSlice(...args),...createUiSlice(...args),...createPresenceSlice(...args)}));
 const project={id:'p',name:'Project',conf:store.getState().data.settings,drawings:[{id:'d',title:'Original',assignees:[],remarks:[],statusHistory:[],status:'Reviewing',rev:'old'}]} as any;
 store.setState({activeProjectId:'p',data:{...store.getState().data,projects:[project]},session:{mode:'kjx',admin:false,requiresPassword:false,permissions:['view']}});
 store.getState().updateDrawing('d',{title:'Forbidden'});store.getState().addRemark('d','Forbidden');store.getState().updateProjectConfig('p',{displayName:'Forbidden'});
 assert.equal(store.getState().hasUnsavedChanges(),false);assert.equal(store.getState().data.projects[0].drawings[0].title,'Original');
 store.setState({session:{mode:'kjx',admin:false,requiresPassword:false,permissions:['drawing.update','project.settings']}});
 store.getState().updateDrawing('d',{title:'Optimistic'});store.getState().updateProjectConfig('p',{displayName:'Optimistic'});
 const save=projectsApi.saveDelta,load=projectsApi.loadProject;projectsApi.saveDelta=async()=>{throw new ApiError('forbidden',403);};projectsApi.loadProject=async()=>{throw Error('offline');};
 try{assert.equal(await store.getState().saveProject('p'),false);assert.equal(store.getState().hasUnsavedChanges(),false);assert.equal(store.getState().data.projects[0].drawings[0].title,'Original');assert.equal(store.getState().data.projects[0].conf.displayName,undefined);assert.match(store.getState().error!,/permission/);}finally{projectsApi.saveDelta=save;projectsApi.loadProject=load;}
});

test('P0 frozen save receipt replays after timeout/newer edits without duplicate audit or lost update',async()=>{
 const f=await fixture();try{
  await f.team(['manager']);
  const {randomUUID}=await import('node:crypto');const {readDrawing}=await import('../src/drawing-revision.ts');
  const before=readDrawing(f.hub.db,P,D)!;
  const body={saveRequestId:randomUUID(),projectName:'PG-VLEC-H2684',updatedDrawings:[{id:D,baseRev:before.rev,base:{title:before.title},changes:{title:'First acknowledged once'}}]};
  const {withSaveTimeout}=await import('../../lib/save-control.ts');
  let confirmed:any;
  const committed=f.request('/api/projects/'+P,'manager',body,'PATCH').then(async first=>{assert.equal(first.status,200);confirmed=await first.json();});
  await assert.rejects(withSaveTimeout(async()=>{await committed;return new Promise<never>(()=>{});},100),{name:'TimeoutError'});
  await committed;
  const count=f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n;
  assert.equal((await f.request('/api/projects/'+P,'manager',{updatedDrawings:[{id:D,changes:{title:'Later editor'}}]},'PATCH')).status,200);
  const replay=await f.request('/api/projects/'+P,'manager',body,'PATCH');assert.equal(replay.status,200);assert.deepEqual(await replay.json(),confirmed);
  assert.equal(f.hub.db.prepare('SELECT title FROM drawings WHERE id=?').get(D)!.title,'Later editor');assert.equal(f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n,count);
  assert.equal((await f.request('/api/projects/'+P,'manager',{...body,projectName:'Changed envelope'},'PATCH')).status,409);
 }finally{await f.close();}
});

test('P1 replay rechecks a transient verification error without repeating the write or audit',async()=>{
 const f=await fixture();try{
  await f.team(['manager']);
  const {randomUUID}=await import('node:crypto');const {readDrawing}=await import('../src/drawing-revision.ts');
  const before=readDrawing(f.hub.db,P,D)!;
  const body={saveRequestId:randomUUID(),updatedDrawings:[{id:D,baseRev:before.rev,base:{title:before.title},changes:{title:'Verify receipt recovery'}}]};
  const first=await f.request('/api/projects/'+P,'manager',body,'PATCH');assert.equal(first.status,200);
  const acknowledgement=await first.json() as any;
  f.hub.db.prepare('UPDATE project_save_receipts SET result_json=? WHERE request_id=?').run(JSON.stringify({...acknowledgement,verification:{ok:false,checked:0,mismatched:[],error:'temporary verification query failure'}}),body.saveRequestId);
  const count=f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n;
  const replay=await f.request('/api/projects/'+P,'manager',body,'PATCH');assert.equal(replay.status,200);assert.equal(((await replay.json()) as any).verification.ok,true);
  assert.equal(f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n,count);
 }finally{await f.close();}
});
