import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createHub} from '../dist/app.mjs';
import {createKjxTestSigner,createKjxVerifier} from '../src/kjx-auth-client.ts';
const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const dir=await mkdtemp(path.join(tmpdir(),'membership-browser-'));let hub,browser;
try{
 Object.assign(process.env,{PORT:'0',AUTH_MODE:'kjx',PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
 const signer=createKjxTestSigner();hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch})});
 const P='proj-test-001',D='dwg-001',origin='http://127.0.0.1:'+hub.port;hub.router.options.identity.publicOrigin=origin;
 hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));hub.db.prepare('INSERT INTO projects(id,name) VALUES(?,?)').run('secret','Hidden Workspace');
 // An existing password stays in the database but must never prompt in kjx.
 const {setProjectPassword}=await import('../src/project-password.ts');setProjectPassword(hub.db,P,'local-test-only');
 browser=await chromium.launch({headless:true,channel:process.env.PAHUB_BROWSER_CHANNEL||'chromium'});
 const contexts={};for(const role of ['admin','manager','reviewer'])contexts[role]=await browser.newContext({extraHTTPHeaders:{'X-Auth-Token':signer.signUser('pahub',{sub:role,username:role,name:'Membership '+role,role})},viewport:{width:1440,height:1000}});
 const admin=await contexts.admin.newPage();await admin.goto(origin+'/');await admin.getByText('Hidden Workspace',{exact:true}).waitFor();
 for(const role of ['reviewer','manager']){
  const page=await contexts[role].newPage();const loaded=page.waitForResponse(response=>response.url().endsWith('/api/projects'));await page.goto(origin+'/');await loaded;
  assert.equal(await page.getByText('Hidden Workspace',{exact:true}).count(),0);
  assert.deepEqual(await(await contexts[role].request.get(origin+'/api/projects')).json(),[]);
  const grant=await contexts.admin.request.patch(origin+'/api/projects/'+P,{headers:{Origin:origin},data:{conf:{reviewers:[{id:role,name:'Membership '+role}],disciplineDefaults:{},defaultAssignees:{}}}});assert.equal(grant.status(),200);
  await page.reload();await page.getByText('PG-VLEC-H2684',{exact:true}).first().waitFor();
  assert.equal(await page.getByText('Hidden Workspace',{exact:true}).count(),0);assert.equal(await page.getByLabel('Password protected',{exact:true}).count(),0);
  await page.goto(origin+'/?project='+P);await page.locator('[data-drawing-list-root]').waitFor();assert.equal(await page.locator('#project-unlock-password').count(),0);
  const pcf=await contexts[role].newPage();await pcf.goto(origin+'/pcf/'+P+'/'+D);assert.equal(await pcf.locator('text=Project password required').count(),0);await pcf.locator('#add-btn').waitFor();
  if(role==='manager')await page.getByRole('button',{name:'Team Setup',exact:true}).waitFor();
  const revoke=await contexts.admin.request.patch(origin+'/api/projects/'+P,{headers:{Origin:origin},data:{conf:{reviewers:[],disciplineDefaults:{},defaultAssignees:{}}}});assert.equal(revoke.status(),200);
  assert.equal((await contexts[role].request.get(origin+'/api/pcf/'+P+'/'+D+'/data')).status(),403);
  const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/projects'));await page.reload();await refreshed;await page.waitForFunction(()=>!document.body.innerText.includes('PG-VLEC-H2684'));assert.equal(await page.getByText('PG-VLEC-H2684',{exact:true}).count(),0);
  assert.deepEqual(await(await contexts[role].request.get(origin+'/api/projects')).json(),[]);
  await pcf.close();await page.close();
 }
 assert.equal((await(await contexts.admin.request.get(origin+'/api/projects')).json()).length,2);
 console.log('membership browser: reviewer/manager hidden → Team Setup grant → password-free access → immediate revoke; admin sees all PASS');
}finally{await browser?.close();await hub?.close();await rm(dir,{recursive:true,force:true});for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
