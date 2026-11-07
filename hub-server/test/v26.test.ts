import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData } from '../src/pcf-storage.ts';
import { upgradeFile } from '../src/pcf-template.ts';
import { externalData, standaloneHTML } from '../src/pcf-exchange.ts';
import * as model from '../src/pcf-model.ts';
const source=readFileSync(path.join(ROOT_DIR,'pcf/template/PG-PCF-v2.6-source.html'),'utf8');
const template=readFileSync(path.join(ROOT_DIR,'pcf/template/PG-PCF-hub.html'),'utf8');
const plain=(v:any)=>JSON.parse(JSON.stringify(v));
function browser(html:string,context?:any,fetchMock?:any){
  const errors:any[]=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
  const dom=new JSDOM(html,{url:'http://pcf.test/pcf/proj-test-001/dwg-005',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    (w as any).structuredClone=structuredClone;Object.defineProperty(w.crypto,'randomUUID',{value:randomUUID});
    (w as any).ResizeObserver=class{observe(){}disconnect(){}};w.HTMLElement.prototype.scrollIntoView=()=>{};
    Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;},set(v){this.textContent=v;}});
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
    if(context)(w as any).PAHUB=context;if(fetchMock)w.fetch=fetchMock;
  }});return {dom,w:dom.window,errors};
}
const normalize=(v:any)=>JSON.parse(JSON.stringify(v,(k,x)=>['id','at'].includes(k)?'<generated>':x));
const round=(id:string,n:number)=>({id,number:n,initiator:'Owner',responder:'Builder',owner:model.blankContent(),reply:model.blankContent(),minHeight:0,createdAt:'2026-01-01',updatedAt:'2026-01-01'});
function fixture(){const d=parseHTML(template);d.comments=[{id:'c1',number:1,status:'open',page:'',tags:[],createdAt:'2026-01-01',updatedAt:'2026-01-01',rounds:[round('r1',1)]},{id:'c2',number:2,status:'open',page:'',tags:[],createdAt:'2026-01-01',updatedAt:'2026-01-01',rounds:[round('r2',3)]}];d.project.currentRound=3;d.nextCommentNumber=3;d.approvalControl.lastOpen=2;d.hub={rev:1,entities:{},tombstones:[]};return model.initData(d);}
test('v2.6 immutable source and jsdom/server business-function parity',()=>{
  assert.equal(createHash('sha256').update(source).digest('hex'),'4b195e7adfedcf7fb699a77ba389f8d65fa2d8d222d8cbdf8a66009b05d994be');
  const b=browser(source);try{
    for(const scenario of ['open','closed','empty','history']){
      const d=fixture();if(scenario==='closed')d.comments.forEach((c:any)=>c.status='closed');if(scenario==='empty')d.comments=[];
      if(scenario==='history'){d.roundRegister.push({id:'dated',round:5,ownerDate:'2026-01-01'});d.roundRegister.push({id:'empty',round:8});d.circulation.push({id:'audit',round:6,note:'keep'});d.project.currentRound=8;}
      (b.w as any).input=structuredClone(d);b.w.eval("Object.assign(state,input)");
      assert.equal(b.w.eval('countOpen(input)'),model.countOpen(d));
      const s=structuredClone(d);model.reconcileApproval(s);b.w.eval('reconcileApproval()');assert.deepEqual(normalize((b.w as any).input),normalize(s));
      assert.deepEqual(plain(b.w.eval('roundCleanupPlan(input,input.comments)')),model.roundCleanupPlan(s,s.comments));
      const server=structuredClone(d);const cleanup=model.cleanupLegacyImport(server);(b.w as any).input=structuredClone(d);
      assert.deepEqual(plain(b.w.eval('cleanupLegacyImport(input)')),cleanup);assert.deepEqual(plain((b.w as any).input),server);
      model.pruneRounds(server,1);b.w.eval('pruneRounds(input,1)');assert.deepEqual(plain((b.w as any).input),server);
      b.w.eval('Object.assign(state,input);renumberComments()');assert.equal(b.w.eval('state.nextCommentNumber'),model.nextCommentNumber(server));
    }
    for(const font of plain(b.w.eval('FONT_OPTIONS'))){
      (b.w as any).rawFont="<span style='font-family:"+font.stack+";color:#ff0000;font-weight:bold;font-style:italic;text-decoration:underline'>Font</span>";
      const sanitized=b.w.eval('sanitize(rawFont)');(b.w as any).serverFont=model.cleanContent({text:'Font',html:sanitized,fill:'',images:[]}).html;
      assert.equal(b.w.eval('sanitize(serverFont)'),sanitized,'server retains v2.6 font '+font.label);
    }assert.deepEqual(b.errors,[]);
  }finally{b.w.close();}
});
test('v5 without PAHUB matches v2.6 connect, auto-save, JSON apply/export and local write behavior',async()=>{
  const results:any[]=[];
  for(const html of [source,template]){
    const b=browser(html);try{
      await new Promise(r=>setTimeout(r,0));let writes=0,opens=0,permission=0,saved='',stamp=1;
      const handle={name:'PCF.html',queryPermission:async()=>{permission++;return 'granted';},requestPermission:async()=>{permission++;return 'granted';},getFile:async()=>({lastModified:stamp,size:saved.length,text:async()=>saved||html}),createWritable:async()=>({write:async(blob:any)=>{writes++;saved=await new Promise<string>(resolve=>{const reader=new b.w.FileReader();reader.onload=()=>resolve(String(reader.result));reader.readAsText(blob);});stamp++;},close:async()=>{}})};
      (b.w as any).showOpenFilePicker=async()=>{opens++;return [handle];};(b.w as any).showSaveFilePicker=async()=>handle;
      b.w.eval('addComment()');await b.w.eval('saveNew()');assert.equal(writes,1);
      b.w.eval('fileHandle=null;rememberedHandle=null;autoPaused=true');await b.w.eval('connectExisting()');await b.w.eval('modalAction()');assert.equal(writes,1);assert.equal(opens,1);
      let auto:any;(b.w as any).setInterval=(f:any)=>{auto=f;return 123;};b.w.eval('state.comments[0].page="auto";touch(state.comments[0]);restartAutoSave()');await auto();await new Promise(r=>setTimeout(r,50));assert.equal(writes,2);
      const data=plain(b.w.eval('state'));delete data.hub;(b.w as any).incoming=data;
      b.w.eval('validateJSON(incoming);cleanupLegacyImport(incoming);applyJSON(incoming,"copy.json")');assert.equal(b.w.eval('autoPaused'),true);assert.equal(b.w.eval('fileHandle'),null);
      b.w.eval('download=(blob,name)=>{window.jsonBlob=blob;window.jsonName=name};exportJSON()');
      const jsonText=await new Promise<string>(resolve=>{const reader=new b.w.FileReader();reader.onload=()=>resolve(String(reader.result));reader.readAsText((b.w as any).jsonBlob);});
      const json=JSON.parse(jsonText);assert.equal(json.comments[0].page,'auto');assert.equal(json.hub,undefined);assert.equal(json.schemaVersion,'1.0');
      results.push({jsonExport:{comments:json.comments.length,page:json.comments[0].page,settings:json.settings,name:(b.w as any).jsonName},writes,opens,permission,comments:parseHTML(saved).comments.length,page:parseHTML(saved).comments[0].page,stats:plain(b.w.eval('validateJSON(state).stats')),theme:b.w.eval('state.settings.theme'),connect:b.w.document.querySelector<HTMLButtonElement>('#connect-file-btn')!.disabled});assert.deepEqual(b.errors,[]);
    }finally{b.w.close();}
  }assert.deepEqual(results[0],results[1]);
});
test('v2.6 permanent deletion cascade, offline add-round conflict, atomic add-all and history clocks',()=>{
  const d=fixture(),actor={clientId:'A',clientName:'A',ip:'local'},old=structuredClone(d);
  const plan=model.roundCleanupPlan(d,d.comments.filter((c:any)=>c.id!=='c2'));
  const cleanup={currentRound:plan.target,roundRegister:plan.affected.map((r:any)=>r.id),circulation:[],approvalHistory:[]};
  const bad=model.applyOps(structuredClone(d),[{type:'record.delete',commentId:'c2',baseRev:0,documentRev:1,cleanup:{...cleanup,currentRound:99}}],actor,2);assert.equal(bad.conflicts.length,1);assert.equal(bad.applied.length,0);
  const removed=model.applyOps(d,[{type:'record.delete',commentId:'c2',baseRev:0,documentRev:1,cleanup}],actor,2);assert.equal(removed.conflicts.length,0);d.hub.rev=2;
  assert.equal(d.project.currentRound,1);assert.deepEqual(d.deleted,[]);assert.ok(d.hub.tombstones.some((t:any)=>t.id==='c2'&&t.clock===2));
  const offline=model.applyOps(d,[{type:'round.add',commentId:'c2',id:'offline-round',number:4,baseRev:0}],{...actor,clientId:'B'},3);assert.equal(offline.conflicts.length,1);assert.equal(d.comments.length,1);
  assert.equal(model.applyOps(d,[{type:'comment.add',id:'c2',roundIdNew:'new-r'}],actor,3).conflicts.length,1);
  const makeBulk=(prefix:string)=>({type:'rounds.addAll',baseRev:0,number:4,rounds:old.comments.map((c:any)=>({commentId:c.id,id:prefix+c.id,recordRev:0}))});
  const bulk=model.applyOps(old,[makeBulk('a-')],actor,2);assert.equal(bulk.conflicts.length,0);
  const other=model.applyOps(old,[makeBulk('b-')],{...actor,clientId:'B'},3);assert.equal(other.conflicts.length,1);assert.ok(old.comments.every((c:any)=>c.rounds.filter((r:any)=>r.number===4).length===1));
  const op={type:'history.set',field:'circulation',baseRev:0,value:[{id:'event',round:4,kind:'round-registration',date:'2026-01-01'}]};assert.equal(model.applyOps(old,[op],actor,3).conflicts.length,0);assert.equal(model.applyOps(old,[op],actor,4).conflicts.length,1);
  const approval={type:'history.set',field:'approvalHistory',baseRev:model.entity(old,'history:approvalHistory').rev,value:[{id:'approval-event',round:4,at:'2026-01-01',from:'Not submitted',to:'Under review',source:'auto',reason:'review'}],approval:'Under review',control:{source:'auto',lastOpen:2,reason:'review'}};
  assert.equal(model.applyOps(old,[approval],actor,5).conflicts.length,0);assert.equal(model.applyOps(old,[approval],{...actor,clientId:'B'},6).conflicts.length,1);
});
test('v4 upgrade cleans legacy deleted and empty high rounds without losing dated history, images or receipts',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'pahub-v26-upgrade-')),file=path.join(temp,'old.html'),d=fixture();
  d.comments[0].rounds[0].owner.images=[{id:'img',name:'x.png',mime:'image/png',data:'data:image/png;base64,AA==',width:1,height:1}];
  d.deleted=[{id:'deleted-old',type:'comment',deletedAt:'2026-01-01',parentNumber:3,data:{id:'lost',rounds:[round('lost-r',7)]}}];
  d.roundRegister.push({id:'date-5',round:5,ownerDate:'2026-01-01'},{id:'empty-8',round:8});d.circulation=[{id:'audit-6',round:6,date:'2026-01-01'}];d.project.currentRound=8;d.hub.receipts=[{batchId:'unchanged',result:{rev:1}}];
  const original=replaceData(template.replace('pahub-template-version" content="5','pahub-template-version" content="4'),d);await writeFile(file,original,'utf8');
  const dry=upgradeFile(file,true);assert.equal(dry.status,'would-upgrade');assert.equal(dry.deletedToClean,1);assert.equal(dry.emptyRoundsToPrune,1);assert.equal(await readFile(file,'utf8'),original);
  const report=upgradeFile(file),up=parseHTML(await readFile(file,'utf8'));assert.equal(await readFile(report.backup!,'utf8'),original);
  assert.equal(up.documentId,d.documentId);assert.deepEqual(up.comments,d.comments);assert.deepEqual(up.hub.receipts,d.hub.receipts);assert.equal(up.project.currentRound,6);assert.ok(up.roundRegister.some((r:any)=>r.id==='date-5'));assert.deepEqual(up.circulation,d.circulation);assert.deepEqual(up.deleted,[]);assert.ok(up.hub.tombstones.some((t:any)=>t.id==='lost-r'));
});
test('v5 builder new fields are non-writable and all downloaded data/context is stripped',()=>{
  const d=fixture();d.hub.credential='SECRET';d.hub.tombstones=[{id:'hidden',clock:1}];d.project.folder='PRIVATE';
  const external=externalData(d);external.export={mode:'builder',round:3,exportId:randomUUID()};
  const html=standaloneHTML(external),b=browser(html);try{
    assert.doesNotMatch(html,/pahub-context|X-PCF-Token|SECRET|PRIVATE|PAhub adapter:/);assert.equal(parseHTML(html).hub,undefined);assert.deepEqual(parseHTML(html).deleted,[]);
    for(const code of ['state.roundRegister[0].ownerDate="BAD"','state.approvalHistory.push({})','state.roundRegister.push({})'])assert.throws(()=>b.w.eval('"use strict";'+code));
    assert.equal(b.w.document.querySelector<HTMLButtonElement>('#import-json-btn')!.disabled,true);assert.equal(b.w.document.querySelector<HTMLButtonElement>('#bulk-round-btn')!.disabled,true);assert.equal(b.w.document.querySelector<HTMLButtonElement>('#export-btn')!.disabled,false);
    b.w.eval('chooseJSON();addRoundToAllOpen()');assert.deepEqual(b.errors,[]);
  }finally{b.w.close();}
});
test('hosted JSON import blocks presence, rejects stale rev, stores history and never requests file permission',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'pahub-v26-api-')),old=Object.fromEntries(['PORT','PAPC_DB_PATH','PAHUB_DATA_DIR','API_TOKEN'].map(k=>[k,process.env[k]]));Object.assign(process.env,{PORT:'0',PAPC_DB_PATH:path.join(temp,'papc.db'),PAHUB_DATA_DIR:temp,API_TOKEN:''});let hub:any;
  try{
    hub=await createHub();hub.db.sqlite.exec(await readFile(path.join(ROOT_DIR,'worker/sql/seed-test-data.sql'),'utf8'));const url='http://127.0.0.1:'+hub.port+'/api/pcf/proj-test-001/dwg-005/';
    const api=async(tail:string,method='GET',body?:any)=>{const r=await fetch(url+tail,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,value:await r.json() as any};};
    await api('create','POST',{});let doc=(await api('data')).value;
    doc=(await api('ops','POST',{clientId:'A',baseRev:doc.rev,batchId:randomUUID(),ops:[{type:'comment.add',id:'c',roundIdNew:'r'}]})).value;
    await api('presence','POST',{clientId:'B',clientName:'Builder',entity:'round:r:owner'});
    const request={clientId:'A',baseRev:doc.rev,data:externalData(doc.data),importJSON:true};assert.equal((await api('document','PUT',request)).status,409);
    await api('presence','POST',{clientId:'B',entity:null});await api('ops','POST',{clientId:'B',baseRev:doc.rev,batchId:randomUUID(),ops:[{type:'content.set',commentId:'c',roundId:'r',side:'owner',baseRev:0,value:{...model.blankContent(),text:'new'} }]});assert.equal((await api('document','PUT',request)).status,409);
    const latest=(await api('data')).value;request.baseRev=latest.rev;const result=await api('document','PUT',request);assert.equal(result.status,200);assert.ok((await api('history')).value.some((x:any)=>x.rev===latest.rev));
    let puts=0,permission=0;const b=browser(replaceData(template,result.value.data),{projectId:'proj-test-001',drawingId:'dwg-005',apiBase:'/api',rev:result.value.rev,credential:'x'},async(u:string,opt:any={})=>{if(u.endsWith('/presence'))return {ok:true,json:async()=>({online:[{clientId:'someone',entity:'round:r:owner'}]})};if(opt.method==='PUT')puts++;return {ok:true,json:async()=>result.value};});
    try{(b.w as any).showOpenFilePicker=()=>{permission++;};(b.w as any).showSaveFilePicker=()=>{permission++;};(b.w as any).incoming=externalData(result.value.data);await b.w.eval('hubImportJSON(incoming,"x.json")');b.w.eval('restoreConnection();connectExisting();rememberHandle({});');assert.equal(puts,0);assert.equal(permission,0);assert.equal(b.w.eval('autoPaused'),false);assert.match(b.w.document.querySelector('#toast')!.textContent!,/editing/i);assert.equal(b.w.document.querySelector<HTMLButtonElement>('#connect-file-btn')!.disabled,true);assert.deepEqual(b.errors,[]);}finally{b.w.close();}
  }finally{await hub?.close();for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
