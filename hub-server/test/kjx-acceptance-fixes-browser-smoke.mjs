import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';
import { createKjxTestSigner, createKjxVerifier } from '../src/kjx-auth-client.ts';
const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const browser=await chromium.launch({headless:true,channel:process.env.PAHUB_BROWSER_CHANNEL||'chromium'});
try{for(const mode of ['kjx','legacy']){
 const dir=await mkdtemp(path.join(tmpdir(),'pahub-t7-browser-'));let hub;
 try{
  Object.assign(process.env,{PORT:'0',AUTH_MODE:mode,PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
  const signer=createKjxTestSigner();hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://kjx.test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch})});
  const P='proj-test-001',D='dwg-001',origin='http://127.0.0.1:'+hub.port;hub.router.options.identity.publicOrigin=origin;
  hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));hub.db.prepare('UPDATE drawings SET discipline=? WHERE id=?').run('Hull',D);
  if(mode==='kjx')for(const id of ['viewer','manager'])hub.db.prepare('INSERT INTO project_team_reviewers VALUES(?,?)').run(P,id);
  const context=role=>browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:mode==='kjx'?{'X-Auth-Token':signer.signUser('pahub',{sub:role,username:role,name:'T7 '+role,role})}:{}});
  const adminContext=await context('admin');const admin=await adminContext.newPage();const errors=[];admin.on('pageerror',error=>errors.push(error.message));
  await admin.goto(origin+'/?project='+P);await admin.getByRole('button',{name:'Team Setup',exact:true}).waitFor();
  if(mode==='kjx'){
   const viewerContext=await context('viewer'),viewer=await viewerContext.newPage();viewer.on('pageerror',error=>errors.push(error.message));
   await viewer.goto(origin+'/?project='+P);await viewer.locator('[data-drawing-list-root]').waitFor();
   assert.equal(await viewer.getByRole('button',{name:'Team Setup',exact:true}).count(),0);assert.equal(await viewer.getByRole('button',{name:'Bulk Load',exact:true}).count(),0);assert.equal(await viewer.getByRole('button',{name:'Delete drawing'}).count(),0);
   assert.equal(await viewer.locator('tbody input,tbody select').count(),0);
   await viewer.goto(origin+'/pcf/'+P+'/'+D);await viewer.locator('#pahub-kjx-permissions').waitFor({state:'attached'});
   assert.deepEqual(errors,[]);
   for(const selector of ['#add-btn','#save-btn','#pahub-export','#pahub-import','#fab-add','#fab-save','#bulk-round-btn','#theme-btn'])assert.equal(await viewer.locator(selector).isVisible(),false,selector);
   assert.equal(await viewer.locator('[contenteditable="true"]').count(),0);
   const blocked=await viewerContext.request.post(origin+'/api/pcf/'+P+'/'+D+'/ops',{headers:{Origin:origin},data:{clientId:'viewer',baseRev:1,ops:[{type:'comment.add',id:'forbidden'}]}});assert.equal(blocked.status(),403);
   await viewerContext.close();
   const managerContext=await context('manager'),manager=await managerContext.newPage();manager.on('pageerror',error=>errors.push(error.message));await manager.goto(origin+'/?project='+P);
   const row=manager.locator('tbody tr').filter({has:manager.getByText('DW-A-001',{exact:true})}).first();await row.waitFor();
   const patches=[];manager.on('request',request=>{if(request.method()==='PATCH')patches.push(request.postDataJSON());});
   await row.locator('td').nth(11).getByRole('button').click();await row.getByText('Engineer B',{exact:true}).click();
   await manager.waitForResponse(response=>response.request().method()==='PATCH'&&response.status()===200);
   assert.ok(hub.db.prepare('SELECT reviewer_id FROM drawing_assignees WHERE drawing_id=?').all(D).some(row=>row.reviewer_id==='Engineer B'));
   assert.ok(patches.length);assert.equal(patches[0].reviewTracker,undefined);
   const command=manager.locator('input[placeholder^="Terminal:"]');await command.fill('@DW-A-001 T7 follow-up remark');await command.press('Enter');
   await manager.waitForResponse(response=>response.request().method()==='PATCH'&&response.status()===200);
   assert.ok(hub.db.prepare('SELECT content FROM drawing_remarks WHERE drawing_id=?').all(D).some(row=>String(row.content).includes('T7 follow-up remark')));
   await managerContext.close();
  }
  // Persisted local state is clean and another workspace has already been opened.
  const hall=await adminContext.newPage();hall.on('dialog',dialog=>dialog.accept('T7 Created '+mode));await hall.goto(origin+'/');
  const created=hall.waitForResponse(response=>response.request().method()==='PATCH'&&response.status()===200);
  await hall.getByRole('button',{name:/Create Workspace/}).click();await created;
  assert.ok(hub.db.prepare('SELECT id FROM projects WHERE name=?').get('T7 Created '+mode));
  await hall.reload();assert.ok(hub.db.prepare('SELECT id FROM projects WHERE name=?').get('T7 Created '+mode));
  assert.deepEqual(errors,[]);await adminContext.close();console.log('T7 '+mode+': workspace persists; '+(mode==='kjx'?'viewer writes hidden and manager assignment then remark saves':'legacy controls unchanged'));
 }finally{for(const context of browser.contexts())await context.close();await hub?.close();await rm(dir,{recursive:true,force:true});}
}}finally{await browser.close();for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
