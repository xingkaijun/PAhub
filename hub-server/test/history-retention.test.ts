import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.ts';
import { ROOT_DIR, PCF_HISTORY_COALESCE_MS } from '../src/config.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { historyDay } from '../src/pcf-history.ts';

const p = 'proj-test-001', d = 'dwg-005';
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-retention-'));
  const db = openDatabase(path.join(dir, 'papc.db'));
  db.sqlite.exec(readFileSync(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
  let at = Date.now(); const storage = new PcfStorage(db.sqlite, dir, () => at);
  const actor = (clientId: string) => ({ clientId, clientName: clientId, ip: '127.0.0.1' });
  storage.create(p, d, actor('A'));
  let count = 0;
  const save = (clientId = 'A') => {
    const current = storage.load(p, d);
    const body = { batchId: randomUUID(), baseRev: current.rev, ops: [{ type: 'project.set', field: 'planTitle', value: 'Edit ' + ++count, baseRev: current.data.hub.entities['project:planTitle']?.rev ?? 0 }] };
    return { body, actor: actor(clientId), result: storage.ops(p, d, body, actor(clientId)) };
  };
  return { db, dir, storage, save, actor, time(value: number) { at = value; }, tick(ms: number) { at += ms; } };
}

test('same client coalesces to pre-segment baseline across storage restart; client and 10min boundaries split', () => {
  const f = fixture(); try {
    const baseline = f.storage.load(p, d).data.project.planTitle;
    for (let i = 0; i < 10; i++) { f.tick(60000); assert.equal(f.save().result.rev, i + 2); }
    assert.equal(f.storage.history(p, d).length, 1);
    const entry = f.storage.history(p, d)[0]; assert.equal(entry.rev, 1);
    assert.equal(JSON.parse(readFileSync(path.join(f.storage.historyDir(p, d), entry.filename), 'utf8')).project.planTitle, baseline);
    const restarted = new PcfStorage(f.db.sqlite, f.dir, () => Date.now() + 11 * 60000);
    const current = restarted.load(p, d);
    restarted.replace(p, d, { baseRev: current.rev, data: { ...current.data, project: { ...current.data.project, planTitle: 'Restart edit' } } }, f.actor('A'));
    assert.equal(restarted.history(p, d).length, 1);
    f.time(Date.now() + 12 * 60000); f.save('B'); assert.equal(f.storage.history(p, d).length, 2);
    f.tick(PCF_HISTORY_COALESCE_MS); f.save('B'); assert.equal(f.storage.history(p, d).length, 3);
    const restored = f.storage.replace(p, d, { baseRev: f.storage.load(p, d).rev }, f.actor('restore'), 1);
    assert.equal(restored.data.project.planTitle, baseline);
  } finally { f.db.sqlite.close(); }
});

test('keep latest 50 plus each Shanghai calendar day final entry, without pruning changes, audit or receipts', () => {
  const f = fixture(); try {
    const start = Date.parse('2026-10-01T15:00:00Z');
    for (let day = 0; day < 3; day++) {
      f.time(start + day * 86400000); f.save('day-' + day + '-early');
      f.tick(30 * 60000); f.save('day-' + day + '-late');
    }
    const daily = f.storage.history(p, d); assert.equal(historyDay(daily[0].savedAt), '2026-10-03');
    f.time(Date.parse('2026-10-03T16:00:00Z')); // Shanghai midnight is UTC 16:00.
    for (let i = 0; i < 60; i++) { f.tick(60000); f.save('recent-' + i); }
    const retained = f.storage.history(p, d), revs = retained.map(e => e.rev);
    assert.equal(retained.length, 53);
    assert.deepEqual(revs.slice(0, 50), Array.from({ length: 50 }, (_, i) => 66 - i));
    assert.deepEqual(revs.slice(50), [6, 4, 2]);
    for (const table of ['pcf_changes', 'audit_log']) assert.equal(Number(f.db.sqlite.prepare('SELECT count(*) AS n FROM ' + table + " WHERE project_id=? AND " + (table === 'pcf_changes' ? 'drawing_id' : 'row_id') + '=?').get(p, d)!.n), 67);
    assert.equal(f.storage.load(p, d).data.hub.receipts.length, 66);
  } finally { f.db.sqlite.close(); }
});

test('missing replay revision returns 409; receipts stay intact and missing restore returns 404', () => {
  const f = fixture(); try {
    const first = f.save(); f.tick(1000); f.save();
    assert.throws(() => f.storage.ops(p, d, first.body, first.actor), (error: any) => error.status === 409 && /no longer retained/.test(error.message));
    const latest = f.storage.load(p, d);
    assert.equal(latest.rev, 3); assert.equal(latest.data.hub.receipts.length, 2);
    assert.throws(() => f.storage.replace(p, d, { baseRev: latest.rev }, f.actor('A'), 2), (error: any) => error.status === 404);
    const last = f.save('B'); assert.deepEqual(f.storage.ops(p, d, last.body, last.actor), last.result);
    f.tick(1000); f.save('C');
    assert.deepEqual(f.storage.ops(p, d, last.body, last.actor), last.result);
    const entry = f.storage.history(p, d).find(e => e.rev === last.result.rev)!;
    unlinkSync(path.join(f.storage.historyDir(p, d), entry.filename));
    assert.throws(() => f.storage.ops(p, d, last.body, last.actor), (error: any) => error.status === 409);
    assert.equal(f.storage.load(p, d).data.hub.receipts.length, 4);
  } finally { f.db.sqlite.close(); }
});

