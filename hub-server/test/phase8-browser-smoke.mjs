// Run after npm run hub:build: isolated Chromium acceptance for phase 8.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-phase8-browser-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub(); let browser;
const artifacts = path.join(root, 'hub-server/test/artifacts'); await mkdir(artifacts, { recursive: true });
try {
  hub.db.sqlite.exec(await readFile(path.join(root, 'worker/sql/seed-test-data.sql'), 'utf8'));
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chrome' });
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'en-US' });
  const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'en-US' });
  const a = await contextA.newPage(), errors = [];
  a.on('pageerror', error => errors.push('A: ' + error.message));
  await a.goto('http://127.0.0.1:' + hub.port + '/');
  await a.locator('button').filter({ hasText: 'PG-VLEC-H2684' }).first().click();
  const drawingLink = a.locator('a[href="/pcf/proj-test-001/dwg-005"]'); await drawingLink.waitFor();
  const row = drawingLink.locator('xpath=ancestor::tr');
  assert.equal((await row.innerText()).includes('Export to Builder'), false, 'Drawing row must not contain Export to Builder');

  const b = await contextB.newPage(); b.on('pageerror', error => errors.push('B: ' + error.message));
  const base = 'http://127.0.0.1:' + hub.port;
  await b.goto(base + '/pcf/proj-test-001/dwg-005');
  const presenceStart = Date.now();
  await a.waitForFunction(() => {
    const link = document.querySelector('a[href="/pcf/proj-test-001/dwg-005"]');
    return !!link?.querySelector('span')?.textContent?.includes('1');
  }, undefined, { timeout: 2000 });
  console.log('presence appearance ms:', Date.now() - presenceStart);
  await a.screenshot({ path: path.join(artifacts, 'phase8-presence.png') });
  await b.goto('about:blank');
  await a.waitForFunction(() => !document.querySelector('a[href="/pcf/proj-test-001/dwg-005"] span'), undefined, { timeout: 2000 });
  console.log('presence disappearance: within 2 s after PCF tab close');

  await b.goto(base + '/pcf/proj-test-001/dwg-005');
  await b.locator('#pahub-export').waitFor({ state: 'attached' });
  assert.equal(await b.locator('#pahub-import').innerText(), 'Import Builder Reply');
  assert.equal((await b.locator('.banner-actions').innerText()).includes('Export to Builder'), true);

  // An unsaved edit must be saved before the export baseline is created.
  await b.locator('#add-btn').click();
  await b.locator('.editor[data-side="owner"]').first().fill('Phase 8 unsaved export comment');
  const downloadEvent = b.waitForEvent('download', { timeout: 8000 });
  await b.locator('#pahub-export').click();
  const download = await downloadEvent, exportedPath = path.join(temp, download.suggestedFilename());
  await download.saveAs(exportedPath);
  const exported = await readFile(exportedPath, 'utf8');
  assert.match(exported, /Phase 8 unsaved export comment/);
  const exportedMarkup = exported.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  assert.doesNotMatch(exportedMarkup, /\bid="(?:pahub-context|pahub-export|pahub-import)"|X-PCF-Token/i);
  const exports = hub.db.sqlite.prepare('SELECT export_id, status FROM pcf_exports WHERE project_id=? AND drawing_id=?').all('proj-test-001', 'dwg-005');
  assert.equal(exports.length, 1); assert.equal(exports[0].status, 'exported');
  await a.waitForFunction(() => {
    const tr = document.querySelector('a[href="/pcf/proj-test-001/dwg-005"]')?.closest('tr');
    return [...(tr?.querySelectorAll('input') || [])].some(input => input.value === '1');
  }, undefined, { timeout: 2000 });
  console.log('PCF save -> PAPC total/open comments: 1/1');
  await b.screenshot({ path: path.join(artifacts, 'phase8-export.png') });

  // Measure both headers at the required viewports and capture their actual pixels.
  const bannerMeasurements = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await a.setViewportSize(viewport); await b.setViewportSize(viewport);
    const papcHeader = a.locator('header').first(), pcfHeader = b.locator('header.banner');
    const papcHeight = await papcHeader.evaluate(el => el.getBoundingClientRect().height);
    const pcfHeight = await pcfHeader.evaluate(el => el.getBoundingClientRect().height);
    const papcStyle = await papcHeader.evaluate(el => ({ paddingTop: getComputedStyle(el).paddingTop, paddingBottom: getComputedStyle(el).paddingBottom, titleSize: getComputedStyle(el.querySelector('h1')).fontSize, logoHeight: getComputedStyle(el.querySelector('img')).height }));
    const pcfStyle = await pcfHeader.evaluate(el => ({ paddingTop: getComputedStyle(el).paddingTop, paddingBottom: getComputedStyle(el).paddingBottom, titleSize: getComputedStyle(el.querySelector('.brand h1')).fontSize, logoHeight: getComputedStyle(el.querySelector('.logo')).height }));
    bannerMeasurements.push({ viewport: viewport.width + 'x' + viewport.height, papcHeight, pcfHeight, difference: Math.abs(papcHeight - pcfHeight), papcStyle, pcfStyle });
    await papcHeader.screenshot({ path: path.join(artifacts, `banner-papc-${viewport.width}.png`) });
    await pcfHeader.screenshot({ path: path.join(artifacts, `banner-pcf-${viewport.width}.png`) });
  }
  console.log('banner measurements:', JSON.stringify(bannerMeasurements));
  assert.ok(bannerMeasurements.every(x => x.difference <= 2), 'PAPC/PCF banner height difference must be <= 2 px at both viewports');

  // The main list entry uses the same dialog. Only ZIP / HTML drops may open it.
  await a.getByRole('button', { name: 'Import Builder Replies' }).click();
  assert.match(await a.getByText('Drop builder reply files here').innerText(), /Drop builder reply files here/);
  await a.getByRole('button', { name: 'Close' }).last().click();
  await a.evaluate(() => {
    const file = new File(['not an import'], 'ignored.txt', { type: 'text/plain' }), transfer = new DataTransfer(); transfer.items.add(file);
    document.querySelector('[data-drawing-list-root]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  assert.equal(await a.getByText('Drop builder reply files here').count(), 0, 'non-zip/html drop must be ignored');
  await a.evaluate(() => {
    const file = new File(['zip bytes'], 'builder-replies.zip', { type: 'application/zip' }), transfer = new DataTransfer(); transfer.items.add(file);
    document.querySelector('[data-drawing-list-root]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await a.getByText('Drop builder reply files here').waitFor();
  assert.match(await a.getByText('1 file(s) selected').innerText(), /1 file/);
  await a.screenshot({ path: path.join(artifacts, 'phase8-import.png') });
  await a.getByRole('button', { name: 'Close' }).last().click();

  assert.deepEqual(errors, []);
  console.log('Chrome phase 8: live presence/comment summaries, save-before-export and clean export, import button/drop filtering, banner measurements; pageerrors=0');
  console.log('Screenshots stored in hub-server/test/artifacts/phase8-*.png and banner-*.png');
} finally {
  await browser?.close(); await hub.close(); await rm(temp, { recursive: true, force: true });
}
