import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const outdir = path.join(root, 'hub-server/dist');
export const bundleOptions = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'esm',
  loader: { '.html': 'text' }, alias: { '@pahub/worker': path.join(root, 'worker/src/index.ts') }, sourcemap: true, logLevel: 'info',
};

export async function copySchema() {
  await mkdir(path.join(outdir, 'sql'), { recursive: true });
  for (const name of ['init-local.sql', 'snapshot-table.sql', 'audit-journal.sql']) {
    await copyFile(path.join(root, 'worker/sql', name), path.join(outdir, 'sql', name));
  }
}

export async function typecheck() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'hub-server/tsconfig.json'], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Hub TypeScript check failed')));
  });
}

export async function buildServer() {
  await copySchema();
  await esbuild({ ...bundleOptions, outdir, entryPoints: {
    server: 'hub-server/src/server.ts', app: 'hub-server/src/app.ts', 'import-d1': 'hub-server/src/import-main.ts',
  }, outExtension: { '.js': '.mjs' } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24.x');
  await typecheck();
  await Promise.all([viteBuild({ root, mode: 'hub' }), buildServer()]);
  console.log('PAhub build complete: frontend dist/ + hub-server/dist/ (same-origin /api)');
}
