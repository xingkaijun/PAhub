import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { bundleOptions, outdir, root, copySchema, typecheck } from './build.mjs';

await typecheck();
await copySchema();
await build({ ...bundleOptions, packages: 'external', entryPoints: ['hub-server/test/d1.test.ts', 'hub-server/test/integration.test.ts', 'hub-server/test/pcf.test.ts', 'hub-server/test/realtime.test.ts'],
  outdir, outExtension: { '.js': '.mjs' } });
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', path.join(outdir, 'd1.test.mjs'), path.join(outdir, 'integration.test.mjs'), path.join(outdir, 'pcf.test.mjs'), path.join(outdir, 'realtime.test.mjs')],
  { cwd: root, stdio: 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code || 0; });
