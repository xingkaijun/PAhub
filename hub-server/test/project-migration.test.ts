import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/database.ts';
import { ROOT_DIR } from '../src/config.ts';
import { getProjectDetail, getProjectList, getSettings, getReviewTracker } from '../src/project-read.ts';

// The frozen-Worker request parity test was removed after route cutover; the D1 Worker is retired and
// the native routes are covered by the project-write, conflict and load-optimization suites.

test('native normalized reads preserve the legacy view contract', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db); db.exec(await readFile(path.join(ROOT_DIR,"hub-server/test/fixtures/legacy-views.sql"),"utf8")); db.exec(await readFile(path.join(ROOT_DIR,'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(getProjectList(db))),JSON.parse(JSON.stringify(db.prepare('SELECT * FROM api_projects ORDER BY name COLLATE NOCASE ASC').all().map(row => ({id:row.id,name:row.name,storagePath:row.storage_path || undefined,lastUpdated:row.last_updated || undefined})))));
    const row = db.prepare('SELECT * FROM api_project_details').get()!;
    const expected = {...JSON.parse(String(row.project_json)),...(row.storage_path ? {storagePath:row.storage_path} : {}),conf:JSON.parse(String(row.conf_json)),lastUpdated:row.last_updated};
    expected.drawings.forEach((d:any) => d.hasPcf=false);
    // rev is additive (optimistic-concurrency token for app saves); the legacy view contract is otherwise unchanged.
    const actual = JSON.parse(JSON.stringify(getProjectDetail(db,'proj-test-001')));
    for (const d of actual.drawings) { assert.match(d.rev,/^[0-9a-f]{16}$/); delete d.rev; }
    assert.deepEqual(actual,expected);
    assert.deepEqual(getSettings(db),JSON.parse(String(db.prepare('SELECT value FROM api_settings').get()!.value)));
    assert.deepEqual(getReviewTracker(db,'proj-test-001'),JSON.parse(String(db.prepare('SELECT data_json FROM api_review_trackers').get()!.data_json)));
    db.prepare("UPDATE drawings SET _deleted=1 WHERE id='dwg-006'").run();
    assert.equal(getProjectDetail(db,'proj-test-001')!.drawings.length,5);
  } finally { db.close(); }
});
