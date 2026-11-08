// Offline only: the caller explicitly acknowledges Hub is stopped.
import path from 'node:path';
import { ROOT_DIR } from '../src/config.ts';
import { migratePcfJson } from '../src/pcf-json-migration.ts';
const args = process.argv.slice(2);
let dataDir = process.env.PAHUB_DATA_DIR || 'data', dbPath: string | undefined, dryRun = false, hubStopped = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--hub-stopped') hubStopped = true;
  else if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[++i];
  else if (args[i] === '--db-path' && args[i + 1]) dbPath = path.resolve(ROOT_DIR, args[++i]);
  else throw Error('Usage: npm run hub:migrate-pcf-json -- [--data-dir DIR] [--db-path FILE] [--dry-run | --hub-stopped]');
}
console.log(JSON.stringify(migratePcfJson({ dataDir: path.resolve(ROOT_DIR, dataDir), dbPath, dryRun, hubStopped }), null, 2));
