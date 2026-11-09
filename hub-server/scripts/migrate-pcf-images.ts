// One-off: move inline base64 PCF images into content-addressed files (see src/pcf-image-migration.ts).
// Idempotent; back up the data directory and stop Hub before running it for real.
import path from 'node:path';
import { ROOT_DIR } from '../src/config.ts';
import { migratePcfImages } from '../src/pcf-image-migration.ts';
const args = process.argv.slice(2);
let dataDir = process.env.PAHUB_DATA_DIR || 'data', dryRun = false, hubStopped = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--hub-stopped') hubStopped = true;
  else if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[++i];
  else throw Error('Usage: npm run hub:migrate-pcf-images -- [--data-dir DIR] [--dry-run | --hub-stopped]');
}
if (!dryRun && !hubStopped) throw Error('Stop Hub first and pass --hub-stopped (or use --dry-run)');
const report = migratePcfImages({ dataDir: path.resolve(ROOT_DIR, dataDir), dryRun });
console.log(JSON.stringify({ ...report, files: report.files.length > 50 ? [...report.files.slice(0, 50), '... ' + (report.files.length - 50) + ' more'] : report.files }, null, 2));
