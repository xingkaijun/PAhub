import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { hashProjectPassword, migrateProjectPasswords, passwordState, setProjectPassword, verifyProjectPassword } from '../src/project-password.ts';
import { createProjectSession } from '../src/project-session.ts';
import { getProjectConfiguration, getProjectList } from '../src/project-read.ts';

const P = 'proj-test-001', BASE = '/api/projects/' + P, PASS = 'fictional-project-test-password';
const json = (value: unknown, headers: Record<string,string> = {}): RequestInit => ({ method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value) });
async function fixture(token = '') {
  const directory=await mkdtemp(path.join(tmpdir(),'pahub-project-password-'));
  const keys=['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','PAPC_DIST_DIR','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{PORT:'0',PAHUB_DATA_DIR:directory,PAPC_DB_PATH:path.join(directory,'papc.db'),PAPC_DIST_DIR:path.join(process.cwd(),'dist'),API_TOKEN:token,ADMIN_PASSWORD:'fictional-admin-test-password',PAHUB_BASIC_AUTH:''});
  const hub=await createHub({host:'127.0.0.1'});
  hub.db.exec(await readFile(path.join(process.cwd(),'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
  setProjectPassword(hub.db,P,PASS);
  const request=(route:string,init:RequestInit={})=>fetch('http://127.0.0.1:'+hub.port+route,init);
  const login=async()=>{const r=await request('/api/session',json({password:'fictional-admin-test-password'}));return r.headers.get('set-cookie')!.split(';')[0];};
  const unlock=async(password=PASS,headers:Record<string,string>={})=>request(BASE+'/unlock',json({password},headers));
  return {directory,hub,request,login,unlock,close:async()=>{await hub.close();for(const [k,v] of Object.entries(previous)) v===undefined?delete process.env[k]:process.env[k]=v;}};
}

test('scrypt hashes use random salt; startup migrates plaintext once with a rollback DB before changing rows',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'pahub-password-migration-')),file=path.join(directory,'papc.db');
  let db=openDatabase(file);
  db.exec("INSERT INTO projects(id,name) VALUES('legacy','Legacy'); INSERT INTO project_settings(project_id,setting_key,setting_value) VALUES('legacy','password','fictional-legacy-password')");
  assert.throws(()=>migrateProjectPasswords(db,file),'backup failure must abort migration');
  assert.equal(db.prepare("SELECT setting_value FROM project_settings WHERE setting_key='password'").get()?.setting_value,'fictional-legacy-password');
  db.close();
  const envKeys=['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD'],previous=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{PORT:'0',PAHUB_DATA_DIR:directory,PAPC_DB_PATH:file,API_TOKEN:'',ADMIN_PASSWORD:'fictional-admin'});
  const hub=await createHub({host:'127.0.0.1'});
  try {
    const state=passwordState(hub.db,'legacy'); assert.match(state.hash,/^scrypt\$/); assert.equal(verifyProjectPassword('fictional-legacy-password',state.hash),true);
    assert.equal(hub.db.prepare("SELECT 1 FROM project_settings WHERE setting_key='password'").get(),undefined);
    const files=await readdir(path.join(directory,'backups'));assert.equal(files.filter(s=>s.startsWith('before-project-password-')).length,1);
    const rollback=new DatabaseSync(path.join(directory,'backups',files.find(s=>s.startsWith('before-project-password-'))!),{readOnly:true});
    try {assert.equal(rollback.prepare("SELECT setting_value FROM project_settings WHERE setting_key='password'").get()?.setting_value,'fictional-legacy-password');} finally{rollback.close();}
    assert.equal(migrateProjectPasswords(hub.db,directory),null);assert.deepEqual(passwordState(hub.db,'legacy'),state);
    const other=hashProjectPassword('fictional-legacy-password');assert.notEqual(other,state.hash);assert.equal(verifyProjectPassword('wrong',other),false);
    assert.equal((getProjectConfiguration(hub.db,'legacy') as any).password,undefined);assert.equal((getProjectList(hub.db)[0] as any).passwordProtected,true);
  } finally {await hub.close();for(const [k,v] of Object.entries(previous))v===undefined?delete process.env[k]:process.env[k]=v;}
});

test('every project route rejects locked requests before data, and unlock cookie permits all reviewer reads',async()=>{
  const f=await fixture();try{
    const routes:Array<[string,RequestInit?]>=[
      [BASE,json({})],[BASE+'/drawings?ids=dwg-001'],[BASE+'/review-tracker'],[BASE+'/heartbeat'],[BASE+'/audit?from=2000-01-01&to=2100-01-01'],[BASE+'/comments'],[BASE+'/comments.xlsx'],[BASE+'/events'],[BASE+'/builder-replies/pending'],
      [BASE,{...json({conf:{password:'forbidden'}}),method:'PATCH'}],[BASE+'/review-tracker',{...json({}),method:'PUT'}],[BASE+'/drawings/dwg-001/status',json({status:'Approved'})],
      ['/pcf/'+P+'/dwg-005'],['/pcf/'+P+'/dwg-005/images/'+'a'.repeat(64)],
      ['/api/pcf/'+P+'/index'],['/api/pcf/'+P+'/presence'],['/api/pcf/'+P+'/exports/batch',json({})],
      ...['data','meta','history','exports','download','events','presence','exports/00000000-0000-4000-8000-000000000000/download'].map(t=>['/api/pcf/'+P+'/dwg-005/'+t] as [string]),
      ...['create','ops','presence','imports','exports','session','history/1/restore','exports/00000000-0000-4000-8000-000000000000/void'].map(t=>['/api/pcf/'+P+'/dwg-005/'+t,json({})] as [string,RequestInit]),
      ['/api/pcf/'+P+'/dwg-005/document',{...json({}),method:'PUT'}],
    ];
    for(const [route,init] of routes){const response=await f.request(route,init);assert.equal(response.status,401,route);if(!route.startsWith('/pcf/'))assert.equal((await response.json() as any).error,'PASSWORD_REQUIRED');else assert.match(await response.text(),/Project password required/);}
    assert.equal((await f.request(BASE,json({password:PASS}))).status,401,'legacy body credentials cannot bypass the cookie');
    assert.equal((await f.request(BASE+'/drawings?ids=dwg-001',{headers:{'X-Project-Password':PASS}})).status,401,'legacy headers cannot bypass the cookie');
    assert.equal((await f.unlock('incorrect')).status,401);
    const response=await f.unlock(),setCookie=response.headers.get('set-cookie')!;assert.equal(response.status,200);assert.match(setCookie,/HttpOnly; SameSite=Strict; Max-Age=43200/);assert.doesNotMatch(setCookie,/; Secure/);
    const headers={Cookie:setCookie.split(';')[0]};
    assert.equal((await f.request(BASE,{...json({conf:{password:'forbidden'}},headers),method:'PATCH'})).status,403,'project unlock does not grant administrator writes');
    for(const route of [BASE+'/drawings?ids=dwg-001',BASE+'/review-tracker',BASE+'/heartbeat',BASE+'/audit?from=2000-01-01&to=2100-01-01',BASE+'/comments',BASE+'/comments.xlsx','/api/pcf/'+P+'/index','/api/pcf/'+P+'/presence','/pcf/'+P+'/dwg-005','/api/pcf/'+P+'/dwg-005/data','/api/pcf/'+P+'/dwg-005/meta','/api/pcf/'+P+'/dwg-005/history','/api/pcf/'+P+'/dwg-005/exports'])assert.equal((await f.request(route,{headers})).status,200,route+' unlocked');
    const loaded=await f.request(BASE,json({},headers));assert.equal(loaded.status,200);const body=await loaded.text();assert.doesNotMatch(body,/fictional-project|scrypt\$|password_hash|"password":/);
    const drawingStream=await f.request('/api/pcf/'+P+'/dwg-005/events?clientId=test-reader',{headers});assert.equal(drawingStream.status,200);const drawingReader=drawingStream.body!.getReader();await drawingReader.read();
    const stream=await f.request(BASE+'/events',{headers});assert.equal(stream.status,200);const reader=stream.body!.getReader();await reader.read();
    const admin=await f.login(),oldState=passwordState(f.hub.db,P);
    const changed=await f.request(BASE,{...json({conf:{password:'fictional-new-password'},confBase:{passwordVersion:oldState.version}},{Cookie:admin}),method:'PATCH'});assert.equal(changed.status,200);
    assert.equal((await f.request(BASE,json({},headers))).status,401,'changing password invalidates old cookie immediately');
    f.hub.writer.realtime.projectChanged(P,'dwg-005',['title']);assert.equal((await reader.read()).done,true,'existing SSE is closed before next project event');
    f.hub.writer.realtime.bus.publish(P+'/dwg-005',{type:'changed',data:{secret:'must not reach revoked session'}});assert.equal((await drawingReader.read()).done,true,'existing drawing SSE is closed before next event');
    const next=await f.unlock('fictional-new-password'),nextCookie=next.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await f.request(BASE+'/heartbeat',{headers:{Cookie:nextCookie}})).status,200);
    assert.equal((await f.request(BASE,{...json({conf:{password:''}},{Cookie:admin}),method:'PATCH'})).status,200);
    assert.equal(passwordState(f.hub.db,P).hash,'');assert.equal((await f.request(BASE,json({}))).status,200);
    setProjectPassword(f.hub.db,P,'fictional-new-password');assert.equal((await f.request(BASE,json({},{Cookie:nextCookie}))).status,401,'clear then reset cannot revive an older cookie');
    assert.equal((await f.request(BASE,json({},{Cookie:admin}))).status,200,'administrator bypass');
  } finally{await f.close();}
});

test('per-source per-project rate limiting, signed cookie expiry/tampering and proxy Secure policy',async()=>{
  const db=openDatabase(':memory:');try{
    db.exec("INSERT INTO projects(id,name) VALUES('a','A'),('b','B')");setProjectPassword(db,'a',PASS);setProjectPassword(db,'b',PASS);
    let now=1000;const session=createProjectSession(db,{isAdmin:()=>false},()=>now);
    const request=(password:string,ip='one',forwarded?:string)=>new Request('http://local/api/projects/a/unlock',{...json({password},{'X-Hub-Remote-Address':ip,...(forwarded?{'X-Forwarded-Proto':forwarded}:{})})});
    for(let i=0;i<5;i++)assert.equal((await session.unlock(request('wrong'),'a')).status,401);
    const limited=await session.unlock(request(PASS),'a');assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'600');
    assert.equal((await session.unlock(request(PASS),'b')).status,200,'other project not locked');assert.equal((await session.unlock(request(PASS,'two'),'a')).status,200,'other source not locked');
    now+=10*60000;const success=await session.unlock(request(PASS),'a'),cookie=success.headers.get('set-cookie')!.split(';')[0];assert.equal(success.status,200);
    const read=(value:string)=>new Request('http://local/api/projects/a',{headers:{Cookie:value}});assert.equal(session.allowed(read(cookie),'a'),true);assert.equal(session.allowed(read(cookie+'x'),'a'),false);assert.equal(session.allowed(read(cookie),'b'),false);
    assert.equal(createProjectSession(db,{isAdmin:()=>false},()=>now).allowed(read(cookie),'a'),false,'restart rotates the signing key');
    assert.match((await session.unlock(new Request('https://local/api/projects/a/unlock',json({password:PASS})),'a')).headers.get('set-cookie')!,/; Secure/);
    assert.match((await session.unlock(request(PASS,'one','HTTPS, http'),'a')).headers.get('set-cookie')!,/; Secure/);assert.doesNotMatch((await session.unlock(request(PASS,'one','http, https'),'a')).headers.get('set-cookie')!,/; Secure/);
    now+=12*3600000;assert.equal(session.allowed(read(cookie),'a'),false);
  } finally{db.close();}
});

test('API token bypasses project locks, and all export/admin/SQL surfaces exclude password material',async()=>{
  const f=await fixture('fictional-machine-token');try{
    const machine={Authorization:'Bearer fictional-machine-token'};assert.equal((await f.request(BASE,json({},machine))).status,200);
    const adminAuth=await f.request('/api/admin/auth',json({password:'fictional-admin-test-password'}));const token=(await adminAuth.json() as any).token,headers={Authorization:'Bearer '+token};
    f.hub.db.prepare("INSERT INTO audit_log(table_name,action,detail) VALUES('project_settings','INSERT',?)").run(JSON.stringify({setting_key:'password',setting_value:'fictional-legacy-audit-secret'}));
    for(const route of ['/api/projects','/api/admin/api/export','/api/admin/api/tables/project_settings','/api/admin/api/tables/audit_log','/api/admin/api/tables']){
      const response=await f.request(route,{headers:route==='/api/projects'?machine:headers});assert.equal(response.status,200,route);assert.doesNotMatch(await response.text(),/fictional-project-test-password|fictional-legacy-audit-secret|scrypt\$|password_hash|project_passwords/);
    }
    const sql=await f.request('/api/admin/api/sql',json({query:'SELECT setting_value AS harmless_alias FROM project_settings UNION ALL SELECT detail FROM audit_log'},headers));assert.equal(sql.status,200);assert.doesNotMatch(await sql.text(),/fictional-project-test-password|fictional-legacy-audit-secret|scrypt\$/);
    const blocked=await f.request('/api/admin/api/sql',json({query:'SELECT hex(password_hash) AS alias FROM project_passwords'},headers));assert.equal(blocked.status,400);
    assert.equal((await f.request('/api/admin/api/tables/project_passwords',{headers})).status,403);
    assert.equal((await f.request('/api/admin/api/tables/project_settings',json({project_id:P,setting_key:'password',setting_value:'fictional-plaintext'},headers))).status,400);
  } finally{await f.close();}
});
