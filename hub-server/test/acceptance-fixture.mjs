// Isolated fixture for CLI-driven browser acceptance; no preview data or fixed ports.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../dist/app.mjs';
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-acceptance-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub();
hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql', 'utf8'));
console.log(JSON.stringify({ url: 'http://127.0.0.1:' + hub.port, dataDir: temp }));
process.on('SIGINT', async () => { await hub.close(); process.exit(0); });
