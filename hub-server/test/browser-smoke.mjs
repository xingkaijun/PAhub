// Run after npm run hub:build: node hub-server/test/browser-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-browser-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub(); let browser;
const artifacts = path.join(root, 'hub-server/test/artifacts'); await mkdir(artifacts, { recursive: true });
try {
  hub.db.sqlite.exec(await readFile(path.join(root, 'worker/sql/seed-test-data.sql'), 'utf8'));
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chrome' });
  const contexts = await Promise.all(['A工','B工'].map(async nickname => { const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.addInitScript(name => localStorage.setItem('pahub.clientName', name), nickname); return context; }));
  const [a,b] = await Promise.all(contexts.map(context => context.newPage()));
  const errors = []; for (const page of [a,b]) page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:' + hub.port + '/pcf/proj-test-001/dwg-005';
  await Promise.all([a.goto(url),b.goto(url)]);
  // Snapshot UI before locating the actual controls.
  console.log('Browser initial:', await a.locator('#save-btn').innerText(), await a.locator('#add-btn').innerText());
  await a.waitForFunction(() => document.querySelector('#pahub-online').textContent.includes('Online: 2 users'));
  await a.locator('#add-btn').click(); await a.locator('.editor[data-side="owner"]').fill('A realtime browser smoke 2026-11-07'); await a.locator('#save-btn').click();
  await b.waitForFunction(() => document.querySelector('.editor[data-side="owner"]')?.textContent.includes('A realtime browser smoke'));
  assert.match(await b.locator('.editor[data-side="owner"]').innerText(), /A realtime browser smoke/);
  // B keeps a real caret in reply while A changes owner: do not replace its node.
  await b.locator('.editor[data-side="reply"]').click();
  await b.evaluate(() => { window.smokeFocusedEditor = document.activeElement; });
  await a.locator('.editor[data-side="owner"]').fill('A second update, B caret preserved'); await a.locator('#save-btn').click();
  await b.waitForFunction(() => document.querySelector('.editor[data-side="owner"]')?.textContent.includes('A second update'));
  assert.equal(await b.evaluate(() => window.smokeFocusedEditor === document.activeElement && document.activeElement.isConnected), true);
  await Promise.all([a.screenshot({ path: path.join(artifacts,'realtime-A.png'), fullPage: true }),b.screenshot({ path: path.join(artifacts,'realtime-B.png'), fullPage: true })]);
  assert.deepEqual(errors, []);
  console.log('Chrome two isolated contexts: A input+save -> B auto displays; second owner update preserves B reply node+caret; pageerrors=0');
  console.log('Screenshots: hub-server/test/artifacts/realtime-A.png; hub-server/test/artifacts/realtime-B.png');
  console.log('Smoke data: ' + temp);
} finally { await browser?.close(); await hub.close(); }
