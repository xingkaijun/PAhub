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
      const destination = path.join(base, rel.replace(/\.html$/, '.json'));
      // A mixed directory may contain an already-converted copy. Never overwrite
      // a conflicting JSON document: keep both originals and use runtime fallback.
      if (existsSync(destination) && !isDeepStrictEqual(JSON.parse(readFileSync(destination, 'utf8')), data)) throw Error('JSON destination conflicts with HTML: ' + rel);
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

// Called before Hub opens SQLite or accepts requests. A private backup contains
// PCF plus SQLite/WAL/SHM, including databases configured outside dataDir.
function startupBackup(dataDir: string, dbPath: string) {
  const backup = path.join(dataDir, 'backups', 'before-pcf-json-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
  mkdirSync(backup, { recursive: true });
  if (existsSync(path.join(dataDir, 'pcf'))) cpSync(path.join(dataDir, 'pcf'), path.join(backup, 'pcf'), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) cpSync(dbPath + suffix, path.join(backup, 'papc.db' + suffix));
  console.log('[PCF migration] Backup ready: ' + backup);
  return backup;
}

function pendingMigration(dataDir: string) {
  if (existsSync(path.join(dataDir, '.pcf-json-migration.json'))) return true;
  const base = path.join(dataDir, 'pcf');
  function walk(relative = ''): boolean {
    if (!existsSync(path.join(base, relative))) return false;
    for (const entry of readdirSync(path.join(base, relative), { withFileTypes: true })) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw Error('Symlinks are not supported in PCF storage: ' + rel);
      if (entry.isDirectory()) { if (walk(rel)) return true; }
      else if (/^[A-Za-z0-9_-]{1,128}\/([A-Za-z0-9_-]{1,128}\.html|\.history\/[A-Za-z0-9_-]{1,128}\/\d+-\d+-[a-f0-9-]+\.html)$/i.test(rel)) return true;
    }
    return false;
  }
  return walk();
}

export function migratePcfJsonAtStartup(dataDir: string, dbPath: string) {
  if (!existsSync(dbPath)) return;
  try {
    if (!pendingMigration(dataDir)) return;
    console.log('[PCF migration] Legacy/mixed storage detected; migrating before listening');
    const report = migratePcfJson({ dataDir, dbPath, hubStopped: true, backupInsideDataDir: true });
    console.log('[PCF migration] Completed: ' + JSON.stringify(report));
  } catch (error) {
    console.error('[PCF migration] Automatic migration failed; original PCF files retained. Serving legacy HTML fallback; fix the cause and restart to retry.', error);
  }
}

export function migratePcfJson(options: { dataDir: string; dbPath?: string; dryRun?: boolean; hubStopped?: boolean; backupInsideDataDir?: boolean }) {
  const dataDir = path.resolve(options.dataDir), dbPath = path.resolve(options.dbPath || path.join(dataDir, 'papc.db'));
  if (!options.backupInsideDataDir && path.dirname(dbPath) !== dataDir) throw Error('Migration requires the database directly inside dataDir so the complete backup contains DB and WAL');
  if (!existsSync(dbPath)) throw Error('Database not found');
  if (!options.dryRun && !options.hubStopped) throw Error('Stop Hub first and pass --hub-stopped');
  const base = path.join(dataDir, 'pcf'), intentFile = path.join(dataDir, '.pcf-json-migration.json');
  // Back up before validation/recovery can touch anything. A failed validation
  // also leaves operators a timestamped copy of the exact input.
  const startupFullBackup = !options.dryRun && options.backupInsideDataDir ? startupBackup(dataDir, dbPath) : '';
  let recovered = false;
  if (existsSync(intentFile)) {
    if (options.dryRun) throw Error('An interrupted migration exists; rerun without --dry-run to recover it first');
    const intent = JSON.parse(readFileSync(intentFile, 'utf8'));
    // Only operate on the exact private staging/backup names written by us.
    if (!/^\.pcf-json-stage-[a-f0-9-]+$/.test(intent.stage) || !/^pcf-html-backup-[\w-]+$/.test(intent.htmlBackup)) throw Error('Invalid migration recovery paths');
    let version = 0; inspectDatabase(dbPath, db => { version = Number(db.prepare('PRAGMA user_version').get()!.user_version); });
    if (version > 2) throw Error('Database is newer than this migration tool; interrupted migration left untouched');
    const backup = path.join(dataDir, intent.htmlBackup), stage = path.join(dataDir, intent.stage);
    // For a version-2 mixed migration the version cannot identify the commit.
    // Restore the old directory and retry; no requests ran since the journal
    // was written, and the scan accepts either HTML or JSON index pointers.
    if ((version < 2 || intent.fromVersion === 2) && existsSync(backup)) {
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
        if (!['pcf/' + rel, 'pcf/' + rel.replace(/\.html$/, '.json')].includes(String(row.file_path))) throw Error('Unexpected indexed path: ' + rel);
      } else if (!existsSync(path.join(base, rel.replace(/\.html$/, '.json')))) throw Error('Indexed PCF file missing: ' + rel);
    }
  });
  const alreadyMigrated = version === 2 && conversions.length === 0;
  const report = {
    dryRun: !!options.dryRun, dataDir, recovered, status: alreadyMigrated ? 'already-migrated' : options.dryRun ? 'would-migrate' : 'migrated',
    documents: conversions.filter(c => c.kind === 'document').length, snapshots: conversions.filter(c => c.kind === 'snapshot').length,
    indexedDocuments: indexed, retainedFiles: retained.length,
    htmlBytes: conversions.reduce((n, c) => n + c.bytes, 0), jsonBytes: conversions.reduce((n, c) => n + Buffer.byteLength(c.json), 0),
    fromVersion: version, toVersion: 2, fullBackup: '', htmlBackup: '',
  };
  if (options.dryRun || alreadyMigrated) return report;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  const fullBackup = startupFullBackup || dataDir + '-backup-before-pcf-json-' + stamp;
  if (!startupFullBackup) cpSync(dataDir, fullBackup, { recursive: true, errorOnExist: true, force: false });
  const stageName = '.pcf-json-stage-' + randomUUID(), backupName = 'pcf-html-backup-' + stamp;
  const stage = path.join(dataDir, stageName), htmlBackup = path.join(dataDir, backupName);
  let movedOld = false, installed = false, committed = false;
  const adapter = openDatabase(dbPath), db = adapter;
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
    atomicWrite(intentFile, JSON.stringify({ stage: stageName, htmlBackup: backupName, fullBackup, fromVersion: version }));
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
