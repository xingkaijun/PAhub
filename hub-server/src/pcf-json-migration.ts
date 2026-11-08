import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { parseHTML } from './pcf-html.ts';
import { renderTemplate } from './pcf-template.ts';
import { atomicWrite } from './atomic-write.ts';
import { openDatabase, applyPcfJsonMigration } from './database.ts';

const id = /^[A-Za-z0-9_-]{1,128}$/;
type Conversion = { relative: string; json: string; kind: 'document' | 'snapshot'; rev: number; bytes: number };
function scan(base: string) {
  const conversions: Conversion[] = [], retained: string[] = [];
  function walk(relative = '') {
    if (!existsSync(path.join(base, relative))) return;
    for (const entry of readdirSync(path.join(base, relative), { withFileTypes: true })) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw Error('Symlinks are not supported in PCF storage: ' + rel);
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!entry.isFile()) throw Error('Non-regular PCF file: ' + rel);
      const parts = rel.split('/'), history = parts.length === 4 && parts[1] === '.history' && id.test(parts[0]) && id.test(parts[2]);
      const document = parts.length === 2 && id.test(parts[0]) && /^[A-Za-z0-9_-]{1,128}\.html$/.test(parts[1]);
      const snapshot = history && /^(\d+)-(\d+)-[a-f0-9-]+\.html$/i.test(parts[3]);
      if (!document && !snapshot) { retained.push(rel); continue; }
      const bytes = readFileSync(path.join(base, rel)), data = parseHTML(bytes.toString('utf8')), rev = data.hub?.rev;
      if (!Number.isSafeInteger(rev) || rev < 1) throw Error('Invalid PCF revision: ' + rel);
      if (snapshot && Number(parts[3].split('-')[0]) !== rev) throw Error('Snapshot filename/revision mismatch: ' + rel);
      const json = JSON.stringify(data);
      if (!isDeepStrictEqual(JSON.parse(json), data)) throw Error('JSON conversion changed data: ' + rel);
      if (!isDeepStrictEqual(parseHTML(renderTemplate(data)), data)) throw Error('Template round-trip changed data: ' + rel);
      if (existsSync(path.join(base, rel.replace(/\.html$/, '.json')))) throw Error('JSON destination already exists: ' + rel);
      conversions.push({ relative: rel, json, kind: document ? 'document' : 'snapshot', rev, bytes: bytes.length });
    }
  }
  walk(); return { conversions, retained };
}

// Dry-run opens a private copy of the SQLite files, not even a read-only WAL
// connection to the supplied directory (SQLite can still touch shared memory).
function inspectDatabase(dbFile: string, task: (db: DatabaseSync) => void) {
  const temp = mkdtempSync(path.join(tmpdir(), 'pahub-migration-inspect-'));
  try {
    const copy = path.join(temp, 'papc.db'); cpSync(dbFile, copy);
    if (existsSync(dbFile + '-wal')) cpSync(dbFile + '-wal', copy + '-wal');
    const db = new DatabaseSync(copy);
    try { task(db); } finally { db.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function migratePcfJson(options: { dataDir: string; dbPath?: string; dryRun?: boolean; hubStopped?: boolean }) {
  const dataDir = path.resolve(options.dataDir), dbPath = path.resolve(options.dbPath || path.join(dataDir, 'papc.db'));
  if (path.dirname(dbPath) !== dataDir) throw Error('Migration requires the database directly inside dataDir so the complete backup contains DB and WAL');
  if (!existsSync(dbPath)) throw Error('Database not found');
  if (!options.dryRun && !options.hubStopped) throw Error('Stop Hub first and pass --hub-stopped');
  const base = path.join(dataDir, 'pcf'), intentFile = path.join(dataDir, '.pcf-json-migration.json');
  let recovered = false;
  if (existsSync(intentFile)) {
    if (options.dryRun) throw Error('An interrupted migration exists; rerun without --dry-run to recover it first');
    const intent = JSON.parse(readFileSync(intentFile, 'utf8'));
    // Only operate on the exact private staging/backup names written by us.
    if (!/^\.pcf-json-stage-[a-f0-9-]+$/.test(intent.stage) || !/^pcf-html-backup-[\w-]+$/.test(intent.htmlBackup)) throw Error('Invalid migration recovery paths');
    let version = 0; inspectDatabase(dbPath, db => { version = Number(db.prepare('PRAGMA user_version').get()!.user_version); });
    const backup = path.join(dataDir, intent.htmlBackup), stage = path.join(dataDir, intent.stage);
    if (version < 2 && existsSync(backup)) {
      if (existsSync(base)) rmSync(base, { recursive: true });
      renameSync(backup, base);
    }
    if (existsSync(stage)) rmSync(stage, { recursive: true });
    rmSync(intentFile); recovered = true;
  }
  const { conversions, retained } = scan(base);
  let version = 0, indexed = 0;
  inspectDatabase(dbPath, db => {
    version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 2) throw Error('Database is newer than this migration tool');
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pcf_index'").get();
    if (!table && conversions.length) throw Error('PCF index table missing');
    if (table) for (const row of db.prepare('SELECT project_id,drawing_id,rev,file_path FROM pcf_index').all()) {
      indexed++;
      const rel = String(row.project_id) + '/' + String(row.drawing_id) + '.html';
      const converted = conversions.find(c => c.kind === 'document' && c.relative === rel);
      if (converted) {
        if (Number(row.rev) > converted.rev) throw Error('Index ahead of PCF file; restore backup: ' + rel);
        if (String(row.file_path) !== 'pcf/' + rel) throw Error('Unexpected indexed path: ' + rel);
      } else if (!existsSync(path.join(base, rel.replace(/\.html$/, '.json')))) throw Error('Indexed PCF file missing: ' + rel);
    }
  });
  if (version === 2 && conversions.length) throw Error('Database says JSON conversion is complete but legacy documents remain');
  const report = {
    dryRun: !!options.dryRun, dataDir, recovered, status: version === 2 ? 'already-migrated' : options.dryRun ? 'would-migrate' : 'migrated',
    documents: conversions.filter(c => c.kind === 'document').length, snapshots: conversions.filter(c => c.kind === 'snapshot').length,
    indexedDocuments: indexed, retainedFiles: retained.length,
    htmlBytes: conversions.reduce((n, c) => n + c.bytes, 0), jsonBytes: conversions.reduce((n, c) => n + Buffer.byteLength(c.json), 0),
    fromVersion: version, toVersion: 2, fullBackup: '', htmlBackup: '',
  };
  if (options.dryRun || version === 2) return report;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  const fullBackup = dataDir + '-backup-before-pcf-json-' + stamp;
  cpSync(dataDir, fullBackup, { recursive: true, errorOnExist: true, force: false });
  const stageName = '.pcf-json-stage-' + randomUUID(), backupName = 'pcf-html-backup-' + stamp;
  const stage = path.join(dataDir, stageName), htmlBackup = path.join(dataDir, backupName);
  let movedOld = false, installed = false, committed = false;
  const adapter = openDatabase(dbPath), db = adapter.sqlite;
  try {
    if (existsSync(base)) cpSync(base, stage, { recursive: true }); else mkdirSync(stage);
    for (const c of conversions) {
      const source = path.join(stage, c.relative), target = source.replace(/\.html$/, '.json');
      atomicWrite(target, c.json);
      if (!isDeepStrictEqual(JSON.parse(readFileSync(target, 'utf8')), parseHTML(readFileSync(source, 'utf8')))) throw Error('Written JSON verification failed: ' + c.relative);
      rmSync(source);
    }
    // The retention manifest points at a historical file; preserve all other metadata.
    for (const rel of retained.filter(r => r.endsWith('/.retention.json'))) {
      const file = path.join(stage, rel), value = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof value.filename === 'string') value.filename = value.filename.replace(/\.html$/, '.json');
      atomicWrite(file, JSON.stringify(value));
    }
    atomicWrite(intentFile, JSON.stringify({ stage: stageName, htmlBackup: backupName, fullBackup }));
    db.exec('BEGIN EXCLUSIVE');
    try {
      if (existsSync(base)) { renameSync(base, htmlBackup); movedOld = true; }
      renameSync(stage, base); installed = true;
      applyPcfJsonMigration(db);
      // Mark/version and index pointers commit only after every target file exists.
      for (const row of db.prepare('SELECT file_path FROM pcf_index').all()) if (!existsSync(path.join(dataDir, String(row.file_path)))) throw Error('Migrated index target missing');
      db.exec('COMMIT'); committed = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    rmSync(intentFile);
    return { ...report, fullBackup, htmlBackup: movedOld ? htmlBackup : '' };
  } finally {
    db.close();
    if (!committed) {
      if (installed && existsSync(base)) rmSync(base, { recursive: true });
      if (movedOld && existsSync(htmlBackup)) renameSync(htmlBackup, base);
      if (existsSync(stage)) rmSync(stage, { recursive: true });
      if (existsSync(intentFile)) rmSync(intentFile);
    }
  }
}
