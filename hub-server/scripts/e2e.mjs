// npm run hub:e2e — full hub build, then every real-browser smoke test, one after another.
// Each test starts its own hub server on fixture data in a temp dir and uses Playwright's bundled Chromium
// (npx playwright install chromium once; PAHUB_BROWSER_CHANNEL=chrome to use an installed Google Chrome).
// PAHUB_E2E_SKIP_BUILD=1 reuses the current dist/ and hub-server/dist/. Optional args pick tests by name.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { root } from './build.mjs';

const TESTS = [
  'browser-smoke.mjs',
  'exchange-browser-smoke.mjs',
  'phase8-browser-smoke.mjs',
  'phase9-browser-smoke.mjs',
  'v26-browser-smoke.mjs',
  'save-conflict-browser-smoke.mjs',
  'load-browser-smoke.mjs',
  'images-browser-smoke.mjs',
  'round5-browser-smoke.mjs',
  'known-issues-browser-smoke.mjs',
  'manual-browser-smoke.mjs',
  'lobby-browser-smoke.mjs',
  'builder-handoff-browser-smoke.mjs',
  'kjx-features-browser-smoke.mjs',
  'kjx-acceptance-fixes-browser-smoke.mjs',
  'kjx-membership-browser-smoke.mjs',
  'kjx-reviewer-view-browser-smoke.mjs',
];

const run = (args, label) => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, PAHUB_DATA_DIR: '' } });
  child.on('error', error => { console.error(error); resolve({ label, code: 1, ms: Date.now() - started }); });
  child.on('exit', code => resolve({ label, code: code ?? 1, ms: Date.now() - started }));
});

const requested = process.argv.slice(2);
const unknown = requested.filter(name => !TESTS.some(test => test === name || test === name + '.mjs'));
if (unknown.length) throw new Error('Unknown e2e test: ' + unknown.join(', '));
const selected = requested.length ? TESTS.filter(test => requested.some(name => test === name || test === name + '.mjs')) : TESTS;

if (process.env.PAHUB_E2E_SKIP_BUILD !== '1') {
  const build = await run(['hub-server/scripts/build.mjs'], 'hub:build');
  if (build.code !== 0) { console.error('hub:e2e: build failed'); process.exit(build.code); }
}
const results = [];
for (const test of selected) {
  console.log('\n=== hub:e2e ' + test);
  results.push(await run([path.join('hub-server/test', test)], test));
}
console.log('\nhub:e2e results');
for (const result of results) console.log((result.code === 0 ? 'PASS ' : 'FAIL ') + result.label + ' (' + (result.ms / 1000).toFixed(1) + ' s)');
const failed = results.filter(result => result.code !== 0).length;
console.log('e2e ' + results.length + ', pass ' + (results.length - failed) + ', fail ' + failed);
process.exitCode = failed ? 1 : 0;
