import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { openDatabase } from '../src/database.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { PcfExchange } from '../src/pcf-exchange.ts';
import { exportPcfProject } from '../src/pcf-project-export.ts';
import { parseHTML } from '../src/pcf-html.ts';
import { ROOT_DIR } from '../src/config.ts';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-project-export-')), db = openDatabase(path.join(dir, 'papc.db'));
  db.exec(readFileSync(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const storage = new PcfStorage(db, dir), exchange = new PcfExchange(storage), p = 'proj-test-001', actor = { clientId: 'fixture', clientName: 'Fixture', ip: '' };
  storage.create(p, 'dwg-001', actor); storage.create(p, 'dwg-002', actor);
  return { dir, db, storage, exchange, p, actor, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function unzip(bytes: Buffer) {
  const result = new Map<string, string>(); let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const size = bytes.readUInt32LE(at + 18), nameSize = bytes.readUInt16LE(at + 26), extra = bytes.readUInt16LE(at + 28), start = at + 30 + nameSize + extra;
    const name = bytes.subarray(at + 30, at + 30 + nameSize).toString('utf8');
    result.set(name, inflateRawSync(bytes.subarray(start, start + size)).toString('utf8')); at = start + size;
  }
  return result;
}

test('project ZIP contains complete independent HTML, baseline records and skipped no-PCF manifest rows', () => {
  const f = fixture(); try {
    const live = f.storage.load(f.p, 'dwg-001'); live.data.circulation = [{ id: 'circulation-business', action: 'Sent', at: '2026-11-08' }]; live.data.approvalHistory = [{ id: 'approval-business', status: 'Approved' }];
    f.storage.replace(f.p, 'dwg-001', { baseRev: live.rev, data: live.data }, f.actor);
    const report = exportPcfProject(f.storage, f.exchange, f.p, path.join(f.dir, '项目完整.zip'), f.actor);
    assert.equal(report.documents, 2); assert.equal(report.skipped, 4);
    const files = unzip(readFileSync(report.output)); assert.deepEqual([...files.keys()], ['dwg-001.html', 'dwg-002.html', 'manifest.json']);
    const data = parseHTML(files.get('dwg-001.html')!);
    assert.equal(data.export.mode, 'complete'); assert.equal(data.circulation[0].id, 'circulation-business'); assert.equal(data.approvalHistory[0].id, 'approval-business'); assert.equal(data.hub, undefined);
    assert.doesNotMatch(files.get('dwg-001.html')!, /PAhub adapter:|X-PCF-Token|id="pahub-context"/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pcf_exports').get()!.n, 2);
    for (const row of report.drawings.filter((r: any) => r.status === 'exported')) assert.equal(f.exchange.download(f.p, row.drawingId, row.exportId).html, files.get(row.file));
    assert.equal(JSON.parse(files.get('manifest.json')!).documents, 2);
  } finally { f.cleanup(); }
});

test('failed complete baseline insertion leaves no orphan export file or partial ZIP', () => {
  const f = fixture(); try {
    f.db.exec("CREATE TRIGGER reject_complete_export BEFORE INSERT ON pcf_exports BEGIN SELECT RAISE(ABORT,'simulated export insert failure'); END");
    assert.throws(() => exportPcfProject(f.storage, f.exchange, f.p, path.join(f.dir, 'failed.zip'), f.actor), /simulated export insert failure/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pcf_exports').get()!.n, 0);
    assert.deepEqual(readdirSync(path.join(f.dir, 'pcf', f.p, 'dwg-001', 'exports')), []);
  } finally { f.cleanup(); }
});

test('export refuses overwrite and rolls back records/files when a later document fails', () => {
  const f = fixture(); try {
    const target = path.join(f.dir, 'exists.zip'); writeFileSync(target, 'KEEP');
    assert.throws(() => exportPcfProject(f.storage, f.exchange, f.p, target, f.actor), /already exists/);
    assert.equal(readFileSync(target, 'utf8'), 'KEEP'); assert.equal(f.db.prepare('SELECT count(*) AS n FROM pcf_exports').get()!.n, 0);
    writeFileSync(f.storage.file(f.p, 'dwg-002'), '{corrupted');
    assert.throws(() => exportPcfProject(f.storage, f.exchange, f.p, path.join(f.dir, 'new.zip'), f.actor));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pcf_exports').get()!.n, 0);
    assert.deepEqual(readdirSync(path.join(f.dir, 'pcf', f.p, 'dwg-001', 'exports')), []);
  } finally { f.cleanup(); }
});
