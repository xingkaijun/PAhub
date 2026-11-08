// Real Chrome integration smoke; PORT=0 and isolated temp data, never production 8080.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),temp=await mkdtemp(path.join(tmpdir(),'pahub-v26-chrome-'));
Object.assign(process.env,{PORT:'0',PAHUB_DATA_DIR:temp,PAPC_DB_PATH:path.join(temp,'papc.db'),API_TOKEN:''});
const hub=await createHub(),artifacts=path.join(root,'hub-server/test/artifacts');await mkdir(artifacts,{recursive:true});let browser;
const dataOf=html=>JSON.parse(html.match(/<script id="pcf-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
const unzip=bytes=>{const files=new Map();let at=0;while(bytes.readUInt32LE(at)===0x04034b50){const method=bytes.readUInt16LE(at+8),size=bytes.readUInt32LE(at+18),n=bytes.readUInt16LE(at+26),x=bytes.readUInt16LE(at+28),name=bytes.subarray(at+30,at+30+n).toString('utf8'),start=at+30+n+x,payload=bytes.subarray(start,start+size);files.set(name,method===8?inflateRawSync(payload):payload);at=start+size;}return files;};
try{
  hub.db.exec(await readFile(path.join(root,'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
  browser=await chromium.launch({channel:'chrome',headless:true});const errors=[];
  const ca=await browser.newContext({viewport:{width:1500,height:1100},acceptDownloads:true}),cb=await browser.newContext({viewport:{width:1500,height:1100},acceptDownloads:true});
  const a=await ca.newPage(),b=await cb.newPage();for(const p of [a,b])p.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:'+hub.port,endpoint=origin+'/api/pcf/proj-test-001/dwg-005/',url=origin+'/pcf/proj-test-001/dwg-005';
  const api=async(tail,method='GET',body)=>{const r=await fetch(endpoint+tail,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,value:await r.json()};};
  const saved=async p=>{await p.locator('#save-btn').click();await p.waitForFunction(()=>document.querySelector('#save-state').textContent.startsWith('Saved to server'));};
  await Promise.all([a.goto(url),b.goto(url)]);console.log('UI snapshot:',await a.locator('.banner-actions').innerText());
  await a.waitForFunction(()=>document.querySelector('#pahub-online').textContent.includes('2 users'));
  await a.evaluate(()=>{eval('state.settings.autoSaveSeconds=0;touch()');});
  for(let i=0;i<2;i++){await a.locator('#add-btn').click();await a.locator('.editor[data-side=owner]').nth(i).fill('Owner v2.6 comment '+(i+1));}await saved(a);
  await b.waitForFunction(()=>document.querySelectorAll('.editor[data-side=owner]').length===2);
  await b.locator('.editor[data-side=reply]').first().click();await b.evaluate(()=>window.focusNode=document.activeElement);
  await a.locator('.editor[data-side=owner]').first().fill('SSE inplace v2.6');await saved(a);await b.waitForFunction(()=>document.querySelector('.editor[data-side=owner]').textContent==='SSE inplace v2.6');assert.equal(await b.evaluate(()=>window.focusNode===document.activeElement),true);
  await a.screenshot({path:path.join(artifacts,'v26-collaboration.png'),fullPage:true});console.log('SSE + presence + caret preserved');
  await a.evaluate(()=>eval('addRound(state.comments[1])'));await saved(a);await b.waitForFunction(()=>eval('state.comments[1].rounds.length===2'));
  await cb.setOffline(true);await b.evaluate(()=>eval('addRound(state.comments[1])'));await b.locator('#save-btn').click();
  await a.evaluate(()=>eval('deleteRecord(state.comments[1]);modalAction()'));await saved(a);assert.equal((await api('data')).value.data.project.currentRound,2);
  await cb.setOffline(false);await b.evaluate(()=>eval('hubSave()'));await b.locator('#hub-resolve').waitFor();assert.match(await b.locator('#modal-body').innerText(),/changed|deleted|missing/i);
  await b.screenshot({path:path.join(artifacts,'v26-delete-offline-conflict.png'),fullPage:true});await b.locator('#hub-all-server').click();await b.locator('#hub-resolve').click();await b.waitForFunction(()=>eval('!writeBusy&&!hubBlocked&&!hubQueue.length&&!dirty()'));await b.evaluate(()=>eval('hubPersistChain'));assert.equal((await api('data')).value.data.comments.length,1);console.log('Permanent delete -> currentRound rollback; offline add conflicts without revival');
  await b.reload();await b.waitForFunction(()=>document.querySelector('#save-state').textContent.startsWith('Saved to server'));
  await cb.setOffline(true);await b.locator('#bulk-round-btn').click();await a.locator('#bulk-round-btn').click();await saved(a);await cb.setOffline(false);await b.evaluate(()=>eval('hubSave()'));await b.locator('#hub-resolve').waitFor();await b.screenshot({path:path.join(artifacts,'v26-add-all-conflict.png'),fullPage:true});await b.locator('#hub-all-server').click();await b.locator('#hub-resolve').click();await b.waitForFunction(()=>eval('!writeBusy&&!hubBlocked&&!hubQueue.length&&!dirty()'));await b.evaluate(()=>eval('hubPersistChain'));assert.equal((await api('data')).value.data.comments[0].rounds.length,2);
  await b.reload();await b.locator('.editor[data-side=reply]').last().click();await a.waitForFunction(()=>eval('hubOnline.some(x=>x.entity)'));
  let imported=(await api('data')).value.data;delete imported.hub;const jsonFile=path.join(temp,'import.json');await writeFile(jsonFile,JSON.stringify(imported),'utf8');
  await a.locator('#json-input').setInputFiles(jsonFile);await a.waitForFunction(()=>document.querySelector('#toast').textContent.includes('import blocked'));await a.screenshot({path:path.join(artifacts,'v26-json-presence-block.png'),fullPage:true});await cb.close();
  await a.waitForFunction(()=>eval('hubOnline.every(x=>!x.entity)'));
  await a.locator('#json-input').setInputFiles(jsonFile);await a.locator('#modal[open]').waitFor();const prior=(await api('data')).value;
  await api('ops','POST',{clientId:'other',baseRev:prior.rev,batchId:randomUUID(),ops:[{type:'project.set',field:'revision',baseRev:prior.data.hub.entities['project:revision']?.rev||0,value:'C'}]});
  await a.locator('#modal-footer [data-action=modal-submit]').click();await a.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Refresh'));await a.locator('#modal-footer [data-action=close-modal]').click();await a.evaluate(()=>eval('hubReload()'));
  imported=(await api('data')).value.data;delete imported.hub;await writeFile(jsonFile,JSON.stringify(imported),'utf8');await a.locator('#json-input').setInputFiles(jsonFile);await a.locator('#modal[open]').waitFor();await a.locator('#modal-footer [data-action=modal-submit]').click();await a.waitForFunction(()=>!document.querySelector('#modal').open);await a.screenshot({path:path.join(artifacts,'v26-json-import.png'),fullPage:true});console.log('Hosted JSON: presence blocked, stale rev rejected, replacement saved');
  await a.locator('#save-menu-btn').click();const download=a.waitForEvent('download');await a.locator('#pahub-export').click();const exportFile=await download,exportPath=path.join(temp,exportFile.suggestedFilename());await exportFile.saveAs(exportPath);const exported=await readFile(exportPath,'utf8');assert.doesNotMatch(exported,/pahub-context|X-PCF-Token|apiBase|clientId/);assert.equal(dataOf(exported).hub,undefined);
  const co=await browser.newContext({viewport:{width:1500,height:1100},acceptDownloads:true});await co.addInitScript(()=>{window.showOpenFilePicker=undefined;window.showSaveFilePicker=undefined;});
  const builder=await co.newPage();builder.on('pageerror',e=>errors.push(e.message));await builder.goto(pathToFileURL(exportPath).href);console.log('Builder snapshot:',await builder.locator('#builder-notice').innerText());assert.equal(await builder.locator('.editor[data-side=owner]').first().getAttribute('contenteditable'),'false');assert.equal(await builder.locator('#import-json-btn').isDisabled(),true);
  assert.equal(await builder.evaluate(()=>eval('(()=>{const old=JSON.stringify({register:state.roundRegister,approval:state.approvalHistory});try{state.roundRegister[0].ownerDate="BAD";state.approvalHistory.push({})}catch{}return old===JSON.stringify({register:state.roundRegister,approval:state.approvalHistory})})()')),true);await builder.screenshot({path:path.join(artifacts,'v26-builder-lock.png'),fullPage:true});
  for(const [label,p] of [['hosted',a],['builder',builder]]){
    for(const button of ['#export-btn','#print-xlsx-btn']){await p.locator('#excel-menu-btn').click();const next=p.waitForEvent('download');await p.locator(button).click();const workbook=await next,workbookPath=path.join(temp,label+'-'+workbook.suggestedFilename());await workbook.saveAs(workbookPath);assert.match(workbook.suggestedFilename(),/\.xlsx$/);const sheets=unzip(await readFile(workbookPath));assert.ok(sheets.has('[Content_Types].xml'));for(const bytes of sheets.values())assert.doesNotMatch(bytes.toString('utf8'),/pahub-context|X-PCF-Token|tombstones/);}
    await p.evaluate(()=>{window.printCalls=0;window.print=()=>window.printCalls++;});await p.locator('#more-btn').click();await p.locator('[data-action=print]').click();await p.waitForFunction(()=>window.printCalls===1);await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  }console.log('Hosted + Builder Excel, print workbook and Print/PDF entry allowed');
  const zipResponse=await fetch(origin+'/api/pcf/proj-test-001/exports/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:'smoke',batchId:randomUUID(),drawingIds:['dwg-005']})});assert.equal(zipResponse.status,200);const zip=Buffer.from(await zipResponse.arrayBuffer()),entries=unzip(zip);await writeFile(path.join(temp,'send-all.zip'),zip);const [name,bytes]=[...entries].find(([name])=>name.endsWith('.html'));const packed=path.join(temp,'unpacked-'+name);await writeFile(packed,bytes);const packPage=await co.newPage();packPage.on('pageerror',e=>errors.push(e.message));await packPage.goto(pathToFileURL(packed).href);await packPage.locator('#builder-notice').waitFor();assert.equal(await packPage.locator('#add-btn').isDisabled(),true);await packPage.screenshot({path:path.join(artifacts,'v26-send-all-open.png'),fullPage:true});
  await a.locator('#save-menu-btn').click();const copyDownload=a.waitForEvent('download');await a.locator('#save-as-btn').click();const copy=await copyDownload,copyPath=path.join(temp,'download-copy.html');await copy.saveAs(copyPath);const copyHTML=await readFile(copyPath,'utf8');assert.doesNotMatch(copyHTML,/pahub-context|X-PCF-Token|apiBase|clientId/);assert.equal(dataOf(copyHTML).hub,undefined);const copyPage=await co.newPage();copyPage.on('pageerror',e=>errors.push(e.message));await copyPage.goto(pathToFileURL(copyPath).href);await copyPage.locator('#add-btn').waitFor();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({pageerrors:errors.length,temp,port:hub.port,screenshots:'hub-server/test/artifacts/v26-*.png',sendAll:[...entries.keys()]},null,2));
}finally{await browser?.close();await hub.close();}
