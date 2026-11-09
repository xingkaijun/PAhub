import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const outdir = path.join(root, 'hub-server/dist');
export const bundleOptions = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'esm',
  loader: { '.html': 'text' }, sourcemap: true, logLevel: 'info',
};

export async function copySchema() {
  // Numbered migrations are the schema source of truth; the server reads them from dist.
  const migrations = path.join(outdir, 'sql', 'migrations');
  await mkdir(migrations, { recursive: true });
  for (const name of await readdir(path.join(root, 'hub-server/sql/migrations'))) {
    await copyFile(path.join(root, 'hub-server/sql/migrations', name), path.join(migrations, name));
  }
}

function tsc(project, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', project], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(label + ' TypeScript check failed')));
  });
}

// Hub server and frontend are both type-checked: vite build itself does not check types.
export async function typecheck() {
  await tsc('hub-server/tsconfig.json', 'Hub');
  await tsc('tsconfig.json', 'Frontend');
}

export async function buildServer() {
  await copySchema();
  await esbuild({ ...bundleOptions, outdir, entryPoints: {
    server: path.join(root, 'hub-server/src/server.ts'), app: path.join(root, 'hub-server/src/app.ts'),
    'import-d1': path.join(root, 'hub-server/src/import-main.ts'),
  }, outExtension: { '.js': '.mjs' } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24.x');
  await typecheck();
  await Promise.all([viteBuild({ root, mode: 'hub' }), buildServer()]);
  console.log('PAhub build complete: frontend dist/ + hub-server/dist/ (same-origin /api)');
}
