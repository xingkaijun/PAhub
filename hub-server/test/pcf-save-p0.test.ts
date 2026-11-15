import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {KJX_SAVE_STATUS} from '../src/pcf-save-status.ts';

test('P0 hosted PCF member rejection deletes IndexedDB batch and permanently stops blind retry',async()=>{
 const dom=new JSDOM('<body></body>',{url:'http://hub.test/pcf/p/d',runScripts:'outside-only'});const w=dom.window as any;
 let calls=0;const database=new IDBFactory();w.indexedDB=database;w.Response=Response;w.structuredClone=structuredClone;w.AbortController=AbortController;
 w.fetch=async()=>{calls++;return Response.json({ok:false,error:'forbidden',capability:'project.member'},{status:403});};
 w.eval(`window.PAHUB={mode:'kjx',user:{id:'owner'}};var state={documentId:'doc',comments:[]},hubBase=structuredClone(state),hubQueue=[{body:{ops:[{type:'comment.add'}]}}],hubDirty=new Set(['x']),hubBlocked=false,hubConflictItems=[],savedRevision=0,editRevision=1,writeBusy=false,hubRecovery=Promise.resolve();
 function hubURL(tail){return 'http://hub.test/api/pcf/p/d/'+tail;}function hubOps(){return hubDirty.size?[{type:'comment.add'}]:[];}function render(){}function dirty(){return editRevision!==savedRevision;}function touch(){hubDirty.add('x');editRevision++;}
 async function hubDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open('pahub-pcf-offline',1);request.onupgradeneeded=()=>request.result.createObjectStore('documents');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
 async function hubPersist(){}async function hubSave(){writeBusy=true;try{const r=await window.fetch(hubURL('ops'),{method:'POST'});if(!r.ok)throw Error('403');}catch{}finally{writeBusy=false;}}
 `);
 try{
  const db=await w.eval('hubDB()');await new Promise<void>((resolve,reject)=>{const tx=db.transaction('documents','readwrite');tx.objectStore('documents').put({queue:[{batchId:'old'}]},'doc');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  w.eval(KJX_SAVE_STATUS.replace(/^<script[^>]*>|<\/script>$/g,''));w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await w.eval('hubSave(false)');assert.equal(calls,1);assert.equal(w.eval('hubQueue.length'),0);assert.equal(w.eval('hubDirty.size'),0);
  const result=await new Promise(resolve=>{const r=db.transaction('documents').objectStore('documents').get('doc');r.onsuccess=()=>resolve(r.result);});assert.equal(result,undefined);
  assert.equal(w.localStorage.getItem('pahub.rejected-save:doc'),'rejected');assert.match(w.document.getElementById('pahub-save-status').textContent,/No permission/);
  await w.eval('hubSave(true)');assert.equal(calls,1);
  assert.equal(w.pahubPendingIsRejected('another-document'),true,'project marker refuses recovery of older queues even without a registry entry');
 }finally{w.dispatchEvent(new w.Event('pagehide'));dom.window.close();}
});
