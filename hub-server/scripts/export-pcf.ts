import path from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT_DIR } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { PcfExchange } from '../src/pcf-exchange.ts';
import { exportPcfProject } from '../src/pcf-project-export.ts';
const args = process.argv.slice(2);
let dataDir = process.env.PAHUB_DATA_DIR || 'data', project = '', output = '', hubStopped = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[++i];
  else if (args[i] === '--project' && args[i + 1]) project = args[++i];
  else if (args[i] === '--output' && args[i + 1]) output = args[++i];
  else if (args[i] === '--hub-stopped') hubStopped = true;
  else throw Error('Usage: npm run hub:export-pcf -- --project ID --output NEW.zip [--data-dir DIR] --hub-stopped');
}
if (!hubStopped || !project || !output) throw Error('Supply --project, --output and --hub-stopped (stop Hub first; exporting records baselines)');
const dir = path.resolve(ROOT_DIR, dataDir), target = path.resolve(ROOT_DIR, output), dbPath = path.join(dir, 'papc.db');
if (!existsSync(dbPath)) throw Error('Database not found');
if (existsSync(target)) throw Error('Output already exists; choose a new ZIP path');
const db = openDatabase(dbPath);
try {
  const storage = new PcfStorage(db.sqlite, dir), exchange = new PcfExchange(storage);
  console.log(JSON.stringify(exportPcfProject(storage, exchange, project, target, { clientId: 'export-pcf-cli', clientName: 'Offline project export', ip: '' }), null, 2));
} finally { db.sqlite.close(); }
