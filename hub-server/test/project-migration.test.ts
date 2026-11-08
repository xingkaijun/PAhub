import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/database.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { PcfRealtime } from '../src/pcf-realtime.ts';
import { writeDrawing } from '../src/drawing-write.ts';
import { ProjectWriter } from '../src/project-write.ts';
import { registerProjectRoutes } from '../src/project-routes.ts';
import { registerTrackerRoutes } from '../src/tracker-routes.ts';
import { Router } from '../src/router.ts';
import { ROOT_DIR } from '../src/config.ts';
import { getProjectDetail, getProjectList, getSettings, getReviewTracker } from '../src/project-read.ts';

const baselinePath = process.env.PAHUB_WORKER_BASELINE;
const oldWorker = baselinePath ? (await import(pathToFileURL(baselinePath).href)).default : undefined;
const D1Adapter=baselinePath?(await import(new URL("d1.mjs",pathToFileURL(baselinePath)).href)).D1Adapter:class {constructor(..._args:unknown[]) {}};

test('native normalized reads preserve the legacy view contract', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db); db.exec(await readFile(path.join(ROOT_DIR,"hub-server/test/fixtures/legacy-views.sql"),"utf8")); db.exec(await readFile(path.join(ROOT_DIR,'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(getProjectList(db))),JSON.parse(JSON.stringify(db.prepare('SELECT * FROM api_projects ORDER BY name COLLATE NOCASE ASC').all().map(row => ({id:row.id,name:row.name,storagePath:row.storage_path || undefined,lastUpdated:row.last_updated || undefined})))));
    const row = db.prepare('SELECT * FROM api_project_details').get()!;
    const expected = {...JSON.parse(String(row.project_json)),...(row.storage_path ? {storagePath:row.storage_path} : {}),conf:JSON.parse(String(row.conf_json)),lastUpdated:row.last_updated};
    expected.drawings.forEach((d:any) => d.hasPcf=false);
    assert.deepEqual(JSON.parse(JSON.stringify(getProjectDetail(db,'proj-test-001'))),expected);
    assert.deepEqual(getSettings(db),JSON.parse(String(db.prepare('SELECT value FROM api_settings').get()!.value)));
    assert.deepEqual(getReviewTracker(db,'proj-test-001'),JSON.parse(String(db.prepare('SELECT data_json FROM api_review_trackers').get()!.data_json)));
    db.prepare("UPDATE drawings SET _deleted=1 WHERE id='dwg-006'").run();
    assert.equal(getProjectDetail(db,'proj-test-001')!.drawings.length,5);
  } finally { db.close(); }
});

test('same project requests match frozen Worker before route cutover', {skip:!oldWorker}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'pahub-project-parity-'));
  const dbs = [new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const realtime = [new PcfRealtime(),new PcfRealtime()];
  try {
    const seed = await readFile(path.join(ROOT_DIR,'hub-server/test/fixtures/seed-test-data.sql'),'utf8');
    const legacyViews=await readFile(path.join(ROOT_DIR,"hub-server/test/fixtures/legacy-views.sql"),"utf8");
    dbs.forEach(db => {initializeSchema(db);db.exec(seed);db.exec(legacyViews);});
    const stores = dbs.map((db,i) => new PcfStorage(db,path.join(dir,String(i))));
    const writer = new ProjectWriter(stores[1],realtime[1]);
    const router = new Router();registerProjectRoutes(router,writer);registerTrackerRoutes(router,writer);
    const env = {PAPC_DB:new D1Adapter(dbs[0]),DRAWING_WRITE:(p:string,d:any) => writeDrawing(stores[0],realtime[0],p,d)};
    const compare = async (url:string,method='GET',body?:any) => {
      const options = {method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)};
      const a = await oldWorker.fetch(new Request('http://local'+url,options),env), b = await router.handle(new Request('http://local/api'+url,options));
      assert.equal(b.status,a.status,url);
      if (a.status>=400) {assert.equal((await b.json()).error,await a.text());return;}
      assert.deepEqual(await b.json(),await a.json(),method+' '+url);
    };
    await compare('/projects');await compare('/projects/proj-test-001','POST',{});
    await compare('/projects/proj-test-001/review-tracker');
    await compare('/projects/proj-test-001/review-tracker','PUT',{'dwg-001':{engineer_a:{done:'true',doneAt:'2026-11-08T12:00:00Z'},senior_eng_c:{done:false}},'dwg-002':{engineer_b:{done:1}}});
    await compare('/projects/proj-test-001/review-tracker');
    await compare('/projects/proj-test-001/review-tracker','PUT',{'dwg-001':{engineer_a:{done:false}}});
    await compare('/projects/proj-test-001/review-tracker');
    await compare('/projects/proj-test-001','PATCH',{updatedDrawings:[{id:'dwg-001',changes:{title:'Native title'}}]});
    await compare('/projects/proj-test-001','PATCH',{conf:{displayName:'Display',defaultAssignees:{Hull:['A','B']},disciplineDefaults:{Hull:'B'}}});
    const project = getProjectDetail(dbs[1],'proj-test-001')!;
    await compare('/projects/proj-test-001','PUT',{project,reviewTracker:{'dwg-001':{A:{done:true,doneAt:'2026-11-08T12:00:00Z'},stranger:{done:true}}}});
    await compare('/projects/proj-test-001','PATCH',{deletedDrawingIds:['dwg-006']});
    dbs.forEach(db => db.prepare("INSERT INTO project_settings VALUES('proj-test-001','password','secret')").run());
    await compare('/projects/proj-test-001','POST',{});await compare('/projects/proj-test-001','POST',{password:'wrong'});await compare('/projects/proj-test-001','POST',{password:'secret'});
    for (const table of ['projects','drawings','drawing_assignees','drawing_remarks','review_tracker','project_settings']) assert.deepEqual(dbs[1].prepare('SELECT * FROM '+table).all(),dbs[0].prepare('SELECT * FROM '+table).all(),table);
  } finally {realtime.forEach(r=>r.close());dbs.forEach(db=>db.close());await rm(dir,{recursive:true,force:true});}
});
