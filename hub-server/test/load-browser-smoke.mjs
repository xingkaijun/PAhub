// Run after npm run hub:build: node hub-server/test/load-browser-smoke.mjs
// Request-count check in a real browser against a real hub server (fixture data):
//  1. opening a project reads the full project exactly once (and the tracker at most once), one live stream;
//  2. switching Tracker -> Inventory sends no project/tracker reads and keeps the same stream (no reconnect);
//  3. another client saves a drawing -> the page fetches only that drawing by id, no full project read,
//     and the new value appears;
//  4. a catch-up refresh (tab becomes visible again) with nothing new is answered 304 for project and tracker;
//  5. the main JS bundle comes compressed with an immutable year-long cache, index.html with no-cache.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-load-e2e-'));
// Explicitly unset: this check counts reads, not permissions, and ADMIN_PASSWORD may be set in the shell.
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: '' });
const hub = await createHub({ host: '127.0.0.1' }); let browser;
const origin = 'http://127.0.0.1:' + hub.port, P = 'proj-test-001', NAME = 'PG-VLEC-H2684';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];

try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('pahub.clientName', 'LoadCheck'));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const log = [], docs = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) log.push({ method: response.request().method(), path: url.pathname, search: url.search, status: response.status() });
    else docs.push({ path: url.pathname, status: response.status(), headers: response.headers() });
  });
  const project = from => log.slice(from).filter(e => e.method === 'POST' && e.path === '/api/projects/' + P);
  const tracker = from => log.slice(from).filter(e => e.method === 'GET' && e.path === '/api/projects/' + P + '/review-tracker');
  const byId = from => log.slice(from).filter(e => e.method === 'GET' && e.path === '/api/projects/' + P + '/drawings');
  const streams = () => log.filter(e => e.path === '/api/projects/' + P + '/events').length;
  const settle = async (ms = 1500) => { await page.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };

  await page.goto(origin + '/'); await settle(300);
  // 1. open project
  let mark = log.length;
  await page.getByRole('button', { name: new RegExp(NAME) }).first().click();
  await page.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor();
  await settle(2500);
  // The stream's first open does a conditional catch-up read; with nothing new it is a bodyless 304.
  const full = project(mark).filter(e => e.status === 200), revalidated = project(mark).filter(e => e.status === 304);
  assert.equal(full.length, 1, 'open: one full project read, got ' + JSON.stringify(project(mark)));
  assert.equal(full.length + revalidated.length, project(mark).length, 'any other read is a 304');
  assert.ok(revalidated.length <= 1);
  assert.ok(tracker(mark).filter(e => e.status === 200).length <= 1, 'open: tracker body read at most once, got ' + JSON.stringify(tracker(mark)));
  assert.equal(streams(), 1, 'one live stream');
  console.log('Open project: full project reads (200)=1, 304 revalidations=' + revalidated.length + ', tracker reads=' + tracker(mark).map(e => e.status).join(',') + ', streams=1');

  // 2. tab switches
  mark = log.length;
  await page.getByRole('button', { name: /^Tracker$/ }).click(); await settle(1000);
  await page.getByRole('button', { name: /^Inventory$/ }).click(); await page.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor(); await settle(1500);
  assert.equal(project(mark).length, 0, 'tab switch: no project read');
  assert.equal(tracker(mark).length, 0, 'tab switch: no tracker read');
  assert.equal(streams(), 1, 'tab switch keeps the stream (no reconnect)');
  console.log('Tracker -> Inventory: project reads=0, tracker reads=0, streams still 1');

  // 3. another client saves one drawing
  const opened = await (await fetch(origin + '/api/projects/' + P, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const d = opened.drawings.find(x => x.id === 'dwg-001');
  mark = log.length;
  const saved = await fetch(origin + '/api/projects/' + P, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'other-client' },
    body: JSON.stringify({ updatedDrawings: [{ id: 'dwg-001', baseRev: d.rev, base: { title: d.title }, changes: { title: 'Remote title R3' } }] }) });
  assert.equal(saved.status, 200);
  await page.getByText('Remote title R3').first().waitFor({ timeout: 10_000 });
  await settle(1500);
  assert.equal(project(mark).length, 0, 'remote save: no full project read, got ' + JSON.stringify(project(mark)));
  assert.equal(byId(mark).length, 1, 'remote save: one by-id read, got ' + JSON.stringify(byId(mark)));
  assert.equal(byId(mark)[0].search, '?ids=dwg-001', 'only the changed drawing');
  console.log('Remote save of dwg-001: full project reads=0, by-id reads=1 (' + byId(mark)[0].search + '), new title shown');

  // 4. catch-up refresh. The page's held ETag is from its last full read, so the first catch-up after the
  //    by-id merge reads the project once more (200); the next one, with nothing new, is a 304.
  mark = log.length;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await settle(1500);
  assert.deepEqual(project(mark).map(e => e.status), [200], 'first catch-up after a remote change: one full read');
  mark = log.length;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await settle(1500);
  assert.equal(project(mark).length, 1, 'catch-up: one conditional project read');
  assert.equal(project(mark)[0].status, 304, 'nothing new -> 304');
  assert.ok(tracker(mark).every(e => e.status === 304), 'tracker 304 too: ' + JSON.stringify(tracker(mark)));
  assert.ok(await page.getByText('Remote title R3').first().isVisible(), 'data kept after 304');
  console.log('Catch-up refresh: project ' + project(mark)[0].status + ', tracker ' + tracker(mark).map(e => e.status).join(','));

  // 5. static headers as the browser saw them
  const js = docs.find(e => /^\/assets\/index-[^/]+\.js$/.test(e.path));
  assert.ok(js, 'main bundle loaded');
  assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(js.headers['content-encoding'] || '', /^(br|gzip)$/);
  const html = docs.find(e => e.path === '/');
  assert.equal(html.headers['cache-control'], 'no-cache');
  console.log('Static: ' + js.path + ' ' + js.headers['content-encoding'] + ' / ' + js.headers['cache-control'] + '; index.html ' + html.headers['cache-control']);
  assert.deepEqual(errors, []);
  console.log('Load browser smoke: PASS; pageerrors=0');
} finally {
  await browser?.close(); await hub.close();
}
