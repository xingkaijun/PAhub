import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData } from '../src/pcf-storage.ts';
import { blankContent } from '../src/pcf-model.ts';

const content = (text: string) => ({ ...blankContent(), text, html: '<b>' + text + '</b>' });
function offline(html: string) {
  const errors: any[] = [], virtualConsole = new VirtualConsole();virtualConsole.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(html, { url: 'file:///PCF.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, beforeParse(w) {
    (w as any).structuredClone = structuredClone; (w as any).Blob = Blob;
    (w as any).ResizeObserver = class { observe() {} disconnect() {} };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(value) { this.textContent = value; } });
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  } });
  return { dom, w: dom.window, errors };
}

test('Builder export/offline save and authenticated three-way import through ops, SSE, PAPC and history', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-exchange-'));
  const old = Object.fromEntries(['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT:'0',PAHUB_DATA_DIR:temp,PAPC_DB_PATH:path.join(temp,'papc.db'),API_TOKEN:'phase4-secret',ADMIN_PASSWORD:'phase4-admin' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined; const abort = new AbortController();
  try {
    hub = await createHub();hub.db.exec(await readFile(path.join(ROOT_DIR,'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
    let origin = 'http://127.0.0.1:' + hub.port; const endpoint = '/api/pcf/proj-test-001/dwg-005/';
    const api = async (tail: string, body?: any, auth = true) => {
      const response = await fetch(origin+endpoint+tail,{ method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer phase4-secret'}:{})},body:body?JSON.stringify({clientId:'reviewer',clientName:'Owner reviewer',...body}):undefined });
      return { status:response.status,value:await response.json() as any };
    };
    assert.equal((await api('create',{})).status,200);
    let live = (await api('data')).value;
    const ops = async (operations: any[]) => { const result=await api('ops',{baseRev:live.rev,batchId:randomUUID(),ops:operations});assert.equal(result.status,200);assert.deepEqual(result.value.conflicts,[]);live=result.value;return result.value; };
    await ops([1,2,3,4].map(i=>({type:'comment.add',id:'c'+i,roundIdNew:'r'+i})));
    await ops([1,2,3,4].map(i=>({type:'content.set',commentId:'c'+i,roundId:'r'+i,side:'owner',baseRev:0,value:content('OWNER_SENTINEL_'+i)})));
    await ops([{type:'project.set',field:'folder',baseRev:0,value:'http://internal-owner-server/private-folder'}]);
    assert.equal((await api('exports',{},false)).status,401);assert.equal((await api('imports',{step:'preview',html:''},false)).status,401);
    const record=(await api('exports',{})).value;
    assert.match(record.filename,/^DW-E-005_B_PCF_\d{4}-\d{2}-\d{2}\.html$/);
    const download=await fetch(origin+endpoint+'exports/'+record.exportId+'/download',{headers:{Authorization:'Bearer phase4-secret'}});
    assert.equal(download.status,200);const exported=await download.text(), data=parseHTML(exported);
    assert.match(data.export.ownerHmac,/^[a-f0-9]{64}$/);assert.equal(data.export.baseRev,live.rev);
    assert.equal(data.hub,undefined);assert.deepEqual(data.deleted,[]);assert.equal(data.project.folder,'');
    assert.doesNotMatch(exported,/phase4-secret|phase4-admin|internal-owner-server|X-PCF-Token|pahub-context|apiBase|clientId|\/api\//);
    const browser=offline(exported);let returnedHTML='';
    try {
      assert.deepEqual(browser.errors,[]);assert.match(browser.w.document.querySelector('#builder-notice')!.textContent!,/save this HTML file and return/);
      for(const selector of ['.editor[data-side="owner"]','.page-field','.tag-toggle','.person-input','.pcf-date','#panel-lock','#add-btn']){
        const element:any=browser.w.document.querySelector(selector);assert.ok(element);assert.ok(element.disabled||element.getAttribute('contenteditable')==='false');
      }
      for(const code of ["state.comments[0].rounds[0].owner.text='BAD'","state.comments[0].tags.push('BAD')","state.comments.push({})","state.comments.length=0","state.comments[0].tags.length=7","state.project.planNo='BAD'","state.export.mode='owner'","state.comments[0].status='closed'","state.roundRegister[0].replyDate='2000-01-01'","Object.defineProperty(state.comments[0],'page',{value:'BAD'})"]){assert.throws(()=>browser.w.eval("'use strict';"+code),/read only|not extensible|Cannot|redefine/i);}
      browser.w.eval('addComment();setCommentStatus(state.comments[0],"closed");');assert.equal(browser.w.eval('state.comments.length'),4);assert.equal(browser.w.eval('state.comments[0].status'),'open');
      const owner=browser.w.document.querySelector<HTMLElement>('.editor[data-side="owner"]')!;owner.setAttribute('contenteditable','true');owner.textContent='CONSOLE_BYPASS';owner.dispatchEvent(new browser.w.Event('input',{bubbles:true}));
      assert.equal(browser.w.eval('state.comments[0].rounds[0].owner.text'),'OWNER_SENTINEL_1');
      for(const [id,text]of [['r1','Builder first reply'],['r2','Builder second reply']]){const editor=browser.w.document.querySelector<HTMLElement>('.editor[data-rid="'+id+'"][data-side="reply"]')!;editor.textContent=text;editor.dispatchEvent(new browser.w.Event('input',{bubbles:true}));}
      // Exercise the v1.9 Save-as picker and actual HTML stream write, not a fabricated return JSON.
      const fileState={size:0,lastModified:0};(browser.w as any).showOpenFilePicker=async()=>[];
      (browser.w as any).showSaveFilePicker=async()=>({name:record.filename,queryPermission:async()=>'granted',getFile:async()=>fileState,createWritable:async()=>({write:async(blob:Blob)=>{returnedHTML=await blob.text();},close:async()=>{fileState.size=returnedHTML.length;fileState.lastModified++;}})});
      (browser.w as any).showOpenFilePicker=async()=>[];await new Promise(r=>setTimeout(r,0));await browser.w.eval('saveNew()');assert.ok(returnedHTML);assert.deepEqual(browser.errors,[]);
      assert.equal(parseHTML(returnedHTML).comments[0].rounds[0].reply.text,'Builder first reply');
      assert.equal(parseHTML(returnedHTML).export.ownerHmac,data.export.ownerHmac);
    }finally{browser.dom.window.close();}
    assert.equal((await api('imports',{step:'preview',html:returnedHTML})).value.ownerTampered,false);
    console.log('Export: no credentials/internal URL/client history; immutable Owner/properties/register/IDs; HMAC present. jsdom Builder: two replies + v1.9 Save-as HTML stream OK');
    await ops([{type:'content.set',commentId:'c2',roundId:'r2',side:'reply',baseRev:0,value:content('Server competing reply')},{type:'comment.add',id:'c5',roundIdNew:'r5'}]);
    await ops([{type:'record.delete',commentId:'c3',deleteId:'t3',baseRev:live.data.hub.entities['comment:c3:record'].rev},{type:'record.delete',commentId:'c4',deleteId:'t4',baseRev:live.data.hub.entities['comment:c4:record'].rev}]);
    const returned=parseHTML(returnedHTML);returned.comments[0].rounds[0].owner.text='TAMPERED_OWNER';returned.comments[2].rounds[0].reply=content('Builder reply to deleted comment');returnedHTML=replaceData(returnedHTML,returned);
    const preview=(await api('imports',{step:'preview',html:returnedHTML})).value;
    assert.equal(preview.ownerTampered,true);assert.ok(preview.ignored.some((x:any)=>x.path.includes('owner.text')));
    assert.deepEqual(preview.automatic.map((x:any)=>x.id),['r1:body']);assert.deepEqual(preview.conflicts.map((x:any)=>x.id),['r2:body','r3:deleted']);
    const beforeApply=live.rev,body={step:'apply',clientId:'import-reviewer',html:returnedHTML,previewToken:preview.previewToken,batchId:randomUUID(),choices:{'r2:body':{choice:'builder'},'r3:deleted':{choice:'server'}},ignoreOwner:true,adminPassword:'phase4-admin'};
    assert.equal((await api('imports',{...body,ignoreOwner:false})).status,409);assert.equal((await api('imports',{...body,adminPassword:'wrong'})).status,403);
    const eventResponse=await fetch(origin+endpoint+'events?clientId=observer',{headers:{Authorization:'Bearer phase4-secret'},signal:abort.signal});assert.equal(eventResponse.status,200);
    const reader=eventResponse.body!.getReader(), decoder=new TextDecoder();let events='';
    assert.equal((await api('imports',{...body,batchId:randomUUID(),choices:{...body.choices,'r3:deleted':{choice:'builder'}}})).status,409);
    const applied=await api('imports',body);assert.equal(applied.status,200);assert.equal(applied.value.rev,beforeApply+1);assert.deepEqual(applied.value.conflicts,[]);
    const timeout=setTimeout(()=>abort.abort(),4000);try{while(!events.includes('event: changed')){events+=decoder.decode((await reader.read()).value);}}finally{clearTimeout(timeout);abort.abort();}
    assert.match(events,/Builder import/);assert.ok(events.includes(record.exportId));assert.match(events,/round:r1:reply/);
    live=applied.value;assert.equal(live.data.comments.length,3);assert.ok(live.data.comments.some((x:any)=>x.id==='c5'));assert.ok(!live.data.comments.some((x:any)=>x.id==='c3'));assert.ok(!live.data.comments.some((x:any)=>x.id==='c4'));
    assert.equal(live.data.comments[0].rounds[0].owner.text,'OWNER_SENTINEL_1');assert.equal(live.data.comments[0].rounds[0].reply.text,'Builder first reply');
    const sql=hub.db.prepare('SELECT manual_comments_count,manual_open_comments_count,current_round FROM drawings WHERE id=?').get('dwg-005')!;
    assert.equal(sql.manual_comments_count,3);assert.equal(sql.manual_open_comments_count,3);assert.equal(sql.current_round,'B');
    assert.equal((await api('exports')).value[0].status,'imported');
    const history=(await api('history')).value;assert.ok(history.some((x:any)=>x.rev===beforeApply));
    const replay=await api('imports',body);assert.deepEqual(replay,applied);assert.equal((await api('data')).value.rev,live.rev);
    const repeated=(await api('imports',{step:'preview',html:returnedHTML})).value;assert.equal(repeated.repeated,true);
    assert.equal((await api('imports',{...body,batchId:randomUUID(),previewToken:repeated.previewToken,choices:{}})).status,409);
    const mismatched=structuredClone(returned);mismatched.documentId=randomUUID();assert.equal((await api('imports',{step:'preview',html:replaceData(returnedHTML,mismatched)})).status,409);
    mismatched.documentId=returned.documentId;mismatched.export.exportId=randomUUID();assert.equal((await api('imports',{step:'preview',html:replaceData(returnedHTML,mismatched)})).status,409);
    const overwritten=await api('imports',{...body,batchId:randomUUID(),previewToken:repeated.previewToken,choices:{'r3:deleted':{choice:'server'}},overwrite:true});assert.equal(overwritten.status,200);assert.equal(overwritten.value.rev,live.rev);assert.deepEqual(overwritten.value.applied,[]);
    const restored=await api('history/'+beforeApply+'/restore',{baseRev:live.rev});assert.equal(restored.status,200);assert.equal(restored.value.data.comments.find((x:any)=>x.id==='c1').rounds[0].reply.text,'');
    // Bodies and attachments must never enter SQLite, including the new exports table.
    for(const row of hub.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())for(const value of hub.db.prepare('SELECT * FROM "'+row.name+'"').all())assert.doesNotMatch(JSON.stringify(value),/OWNER_SENTINEL|Builder first reply|Builder second reply|TAMPERED_OWNER/);
    await hub.close();hub=await createHub();origin='http://127.0.0.1:'+hub.port;
    assert.deepEqual(await api('imports',body),applied);assert.equal((await api('imports',{step:'preview',html:returnedHTML})).value.ownerTampered,true);
    assert.equal((await api('exports/'+record.exportId+'/void',{})).status,200);assert.equal((await api('imports',{step:'preview',html:returnedHTML})).status,409);
    console.log('Three-way: ship-only automatic; same reply conflict; server addition retained; deleted+reply conflict/restored; silent deleted ignored; tampered Owner ignored with admin confirmation');
    console.log('Apply: rev +1; real SSE changed; PAPC 4/4 round B; history restore; exact batch replay before/after restart; documentId/exportId/void rejected; SQLite body sentinel absent');
    console.log('Exchange test data: '+temp);
  } finally { abort.abort();await hub?.close();for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v; }
});

test('upgrade CLI: dry-run untouched; backup+atomic replacement; deep JSON equality; page loads', async () => {
  const temp=await mkdtemp(path.join(tmpdir(),'pahub-upgrade-'));const dir=path.join(temp,'pcf','project-x');
  const { mkdir }=await import('node:fs/promises');await mkdir(dir,{recursive:true});
  const template=await readFile(path.join(ROOT_DIR,'pcf/template/PG-PCF-hub.html'),'utf8'), data=parseHTML(template);
  data.hub={rev:9,entities:{example:{rev:8}},receipts:[{id:'keep-me',result:{rev:9}}],custom:'keep-hub'};data.custom={preserve:['all','data']};
  const original=replaceData(template.replace('<meta name="pahub-template-version" content="6">','<meta name="pahub-template-version" content="5">'),data), file=path.join(dir,'drawing-y.html');await writeFile(file,original,'utf8');
  const run=(flags:string[])=>execFileSync(process.execPath,['hub-server/scripts/upgrade-pcf.mjs',...flags],{cwd:ROOT_DIR,env:{...process.env,PAHUB_DATA_DIR:temp},encoding:'utf8'});
  const report=JSON.parse(run(['--dry-run','--project','project-x','--drawing','drawing-y']));assert.equal(report.report[0].status,'would-upgrade');assert.equal(await readFile(file,'utf8'),original);assert.deepEqual(await readdir(dir),['drawing-y.html']);
  const upgraded=JSON.parse(run(['--project','project-x','--drawing','drawing-y']));assert.equal(upgraded.report[0].status,'upgraded');assert.equal(await readFile(upgraded.report[0].backup,'utf8'),original);
  const final=await readFile(file,'utf8');data.hub.tombstones=[];assert.deepEqual(parseHTML(final),data);assert.match(final,/pahub-template-version" content="6/);assert.ok(!(await readdir(dir)).some(x=>x.endsWith('.tmp')));
  const browser=offline(final);try{assert.deepEqual(browser.errors,[]);assert.equal(browser.w.document.querySelector('#save-btn')!.textContent,'Save');}finally{browser.dom.window.close();}
  assert.equal(JSON.parse(run([])).report[0].status,'current');
  console.log('Upgrade CLI: dry-run byte-identical/no backup; real backup byte-identical; JSON deep-equal (documentId/hub/receipts/custom); atomic temp cleared; jsdom page loaded; rerun=current');
  console.log('Upgrade test data: '+temp);
});
