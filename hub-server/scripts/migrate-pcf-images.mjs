import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const result = await build({
  absWorkingDir: root, entryPoints: ['hub-server/scripts/migrate-pcf-images.ts'],
  bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false,
  define: { 'import.meta.url': JSON.stringify(import.meta.url) }, logLevel: 'silent',
});
await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
