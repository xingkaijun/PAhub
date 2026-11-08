import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { bundleOptions, outdir, root, copySchema, typecheck } from './build.mjs';

await typecheck();
await copySchema();
await build({ ...bundleOptions, packages: 'external', define: { 'import.meta.env': JSON.stringify({ MODE: 'hub', VITE_DATA_API_BASE_URL: '/api', VITE_DATA_API_TOKEN: '' }) }, entryPoints: ['hub-server/test/d1.test.ts', 'hub-server/test/integration.test.ts', 'hub-server/test/pcf.test.ts', 'hub-server/test/realtime.test.ts', 'hub-server/test/exchange.test.ts', 'hub-server/test/exchange-edge.test.ts', 'hub-server/test/send-all.test.ts', 'hub-server/test/v26.test.ts', 'hub-server/test/builder-replies.test.ts', 'hub-server/test/phase8.test.ts', 'hub-server/test/history-retention.test.ts', 'hub-server/test/cost-affect.test.ts', 'hub-server/test/comments.test.ts', 'hub-server/test/activity-report.test.ts', 'hub-server/test/banner-toolbar.test.ts'].map(relative => path.join(root, relative)),
  outdir, outExtension: { '.js': '.mjs' } });
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', path.join(outdir, 'd1.test.mjs'), path.join(outdir, 'integration.test.mjs'), path.join(outdir, 'pcf.test.mjs'), path.join(outdir, 'realtime.test.mjs'), path.join(outdir, 'exchange.test.mjs'), path.join(outdir, 'exchange-edge.test.mjs'), path.join(outdir, 'send-all.test.mjs'), path.join(outdir, 'v26.test.mjs'), path.join(outdir, 'builder-replies.test.mjs'), path.join(outdir, 'phase8.test.mjs'), path.join(outdir, 'history-retention.test.mjs'), path.join(outdir, 'cost-affect.test.mjs'), path.join(outdir, 'comments.test.mjs'), path.join(outdir, 'activity-report.test.mjs'), path.join(outdir, 'banner-toolbar.test.mjs')],
  { cwd: root, stdio: 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code || 0; });
