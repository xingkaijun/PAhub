import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStore } from 'zustand/vanilla';
import { createProjectSlice } from '../../store/projectSlice';
import { createReviewTrackerSlice } from '../../store/reviewTrackerSlice';
import { createUiSlice } from '../../store/uiSlice';
import { createPresenceSlice } from '../../store/presenceSlice';
import type { AppState } from '../../store/types';
import type { Project, Drawing } from '../../types';
import { projectsApi } from '../../services/api/projectsApi';
import { ApiError } from '../../services/api/apiClient';
import { createHub } from '../src/app.ts';
import { createKjxTestSigner, createKjxVerifier } from '../src/kjx-auth-client.ts';
import { KJX_PCF_ADAPTER } from '../src/pcf-kjx-adapter.ts';

const P='proj-test-001',D='dwg-001';
async function httpFixture(mode:'kjx'|'legacy'='kjx') {
 const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const dir=await mkdtemp(path.join(tmpdir(),'pahub-t7-'));Object.assign(process.env,{PORT:'0',AUTH_MODE:mode,PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
 const signer=createKjxTestSigner();const hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://kjx.test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch})});hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));
 if(mode==='kjx')hub.db.prepare('INSERT INTO project_team_reviewers VALUES(?,?)').run(P,'user-1');
 const request=(url:string,role:string,body:any)=>fetch('http://127.0.0.1:'+hub.port+url,{method:'PATCH',headers:{'X-Auth-Token':signer.signUser('pahub',{role}),Origin:'https://pahub.kjxing.com','Content-Type':'application/json'},body:JSON.stringify(body)});
 return {hub,request,close:async()=>{await hub.close();await rm(dir,{recursive:true,force:true});for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}};
}
function storeFixture(mode:'kjx'|'legacy'='kjx') {
 const store=createStore<AppState>()((...args)=>({...createProjectSlice(...args),...createReviewTrackerSlice(...args),...createUiSlice(...args),...createPresenceSlice(...args)}));
 const drawing={id:'d',customId:'001',drawingNo:'D1',title:'Drawing',status:'Reviewing',assignees:[],remarks:[],statusHistory:[],logs:[],manualCommentsCount:0,manualOpenCommentsCount:0,currentRound:'A'} as unknown as Drawing;
 const project={id:'p',name:'Project',drawings:[drawing],conf:store.getState().data.settings} as Project;
 store.setState({activeProjectId:'p',data:{...store.getState().data,projects:[project]},session:{mode,admin:true,requiresPassword:false,permissions:['drawing.update']}});return store;
}

test('T7 D1: viewer controls are capability-gated and PCF gates use actual IDs',async()=>{
 const row=await readFile('components/DrawingRow.tsx','utf8');
 assert.match(row,/StatusBadge readOnly=\{!canWrite\}/);assert.match(row,/!kjx \|\| canDelete/);
 assert.match(KJX_PCF_ADAPTER,/'add-btn':'pcf.comment.create'/);assert.match(KJX_PCF_ADAPTER,/'save-btn':'pcf.comment.create'/);assert.match(KJX_PCF_ADAPTER,/display:none!important/);
});

test('T7 D2: manager no-op tracker/config fields are omitted, real tracker changes stay admin-only and atomic',async()=>{
 const f=await httpFixture();try{
  f.hub.db.prepare('DELETE FROM review_tracker WHERE project_id=? AND drawing_id=?').run(P,D);
  f.hub.db.prepare('INSERT OR REPLACE INTO review_tracker(project_id,drawing_id,raw_drawing_ref,reviewer_id,done,done_at) VALUES(?,?,?,?,?,?)').run(P,D,D,'A',1,null);
  const conf=(await import('../src/project-read.ts')).getProjectConfiguration(f.hub.db,P);
  const body={updatedDrawings:[{id:D,changes:{assignees:['A']}}],reviewTracker:{[D]:{A:{done:true,doneAt:null}}},conf:{holidays:conf.holidays},confBase:{holidays:conf.holidays}};
  assert.equal((await f.request('/api/projects/'+P,'manager',body)).status,200);assert.equal(f.hub.db.prepare('SELECT reviewer_id FROM drawing_assignees WHERE drawing_id=?').all(D).some(row=>row.reviewer_id==='A'),true);
  const before=f.hub.db.prepare('SELECT title FROM drawings WHERE id=?').get(D);
  for(const tracker of [{[D]:{unassigned:{done:true,doneAt:null}}},{[D]:{A:{done:true,doneAt:null,unknown:'x'}}}]){
   const response=await f.request('/api/projects/'+P,'manager',{updatedDrawings:[{id:D,changes:{title:'Must not land'}}],reviewTracker:tracker});assert.equal(response.status,tracker[D].unassigned?403:400);assert.deepEqual(f.hub.db.prepare('SELECT title FROM drawings WHERE id=?').get(D),before);
  }
  assert.equal((await f.request('/api/projects/'+P,'manager',{conf:{password:'unauthorized-change'}})).status,403);
 }finally{await f.close();}
});

test('T7 D2: assignee edit does not dirty tracker in kjx and denied saves provide explicit reload recovery',async()=>{
 const store=storeFixture(),save=projectsApi.saveDelta;let calls=0,payload:any;
 projectsApi.saveDelta=async(_id,body)=>{calls++;payload=body;return {success:true} as any;};
 try{
  store.getState().updateDrawing('d',{assignees:['A']});assert.equal(store.getState()._dirtyTracker,false);await store.getState().saveProject('p');assert.equal(payload.reviewTracker,undefined);
  store.getState().updateDrawing('d',{title:'Denied'});projectsApi.saveDelta=async()=>{calls++;throw new ApiError('forbidden',403);};assert.equal(await store.getState().saveProject('p'),false);assert.equal(store.getState().hasUnsavedChanges(),false);assert.match(store.getState().error!,/permission/);assert.notEqual(store.getState().data.projects[0].drawings[0].title,'Denied');
  const count=calls;assert.equal(await store.getState().saveProject('p'),true);assert.equal(calls,count);
  const legacy=storeFixture('legacy');legacy.getState().updateDrawing('d',{assignees:['A']});assert.equal(legacy.getState()._dirtyTracker,true);
 }finally{projectsApi.saveDelta=save;}
});

test('T7 D3: clean new workspace saves independently in both modes and fec6429 contains the original defect',async()=>{
 const old=execFileSync('git',['show','fec6429:store/projectSlice.ts'],{encoding:'utf8'});assert.match(old,/const hasDirty = dirtyCount > 0 \|\| dirtyConfSnapshot \|\| dirtyTrackerSnapshotFlag;/);
 const save=projectsApi.saveDelta;
 try{for(const mode of ['kjx','legacy'] as const){
  const store=storeFixture(mode);const original=store.getState().activeProjectId;store.getState().addProject('New Workspace');const project=store.getState().data.projects.find(p=>p.localOnly)!;
  let submitted:any;projectsApi.saveDelta=async(id,body)=>{submitted={id,body};return {success:true} as any;};
  assert.equal(await store.getState().saveProject(project.id),true);assert.equal(submitted.id,project.id);assert.equal(submitted.body.projectName,'New Workspace');assert.deepEqual(submitted.body.conf,project.conf);assert.equal(submitted.body.reviewTracker,undefined);assert.equal(store.getState().activeProjectId,original);assert.equal(store.getState().data.projects.find(p=>p.id===project.id)?.localOnly,undefined);
 }}finally{projectsApi.saveDelta=save;}
 for(const mode of ['kjx','legacy'] as const){const f=await httpFixture(mode);try{const id='new-'+mode;assert.equal((await f.request('/api/projects/'+id,'admin',{projectName:'Persisted Workspace',conf:{reviewers:[],holidays:[],disciplineDefaults:{},roundACycle:10,otherRoundsCycle:5}})).status,200);assert.equal(f.hub.db.prepare('SELECT name FROM projects WHERE id=?').get(id)?.name,'Persisted Workspace');}finally{await f.close();}}
});
