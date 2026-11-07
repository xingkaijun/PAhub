// Run after npm run hub:build. Real Chrome; isolated data only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-exchange-browser-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub(); let browser;
const artifacts = path.join(root, 'hub-server/test/artifacts'); await mkdir(artifacts, { recursive: true });
try {
  hub.db.sqlite.exec(await readFile(path.join(root, 'worker/sql/seed-test-data.sql'), 'utf8'));
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1600 }, acceptDownloads: true, locale: 'en-US' });
  const host = await context.newPage(), errors = []; host.on('pageerror', e => errors.push(e.message));
  const url = 'http://127.0.0.1:' + hub.port + '/pcf/proj-test-001/dwg-005';
  await host.goto(url); await host.locator('#pahub-export').waitFor();
  console.log('Hosted snapshot:', await host.locator('.banner-actions').innerText());
  for (let i = 1; i <= 2; i++) { await host.locator('#add-btn').click(); await host.locator('.editor[data-side="owner"]').nth(i - 1).fill('Owner Chrome comment ' + i); }
  await host.locator('#save-btn').click(); await host.waitForFunction(() => document.querySelector('#save-state').textContent.includes('Saved to server'));
  const exportDownload = host.waitForEvent('download'); await host.locator('#pahub-export').click();
  const exported = await exportDownload, exportedPath = path.join(temp, exported.suggestedFilename()); await exported.saveAs(exportedPath);
  assert.match(exported.suggestedFilename(), /^DW-E-005_R02_PCF_\d{4}-\d{2}-\d{2}\.html$/);
  assert.doesNotMatch(await readFile(exportedPath, 'utf8'), /X-PCF-Token|apiBase|pahub-context|clientId|\/api\//);
  const offlineContext = await browser.newContext({ viewport: { width: 1600, height: 1600 }, acceptDownloads: true, locale: 'en-US' });
  // Exercise the existing v1.9 download fallback, without automating an OS file picker.
  await offlineContext.addInitScript(() => { window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
  const builder = await offlineContext.newPage(); builder.on('pageerror', e => errors.push(e.message));
  await builder.goto(pathToFileURL(exportedPath).href); await builder.locator('#builder-notice').waitFor();
  console.log('Offline snapshot:', await builder.locator('#builder-notice').innerText());
  assert.equal(await builder.locator('.editor[data-side="owner"]').first().getAttribute('contenteditable'), 'false');
  assert.equal(await builder.locator('#add-btn').isDisabled(), true);
  for (let i = 1; i <= 2; i++) await builder.locator('.editor[data-side="reply"]').nth(i - 1).fill('Builder Chrome reply ' + i);
  await builder.screenshot({ path: path.join(artifacts, 'builder-offline.png'), fullPage: true });
  const returnedDownload = builder.waitForEvent('download'); await builder.locator('#save-as-btn').click();
  const returned = await returnedDownload, returnedPath = path.join(temp, 'builder-return.html'); await returned.saveAs(returnedPath);
  await builder.getByRole('button', { name: 'I have saved the copy', exact: true }).click();
  const reopened = await offlineContext.newPage(); reopened.on('pageerror', e => errors.push(e.message)); await reopened.goto(pathToFileURL(returnedPath).href);
  assert.equal(await reopened.locator('.editor[data-side="reply"]').first().innerText(), 'Builder Chrome reply 1');
  // Force one real server-vs-Builder conflict for the shared comparison component.
  await host.locator('.editor[data-side="reply"]').nth(1).fill('Server Chrome alternative'); await host.locator('#save-btn').click();
  await host.waitForFunction(() => document.querySelector('#save-state').textContent.includes('Saved to server'));
  await host.locator('#pahub-import-file').setInputFiles(returnedPath); await host.locator('#import-apply').waitFor();
  console.log('Import preview snapshot:', await host.locator('#modal-body').innerText());
  assert.match(await host.locator('#modal-body').innerText(), /Automatic merges \(1\)/); assert.match(await host.locator('#modal-body').innerText(), /Conflicts \(1\)/);
  await host.locator('[data-import-conflict="0"] .hub-choice').selectOption('merge');
  await host.locator('[data-import-conflict="0"] .hub-merge-editor').fill('Builder Chrome reply 2 — manually merged');
  await host.screenshot({ path: path.join(artifacts, 'builder-import-preview.png'), fullPage: true });
  await host.locator('#import-apply').click(); await host.waitForFunction(() => !document.querySelector('#modal').open);
  await host.waitForFunction(() => document.querySelector('.editor[data-side="reply"]')?.textContent.includes('Builder Chrome reply 1'));
  assert.equal(await host.locator('.editor[data-side="reply"]').nth(1).innerText(), 'Builder Chrome reply 2 — manually merged');
  await host.locator('#pahub-exchange').click(); await host.waitForFunction(() => document.querySelector('#modal').open && document.querySelector('#modal-title').textContent === 'Shipyard correspondence');
  assert.match(await host.locator('#modal-body').innerText(), /Imported/); await host.locator('#modal-footer [data-action="close-modal"]').click();
  await host.screenshot({ path: path.join(artifacts, 'builder-import-applied.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Chrome: Hub Export -> file:// Owner locked -> two Builder replies -> Save as/download -> reopened saved HTML -> upload preview (1 automatic/1 conflict) -> manual merge -> Confirm -> replies visible; correspondence Imported; pageerrors=0');
  console.log('Screenshots: hub-server/test/artifacts/builder-offline.png; builder-import-preview.png; builder-import-applied.png');
  console.log('Smoke data: ' + temp);
} finally { await browser?.close(); await hub.close(); }
