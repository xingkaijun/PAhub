import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createHub} from '../dist/app.mjs';
import {createKjxTestSigner,createKjxVerifier} from '../src/kjx-auth-client.ts';
const dir=await mkdtemp(path.join(tmpdir(),'config-ui-'));
const keys=['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];
const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));let hub,browser;
try {
 Object.assign(process.env,{PORT:'0',AUTH_MODE:'kjx',PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:''});delete process.env.PCF_GRANT_SECRET;
 const signer=createKjxTestSigner();
 const people=[
  {id:'admin',name:'Kevin',username:'kevin',role:'admin',title:'Project Administrator',disciplines:['HULL']},
  {id:'manager',name:'Team Manager',username:'manager',role:'manager',title:'Technical Manager',disciplines:['HULL','PIPING']},
  {id:'reviewer',name:'Marine Reviewer',username:'reviewer',role:'reviewer',title:'Marine Engineer',disciplines:['ELECTRICAL']},
  {id:'other',name:'Piping Lead',username:'other',role:'reviewer',title:'Senior Engineer',disciplines:['PIPING']},
 ];
 hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch}),directory:{clientId:'fixture',clientSecret:'fixture-only',internalUrl:'http://directory.test',fetch:async input=>String(input).endsWith('/oauth/token')?Response.json({access_token:'fixture',expires_in:600}):Response.json(people.map(person=>({...person,active:true})))}});
 const P='proj-test-001',origin='http://127.0.0.1:'+hub.port;hub.router.options.identity.publicOrigin=origin;
 hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));
 hub.db.prepare('UPDATE projects SET name=? WHERE id=?').run('SINOCHEM',P);
 for(const person of people.slice(0,3)){
  hub.db.prepare('INSERT OR REPLACE INTO reviewers VALUES(?,?)').run(person.id,person.name);
  hub.db.prepare('INSERT OR IGNORE INTO project_team_reviewers VALUES(?,?)').run(P,person.id);
 }
 browser=await chromium.launch({headless:true,channel:process.env.PAHUB_BROWSER_CHANNEL||'chromium'});
 const context=await browser.newContext({viewport:{width:1920,height:1200},extraHTTPHeaders:{'X-Auth-Token':signer.signUser('pahub',{sub:'admin',username:'kevin',name:'Kevin',role:'admin'})}});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.goto(origin+'/?project='+P);await page.locator('[data-drawing-list-root]').waitFor();
 await page.locator('[data-primary-nav] button[title="Configuration"]').click();
 const config=page.getByTestId('settings-page');await config.waitFor();
 const roster=page.getByRole('button',{name:'Select team members',exact:true});
 await roster.click();await page.getByRole('checkbox',{name:'Piping Lead',exact:true}).waitFor();
 await page.getByLabel('Search team members',{exact:true}).fill('piping');assert.equal(await page.getByRole('checkbox').count(),2);
 const other=page.getByRole('checkbox',{name:'Piping Lead',exact:true});await other.focus();await page.keyboard.press('Space');assert.equal(await other.isChecked(),true);
 await page.keyboard.press('Escape');assert.equal(await roster.getAttribute('aria-expanded'),'false');
 assert.equal(await page.getByRole('button',{name:'Remove member Piping Lead',exact:true}).count(),1);
 const lead=page.getByLabel('Select Piping lead',{exact:true});await lead.selectOption('other');
 const patch=page.waitForResponse(response=>response.request().method()==='PATCH'&&response.status()===200);await page.getByRole('button',{name:'Save Now',exact:true}).click();await patch;
 assert.equal(hub.db.prepare('SELECT reviewer_id FROM discipline_defaults WHERE project_id=? AND discipline=?').get(P,'Piping').reviewer_id,'other');
 await lead.selectOption('');assert.equal(await lead.inputValue(),'');await lead.selectOption('other');
 await roster.click();await page.getByRole('checkbox',{name:'Piping Lead',exact:true}).waitFor();
 await page.getByRole('heading',{name:'Default Leads',exact:true}).click();assert.equal(await roster.getAttribute('aria-expanded'),'false');
 await page.getByRole('button',{name:'Remove member Piping Lead',exact:true}).click();await page.getByRole('button',{name:'Remove member Piping Lead',exact:true}).waitFor({state:'detached'});
 assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM project_team_reviewers WHERE project_id=? AND reviewer_id=?').get(P,'other').n,0);
 await roster.click();await page.getByLabel('Search team members',{exact:true}).fill('');await page.getByRole('checkbox',{name:'Piping Lead',exact:true}).check();await page.keyboard.press('Escape');await lead.selectOption('other');
 const styles=await config.locator('select,input:not([type=range]):not([type=file])').evaluateAll(nodes=>nodes.map(node=>{const css=getComputedStyle(node);return {size:css.fontSize,weight:css.fontWeight,radius:css.borderRadius};}));
 assert.ok(styles.every(style=>style.size==='10px'&&style.weight==='900'&&style.radius===styles[0].radius));
 assert.equal(await page.getByRole('button',{name:'Local Backup',exact:true}).count(),1);
 const merged=page.locator('section').filter({has:page.getByRole('heading',{name:'Project Settings',exact:true})});
 assert.equal(await merged.getByText('Data Management',{exact:true}).count(),1);assert.equal(await merged.getByText('Project Configuration',{exact:true}).count(),1);
 await roster.click();await page.getByRole('checkbox',{name:'Piping Lead',exact:true}).waitFor();
 await mkdir('hub-server/test/artifacts',{recursive:true});await page.screenshot({path:'hub-server/test/artifacts/config-ui-1920.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('Config UI 1920: search, keyboard checkbox/Escape, outside close, chips/remove, saved roster-only leads, clear and shared typography PASS');
}finally{
 await browser?.close();await hub?.close();await rm(dir,{recursive:true,force:true});
 for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;
}
