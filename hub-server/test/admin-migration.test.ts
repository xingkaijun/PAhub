import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {initializeSchema} from '../src/database.ts';
import {PcfStorage} from '../src/pcf-storage.ts';
import {PcfRealtime} from '../src/pcf-realtime.ts';
import {ProjectWriter} from '../src/project-write.ts';
import {AdminApi} from '../src/admin-api.ts';
import {Router} from '../src/router.ts';
import {ROOT_DIR} from '../src/config.ts';
const baselinePath=process.env.PAHUB_WORKER_BASELINE;
const oldWorker=baselinePath?(await import(pathToFileURL(baselinePath).href)).default:undefined;
const D1Adapter=baselinePath?(await import(new URL("d1.mjs",pathToFileURL(baselinePath)).href)).D1Adapter:class {constructor(..._args:unknown[]) {}};

test('native admin matches frozen Worker for auth, schema, search, CRUD, SQL and export',async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'pahub-admin-parity-')),db=new DatabaseSync(path.join(dir,'papc.db')),realtime=new PcfRealtime();
 try{
  initializeSchema(db);db.exec(await readFile(path.join(ROOT_DIR,'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
  if(oldWorker)db.exec(await readFile(path.join(ROOT_DIR,'hub-server/test/fixtures/legacy-views.sql'),'utf8'));
  const writer=new ProjectWriter(new PcfStorage(db,dir),realtime),admin=new AdminApi(db,path.join(dir,'papc.db'),'password',writer),router=new Router();
  router.add({pattern:/^\/api\/admin(?:\/|$)/,auth:'none',handle:ctx=>admin.handle(ctx.request)});
  const env={PAPC_DB:new D1Adapter(db),ADMIN_PASSWORD:'password',ADMIN_SQL:(sql:string)=> {const reader=new DatabaseSync(path.join(dir,'papc.db'),{readOnly:true});try{reader.exec('PRAGMA query_only=ON');return reader.prepare(sql).all();}finally{reader.close();}}};
  const token='admin_token_'+btoa('password').substring(0,10);
  const call=async (url:string,method='GET',body?:any,authenticated=true,parity=true) => {
   const options={method,headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)};
   const actual=await router.handle(new Request('http://local/api/admin'+url,options));
   if(oldWorker && parity){const old=await oldWorker.fetch(new Request('http://local/admin'+url,options),env);assert.equal(actual.status,old.status);const a=await actual.clone().json(),b=await old.json();if(url==='/api/export'){delete a.exportedAt;delete b.exportedAt;}assert.deepEqual(a,b,method+' '+url);}
   return actual;
  };
  await call('/auth','POST',{password:'wrong'},false);await call('/auth','POST',{password:'password'},false);await call('/api/tables','GET',undefined,false);
  await call('/api/tables');await call('/api/tables/drawings/schema');await call('/api/tables/drawings?search=id:DW-A&projectId=proj-test-001');await call('/api/tables/review_tracker?projectId=proj-test-001');
  await call('/api/sql','POST',{query:'SELECT COUNT(*) AS n FROM drawings'});await call('/api/sql','POST',{query:'-- comment\nDELETE FROM projects'});await call('/api/export');
  // Mutations run once against each implementation using distinct rows to avoid duplicate PKs.
  for(const method of ['POST','PUT','DELETE']){
   const url=method==='POST'?'/api/tables/reviewers':'/api/tables/reviewers/native';const data=method==='DELETE'?undefined:method==='POST'?{id:'native',display_name:'Native'}:{display_name:'Updated'};
   assert.deepEqual(await (await call(url,method,data,true,false)).json(),{success:true});
   if(oldWorker){const oldUrl=method==='POST'?'/admin/api/tables/reviewers':'/admin/api/tables/reviewers/legacy';const oldBody=method==='POST'?{id:'legacy',display_name:'Native'}:data;const response=await oldWorker.fetch(new Request('http://local'+oldUrl,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:oldBody===undefined?undefined:JSON.stringify(oldBody)}),env);assert.deepEqual(await response.json(),{success:true});}
  }
  const injection=await call('/api/tables/reviewers','POST',{'display_name) VALUES (\'bad\');--':'bad'},true,false);assert.equal(injection.status,400);
  const page=await router.handle(new Request('http://local/api/admin'));assert.match(await page.text(),/\/api\/admin\/auth/);
 }finally{realtime.close();db.close();await rm(dir,{recursive:true,force:true});}
});
