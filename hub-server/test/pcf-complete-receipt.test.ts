import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.ts';
import { ROOT_DIR } from '../src/config.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { PcfExchange } from '../src/pcf-exchange.ts';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-complete-receipt-')), db = openDatabase(path.join(dir, 'papc.db'));
  db.sqlite.exec(readFileSync(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
  const storage = new PcfStorage(db.sqlite, dir), exchange = new PcfExchange(storage), actor = { clientId: 'owner', clientName: 'Owner', ip: '' }, p = 'proj-test-001', d = 'dwg-005';
  storage.create(p, d, actor);
  const record = exchange.createComplete(p, d, actor), json = exchange.downloadCompleteJSON(p, d, record.exportId).data;
  json.project.planTitle = 'Complete import title'; const preview = exchange.preview(p, d, { json });
  const body = { json, previewToken: preview.previewToken, batchId: randomUUID(), choices: {} };
  return { dir, db, storage, exchange, actor, p, d, record, body, cleanup() { db.sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('complete merge receipt is atomic with data and replays after lost response, newer edit and restart', () => {
  const f = fixture(); try {
    const first = f.exchange.apply(f.p, f.d, f.body, f.actor);
    assert.equal(first.replayed, false);
    const stored = JSON.parse(readFileSync(f.storage.file(f.p, f.d), 'utf8'));
    assert.equal(stored.hub.receipts.at(-1).id, f.body.batchId); assert.equal(stored.hub.receipts.at(-1).kind, 'complete-import');
    assert.equal(existsSync(path.join(f.dir, 'pcf', f.p, f.d, 'imports', f.body.batchId + '.json')), false, 'no separate full data receipt needed');
    assert.equal(f.exchange.list(f.p, f.d)[0].status, 'imported');
    const current = f.storage.load(f.p, f.d);
    f.storage.ops(f.p, f.d, { baseRev: current.rev, batchId: randomUUID(), ops: [{ type: 'project.set', field: 'planNo', value: 'newer plan', baseRev: current.data.hub.entities['project:planNo'].rev }] }, { ...f.actor, clientId: 'other' });
    const restarted = new PcfExchange(new PcfStorage(f.db.sqlite, f.dir));
    const replay = restarted.apply(f.p, f.d, f.body, f.actor);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.result, first.result);
    assert.equal(f.storage.load(f.p, f.d).data.project.planNo, 'newer plan');
    assert.throws(() => restarted.apply(f.p, f.d, { ...f.body, choices: { bad: { choice: 'server' } } }, f.actor), (e: any) => e.status === 409 && /batchId reused/.test(e.message));
  } finally { f.cleanup(); }
});

test('complete export status failure rolls back merge data, revision, receipt and export record', () => {
  const f = fixture(); try {
    const before = readFileSync(f.storage.file(f.p, f.d), 'utf8');
    f.db.sqlite.exec("CREATE TRIGGER reject_import_status BEFORE UPDATE OF status ON pcf_exports WHEN NEW.status='imported' BEGIN SELECT RAISE(ABORT,'simulated status failure'); END");
    assert.throws(() => f.exchange.apply(f.p, f.d, f.body, f.actor), /simulated status failure/);
    assert.equal(readFileSync(f.storage.file(f.p, f.d), 'utf8'), before);
    assert.equal(f.exchange.list(f.p, f.d)[0].status, 'exported');
    assert.equal(f.storage.load(f.p, f.d).data.hub.receipts, undefined);
    f.db.sqlite.exec('DROP TRIGGER reject_import_status');
    assert.equal(f.exchange.apply(f.p, f.d, f.body, f.actor).result.rev, 2);
  } finally { f.cleanup(); }
});
