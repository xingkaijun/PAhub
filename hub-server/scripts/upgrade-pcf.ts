// Run with the Hub stopped: this is an offline, data-preserving maintenance tool.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/config.ts';
import { safeId } from '../src/pcf-model.ts';
import { upgradeFile } from '../src/pcf-template.ts';
const args = process.argv.slice(2); let dryRun = false, project: string | undefined, drawing: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--project') project = safeId(args[++i]);
  else if (args[i] === '--drawing') drawing = safeId(args[++i]);
  else throw Error('Usage: npm run hub:upgrade-pcf -- [--dry-run] [--project X] [--drawing Y]');
}
const base = path.join(path.resolve(ROOT_DIR, process.env.PAHUB_DATA_DIR || 'data'), 'pcf');
const report: unknown[] = [];
if (existsSync(base)) for (const p of readdirSync(base, { withFileTypes: true })) {
  if (!p.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(p.name) || (project && p.name !== project)) continue;
  for (const f of readdirSync(path.join(base, p.name), { withFileTypes: true })) {
    if (!f.isFile() || !/^[A-Za-z0-9_-]{1,128}\.html$/.test(f.name) || (drawing && f.name !== drawing + '.html')) continue;
    // Deliberately excludes exports, import receipts, historical HTML and backups.
    report.push(upgradeFile(path.join(base, p.name, f.name), dryRun));
  }
}
console.log(JSON.stringify({ dryRun, files: report.length, report }, null, 2));
