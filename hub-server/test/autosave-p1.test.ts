import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from 'zustand/vanilla';
import {createProjectSlice} from '../../store/projectSlice';
import {createReviewTrackerSlice} from '../../store/reviewTrackerSlice';
import {createUiSlice} from '../../store/uiSlice';
import {createPresenceSlice} from '../../store/presenceSlice';
import type {AppState} from '../../store/types';
import {projectsApi} from '../../services/api/projectsApi';
import {persistenceOptions} from '../../store/persistence';
import {recoveryStorage,storageWarningSnapshot} from '../../lib/local-storage';
import {mergeContinuousComments} from '../../lib/audit-merge';
import {DatabaseSync} from 'node:sqlite';
import {registerActivityRoutes} from '../src/activity-routes';
import type {Route} from '../src/router';
function fixture(kjx=true){
 const store=createStore<AppState>()((...args)=>({...createProjectSlice(...args),...createReviewTrackerSlice(...args),...createUiSlice(...args),...createPresenceSlice(...args)}));
 const conf={...store.getState().data.settings,reviewers:[],disciplineDefaults:{}};
 store.setState({activeProjectId:'p',session:kjx?{mode:'kjx',admin:false,requiresPassword:false,user:{id:'manager',username:'manager',name:'Manager',title:null,disciplines:[],role:'manager'},permissions:['drawing.update','project.settings']}:null,data:{...store.getState().data,projects:[{id:'p',name:'Project',conf,drawings:[{id:'d',title:'Original',rev:'r1',remarks:[],assignees:['manager'],statusHistory:[],status:'Reviewing'} as any]}]}});
 return store;
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('P1 saves do not set global loading; newer edits survive and unknown verification stays pending',async()=>{
 for(const kjx of [true,false]){
  const store=fixture(kjx),original=projectsApi.saveDelta;let release!:(value:any)=>void;
  projectsApi.saveDelta=async()=>new Promise(resolve=>release=resolve);
  try{
   store.getState().updateDrawing('d',{title:'First'});
   const save=store.getState().saveProject('p');await flush();assert.equal(store.getState().isLoading,false);
   store.getState().updateDrawing('d',{title:'Second'});
   release({success:true,verification:{ok:false,error:'read unavailable',mismatched:[],checked:0}});
   assert.equal(await save,false);assert.equal(store.getState().saveStatuses.p.phase,'unconfirmed');assert.equal(store.getState().hasUnsavedChanges(),true);
   assert.equal(store.getState().data.projects[0].drawings[0].title,'Second');
   assert.equal(!!store.getState().pendingSaves.p,kjx);
   projectsApi.saveDelta=async()=>({success:true,drawings:[{...store.getState().data.projects[0].drawings[0],title:kjx?'First':'Second'}]} as any);
   await store.getState().saveProject('p',{manual:true});
   assert.equal(store.getState().hasUnsavedChanges(),kjx,'frozen kjx receipt clears only First; newer edit stays');
  }finally{projectsApi.saveDelta=original;}
 }
});
test('P1 Tracker blocks double clicks, verifies lost receipts and persists failed exact intent for retry',async()=>{
 for(const kjx of [true,false]){
  const store=fixture(kjx),put=projectsApi.saveReviewTracker,get=projectsApi.loadReviewTracker;let calls=0,release!:()=>void;
  const key=JSON.stringify(['p','d','manager']);
  projectsApi.saveReviewTracker=async()=>{calls++;await new Promise<void>(resolve=>release=resolve);throw Error('lost response');};
  projectsApi.loadReviewTracker=async()=>({d:{manager:{done:true,doneAt:'confirmed'}}});
  try{
   store.getState().toggleAssigneeDone('d','manager');store.getState().toggleAssigneeDone('d','manager');assert.equal(calls,1);assert.equal(store.getState().trackerWrites[key].phase,'saving');
   release();await flush();assert.equal(store.getState().reviewTracker.d.manager.done,true);assert.equal(store.getState().trackerWrites[key],undefined);
   projectsApi.saveReviewTracker=async()=>{calls++;throw Error('offline');};projectsApi.loadReviewTracker=async()=>{throw Error('read offline');};
   store.getState().toggleAssigneeDone('d','manager');await flush();assert.equal(store.getState().trackerWrites[key].phase,'failed');assert.equal(store.getState().trackerWrites[key].done,false);
   assert.equal(store.getState().hasUnsavedChanges(),true);
   const persisted=persistenceOptions.partialize!(store.getState());assert.equal(persisted.trackerWrites[key].done,false);
   projectsApi.saveReviewTracker=async(_p,body)=>{assert.equal(body.d.manager.done,false);return {success:true};};projectsApi.loadReviewTracker=async()=>({d:{manager:{done:false}}});
   assert.equal(await store.getState().retryTrackerWrite(key),true);assert.equal(store.getState().hasUnsavedChanges(),false);
  }finally{projectsApi.saveReviewTracker=put;projectsApi.loadReviewTracker=get;}
 }
});
test('P1 local recovery quota/disabled errors are explicit and do not throw away in-memory edits',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 try{
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(){throw Error('disabled');},setItem(){throw Error('quota');},removeItem(){throw Error('disabled');}}});
  assert.equal(recoveryStorage.getItem('x'),null);assert.match(storageWarningSnapshot()!,/Local recovery unavailable/);
  assert.doesNotThrow(()=>recoveryStorage.setItem('x','value'));assert.match(storageWarningSnapshot()!,/quota/);
 }finally{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete (globalThis as any).localStorage;}
});
test('P1 merge only coalesces adjacent known same-actor/same-drawing events with continuous counts',()=>{
 const row=(actorId:string,from:number,to:number,other={})=>({date:'2026-11-15',drawingId:'d',actorId,eventType:'Comments',detail:`Comments: ${from} -> ${to}`,time:'12:00',occurredAt:0,note:'app',...other});
 assert.equal(mergeContinuousComments([row('a',0,1),row('a',1,2)])[0].detail,'Comments: 0 -> 2');
 for(const middle of [row('b',1,2),row('a',1,2,{drawingId:'other'}),row('a',1,2,{eventType:'Status'})])assert.equal(mergeContinuousComments([row('a',0,1),middle,row('a',2,3)]).length,3);
 assert.equal(mergeContinuousComments([row('',0,1),row('',1,2)]).length,2);
 assert.equal(mergeContinuousComments([row('a',0,1),row('a',3,4)]).length,2);
});
test('P1 audit cursor loads beyond 2000 entries, including same-timestamp rows and new head inserts',async()=>{
 const db=new DatabaseSync(':memory:');const routes:Route[]=[];
 try{
  db.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT,row_id TEXT,action TEXT,detail TEXT,created_at TEXT)');
  const insert=db.prepare("INSERT INTO audit_log(project_id,row_id,action,detail,created_at) VALUES('p','d','COMMENTS','{}','2026-11-15T00:00:00Z')");
  db.exec('BEGIN');for(let i=0;i<2105;i++)insert.run();db.exec('COMMIT');
  registerActivityRoutes({add:(route:Route)=>routes.push(route),kjx:false} as any,db);
  const read=async(cursor?:string)=>{const url=new URL('http://hub/api/projects/p/audit?from=2026-11-14&to=2026-11-16');if(cursor)url.searchParams.set('cursor',cursor);return await (await routes[0].handle({params:['p'],url,request:new Request(url),json:async()=>({})})).json() as any;};
  let page=await read(),ids=page.entries.map((e:any)=>e.id);insert.run();
  while(page.nextCursor){page=await read(page.nextCursor);ids.push(...page.entries.map((e:any)=>e.id));}
  assert.equal(ids.length,2105);assert.equal(new Set(ids).size,2105);assert.equal(ids.at(-1),'1');assert.equal(page.truncated,false);
 }finally{db.close();}
});
