import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { initializeSchema } from '../src/database.ts';
import { Router } from '../src/router.ts';
import { registerActivityRoutes } from '../src/activity-routes.ts';
const baselinePath=process.env.PAHUB_WORKER_BASELINE;
const oldWorker=baselinePath?(await import(pathToFileURL(baselinePath).href)).default:undefined;
const D1Adapter=baselinePath?(await import(new URL("d1.mjs",pathToFileURL(baselinePath)).href)).D1Adapter:class {constructor(..._args:unknown[]) {}};

test('audit boundaries, invalid details, ordering and truncation preserve Worker behavior',async () => {
  const db=new DatabaseSync(':memory:');
  try {
    initializeSchema(db);db.exec("INSERT INTO projects(id,name) VALUES('p','P')");
    const insert=db.prepare('INSERT INTO audit_log(project_id,table_name,row_id,action,detail,created_at) VALUES(?,?,?,?,?,?)');
    insert.run('p','drawings','d','STATUS','{"from":"Pending","to":"Reviewing","customId":"001"}','2026-11-07T16:00:00Z');
    insert.run('p','drawings','d','COMMENTS','bad json','2026-11-08T15:59:59Z');
    insert.run('p','drawings','d','STATUS','{}','2026-11-08T16:00:00Z');
    insert.run('p','drawings','d','SQL','{}','2026-11-08T00:00:00Z');
    const router=new Router();registerActivityRoutes(router,db);
    const env={PAPC_DB:new D1Adapter(db)};
    const compare=async (query:string) => {
      const response=await router.handle(new Request('http://local/api/projects/p/audit'+query));
      if(oldWorker){const old=await oldWorker.fetch(new Request('http://local/projects/p/audit'+query),env);assert.equal(response.status,old.status);assert.deepEqual(await response.clone().json(),await old.json());}
      return response.json();
    };
    const result=await compare('?from=2026-11-07T16:00:00Z&to=2026-11-08T16:00:00Z');assert.equal(result.entries.length,2);assert.deepEqual(result.entries[0].detail,{});assert.equal(result.truncated,false);
    assert.ok((await compare('')).error);
    for(let i=0;i<2001;i++)insert.run('p','drawings','d','STATUS','{}','2026-11-08T01:00:00Z');
    const full=await compare('?from=2026-11-08T00:00:00Z&to=2026-11-08T16:00:00Z');assert.equal(full.entries.length,2000);assert.equal(full.truncated,true);
  }finally{db.close();}
});
test('heartbeat reads and writes match Worker and persist only project setting',async () => {
  const db=new DatabaseSync(':memory:');
  try{
    initializeSchema(db);db.exec("INSERT INTO projects(id,name) VALUES('p','P')");
    const router=new Router();registerActivityRoutes(router,db);const env={PAPC_DB:new D1Adapter(db)};
    for(const method of ['GET','PUT','GET']){
      const response=await router.handle(new Request('http://local/api/projects/p/heartbeat',{method}));
      const body=await response.json();assert.equal(response.status,200);
      if(oldWorker){const old=await oldWorker.fetch(new Request('http://local/projects/p/heartbeat',{method}),env);const expected=await old.json();if(method==='GET')assert.deepEqual(body,expected);else assert.deepEqual(body,{success:true});}
    }
    assert.ok(db.prepare("SELECT setting_value FROM project_settings WHERE setting_key='admin_last_seen'").get());
  }finally{db.close();}
});
