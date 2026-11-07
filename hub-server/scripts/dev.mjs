import { createServer as createViteServer } from 'vite';
import { context } from 'esbuild';
import { bundleOptions, copySchema, outdir, root } from './build.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

await copySchema();
let vite;
let hub;
let stopping = false;
let reload = Promise.resolve();
const ctx = await context({
  ...bundleOptions,
  entryPoints: ['hub-server/src/app.ts'], outfile: path.join(outdir, 'dev-app.mjs'),
  plugins: [{ name: 'reload-hub', setup(build) {
    build.onEnd(result => {
      if (result.errors.length || stopping) return;
      reload = reload.then(async () => {
        await vite?.close();
        await hub?.close();
        const mod = await import(pathToFileURL(path.join(outdir, 'dev-app.mjs')).href + '?v=' + Date.now());
        hub = await mod.createHub({ middleware: (req, res, next) => vite.middlewares(req, res, next) });
        vite = await createViteServer({ root, mode: 'hub', server: {
          middlewareMode: true, proxy: {}, hmr: { server: hub.server },
        }, appType: 'spa' });
      }).catch(error => console.error('Dev reload failed:', error));
      return reload;
    });
  } }],
});
await ctx.watch();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void (async () => { await ctx.dispose(); await reload; await vite?.close(); await hub?.close(); process.exit(0); })();
});
console.log('PAhub dev: one Node process and one HTTP/HMR port; frontend HMR and server rebuilds enabled.');
