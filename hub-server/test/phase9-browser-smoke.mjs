// Run after npm run hub:build, with the parent's preview-data copy prepared.
// Browser/server port is ALWAYS 8082. This never starts/stops 8080 or 8081.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const requestedData = process.env.PAHUB_DATA_DIR || 'data-p9';
const dataDir = await realpath(path.resolve(root, requestedData));
const originalPreview = path.resolve(root, '../PAhub-preview/data');
const originalReal = await realpath(originalPreview).catch(() => originalPreview);
assert.notEqual(dataDir.toLowerCase(), originalReal.toLowerCase(), 'Use copied preview data, never PAhub-preview/data');
assert.notEqual(path.basename(dataDir).toLowerCase(), 'data', 'PAHUB_DATA_DIR must name a dedicated copied-data directory');
const dbPath = path.join(dataDir, 'papc.db');
assert.ok((await stat(dbPath)).isFile(), 'Prepare the existing preview DB copy before running this smoke');
const artifacts = path.join(root, 'hub-server/test/artifacts');
const suffix = Date.now() + '-' + randomUUID().slice(0, 8);
const projectId = 'p9-browser-' + suffix, projectName = 'Phase 9 Browser ' + suffix;
const hullId = 'p9-hull-' + suffix, machineId = 'p9-machine-' + suffix, noPcfId = 'p9-no-pcf-' + suffix;
const hullNo = 'P9-HULL-' + suffix, machineNo = 'P9-MACH-' + suffix;
const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN'];
const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
Object.assign(process.env, { PORT: '8082', PAHUB_DATA_DIR: dataDir, PAPC_DB_PATH: dbPath, API_TOKEN: '' });
let hub, browser, page;
const errors = [], apiFailures = [], commentRequests = [];
const screenshots = [];
const origin = 'http://127.0.0.1:8082';
const blank = text => ({ text, html: text, fill: '', images: [] });
const screenshot = async (target, name) => {
  const filename = path.join(artifacts, 'phase9-' + name + '.png');
  await target.screenshot({ path: filename, fullPage: true }); screenshots.push(filename);
};
async function json(url, body) {
  const response = await fetch(origin + url, { ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, url + ' HTTP status'); return await response.json();
}
async function ops(drawingId, values) {
  const base = '/api/pcf/' + projectId + '/' + drawingId + '/';
  const current = await json(base + 'data');
  const result = await json(base + 'ops', { clientId: 'phase9-browser-seed', clientName: 'Phase 9 浏览器',
    baseRev: current.rev, batchId: randomUUID(), ops: values });
  assert.deepEqual(result.conflicts, [], 'fixture ops must apply without conflicts'); return result;
}
async function seedDrawing(drawingId, rows) {
  // These routes invoke storage.create + storage.ops on only the dedicated IDs.
  await json('/api/pcf/' + projectId + '/' + drawingId + '/create', {});
  const values = [];
  for (const row of rows) {
    values.push({ type: 'comment.add', id: row.commentId, roundIdNew: row.roundId },
      { type: 'content.set', commentId: row.commentId, roundId: row.roundId, side: 'owner', baseRev: 0, value: blank(row.owner) },
      { type: 'content.set', commentId: row.commentId, roundId: row.roundId, side: 'reply', baseRev: 0, value: blank(row.reply) },
      { type: 'comment.meta', commentId: row.commentId, baseRev: 0, value: { tags: row.tags } },
      { type: 'round.meta', commentId: row.commentId, roundId: row.roundId, field: 'initiator', baseRev: 0, value: '审图员王' });
    if (row.closed) values.push({ type: 'comment.status', commentId: row.commentId, baseRev: 0, value: 'closed' });
  }
  await ops(drawingId, values);
}
const row = (owner, tags = ['Safety'], closed = false) => ({ commentId: randomUUID(), roundId: randomUUID(), owner, reply: 'Builder 回复 ' + owner, tags, closed });
const selected = row('Phase9 目标中文意见 — 核实阀门及燃气管路'), closed = row('Phase9 closed excluded marker', ['Safety'], true);
const wrongTag = row('Phase9 wrong tag excluded marker', ['Structure']), machinery = row('Phase9 machinery excluded marker');
try {
  hub = await createHub({ host: '127.0.0.1' }); assert.equal(hub.port, 8082); await mkdir(artifacts, { recursive: true });
  const db = hub.db;
  const demoProjectsBefore = db.prepare('SELECT id,name FROM projects ORDER BY id').all();
  const demoDrawingsBefore = db.prepare('SELECT id,project_id,drawing_no FROM drawings ORDER BY id').all();
  db.prepare('INSERT INTO projects(id,name,last_updated) VALUES (?,?,?)').run(projectId, projectName, new Date().toISOString());
  const addDrawing = db.prepare('INSERT INTO drawings(id,project_id,drawing_no,title,discipline,status,current_round) VALUES (?,?,?,?,?,?,?)');
  addDrawing.run(hullId, projectId, hullNo, '燃气管路图 Phase 9', 'Hull', 'Under Review', 'A');
  addDrawing.run(machineId, projectId, machineNo, 'Machinery Phase 9', 'Machinery', 'Waiting Reply', 'A');
  addDrawing.run(noPcfId, projectId, 'P9-NO-PCF-' + suffix, 'No PCF should be created', 'Electrical', 'Pending', 'A');
  await seedDrawing(hullId, [selected, closed, wrongTag]); await seedDrawing(machineId, [machinery]);
  const seeded = await json('/api/projects/' + projectId + '/comments');
  assert.equal(seeded.comments.length, 4); assert.equal(seeded.statistics.open, 3); assert.equal(seeded.statistics.closed, 1);
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', colorScheme: 'light', acceptDownloads: true });
  await context.addInitScript(expectedOrigin => {
    if (location.origin === expectedOrigin) localStorage.setItem('pahub.clientName', 'Phase 9 Browser');
  }, origin);
  context.on('page', target => target.on('pageerror', error => errors.push(error.message)));
  page = await context.newPage();
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/projects/' + projectId + '/') && response.status() >= 400) apiFailures.push({ path: url.pathname, status: response.status() });
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/projects/' + projectId + '/comments') commentRequests.push({ method: request.method(), query: url.search });
  });
  await page.goto(origin + '/');
  await page.getByRole('button').filter({ hasText: projectName }).first().waitFor();
  console.log('Initial project-selector snapshot:', (await page.locator('body').innerText()).slice(0, 1600));
  await page.getByRole('button').filter({ hasText: projectName }).first().click();
  await page.getByRole('button', { name: 'Comments', exact: true }).click();
  const register = page.locator('section[aria-label="Comments register"]'); await register.waitFor();
  await page.waitForFunction(() => document.querySelector('section[aria-label="Comments register"]')?.getAttribute('aria-busy') === 'false');
  await page.getByText('Live change notices', { exact: false }).waitFor();
  assert.equal(await register.locator('tbody tr').count(), 4);
  assert.equal(await register.getByRole('columnheader', { name: 'Issued by' }).count(), 1);
  assert.equal(await register.getByRole('columnheader', { name: 'Open days' }).count(), 0);
  assert.equal(await register.locator('tbody tr').first().getByText('审图员王', { exact: true }).count(), 1);
  console.log('Comments initial snapshot:', (await register.innerText()).slice(0, 2200));
  await screenshot(page, 'comments-all');
  await screenshot(page, 'comments-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.locator('.comments-register-page').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(15, 23, 42)');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.comments-register-page select')).backgroundColor === 'rgb(15, 23, 42)');
  await screenshot(page, 'comments-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.comments-register-page select')).backgroundColor === 'rgb(255, 255, 255)');

  await page.getByLabel('Discipline', { exact: true }).selectOption('Hull');
  await page.getByLabel('Drawing status', { exact: true }).selectOption('Under Review');
  await page.getByLabel('Comment status', { exact: true }).selectOption('open');
  await page.getByLabel('Round', { exact: true }).selectOption('1');
  await page.getByLabel('Tag', { exact: true }).selectOption('Safety');
  await page.getByLabel('Search all round text', { exact: true }).fill('Phase9');
  const filteredPromise = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === '/api/projects/' + projectId + '/comments' && url.searchParams.get('discipline') === 'Hull';
  });
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const filtered = await (await filteredPromise).json();
  assert.deepEqual(filtered.comments.map(item => item.commentId), [selected.commentId]);
  await page.waitForFunction(() => document.querySelector('section[aria-label="Comments register"]')?.getAttribute('aria-busy') === 'false');
  assert.equal(await register.locator('tbody tr').count(), 1); assert.match(await register.innerText(), /目标中文意见/);
  await screenshot(page, 'comments-filtered');

  const exportResponsePromise = page.waitForResponse(response => /\/comments(?:\.xlsx|\/export\.xlsx)$/.test(new URL(response.url()).pathname));
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export (?:Excel|XLSX)$/i }).click();
  const exportResponse = await exportResponsePromise; assert.equal(exportResponse.status(), 200);
  const exportUrl = new URL(exportResponse.url());
  for (const [key, value] of Object.entries({ discipline: 'Hull', drawingStatus: 'Under Review', commentStatus: 'open', round: '1', tag: 'Safety', q: 'Phase9' })) assert.equal(exportUrl.searchParams.get(key), value, 'export keeps loaded filter ' + key);
  const download = await downloadPromise; assert.equal(await download.failure(), null); assert.match(download.suggestedFilename(), /\.xlsx$/i);
  const bytes = await readFile(await download.path()); assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'real XLSX ZIP download');
  await screenshot(page, 'comments-export');

  // Snapshot and click the real row link; PCF must open a popup with hash focus.
  const commentLink = register.getByRole('link', { name: 'Open comment 1 for ' + hullNo, exact: true });
  console.log('Focused-PCF row link:', await commentLink.getAttribute('href'));
  const popupPromise = page.waitForEvent('popup');
  await commentLink.locator('xpath=ancestor::tr').getByRole('cell').nth(1).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(new URL(popup.url()).pathname, '/pcf/' + projectId + '/' + hullId);
  assert.equal(new URL(popup.url()).hash, '#comment=' + selected.commentId);
  await popup.locator('[data-comment-focus="true"]').waitFor();
  assert.match(await popup.locator('[data-comment-focus="true"]').innerText(), /目标中文意见/);
  await screenshot(popup, 'pcf-focus');

  const missing = await context.newPage();
  await missing.goto(origin + '/pcf/' + projectId + '/' + hullId + '#comment=' + randomUUID());
  await missing.locator('#save-btn').waitFor();
  await missing.waitForFunction(() => document.readyState === 'complete');
  assert.equal(await missing.locator('[data-comment-focus="true"]').count(), 0, 'missing comment ID is harmless and never focuses another comment');
  assert.ok(await missing.locator('.editor[data-side="owner"]').count() > 0, 'PCF remains usable');
  await screenshot(missing, 'pcf-missing-id'); await missing.close(); await popup.close();

  // A real op triggers project SSE. It only marks stale, without silently replacing rows.
  const requestsBeforeChange = commentRequests.length;
  const current = await json('/api/pcf/' + projectId + '/' + hullId + '/data');
  const fieldKey = 'round:' + selected.roundId + ':owner';
  const updatedText = 'Phase9 目标中文意见 — SSE refreshed marker';
  await ops(hullId, [{ type: 'content.set', commentId: selected.commentId, roundId: selected.roundId, side: 'owner',
    baseRev: current.data.hub.entities[fieldKey]?.rev || 0, value: blank(updatedText) }]);
  const stale = page.getByRole('status').filter({ hasText: 'Project changes detected' }); await stale.waitFor();
  assert.equal(commentRequests.length, requestsBeforeChange, 'SSE must not refetch comments automatically');
  assert.match(await register.innerText(), /核实阀门及燃气管路/); assert.ok(!(await register.innerText()).includes('SSE refreshed marker'));
  await screenshot(page, 'comments-stale');
  const refreshPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/' + projectId + '/comments');
  await page.getByRole('button', { name: 'Refresh register', exact: true }).click(); await refreshPromise;
  await page.waitForFunction(() => document.querySelector('section[aria-label="Comments register"]')?.textContent.includes('SSE refreshed marker'));
  await stale.waitFor({ state: 'hidden' }); assert.equal(commentRequests.length, requestsBeforeChange + 1);
  await screenshot(page, 'comments-refreshed');

  // Stable-ID focus also reveals a comment beyond page 1 and clears hiding filters.
  const pagedId = 'p9-paged-' + suffix;
  addDrawing.run(pagedId, projectId, 'P9-PAGED-' + suffix, 'Pagination focus', 'Hull', 'Under Review', 'A');
  const pagedRows = Array.from({ length: 30 }, (_, n) => row('Pagination comment ' + (n + 1), ['Safety'], n === 29));
  await seedDrawing(pagedId, pagedRows);
  const paged = await context.newPage();
  await paged.goto(origin + '/pcf/' + projectId + '/' + pagedId + '#comment=' + pagedRows[29].commentId);
  await paged.locator('[data-comment-focus="true"]').waitFor();
  assert.equal(await paged.locator('[data-comment-focus="true"]').getAttribute('data-cid'), pagedRows[29].commentId);
  assert.match(await paged.locator('#page-label').innerText(), /Page 2 of 2/);
  await screenshot(paged, 'pcf-focus-pagination');
  await paged.locator('.tab[data-filter="open"]').click();
  await paged.evaluate(id => { location.hash = '#comment=' + id; }, pagedRows[0].commentId);
  await paged.locator('[data-comment-focus="true"]').waitFor();
  await paged.evaluate(id => { location.hash = '#comment=' + id; }, pagedRows[29].commentId);
  await paged.waitForFunction(id => document.querySelector('[data-comment-focus="true"]')?.getAttribute('data-cid') === id, pagedRows[29].commentId);
  assert.equal(await paged.locator('.tab[data-filter="all"]').getAttribute('aria-pressed'), 'true');
  await screenshot(paged, 'pcf-focus-filter-reset');
  await paged.close();

  assert.equal(await stat(path.join(dataDir, 'pcf', projectId, noPcfId + '.html')).catch(() => null), null);
  assert.deepEqual(db.prepare('SELECT id,name FROM projects WHERE id<>? ORDER BY id').all(projectId), demoProjectsBefore, 'existing demo projects preserved');
  assert.deepEqual(db.prepare('SELECT id,project_id,drawing_no FROM drawings WHERE project_id<>? ORDER BY id').all(projectId), demoDrawingsBefore, 'existing demo drawings preserved');
  assert.deepEqual(errors, [], 'pageerrors=0, including missing focus ID'); assert.deepEqual(apiFailures, []);
  console.log(JSON.stringify({ result: 'PASS', port: 8082, dataDir, dedicatedProject: projectId, seedRows: 4, filteredRows: 1, requests: commentRequests, pageErrors: errors, screenshots }, null, 2));
  console.log('Dedicated smoke data retained in the copied data directory; no demo data deleted.');
} catch (error) {
  // No retries: repeated failures must be reported by the caller, not looped here.
  if (page && !page.isClosed()) await screenshot(page, 'failure').catch(() => {});
  console.error('Phase 9 smoke failed (no automatic retry):', error); throw error;
} finally {
  try { await browser?.close(); } finally {
    try { await hub?.close(); } finally {
      for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
  }
}
