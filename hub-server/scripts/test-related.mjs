// Bundle only named test files; no frontend build or full-suite execution.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { bundleOptions, outdir, root, copySchema } from './build.mjs';
const files = process.argv.slice(2);
if (!files.length || files.some(f => !/^hub-server\/test\/[\w-]+\.test\.ts$/.test(f))) throw Error('Supply hub-server/test/<name>.test.ts files');
await copySchema();
await build({ ...bundleOptions, packages: 'external', define: { 'import.meta.env': JSON.stringify({ MODE: 'hub', VITE_DATA_API_BASE_URL: '/api', VITE_DATA_API_TOKEN: '' }) }, entryPoints: files.map(f => path.join(root, f)), outdir, outExtension: { '.js': '.mjs' } });
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(f => path.join(outdir, path.basename(f).replace(/\.ts$/, '.mjs')))], { cwd: root, stdio: 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code || 0; });
