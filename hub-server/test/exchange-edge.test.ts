import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData } from '../src/pcf-storage.ts';
import { blankContent } from '../src/pcf-model.ts';
import { openDatabase } from '../src/database.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { PcfExchange } from '../src/pcf-exchange.ts';
import { JSDOM, VirtualConsole } from 'jsdom';
import { refRecord, decodeDataURL } from '../src/pcf-images.ts';

test('exchange edges: whole image sets, disjoint fields, stale preview, invalid mode and JSON rendering', async () => {
  const temp=await mkdtemp(path.join(tmpdir(),'pahub-exchange-edge-'));
  const old=Object.fromEntries(['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN'].map(k=>[k,process.env[k]]));
  Object.assign(process.env,{PORT:'0',PAHUB_DATA_DIR:temp,PAPC_DB_PATH:path.join(temp,'papc.db'),API_TOKEN:''});
  const hub=await createHub();
  try {
    hub.db.exec(await readFile(path.join(ROOT_DIR,'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
    const origin='http://127.0.0.1:'+hub.port,route='/api/pcf/proj-test-001/dwg-005/';
    const api=async(tail:string,body?:any)=>{const r=await fetch(origin+route+tail,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify({clientId:'edge-reviewer',...body}):undefined});return {status:r.status,data:await r.json() as any};};
    await api('create',{});let live=(await api('data')).data;
    const ops=async(operations:any[])=>{const r=await api('ops',{baseRev:live.rev,batchId:randomUUID(),ops:operations});assert.equal(r.status,200);assert.deepEqual(r.data.conflicts,[]);live=r.data;};
    await ops([{type:'comment.add',id:'c1',roundIdNew:'r1'}]);
    const record=(await api('exports',{})).data,html=await (await fetch(origin+route+'exports/'+record.exportId+'/download')).text(),data=parseHTML(html);
    const image=(id:string)=>({id,name:id+'.png',mime:'image/png',data:'data:image/png;base64,AA==',width:1,height:1});
    const refImage=(id:string)=>refRecord(image(id),decodeDataURL(image(id).data).hash);
    data.comments[0].rounds[0].reply={...blankContent(),text:'Builder body',html:'<b>Builder body</b>',images:[image('builder-image')]};
    const returned=replaceData(html,data),first=(await api('imports',{step:'preview',html:returned})).data;
    assert.equal(first.ownerTampered,false);assert.deepEqual(first.automatic.map((x:any)=>x.field),['body','images']);
    await ops([{type:'content.set',commentId:'c1',roundId:'r1',side:'reply',baseRev:0,value:{...blankContent(),images:[image('server-image-a'),image('server-image-b')]}}]);
    const stale=await api('imports',{step:'apply',html:returned,previewToken:first.previewToken,batchId:randomUUID(),choices:{'r1:images':{choice:'server'}}});assert.equal(stale.status,409);assert.match(stale.data.error,/server changed/);
    const preview=(await api('imports',{step:'preview',html:returned})).data;
    assert.deepEqual(preview.automatic.map((x:any)=>x.field),['body']);assert.deepEqual(preview.conflicts.map((x:any)=>x.field),['images']);
    assert.equal(preview.conflicts[0].server.length,2);assert.equal(preview.conflicts[0].builder.length,1);
    const applied=await api('imports',{step:'apply',html:returned,previewToken:preview.previewToken,batchId:randomUUID(),choices:{'r1:images':{choice:'builder'}}});
    assert.equal(applied.status,200);assert.equal(applied.data.data.comments[0].rounds[0].reply.text,'Builder body');assert.deepEqual(applied.data.data.comments[0].rounds[0].reply.images,[refImage('builder-image')]); // stored as a content-addressed reference
    const invalid=structuredClone(data);invalid.export.mode='owner';assert.equal((await api('imports',{step:'preview',html:replaceData(html,invalid)})).status,409);
    const file=path.join(temp,'pcf','proj-test-001','dwg-005.json'),original=await readFile(file,'utf8');
    const page=await (await fetch(origin+'/pcf/proj-test-001/dwg-005')).text();assert.match(page,/pahub-template-version" content="6/);assert.doesNotMatch(page,/<script id="pahub-template-note-script">/);assert.equal(await readFile(file,'utf8'),original);
    console.log('Exchange edges: images compared/replaced as whole sets; Builder body + server image disjoint automatic; stale preview 409; wrong mode 409; current template renders without changing authoritative JSON');
  } finally {await hub.close();for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('later Builder exports permit unanswered historical replies, preserve completed history and import safely', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-late-replies-')), db = openDatabase(path.join(dir, 'papc.db'));
  let dom: JSDOM | undefined;
  try {
    db.exec(await readFile(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
    const p = 'proj-test-001', d = 'dwg-005', storage = new PcfStorage(db, dir), exchange = new PcfExchange(storage);
    const actor = { clientId: 'late-test', clientName: 'Reviewer', ip: '' };
    storage.create(p, d, actor);
    const ops = (items: any[]) => { const live = storage.load(p, d); return storage.ops(p, d, { baseRev: live.rev, ops: items }, actor); };
    ops(['pending','done','closed','whitespace','html-only','image-only'].map(id => ({ type: 'comment.add', id, roundIdNew: id + '-r1' })));
    const image = { id: 'old-image', name: 'old.png', mime: 'image/png', data: 'data:image/png;base64,AA==', width: 1, height: 1 };
    ops([
      { type: 'content.set', commentId: 'done', roundId: 'done-r1', side: 'reply', baseRev: 0, value: { ...blankContent(), text: 'Completed reply' } },
      { type: 'comment.status', commentId: 'closed', baseRev: 0, value: 'closed' },
      { type: 'content.set', commentId: 'whitespace', roundId: 'whitespace-r1', side: 'reply', baseRev: 0, value: { ...blankContent(), html: '<p>&nbsp;&#160;&#x200b;</p>' } },
      { type: 'content.set', commentId: 'html-only', roundId: 'html-only-r1', side: 'reply', baseRev: 0, value: { ...blankContent(), html: '<b>Reply in HTML</b>' } },
      { type: 'content.set', commentId: 'image-only', roundId: 'image-only-r1', side: 'reply', baseRev: 0, value: { ...blankContent(), images: [image] } },
      { type: 'project.set', field: 'currentRound', baseRev: 0, value: 3 },
    ]);
    ops([{ type: 'round.add', commentId: 'pending', id: 'pending-r2', number: 3 }]);
    ops([{ type: 'project.set', field: 'currentRound', baseRev: storage.load(p,d).data.hub.entities['project:currentRound'].rev, value: 4 }]);
    const record = exchange.create(p, d, actor), html = exchange.download(p, d, record.exportId).html, exported = parseHTML(html);
    assert.equal(record.round, 4); assert.deepEqual(exported.export.writableRounds, ['pending-r1','pending-r2','whitespace-r1']);
    const errors: string[] = [], vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
    dom = new JSDOM(html, { url: 'file:///late.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
      (w as any).structuredClone = structuredClone; (w as any).ResizeObserver = class { observe() {} disconnect() {} };
      Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID }); w.HTMLElement.prototype.scrollIntoView = () => {};
      Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
      w.HTMLDialogElement.prototype.showModal = function() { this.open = true; }; w.HTMLDialogElement.prototype.close = function() { this.open = false; };
    } });
    const w = dom.window;
    for (const id of exported.export.writableRounds) {
      const ed = w.document.querySelector<HTMLElement>('.editor[data-rid="'+id+'"][data-side="reply"]')!;
      assert.equal(ed.getAttribute('contenteditable'), 'true'); ed.textContent = 'Late reply '+id; ed.dispatchEvent(new w.Event('input', { bubbles: true }));
    }
    for (const id of ['done-r1','closed-r1','html-only-r1','image-only-r1']) assert.equal(w.document.querySelector('.editor[data-rid="'+id+'"][data-side="reply"]')!.getAttribute('contenteditable'), 'false');
    assert.equal(w.document.querySelector('.editor[data-side="owner"]')!.getAttribute('contenteditable'), 'false');
    assert.throws(() => w.eval('"use strict";state.export.writableRounds.push("done-r1")'));
    const savedHTML = String(w.eval('snapshotHTML(state)')), returned = parseHTML(savedHTML);
    assert.equal(returned.comments[0].rounds[0].reply.text, 'Late reply pending-r1');
    const preview = exchange.preview(p, d, { html: savedHTML });
    assert.equal(preview.ownerTampered, false); assert.deepEqual(preview.conflicts, []); assert.equal(preview.automatic.length, 3);
    const forged = structuredClone(returned); forged.export.writableRounds.push('done-r1'); forged.comments.find((c:any)=>c.id==='done').rounds[0].reply.text = 'Forged historical rewrite';
    const rejected = exchange.preview(p, d, { html: replaceData(savedHTML, forged) }); assert.equal(rejected.ownerTampered, true);
    assert.equal([...rejected.automatic,...rejected.conflicts].some((x:any)=>x.roundId==='done-r1'), false);
    const body = { step: 'apply', html: savedHTML, previewToken: preview.previewToken, batchId: randomUUID(), choices: {} };
    const applied = exchange.apply(p, d, body, actor); assert.equal(applied.result.applied.length, 3);
    const live = storage.load(p, d).data; assert.equal(live.comments[0].rounds[0].reply.text, 'Late reply pending-r1');
    assert.equal(live.comments.find((c:any)=>c.id==='done').rounds[0].reply.text, 'Completed reply'); assert.deepEqual(errors, []);
    assert.equal(exchange.apply(p, d, body, actor).replayed, true);
    const next = parseHTML(exchange.download(p, d, exchange.create(p, d, actor).exportId).html);
    assert.equal(next.export.writableRounds, undefined, 'completed historical replies lock again on the next export');
    const competing = structuredClone(returned); competing.comments[0].rounds[0].reply.text = 'Different late reply';
    const conflict = exchange.preview(p,d,{html:replaceData(savedHTML,competing)});
    assert.ok(conflict.conflicts.some((x:any)=>x.roundId==='pending-r1'&&x.field==='body'), 'late replies still use three-way conflict detection');
    ops([{type:'comment.status',commentId:'pending',value:'closed',baseRev:0}]);
    const closedPreview = exchange.preview(p,d,{html:replaceData(savedHTML,competing)});
    assert.match(closedPreview.conflicts.find((x:any)=>x.roundId==='pending-r1').reason,/closed/);
    assert.throws(()=>exchange.apply(p,d,{step:'apply',html:replaceData(savedHTML,competing),previewToken:closedPreview.previewToken,batchId:randomUUID(),overwrite:true,choices:Object.fromEntries(closedPreview.conflicts.map((x:any)=>[x.id,{choice:'builder'}]))},actor),/Reopen/);
  } finally { dom?.window.close(); db.close(); }
});
