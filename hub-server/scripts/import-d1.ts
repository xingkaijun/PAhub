import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

// Node 24 strips this launcher TypeScript. The build handles the Worker's HTML text import.
const entry = new URL('../dist/import-d1.mjs', import.meta.url);
try { await access(fileURLToPath(entry)); }
catch { throw new Error('Run npm run hub:build before importing data.'); }
await import(entry.href);
