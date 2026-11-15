import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createHub} from '../dist/app.mjs';
import {createKjxTestSigner,createKjxVerifier} from '../src/kjx-auth-client.ts';
const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const dir=await mkdtemp(path.join(tmpdir(),'reviewer-view-'));let hub,browser;
try{
 Object.assign(process.env,{PORT:'0',AUTH_MODE:'kjx',PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
 const signer=createKjxTestSigner();hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch})});
 const P='proj-test-001',D='dwg-001',origin='http://127.0.0.1:'+hub.port;hub.router.options.identity.publicOrigin=origin;
 hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));
 const ids=['569b807f-73c4-4ba2-9623-818be3e97523','b299dc0c-3d76-4bcc-be8e-fda54557b3ff','00c71fe5-8d3e-4ccb-9906-c54fa4c52931'];
 for(const[id,name]of [[ids[0],'Kevin'],[ids[1],'Wangyu'],[ids[2],'why'],['reviewer','Test Reviewer'],['manager','Manager']])hub.db.prepare('INSERT OR REPLACE INTO reviewers VALUES(?,?)').run(id,name);
 for(const id of ['reviewer','manager',...ids])hub.db.prepare('INSERT OR IGNORE INTO project_team_reviewers VALUES(?,?)').run(P,id);
 hub.db.prepare('DELETE FROM drawing_assignees WHERE drawing_id=?').run(D);
 for(const id of ['reviewer',ids[0],'Kevin','Wangyu',ids[2],'11111111-1111-4111-8111-111111111111'])hub.db.prepare('INSERT INTO drawing_assignees VALUES(?,?)').run(D,id);
 hub.db.prepare('UPDATE drawings SET discipline=?,version=?,status=? WHERE id=?').run('Hull','A1','Reviewing',D);
 browser=await chromium.launch({headless:true,channel:process.env.PAHUB_BROWSER_CHANNEL||'chromium'});
 const contexts={},pages={},errors=[];
 for(const role of ['reviewer','admin','manager']){
  contexts[role]=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{'X-Auth-Token':signer.signUser('pahub',{sub:role,username:role,name:role,role})}});
  pages[role]=await contexts[role].newPage();pages[role].on('pageerror',e=>errors.push(e.message));await pages[role].goto(origin+'/?project='+P);await pages[role].locator('[data-drawing-list-root]').waitFor();
 }
 await mkdir('hub-server/test/artifacts',{recursive:true});
 const row=page=>page.locator('tbody tr').filter({has:page.getByText('DW-A-001',{exact:true})}).first();
 const read=row(pages.reviewer),admin=row(pages.admin);
 assert.equal(await read.locator('input,select,[contenteditable=true]').count(),0);
 assert.equal(await read.locator('td').nth(11).getByRole('button').count(),0);
 for(const name of ['Kevin','Wangyu','why','Unknown reviewer'])assert.equal(await read.getByLabel(name,{exact:true}).count(),1);
 assert.doesNotMatch(await read.innerText(),/[0-9a-f]{8}-[0-9a-f]{4}-/i);
 for(const column of [3,5,12,13,14]){
  const display=read.locator('td').nth(column).locator('span').first();const edit=admin.locator('td').nth(column).locator('input,select,span').first();
  assert.equal(await display.evaluate(node=>getComputedStyle(node).fontSize),await edit.evaluate(node=>getComputedStyle(node).fontSize),'column '+column);
 }
 await pages.reviewer.screenshot({path:'hub-server/test/artifacts/reviewer-inventory-readonly.png',fullPage:true});
 await pages.admin.screenshot({path:'hub-server/test/artifacts/admin-inventory-comparison.png',fullPage:true});
 await admin.locator('td').nth(11).getByRole('button').click();
 for(const name of ['Kevin','Wangyu','why','Test Reviewer'])assert.equal(await admin.locator('label').filter({hasText:name}).getByRole('checkbox').isChecked(),true,name);
 await pages.admin.screenshot({path:'hub-server/test/artifacts/assignees-mixed-id-name-dropdown.png',fullPage:true});
 await pages.manager.locator('button[title="Configuration"]').click();
 await pages.manager.getByText('Project Configuration',{exact:true}).waitFor();
 assert.equal(await pages.manager.getByRole('button',{name:'Local Backup'}).count(),0);assert.equal(await pages.manager.getByRole('button',{name:'Fix Deadline'}).count(),0);
 const saved=pages.manager.waitForResponse(response=>response.request().method()==='PATCH'&&response.status()===200);
 await pages.manager.getByPlaceholder('CUSTOM DISPLAY TITLE').fill('Manager Config saved');await saved;
 assert.equal(hub.db.prepare('SELECT setting_value FROM project_settings WHERE project_id=? AND setting_key=?').get(P,'displayName').setting_value,'Manager Config saved');
 await pages.manager.screenshot({path:'hub-server/test/artifacts/manager-project-config.png',fullPage:true});
 await pages.manager.route('**/api/projects/'+P,async route=>{if(route.request().method()==='PATCH')await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:'forbidden',capability:'project.settings'})});else await route.continue();});
 await pages.manager.getByPlaceholder('CUSTOM DISPLAY TITLE').fill('Must roll back');
 await pages.manager.waitForFunction(()=>document.querySelector('input[placeholder="CUSTOM DISPLAY TITLE"]')?.value==='Manager Config saved');
 const cached=await pages.manager.evaluate(()=>JSON.parse(localStorage.getItem('pahub-storage')).state);
 assert.equal(cached._dirtyConf,false);assert.deepEqual(cached._dirtyDrawingIds,[]);assert.doesNotMatch(JSON.stringify(cached),/Must roll back/);
 assert.deepEqual(errors,[]);
 console.log('reviewer-view browser: styled read-only cells, safe assignee names/mixed checks, manager Config and 403 rollback PASS');
}finally{await browser?.close();await hub?.close();await rm(dir,{recursive:true,force:true});for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
