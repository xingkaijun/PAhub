import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROJECT_TIME_ZONE } from '../../lib/deadline.ts';
import { identityConfig } from './identity.ts';

// Project calendar time zone, shared with the browser through lib/deadline.ts.
export { PROJECT_TIME_ZONE };

// Source and bundled modules both live two levels below the repository root.
export const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const SQL_DIR = path.join(ROOT_DIR, 'hub-server/dist/sql');

// PCF history policy: independent of revision clocks, audit logs and receipts.
export const PCF_HISTORY_COALESCE_MS = 10 * 60 * 1000;
export const PCF_HISTORY_RECENT_LIMIT = 50;
// History retention bands (see pcf-history.ts): daily below 30 days, weekly up to 180 days, monthly beyond.
export const PCF_HISTORY_DAILY_DAYS = 30;
export const PCF_HISTORY_WEEKLY_DAYS = 180;

export function readConfig() {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('PAhub requires Node 24.x (built-in node:sqlite).');
  }
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const bodyLimit = Number(process.env.MAX_BODY_BYTES || 51 * 1024 * 1024);
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1) throw new Error('Invalid MAX_BODY_BYTES');
  const dataDir = path.resolve(ROOT_DIR, process.env.PAHUB_DATA_DIR || 'data');
  // Optional gate for public exposure (e.g. frp tcp proxy). Unset means no authentication.
  const basicAuth = process.env.PAHUB_BASIC_AUTH || '';
  if (basicAuth && !basicAuth.includes(':')) throw new Error('PAHUB_BASIC_AUTH must be <username>:<password>');
  const identity = identityConfig(process.env);
  const grantSecret = process.env.PCF_GRANT_SECRET;
  if (grantSecret !== undefined && Buffer.byteLength(grantSecret, 'utf8') < 32) throw new Error('PCF_GRANT_SECRET must contain at least 32 bytes');
  return {
    identity,
    grantSecret,
    port,
    basicAuth,
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
