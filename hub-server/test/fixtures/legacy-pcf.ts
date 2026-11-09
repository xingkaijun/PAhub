import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/database.ts';
import { ROOT_DIR } from '../../src/config.ts';
import { PcfStorage } from '../../src/pcf-storage.ts';
import { renderTemplate } from '../../src/pcf-template.ts';

export function legacyPcfFixture() {
  const parent = mkdtempSync(path.join(tmpdir(), 'pahub-migrate-json-test-')), dir = path.join(parent, 'data'); mkdirSync(dir);
  const db = openDatabase(path.join(dir, 'papc.db'));
  db.exec(readFileSync(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const p = 'proj-test-001', d = 'dwg-005', storage = new PcfStorage(db, dir), actor = { clientId: 'fixture', clientName: '', ip: '127.0.0.1' };
  storage.create(p, d, actor); const baseline = storage.load(p, d).data;
  storage.ops(p, d, { baseRev: 1, batchId: randomUUID(), ops: [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }] }, actor);
  const data = storage.load(p, d).data;
  const html = renderTemplate(data); writeFileSync(storage.file(p, d).replace(/\.json$/, '.html'), html, 'utf8'); rmSync(storage.file(p, d));
  const h = storage.historyDir(p, d);
  const snapshot = readdirSync(h).find(n => n.endsWith('.json') && !n.startsWith('.'))!;
  const historyFile = path.join(h, snapshot);
  writeFileSync(historyFile.replace(/\.json$/, '.html'), renderTemplate(JSON.parse(readFileSync(historyFile, 'utf8'))), 'utf8'); rmSync(historyFile);
  const manifest = path.join(h, '.retention.json'), value = JSON.parse(readFileSync(manifest, 'utf8')); value.filename = value.filename.replace(/\.json$/, '.html'); writeFileSync(manifest, JSON.stringify(value));
  db.prepare("UPDATE pcf_index SET file_path=replace(file_path,'.json','.html')").run();
  db.exec('PRAGMA user_version=1'); db.close();
  const exportDir = path.join(dir, 'pcf', p, d, 'exports'); mkdirSync(exportDir, { recursive: true }); writeFileSync(path.join(exportDir, 'baseline.html'), html);
  return { parent, dir, p, d, data, baseline, snapshot: snapshot.replace(/\.json$/, '.html'), html, cleanup() { rmSync(parent, { recursive: true, force: true }); } };
}
