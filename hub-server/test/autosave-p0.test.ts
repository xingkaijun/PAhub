import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from 'zustand/vanilla';
import {createProjectSlice} from '../../store/projectSlice';
import {createReviewTrackerSlice} from '../../store/reviewTrackerSlice';
import {createUiSlice} from '../../store/uiSlice';
import {createPresenceSlice} from '../../store/presenceSlice';
import type {AppState} from '../../store/types';
import {projectsApi} from '../../services/api/projectsApi';
import {ApiError} from '../../services/api/apiClient';
import {SaveLock,retryDelay,saveFailure,retryable,withSaveTimeout} from '../../lib/save-control.ts';
import {persistenceOptions} from '../../store/persistence';
import {sessionApi} from '../../services/api/sessionApi';

function fixture(){
 const store=createStore<AppState>()((...args)=>({...createProjectSlice(...args),...createReviewTrackerSlice(...args),...createUiSlice(...args),...createPresenceSlice(...args)}));
 const conf={...store.getState().data.settings,reviewers:[],disciplineDefaults:{}};
 store.setState({activeProjectId:'p',session:{mode:'kjx',admin:false,requiresPassword:false,user:{id:'manager',username:'manager',name:'Manager',title:null,disciplines:[],role:'manager'},permissions:['drawing.update','project.settings']},data:{...store.getState().data,projects:[{id:'p',name:'Project',conf,drawings:[{id:'d',title:'Original',rev:'r1',remarks:[],assignees:[],statusHistory:[],status:'Reviewing'} as any]},{id:'q',name:'Other',conf,drawings:[]}]}});
 return store;
}

test('P0 retry delays grow to 60 seconds; permanent errors do not retry',()=>{
 assert.deepEqual([1,2,3,4,5,6,7].map(retryDelay),[3000,6000,12000,24000,48000,60000,60000]);
 for(const status of [401,403,413,409,400])assert.equal(retryable(saveFailure({status})),false);
 for(const status of [500,502,503])assert.equal(retryable(saveFailure({status})),true);
 assert.equal(retryable(saveFailure(new Error('offline'))),true);
 assert.equal(saveFailure({name:'TimeoutError'}),'timeout');
});

test('P0 lock shares same save and serializes other workspaces; timeout aborts request',async()=>{
 const lock=new SaveLock();let release!:()=>void,calls=0;
 const task=()=>new Promise<boolean>(resolve=>{calls++;release=()=>resolve(true);});
 const a=lock.run('p',task),b=lock.run('p',task);let second=false;
 const c=lock.run('q',async()=>{second=true;return true;});
 assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);assert.equal(second,false);release();await Promise.all([a,b,c]);assert.equal(second,true);
 let aborted=false;
 await assert.rejects(withSaveTimeout(signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(Error('expired'),{name:'TimeoutError'}));});}),5),{name:'TimeoutError'});
 assert.equal(aborted,true);
});

test('P0 store freezes retry payload, keeps newer edits, preserves baselines and resets backoff',async()=>{
 const store=fixture(),original=projectsApi.saveDelta;const calls:any[]=[];
 projectsApi.saveDelta=async(_id,body)=>{calls.push(structuredClone(body));throw new ApiError('Unavailable',500);};
 try{
  store.getState().updateDrawing('d',{title:'First'});
  assert.equal(await store.getState().saveProject('p'),false);
  assert.equal(store.getState().saveStatuses.p.failure,'server');assert.equal(store.getState().saveStatuses.p.attempts,1);
  const remaining=store.getState().saveStatuses.p.retryAt!-Date.now();assert.ok(remaining>2900&&remaining<=3000);
  await store.getState().saveProject('p');assert.equal(calls.length,1);
  store.getState().updateDrawing('d',{title:'Second'});
  await store.getState().saveProject('p',{manual:true});assert.deepEqual(calls[0],calls[1]);assert.equal(store.getState().saveStatuses.p.attempts,2);
  const frozen=calls[0];assert.ok(frozen.saveRequestId);assert.equal(frozen.updatedDrawings[0].changes.title,'First');
  projectsApi.saveDelta=async(_id,body)=>{calls.push(structuredClone(body));return {success:true,drawings:[{...store.getState().data.projects[0].drawings[0],title:'First',rev:'r2'}]} as any;};
  assert.equal(await store.getState().saveProject('p',{manual:true}),true);
  assert.deepEqual(calls[2],frozen);assert.equal(store.getState().data.projects[0].drawings[0].title,'Second');assert.equal(store.getState().hasUnsavedChanges(),true);
  assert.equal(store.getState().saveStatuses.p.attempts,0);assert.equal(store.getState().saveStatuses.p.retryAt,undefined);
  const persisted=persistenceOptions.partialize!(store.getState());assert.ok(persisted.saveStatuses.p.lastSuccess);
 }finally{projectsApi.saveDelta=original;}
});

test('P0 permanent 413 stops manual/automatic resubmission; 401 resumes only after session verification',async()=>{
 const original=projectsApi.saveDelta,oldSession=sessionApi.status;try{
  const oversize=fixture();oversize.getState().updateDrawing('d',{title:'Big'});let calls=0;
  projectsApi.saveDelta=async()=>{calls++;throw new ApiError('too large',413);};
  await oversize.getState().saveProject('p');await oversize.getState().saveProject('p');await oversize.getState().saveProject('p',{manual:true});assert.equal(calls,1);assert.equal(oversize.getState().saveStatuses.p.retryAt,undefined);
  const login=fixture();login.getState().updateDrawing('d',{title:'Sign in'});calls=0;
  projectsApi.saveDelta=async()=>{calls++;throw new ApiError('expired',401);};await login.getState().saveProject('p');await login.getState().saveProject('p',{manual:true});assert.equal(calls,1);
  sessionApi.status=async()=>login.getState().session!;await login.getState().refreshSession();
  await login.getState().saveProject('p');assert.equal(calls,2);
 }finally{projectsApi.saveDelta=original;sessionApi.status=oldSession;}
});

test('P0 switching is blocked on failed save and resumes after identical frozen request succeeds',async()=>{
 const store=fixture(),save=projectsApi.saveDelta,load=projectsApi.loadProject;
 projectsApi.saveDelta=async()=>{throw new ApiError('offline',500);};
 try{
  store.getState().updateDrawing('d',{title:'Retain while switching'});
  await assert.rejects(store.getState().loadProject('q'),/Switch blocked/);
  assert.equal(store.getState().activeProjectId,'p');assert.equal(store.getState().hasUnsavedChanges(),true);
  const held=persistenceOptions.partialize!(store.getState());assert.equal(held.data.projects[0].drawings[0].title,'Retain while switching');assert.ok(held.pendingSaves.p);
  projectsApi.saveDelta=async()=>({success:true,drawings:[store.getState().data.projects[0].drawings[0]]} as any);
  projectsApi.loadProject=async(project)=>project;
  await store.getState().loadProject('q');assert.equal(store.getState().activeProjectId,'q');assert.equal(store.getState().hasUnsavedChanges(),false);
 }finally{projectsApi.saveDelta=save;projectsApi.loadProject=load;}
});

test('P0 persisted interrupted save restores the identical request and serializes in-flight callers',async()=>{
 const store=fixture(),save=projectsApi.saveDelta;let release!:(value:any)=>void,calls=0;
 projectsApi.saveDelta=async()=>{calls++;return new Promise(resolve=>{release=resolve;});};
 try{
  store.getState().updateDrawing('d',{title:'Interrupted request'});
  const first=store.getState().saveProject('p'),second=store.getState().saveProject('p');
  await Promise.resolve();await Promise.resolve();assert.equal(calls,1);
  const persisted=persistenceOptions.partialize!(store.getState());assert.equal(persisted.saveStatuses.p.phase,'failed');
  const body=structuredClone(persisted.pendingSaves.p.payload);
  release({success:true,drawings:[store.getState().data.projects[0].drawings[0]]});await Promise.all([first,second]);
  const restarted=fixture();restarted.setState(persistenceOptions.merge!(JSON.parse(JSON.stringify(persisted)),restarted.getState()));
  let replay:any;projectsApi.saveDelta=async(_id,request)=>{replay=request;return {success:true,drawings:[restarted.getState().data.projects[0].drawings[0]]} as any;};
  assert.equal(await restarted.getState().saveProject('p',{manual:true}),true);assert.deepEqual(replay,body);assert.equal(restarted.getState().hasUnsavedChanges(),false);
 }finally{projectsApi.saveDelta=save;}
});
