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

test('exchange edges: whole image sets, disjoint fields, stale preview, invalid mode and old-template hint', async () => {
  const temp=await mkdtemp(path.join(tmpdir(),'pahub-exchange-edge-'));
  const old=Object.fromEntries(['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN'].map(k=>[k,process.env[k]]));
  Object.assign(process.env,{PORT:'0',PAHUB_DATA_DIR:temp,PAPC_DB_PATH:path.join(temp,'papc.db'),API_TOKEN:''});
  const hub=await createHub();
  try {
    hub.db.sqlite.exec(await readFile(path.join(ROOT_DIR,'worker/sql/seed-test-data.sql'),'utf8'));
    const origin='http://127.0.0.1:'+hub.port,route='/api/pcf/proj-test-001/dwg-005/';
    const api=async(tail:string,body?:any)=>{const r=await fetch(origin+route+tail,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify({clientId:'edge-reviewer',...body}):undefined});return {status:r.status,data:await r.json() as any};};
    await api('create',{});let live=(await api('data')).data;
    const ops=async(operations:any[])=>{const r=await api('ops',{baseRev:live.rev,batchId:randomUUID(),ops:operations});assert.equal(r.status,200);assert.deepEqual(r.data.conflicts,[]);live=r.data;};
    await ops([{type:'comment.add',id:'c1',roundIdNew:'r1'}]);
    const record=(await api('exports',{})).data,html=await (await fetch(origin+route+'exports/'+record.exportId+'/download')).text(),data=parseHTML(html);
    const image=(id:string)=>({id,name:id+'.png',mime:'image/png',data:'data:image/png;base64,AA==',width:1,height:1});
    data.comments[0].rounds[0].reply={...blankContent(),text:'Builder body',html:'<b>Builder body</b>',images:[image('builder-image')]};
    const returned=replaceData(html,data),first=(await api('imports',{step:'preview',html:returned})).data;
    assert.equal(first.ownerTampered,false);assert.deepEqual(first.automatic.map((x:any)=>x.field),['body','images']);
    await ops([{type:'content.set',commentId:'c1',roundId:'r1',side:'reply',baseRev:0,value:{...blankContent(),images:[image('server-image-a'),image('server-image-b')]}}]);
    const stale=await api('imports',{step:'apply',html:returned,previewToken:first.previewToken,batchId:randomUUID(),choices:{'r1:images':{choice:'server'}}});assert.equal(stale.status,409);assert.match(stale.data.error,/server changed/);
    const preview=(await api('imports',{step:'preview',html:returned})).data;
    assert.deepEqual(preview.automatic.map((x:any)=>x.field),['body']);assert.deepEqual(preview.conflicts.map((x:any)=>x.field),['images']);
    assert.equal(preview.conflicts[0].server.length,2);assert.equal(preview.conflicts[0].builder.length,1);
    const applied=await api('imports',{step:'apply',html:returned,previewToken:preview.previewToken,batchId:randomUUID(),choices:{'r1:images':{choice:'builder'}}});
    assert.equal(applied.status,200);assert.equal(applied.data.data.comments[0].rounds[0].reply.text,'Builder body');assert.deepEqual(applied.data.data.comments[0].rounds[0].reply.images,[image('builder-image')]);
    const invalid=structuredClone(data);invalid.export.mode='owner';assert.equal((await api('imports',{step:'preview',html:replaceData(html,invalid)})).status,409);
    const file=path.join(temp,'pcf','proj-test-001','dwg-005.html'),original=(await readFile(file,'utf8')).replace('<meta name="pahub-template-version" content="4">','');await writeFile(file,original,'utf8');
    const oldPage=await (await fetch(origin+'/pcf/proj-test-001/dwg-005')).text();assert.match(oldPage,/pahub-template-note-script/);assert.match(oldPage,/Template upgrade available/);assert.equal(await readFile(file,'utf8'),original);
    console.log('Exchange edges: images compared/replaced as whole sets; Builder body + server image disjoint automatic; stale preview 409; wrong mode 409; old-template hint injected without changing authoritative HTML');
  } finally {await hub.close();for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
