import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { bundleOptions, outdir, root, copySchema, typecheck } from './build.mjs';

await typecheck();
await copySchema();
await build({ ...bundleOptions, entryPoints: ['hub-server/test/d1.test.ts', 'hub-server/test/integration.test.ts'],
  outdir, outExtension: { '.js': '.mjs' } });
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', path.join(outdir, 'd1.test.mjs'), path.join(outdir, 'integration.test.mjs')],
  { cwd: root, stdio: 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code || 0; });
