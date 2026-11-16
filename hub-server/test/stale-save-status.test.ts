import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const outfile=path.resolve('hub-server/dist/stale-save-status-components.mjs');
await build({stdin:{contents:`export {useStore} from './store'; export {persistenceOptions} from './store/persistence'; export {SaveStatusBar} from './components/SaveStatusBar'; export {projectsApi} from './services/api/projectsApi'; export {ApiError} from './services/api/apiClient'; export {createElement} from 'react'; export {renderToStaticMarkup} from 'react-dom/server';`,resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':JSON.stringify({MODE:'hub',VITE_DATA_API_BASE_URL:'/api'})}});
const ui=await import(pathToFileURL(outfile).href);
function reset(){
 const store=ui.useStore;
 store.setState({activeProjectId:'p',session:{mode:'kjx',admin:true,user:{id:'admin',role:'admin'},permissions:['drawing.update','project.settings']},saveStatuses:{},pendingSaves:{},trackerWrites:{},_dirtyDrawingIds:new Set(),_deletedDrawingIds:new Set(),_dirtyDrawingFields:{},_dirtyDrawingBase:{},_dirtyConf:false,_dirtyConfKeys:new Set(),_dirtyConfBase:{},_dirtyTracker:false,_dirtyTrackerDrawingIds:new Set(),reviewTracker:{},data:{...store.getState().data,projects:[{id:'p',name:'Project',conf:store.getState().data.settings,drawings:[{id:'d',title:'Original',rev:'r1',discipline:'Hull',assignees:[],remarks:[],statusHistory:[],status:'Reviewing'}]}]}});
 return store;
}
const failed=(failure:string)=>({phase:'failed',failure,reason:'Old failure',attempts:1,lastSuccess:123});
const render=()=>{Object.assign(ui.useStore.getInitialState(),ui.useStore.getState());return ui.renderToStaticMarkup(ui.createElement(ui.SaveStatusBar));};

test('version-2 hydration and future persistence drop terminal errors, retaining recovery and retry state',()=>{
 const store=reset();store.getState().updateDrawing('d',{title:'Retained edit'});
 const statuses:Record<string,any>=Object.fromEntries(['forbidden','login','oversize','invalid','network','timeout','server','conflict'].map(failure=>[failure,failed(failure)]));
 statuses.saved={phase:'saved',lastSuccess:123,attempts:0};
 statuses.saving={phase:'saving',attempts:1};
 statuses.unconfirmed={phase:'unconfirmed',failure:'network',attempts:1,retryAt:456};
 store.setState({saveStatuses:statuses,pendingSaves:{p:{project:store.getState().data.projects[0],payload:{saveRequestId:'keep-receipt'},actorId:'admin'}}});
 const persisted=ui.persistenceOptions.partialize(store.getState());
 for(const key of ['forbidden','login','oversize','invalid'])assert.equal(persisted.saveStatuses[key],undefined);
 assert.equal(persisted.saveStatuses.saving.failure,'network');
 const restored=ui.persistenceOptions.merge({...persisted,saveStatuses:statuses},store.getState());
 for(const key of ['forbidden','login','oversize','invalid'])assert.equal(restored.saveStatuses[key],undefined);
 for(const key of ['network','timeout','server','conflict','saved','unconfirmed'])assert.deepEqual(restored.saveStatuses[key],statuses[key]);
 assert.equal(restored.pendingSaves.p.payload.saveRequestId,'keep-receipt');
 assert.equal(restored._dirtyDrawingIds.has('d'),true);
 assert.equal(restored.data.projects[0].drawings[0].title,'Retained edit');
});

test('clean save clears stale failure without sending a request or inventing a success timestamp',async()=>{
 const store=reset(),original=ui.projectsApi.saveDelta;let calls=0;ui.projectsApi.saveDelta=async()=>{calls++;throw Error('unexpected save');};
 try{for(const failure of ['forbidden','login','oversize','invalid']){
  store.setState({saveStatuses:{p:failed(failure)}});
  assert.equal(await store.getState().saveProject('p',{manual:true}),true);
  assert.deepEqual(store.getState().saveStatuses.p,{phase:'saved',attempts:0,lastSuccess:123});
 }assert.equal(calls,0);}finally{ui.projectsApi.saveDelta=original;}
});

test('clean status bar hides stale error/retry but dirty or unconfirmed recovery remains visible',()=>{
 const store=reset();
 for(const failure of ['forbidden','login','oversize','invalid','network']){
  store.setState({saveStatuses:{p:failed(failure)}});const html=render();
  assert.doesNotMatch(html,/Save failed|Retry now|Sign in \/ check session/);assert.match(html,/Saved/);
 }
 store.getState().updateDrawing('d',{title:'Pending'});assert.match(render(),/Save failed/);
 store.setState({_dirtyDrawingIds:new Set(),saveStatuses:{p:{phase:'unconfirmed',failure:'network',reason:'Read-back pending',attempts:1}},pendingSaves:{p:{}}});
 assert.match(render(),/Awaiting confirmation/);
});

test('real HTTP 403 still rolls back edits; clean bar is quiet and later edits can save',async()=>{
 const store=reset(),original=ui.projectsApi.saveDelta;let calls=0;
 ui.projectsApi.saveDelta=async()=>{calls++;throw new ui.ApiError('No permission',403);};
 try{
  store.getState().updateDrawing('d',{title:'Rejected edit'});
  assert.equal(await store.getState().saveProject('p'),false);
  assert.equal(calls,1);assert.equal(store.getState().saveStatuses.p.failure,'forbidden');
  assert.equal(store.getState().hasUnsavedChanges(),false);
  assert.equal(store.getState().pendingSaves.p,undefined);
  assert.equal(store.getState().data.projects[0].drawings[0].title,'Original');
  assert.doesNotMatch(render(),/Save failed|Retry now/);
  ui.projectsApi.saveDelta=async()=>{calls++;return {success:true,drawings:store.getState().data.projects[0].drawings};};
  store.getState().updateDrawing('d',{title:'New authorized edit'});
  assert.equal(await store.getState().saveProject('p'),true);assert.equal(calls,2);
 }finally{ui.projectsApi.saveDelta=original;}
});
