import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { initializeSchema, migrationSql } from '../src/database.ts';
import { Router } from '../src/router.ts';
import { registerSystemRoutes } from '../src/system-routes.ts';
const baselinePath=process.env.PAHUB_WORKER_BASELINE;
const oldWorker=baselinePath?(await import(pathToFileURL(baselinePath).href)).default:undefined;
const D1Adapter=baselinePath?(await import(new URL("d1.mjs",pathToFileURL(baselinePath)).href)).D1Adapter:class {constructor(..._args:unknown[]) {}};

test('settings, health and API discovery match Worker with empty and populated tables',async () => {
  const db=new DatabaseSync(':memory:');
  try{
    initializeSchema(db);if(oldWorker)db.exec(migrationSql('001_schema.sql'));const router=new Router();registerSystemRoutes(router,db);const env={PAPC_DB:new D1Adapter(db)};
    const compare=async () => {for(const url of ['/','/health','/settings']){
      const response=await router.handle(new Request('http://local/api'+url));assert.equal(response.status,200);
      if(oldWorker){const old=await oldWorker.fetch(new Request('http://local'+url),env);assert.deepEqual(await response.json(),await old.json());}
    }};
    await compare();
    db.exec("INSERT INTO projects(id,name) VALUES('p','P'),('q','Q'); INSERT INTO reviewers VALUES('r','Reviewer'); INSERT INTO discipline_defaults VALUES('p','Hull','r'); INSERT INTO project_settings VALUES('p','holidays','[\"2026-11-08\"]'),('p','roundACycle','14'),('p','otherRoundsCycle','7'),('p','displayName','Name'),('p','autoSyncInterval','3')");
    await compare();
    db.exec('DROP VIEW IF EXISTS api_settings');
    assert.equal((await router.handle(new Request('http://local/api/health'))).status,200);
    assert.equal((await router.handle(new Request('http://local/api/settings'))).status,200);
  }finally{db.close();}
});
