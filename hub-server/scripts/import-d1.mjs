import { build as esbuild } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleOptions, outdir, root, copySchema } from './build.mjs';

// One-time migration from the retired Cloudflare D1 (SQL dump or old admin JSON export) into a new
// local SQLite database. It is no longer part of `npm run hub:build`; this script bundles the importer
// on demand into hub-server/dist/import-d1.mjs and runs it with the given arguments.
// Usage: npm run hub:import-d1 -- SOURCE.sql|SOURCE.json [--db PATH]
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24.x');
await copySchema();
await esbuild({ ...bundleOptions, logLevel: 'warning', outdir, entryPoints: { 'import-d1': path.join(root, 'hub-server/src/import-main.ts') }, outExtension: { '.js': '.mjs' } });
await import(pathToFileURL(path.join(outdir, 'import-d1.mjs')).href);
