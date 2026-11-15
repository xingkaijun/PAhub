import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createHub} from '../dist/app.mjs';
import {createKjxTestSigner,createKjxVerifier} from '../src/kjx-auth-client.ts';
const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const dir=await mkdtemp(path.join(tmpdir(),'autosave-p1-browser-'));let hub,browser;
try{
 Object.assign(process.env,{PORT:'0',AUTH_MODE:'kjx',PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
 const signer=createKjxTestSigner();hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch})});
 const P='proj-test-001',D='dwg-001',origin='http://127.0.0.1:'+hub.port;hub.router.options.identity.publicOrigin=origin;
 hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));
 hub.db.prepare('INSERT INTO project_team_reviewers VALUES(?,?)').run(P,'manager');
 hub.db.prepare('INSERT OR REPLACE INTO reviewers VALUES(?,?)').run('manager','Manager');
 hub.db.prepare('INSERT OR IGNORE INTO drawing_assignees VALUES(?,?)').run(D,'manager');
 hub.db.prepare('DELETE FROM review_tracker WHERE project_id=?').run(P);
 browser=await chromium.launch({headless:true,channel:process.env.PAHUB_BROWSER_CHANNEL||'chromium'});
 const context=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{'X-Auth-Token':signer.signUser('pahub',{sub:'manager',username:'manager',name:'Manager',role:'manager'})}});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.dismiss());
 await page.clock.install();await page.goto(origin+'/?project='+P);await page.locator('[data-drawing-list-root]').waitFor();
 await page.locator('button[title="Configuration"]').click();const input=page.getByPlaceholder('CUSTOM DISPLAY TITLE');await input.waitFor();
 let calls=0,release,parked;const hold=new Promise(resolve=>release=resolve),started=new Promise(resolve=>parked=resolve);
 await page.route('**/api/projects/'+P,async route=>{if(route.request().method()!=='PATCH')return route.continue();calls++;parked();await hold;return route.continue();});
 await input.fill('Fifteen minute cadence');const bar=page.getByTestId('save-status-bar');assert.match(await bar.innerText(),/Next autosave:.*15 min/);
 await page.clock.fastForward(3500);assert.equal(calls,0,'no save at former three-second debounce');
 await page.clock.fastForward(15*60*1000);await started;assert.match(await bar.innerText(),/Saving/);
 await input.focus();await input.fill('Typing while save is in flight');assert.equal(await input.evaluate(el=>document.activeElement===el),true);assert.equal(await page.getByText('Syncing Data',{exact:true}).count(),0);
 release();await page.waitForFunction(()=>document.querySelector('[data-testid="save-status-bar"]')?.textContent.includes('Pending sync'));
 assert.equal(await input.inputValue(),'Typing while save is in flight');assert.equal(await input.evaluate(el=>document.activeElement===el),true);
 await mkdir('hub-server/test/artifacts',{recursive:true});await page.screenshot({path:'hub-server/test/artifacts/autosave-p1-status.png',fullPage:true});
 const saved=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.status()===200);await page.getByRole('button',{name:'Save Now',exact:true}).click();await saved;
 await page.locator('button[title="Daily Change Log"]').click();await page.getByRole('heading',{name:'Daily Logs',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Local',exact:true}).count(),0);await page.getByRole('button',{name:'Raw entries',exact:true}).waitFor();
 // 505 real server audit rows establish Load more and export scope.
 const stamp=new Date().toISOString();const insert=hub.db.prepare("INSERT INTO audit_log(table_name,row_id,project_id,action,detail,created_at,actor_id,actor_name) VALUES('drawings',?,?,'COMMENTS',?,?,?,?)");
 for(let i=0;i<505;i++)insert.run(D,P,JSON.stringify({from:{total:i,open:i},to:{total:i+1,open:i+1},drawingNo:'P1-'+i,customId:'P1-'+i}),stamp,'manager','Manager');
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Load more',exact:true}).waitFor();await page.getByRole('button',{name:'Load more',exact:true}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(b=>b.textContent==='Load more'));
 let auditCalls=0;page.on('request',request=>{if(request.url().includes('/audit?'))auditCalls++;});
 hub.pcf.realtime.projectChanged(P,D,['project-data']);hub.pcf.realtime.projectChanged(P,D,['project-data']);
 // Allow the SSE frames to arrive, then advance only the throttle clock.
 await page.waitForTimeout(100);await page.clock.fastForward(1100);await page.getByRole('button',{name:'Load more',exact:true}).waitFor();assert.ok(auditCalls<=1,'SSE bursts cause at most one audit refresh');
 await page.screenshot({path:'hub-server/test/artifacts/autosave-p1-daily-server.png',fullPage:true});
 await page.getByRole('button',{name:'Tracker',exact:true}).click();const mine=page.getByRole('button',{name:'Manager',exact:true}).first();await mine.waitFor();
 let trackerMode='fail',trackerCalls=0,trackerRelease;const trackerGate=new Promise(resolve=>trackerRelease=resolve);
 await page.route('**/review-tracker',async route=>{if(route.request().method()!=='PUT')return route.continue();trackerCalls++;if(trackerMode==='fail'){await trackerGate;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary failure"}'});}if(trackerMode==='lost'){await route.fetch();return route.abort();}return route.continue();});
 await mine.click();await page.getByRole('button',{name:/Manager.*In progress/}).first().waitFor();assert.equal(await page.getByRole('button',{name:/Manager.*In progress/}).first().isDisabled(),true);assert.equal(trackerCalls,1);
 trackerRelease();await page.getByRole('button',{name:/Manager.*Failed.*Retry/}).first().waitFor();await page.screenshot({path:'hub-server/test/artifacts/autosave-p1-tracker-failed.png',fullPage:true});
 trackerMode='ok';await page.getByRole('button',{name:/Manager.*Failed.*Retry/}).first().click();await page.getByRole('button',{name:'Manager',exact:true}).first().waitFor();assert.equal(hub.db.prepare('SELECT done FROM review_tracker WHERE project_id=? AND drawing_id=? AND reviewer_id=?').get(P,D,'manager').done,1);
 trackerMode='lost';await page.getByRole('button',{name:'Manager',exact:true}).first().click();await page.getByRole('button',{name:'Manager',exact:true}).first().waitFor();assert.equal(hub.db.prepare('SELECT done FROM review_tracker WHERE project_id=? AND drawing_id=? AND reviewer_id=?').get(P,D,'manager').done,0,'lost PUT receipt uses fresh read-back');
 // Browser storage failure is visible, and the in-memory edit still works.
 await page.locator('button[title="Configuration"]').click();await input.waitFor();await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Quota exceeded','QuotaExceededError');};});await input.fill('Memory remains editable');assert.match(await bar.innerText(),/Local recovery unavailable/);assert.equal(await input.inputValue(),'Memory remains editable');
 assert.deepEqual(errors,[]);console.log('autosave P1 browser: fifteen-minute cadence, uninterrupted typing, Daily Log server/refresh/pagination/SSE, Tracker failure/retry/lost receipt, storage warning PASS');
}finally{await browser?.close();await hub?.close();await rm(dir,{recursive:true,force:true});for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
