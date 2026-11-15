import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createHub} from '../dist/app.mjs';
import {createKjxTestSigner,createKjxVerifier} from '../src/kjx-auth-client.ts';
const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const dir=await mkdtemp(path.join(tmpdir(),'manual-kjx-'));let hub,browser;
try{
 Object.assign(process.env,{PORT:'0',AUTH_MODE:'kjx',PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
 const signer=createKjxTestSigner();hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch})});
 const P='proj-test-001',origin='http://127.0.0.1:'+hub.port;hub.router.options.identity.publicOrigin=origin;
 hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));hub.db.prepare('INSERT INTO project_team_reviewers VALUES(?,?)').run(P,'reviewer');
 browser=await chromium.launch({headless:true,channel:process.env.PAHUB_BROWSER_CHANNEL||'chromium'});await mkdir('hub-server/test/artifacts',{recursive:true});
 for(const role of ['admin','reviewer']){
  const context=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{'X-Auth-Token':signer.signUser('pahub',{sub:role,username:role,name:'Guide '+role,role})}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/?project='+P);await page.locator('[data-drawing-list-root]').waitFor();await page.getByRole('button',{name:'Guide',exact:true}).click();
  const frame=page.frameLocator('[data-testid="manual-frame"]');await frame.locator('html[data-auth-mode="kjx"]').waitFor({state:'attached'});
  assert.equal(await frame.locator('[data-manual-kjx]').isVisible(),true);assert.equal(await frame.locator('#config').isVisible(),false);
  await frame.getByRole('heading',{name:'四种角色、成员范围与限制'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'hub-server/test/artifacts/guide-kjx-'+role+'.png',fullPage:true});
  const text=await frame.locator('[data-manual-kjx]').innerText();assert.match(text,/不再用项目密码/);assert.match(text,/Unknown reviewer/);assert.match(text,/Tracker 历史不删除/);
  await page.getByRole('tab',{name:'English',exact:true}).click();await page.getByTestId('kjx-english-guide').waitFor();assert.equal(await page.getByTestId('english-guide').count(),0);assert.match(await page.getByTestId('kjx-english-guide').innerText(),/Inventory is read-only/);
  await page.getByRole('tab',{name:'中文手册',exact:true}).click();await page.getByTestId('manual-frame').waitFor();assert.deepEqual(errors,[]);await context.close();
 }
 console.log('kjx Guide: admin/reviewer Chinese current-mode content, legacy isolation, English quick guide and screenshots PASS');
}finally{await browser?.close();await hub?.close();await rm(dir,{recursive:true,force:true});for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
