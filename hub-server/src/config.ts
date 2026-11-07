import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source and bundled modules both live two levels below the repository root.
export const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const SQL_DIR = path.join(ROOT_DIR, 'hub-server/dist/sql');

export function readConfig() {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('PAhub requires Node 24.x (built-in node:sqlite).');
  }
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const bodyLimit = Number(process.env.MAX_BODY_BYTES || 32 * 1024 * 1024);
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1) throw new Error('Invalid MAX_BODY_BYTES');
  const dataDir = path.resolve(ROOT_DIR, process.env.PAHUB_DATA_DIR || 'data');
  return {
    port,
    dbPath: path.resolve(ROOT_DIR, process.env.PAPC_DB_PATH || path.join(dataDir, 'papc.db')),
    dataDir,
    distDir: path.resolve(ROOT_DIR, process.env.PAPC_DIST_DIR || 'dist'),
    bodyLimit,
    env: {
      API_TOKEN: process.env.API_TOKEN,
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
      ALLOW_CORS_ORIGIN: process.env.ALLOW_CORS_ORIGIN,
    },
  };
}
