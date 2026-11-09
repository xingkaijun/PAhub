// Run after npm run hub:build. Chromium; isolated data only.
// Online PCF paste image -> save -> reopen (served by hash) -> Builder export -> offline file:// shows it ->
// Builder pastes a reply image -> Save as -> import -> both images stored as references and shown in the platform.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-images-browser-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub(); let browser;
const artifacts = path.join(root, 'hub-server/test/artifacts'); await mkdir(artifacts, { recursive: true });
// Paste a generated PNG (drawn on a canvas in the page) into an editor through a real ClipboardEvent.
const pasteImage = (page, selector, colour, label) => page.evaluate(async ({ selector, colour, label }) => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
  const g = canvas.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '32px sans-serif'; g.fillText(label, 20, 110);
  const blob = await new Promise(ok => canvas.toBlob(ok, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], label + '.png', { type: 'image/png' }));
  const editor = document.querySelector(selector); editor.focus();
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, { selector, colour, label });
const images = (page, side) => page.$$eval('.image-card img', (list, side) => list.filter(img => !side || img.closest('[data-side],.side,.cell')?.outerHTML.includes(side) || true)
  .map(img => ({ src: img.getAttribute('src').slice(0, 120), loaded: img.complete && img.naturalWidth > 0 })), side);
const waitImagesLoaded = (page, count) => page.waitForFunction(count => { const list = [...document.querySelectorAll('.image-card img')]; return list.length === count && list.every(img => img.complete && img.naturalWidth > 0); }, count, { timeout: 15000 });
try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 }, acceptDownloads: true, locale: 'en-US' });
  const host = await context.newPage(), errors = []; host.on('pageerror', e => errors.push(e.message));
  const url = 'http://127.0.0.1:' + hub.port + '/pcf/proj-test-001/dwg-005';
  await host.goto(url); await host.locator('#pahub-export').waitFor();
  await host.locator('#add-btn').click(); await host.locator('.editor[data-side="owner"]').first().fill('Owner comment with a pasted drawing');
  await pasteImage(host, '.editor[data-side="owner"]', '#1f6feb', 'OWNER');
  await waitImagesLoaded(host, 1);
  await host.locator('#save-btn').click(); await host.waitForFunction(() => document.querySelector('#save-state').textContent.includes('Saved to server'));
  // Stored as a reference; the bytes are a file under .images.
  const stored = JSON.parse(await readFile(path.join(temp, 'pcf/proj-test-001/dwg-005.json'), 'utf8'));
  const ownerRef = stored.comments[0].rounds[0].owner.images[0];
  assert.match(ownerRef.hash, /^[a-f0-9]{64}$/); assert.equal(ownerRef.data, undefined); assert.equal(ownerRef.mime, 'image/png');
  assert.doesNotMatch(JSON.stringify(stored), /data:image\//);
  // Reopen: the image is served by hash with a long immutable cache.
  const imageResponse = host.waitForResponse(r => r.url().includes('/images/' + ownerRef.hash));
  await host.reload(); await host.locator('#pahub-export').waitFor();
  const served = await imageResponse; assert.equal(served.status(), 200); assert.match(served.headers()['cache-control'], /immutable/);
  await waitImagesLoaded(host, 1);
  assert.match((await images(host))[0].src, new RegExp('/pcf/proj-test-001/dwg-005/images/' + ownerRef.hash + '$'));
  // Viewer uses the same source.
  await host.locator('.image-card img').first().click();
  await host.waitForFunction(() => { const img = document.querySelector('#large-image'); return img && img.complete && img.naturalWidth > 0; });
  assert.match(await host.locator('#large-image').getAttribute('src'), /\/images\/[a-f0-9]{64}$/);
  await host.keyboard.press('Escape');
  // Print Excel in the hub gets the image bytes (re-inlined in the browser).
  const printDownload = host.waitForEvent('download');
  await host.locator('#excel-menu-btn').click(); await host.locator('#print-xlsx-btn').click();
  const printed = await printDownload, printedPath = path.join(temp, 'print.xlsx'); await printed.saveAs(printedPath);
  assert.ok((await readFile(printedPath)).includes(Buffer.from('xl/media/')), 'print Excel embeds the image');
  // Builder export is self-contained.
  const exportDownload = host.waitForEvent('download'); await host.locator('#pahub-export').click();
  const exported = await exportDownload, exportedPath = path.join(temp, exported.suggestedFilename()); await exported.saveAs(exportedPath);
  const exportedHTML = await readFile(exportedPath, 'utf8');
  assert.doesNotMatch(exportedHTML, /\/images\/[a-f0-9]{64}/); assert.match(exportedHTML, /"data":"data:image\/png;base64,/);
  const offlineContext = await browser.newContext({ viewport: { width: 1600, height: 1400 }, acceptDownloads: true, locale: 'en-US', offline: true });
  await offlineContext.addInitScript(() => { window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
  const builder = await offlineContext.newPage(); builder.on('pageerror', e => errors.push(e.message));
  await builder.goto(pathToFileURL(exportedPath).href); await builder.locator('#builder-notice').waitFor();
  await waitImagesLoaded(builder, 1);
  assert.match((await images(builder))[0].src, /^data:image\/png;base64,/);
  await builder.locator('.editor[data-side="reply"]').first().fill('Builder reply with a photo');
  await pasteImage(builder, '.editor[data-side="reply"]', '#d1242f', 'BUILDER');
  await waitImagesLoaded(builder, 2);
  await builder.screenshot({ path: path.join(artifacts, 'images-builder-offline.png'), fullPage: true });
  await builder.locator('#save-menu-btn').click(); await builder.locator('#save-as-btn').waitFor({ state: 'visible' });
  const returnedDownload = builder.waitForEvent('download'); await builder.locator('#save-as-btn').click();
  const returned = await returnedDownload, returnedPath = path.join(temp, 'builder-return.html'); await returned.saveAs(returnedPath);
  await builder.getByRole('button', { name: 'I have saved the copy', exact: true }).click();
  // Import: the unchanged owner image is not tampering; the reply text and image merge automatically.
  await host.locator('#pahub-import-file').setInputFiles(returnedPath); await host.locator('#import-apply').waitFor();
  const previewText = await host.locator('#modal-body').innerText();
  assert.doesNotMatch(previewText, /tamper|modified Owner|Owner content was changed/i);
  assert.match(previewText, /Automatic merges \(2\)/); assert.doesNotMatch(previewText, /Conflicts \([1-9]/);
  await host.locator('#import-apply').click(); await host.waitForFunction(() => !document.querySelector('#modal').open);
  await host.waitForFunction(() => document.querySelector('.editor[data-side="reply"]')?.textContent.includes('Builder reply with a photo'));
  await waitImagesLoaded(host, 2);
  const shown = await images(host);
  assert.equal(shown.length, 2); for (const im of shown) assert.match(im.src, /\/images\/[a-f0-9]{64}$/);
  const after = JSON.parse(await readFile(path.join(temp, 'pcf/proj-test-001/dwg-005.json'), 'utf8'));
  const round = after.comments[0].rounds[0];
  assert.equal(round.owner.images[0].hash, ownerRef.hash); assert.match(round.reply.images[0].hash, /^[a-f0-9]{64}$/); assert.notEqual(round.reply.images[0].hash, ownerRef.hash);
  assert.doesNotMatch(JSON.stringify(after), /data:image\//);
  const files = (await readdir(path.join(temp, 'pcf/proj-test-001/.images'), { recursive: true })).filter(f => /\.png$/.test(f));
  assert.equal(files.length, 2);
  // Reopen once more: both images come from the platform.
  await host.reload(); await host.locator('#pahub-export').waitFor(); await waitImagesLoaded(host, 2);
  await host.screenshot({ path: path.join(artifacts, 'images-platform-after-import.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Chromium: paste owner image -> saved as reference ' + ownerRef.hash.slice(0, 12) + ' -> reopen served by hash (immutable) -> viewer -> print Excel has xl/media -> Builder export self-contained -> offline file:// shows image -> Builder pastes reply image -> Save as -> import preview (2 automatic, 0 conflicts, no tampering) -> applied -> 2 images shown from /images/ after reload; 2 image files; JSON has no data URLs; pageerrors=0');
  console.log('Screenshots: hub-server/test/artifacts/images-builder-offline.png; images-platform-after-import.png');
} finally { await browser?.close(); await hub.close(); }
