import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ProjectWriter } from './project-write.ts';
import { PcfStorage } from './pcf-storage.ts';
import { PcfRealtime } from './pcf-realtime.ts';
import { ROOT_DIR, readConfig } from './config.ts';
import { initializeSchema } from './database.ts';
import { normalizeLegacySql, normalizeLegacyExport } from './import-legacy.ts';

type ExportEntry = { project: { id: string; drawings: { id: string }[] }; reviewTracker?: Record<string, unknown> };

function validateExport(value: unknown): asserts value is { projects: ExportEntry[]; projectCount?: number } {
  const data = value as { projects?: ExportEntry[]; projectCount?: number };
  if (!data || !Array.isArray(data.projects)) throw new Error('Expected Worker export { projects: [{ project, reviewTracker }] }');
  if (data.projectCount !== undefined && data.projectCount !== data.projects.length) throw new Error('projectCount mismatch');
  const projectIds = new Set<string>();
  const drawingIds = new Set<string>();
  for (const entry of data.projects) {
    const project = entry?.project;
    if (!project || typeof project.id !== 'string' || !project.id || !Array.isArray(project.drawings)) throw new Error('Invalid project entry');
    if (projectIds.has(project.id)) throw new Error('Duplicate project id: ' + project.id);
    projectIds.add(project.id);
    for (const drawing of project.drawings) {
      if (!drawing || typeof drawing.id !== 'string' || !drawing.id || drawingIds.has(drawing.id)) throw new Error('Invalid or duplicate drawing id');
      drawingIds.add(drawing.id);
    }
    if (entry.reviewTracker !== undefined && (!entry.reviewTracker || typeof entry.reviewTracker !== 'object' || Array.isArray(entry.reviewTracker))) {
      throw new Error('Invalid reviewTracker');
    }
  }
}

export async function importData(source: string, destination: string) {
  const content = (await readFile(source, 'utf8')).replace(/^\uFEFF/, '');
  for (const file of [destination, destination + '-wal', destination + '-shm']) {
    if (await access(file).then(() => true, () => false)) throw new Error('Refusing to overwrite existing database: ' + file);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const stageDir = await mkdtemp(path.join(path.dirname(destination), '.pahub-import-'));
  const stageFile = path.join(stageDir, 'stage.db');
  let sqlite: DatabaseSync | undefined = new DatabaseSync(stageFile);
  try {
    if (content.trimStart().startsWith('{')) {
      const data: unknown = JSON.parse(content);
      normalizeLegacyExport(data);
      validateExport(data);
      sqlite.exec('PRAGMA foreign_keys = ON');
      initializeSchema(sqlite);
      const realtime = new PcfRealtime();
      const writer = new ProjectWriter(new PcfStorage(sqlite,stageDir),realtime);
      sqlite.exec('SAVEPOINT pahub_import');
      try {
        for (const entry of data.projects) {
          const verification = await writer.save(entry.project.id,entry.project,entry.reviewTracker || {},'import');
          if (!verification.ok) throw new Error('Project import verification failed: ' + JSON.stringify(verification));
        }
        sqlite.prepare("INSERT INTO audit_log(table_name,action,detail) VALUES('FULL_DB','IMPORT',?)").run(JSON.stringify({imported:data.projects.length}));
        sqlite.exec('RELEASE pahub_import');
      } catch (error) { sqlite.exec('ROLLBACK TO pahub_import; RELEASE pahub_import'); throw error; }
      finally { realtime.close(); }
    } else {
      // A Wrangler full dump carries its own schema/transactions. A seed or data-only dump does not.
      const hasSchema = /\bCREATE\s+TABLE\b/i.test(content);
      if (!hasSchema) initializeSchema(sqlite);
      // Dumps can insert child rows before parent rows. Validate all foreign keys afterwards.
      sqlite.exec('PRAGMA foreign_keys = OFF');
      sqlite.exec(normalizeLegacySql(content));
      sqlite.exec('PRAGMA foreign_keys = ON');
      initializeSchema(sqlite);
    }
    const integrity = sqlite.prepare('PRAGMA integrity_check').get()!;
    if (integrity.integrity_check !== 'ok') throw new Error('SQLite integrity check failed: ' + JSON.stringify(integrity));
    const counts = {
      projects: Number(sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n),
      drawings: Number(sqlite.prepare('SELECT COUNT(*) AS n FROM drawings').get()!.n),
      audit_log: Number(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n),
    };
    sqlite.close(); sqlite = undefined;
    await copyFile(stageFile, destination, constants.COPYFILE_EXCL);
    console.log('Imported ' + path.basename(source) + ' -> ' + destination);
    console.log(JSON.stringify({ ...counts, integrity: 'ok' }));
    return counts;
  } finally {
    sqlite?.close();
    await unlink(stageFile).catch(() => {});
    await unlink(stageFile + '-journal').catch(() => {});
    await rmdir(stageDir);
  }
}

export async function runImport(args = process.argv.slice(2)) {
  const config = readConfig();
  if (args.includes('--help') || !args.length) {
    console.log('Usage: npm run hub:import-d1 -- SOURCE.sql|SOURCE.json [--db PATH]');
    return;
  }
  if (args.length !== 1 && (args.length !== 3 || args[1] !== '--db')) throw new Error('Invalid arguments; use --help');
  await importData(path.resolve(ROOT_DIR, args[0]), path.resolve(ROOT_DIR, args[2] || config.dbPath));
}
