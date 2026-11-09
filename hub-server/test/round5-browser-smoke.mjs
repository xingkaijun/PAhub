// Run after npm run hub:build: node hub-server/test/round5-browser-smoke.mjs
// Real browser, real hub server (fixture data):
//  1. favicon: /favicon.ico and /favicon.svg answer 200, index.html declares them, no console errors;
//  2. a project that is gone from the server (404 on open) shows the "does not exist" notice and stays on the selector
//     (no local copy is opened);
//  3. at 390px the inventory page and the hosted PCF page have no horizontal overflow (scrollWidth <= viewport),
//     also with every PCF banner menu open, and the secondary inventory actions sit in a "More" menu;
//  4. the Builder offline file at 390px: no overflow, the primary "Save copy to return" button is visible in the
//     Builder notice and saves a copy; the owner/hosted page has no such button;
//  5. at 1440px the desktop toolbar is unchanged (all buttons inline, no "More").
// Screenshots go to hub-server/test/artifacts/round5-*.png.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-round5-e2e-'));
const shots = path.join(root, 'hub-server/test/artifacts'); await mkdir(shots, { recursive: true });
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: '' });
const hub = await createHub({ host: '127.0.0.1' }); let browser;
const origin = 'http://127.0.0.1:' + hub.port, P = 'proj-test-001', NAME = 'PG-VLEC-H2684', GONE = 'PG-GONE-H0000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const problems = [];
const watch = (page, label) => {
  page.on('pageerror', error => problems.push(label + ' pageerror: ' + error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404 (Not Found)')) problems.push(label + ' console: ' + message.text()); });
  page.on('response', response => {
    const url = new URL(response.url());
    // The only expected 4xx is the deliberate 404 for the deleted project in step 2.
    if (response.status() >= 400 && url.pathname !== '/api/projects/proj-gone') problems.push(label + ' ' + response.status() + ' ' + url.pathname);
  });
};
const overflow = page => page.evaluate(() => {
  const vw = document.documentElement.clientWidth, sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  return { vw, sw };
});
const noOverflow = async (page, label) => {
  const { vw, sw } = await overflow(page);
  assert.ok(sw <= vw, `${label}: scrollWidth ${sw} > viewport ${vw}`);
  return `${label} scrollWidth=${sw} viewport=${vw}`;
};

try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  hub.db.prepare("INSERT INTO projects (id, name, storage_path, last_updated) VALUES ('proj-gone', ?, NULL, datetime('now'))").run(GONE);
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });

  // 1. favicon
  for (const [file, type] of [['/favicon.ico', /^image\/(x-icon|vnd\.microsoft\.icon)$/], ['/favicon.svg', /^image\/svg\+xml/]]) {
    const response = await fetch(origin + file);
    assert.equal(response.status, 200, file); assert.match(response.headers.get('content-type') || '', type, file);
    assert.ok((await response.arrayBuffer()).byteLength > 100, file);
  }
  const html = await (await fetch(origin + '/')).text();
  assert.match(html, /<link rel="icon" href="\/favicon\.ico"/); assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
  console.log('Favicon: /favicon.ico 200, /favicon.svg 200, declared in index.html');

  // 2. loadProject 404 -> notice, selector stays
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await desktop.addInitScript(() => localStorage.setItem('pahub.clientName', 'Round5'));
  const page = await desktop.newPage(); watch(page, 'desktop');
  const favicons = [];
  page.on('response', response => { if (/\/favicon\.(ico|svg)$/.test(new URL(response.url()).pathname)) favicons.push(response.status()); });
  await page.goto(origin + '/');
  await page.getByRole('button', { name: new RegExp(GONE) }).first().waitFor();
  hub.db.prepare("DELETE FROM projects WHERE id='proj-gone'").run();
  await page.getByRole('button', { name: new RegExp(GONE) }).first().click();
  const notice = page.getByTestId('project-not-found');
  await notice.waitFor();
  const noticeText = await notice.innerText();
  assert.match(noticeText, new RegExp(`Project "${GONE}" does not exist on the server`));
  assert.equal(await page.getByText('Project Access Hall').isVisible(), true, 'still on the project selector');
  assert.equal(await page.locator('td', { hasText: /^DW-A-001$/ }).count(), 0, 'no project table opened');
  console.log('404 notice: "' + noticeText.replace(/\s*×$/, '') + '"');
  await page.screenshot({ path: path.join(shots, 'round5-project-not-found-1440.png') });
  await page.getByRole('button', { name: 'Dismiss project notice' }).click();
  assert.ok(favicons.length > 0 && favicons.every(status => status === 200), 'browser favicon requests: ' + favicons.join(','));
  console.log('Browser favicon requests: ' + favicons.join(','));

  // 5. desktop toolbar unchanged
  await page.getByRole('button', { name: new RegExp(NAME) }).first().click();
  await page.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor(); await sleep(800);
  for (const name of [/Import Builder Replies/, /Print List/, /Team Setup/, /Bulk Load/]) assert.equal(await page.getByRole('button', { name }).first().isVisible(), true, String(name));
  assert.equal(await page.locator('[data-inventory-more]').isVisible(), false);
  const search = await page.locator('[data-inventory-toolbar] input').first().boundingBox();
  assert.equal(Math.round(search.width), 288, 'desktop search box keeps w-72');
  console.log(await noOverflow(page, 'Inventory 1440'));
  await page.screenshot({ path: path.join(shots, 'round5-inventory-1440.png') });
  const hosted1440 = await desktop.newPage(); watch(hosted1440, 'pcf1440');
  await hosted1440.goto(origin + '/pcf/' + P + '/dwg-005'); await hosted1440.locator('#pahub-export').waitFor(); await sleep(500);
  console.log(await noOverflow(hosted1440, 'Hosted PCF 1440'));
  await hosted1440.screenshot({ path: path.join(shots, 'round5-pcf-1440.png') });

  // 3. phones: inventory
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  await phone.addInitScript(() => localStorage.setItem('pahub.clientName', 'Round5Phone'));
  const mobile = await phone.newPage(); watch(mobile, 'mobile');
  await mobile.goto(origin + '/');
  await mobile.getByRole('button', { name: new RegExp(NAME) }).first().click();
  await mobile.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor(); await sleep(1000);
  console.log(await noOverflow(mobile, 'Inventory 390'));
  const toolbar = await mobile.locator('[data-inventory-toolbar]').boundingBox();
  const mobileSearch = await mobile.locator('[data-inventory-toolbar] input').first().boundingBox();
  assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= 390, 'toolbar inside the viewport: ' + JSON.stringify(toolbar));
  assert.ok(mobileSearch.width >= toolbar.width - 60, 'search box spans the row: ' + JSON.stringify(mobileSearch));
  for (const name of [/Import Builder Replies/, /Print List/, /Team Setup/, /Bulk Load/]) assert.equal(await mobile.getByRole('button', { name }).first().isVisible(), false, 'hidden on phones: ' + name);
  const more = mobile.locator('[data-inventory-more]');
  assert.equal(await more.isVisible(), true);
  await mobile.screenshot({ path: path.join(shots, 'round5-inventory-390.png') });
  await more.click();
  const items = await mobile.getByRole('menuitem').allTextContents();
  assert.deepEqual(items.map(text => text.trim()), ['Import Builder Replies', 'Print List', 'Team Setup', 'Bulk Load']);
  console.log(await noOverflow(mobile, 'Inventory 390 with More open'));
  const menu = await mobile.getByRole('menu').boundingBox();
  assert.ok(menu.x >= 0 && menu.x + menu.width <= 390, 'More menu inside the viewport');
  await mobile.screenshot({ path: path.join(shots, 'round5-inventory-390-more.png') });
  await mobile.getByRole('menuitem', { name: 'Import Builder Replies' }).click();
  await mobile.locator('#builder-replies-title').waitFor();
  await mobile.keyboard.press('Escape'); await mobile.locator('#builder-replies-title').waitFor({ state: 'hidden' });
  console.log('Inventory 390: search box ' + Math.round(mobileSearch.width) + 'px, More menu = ' + items.map(text => text.trim()).join(' / ') + '; Import Builder Replies opens from More');

  // 3. phones: hosted PCF, with each banner menu open
  const hosted = await phone.newPage(); watch(hosted, 'pcf390');
  await hosted.goto(origin + '/pcf/' + P + '/dwg-005'); await hosted.locator('#pahub-export').waitFor(); await sleep(500);
  const pcfLines = [await noOverflow(hosted, 'Hosted PCF 390')];
  for (const menuName of ['save', 'json', 'excel']) {
    await hosted.locator(`.banner-menu[data-menu=${menuName}] .menu-trigger`).click(); await sleep(250);
    const box = await hosted.locator(`.banner-menu[data-menu=${menuName}] .banner-menu-panel`).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${menuName} menu panel inside the viewport: ` + JSON.stringify(box));
    pcfLines.push(await noOverflow(hosted, `Hosted PCF 390 (${menuName} menu open)`));
    await hosted.mouse.click(5, 700); await sleep(200);
  }
  assert.equal(await hosted.locator('#builder-save-copy').count(), 0, 'no Builder button on the owner/hosted page');
  console.log(pcfLines.join('; '));
  await hosted.screenshot({ path: path.join(shots, 'round5-pcf-390.png') });

  // 4. Builder offline file at 390px
  const exported = hosted.waitForEvent('download'); await hosted.locator('#pahub-export').click();
  const builderFile = path.join(temp, 'builder.html'); await (await exported).saveAs(builderFile);
  // Without the File System Access API (Firefox, phones) Save copy downloads the HTML, as Save as does.
  const builderPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  await builderPhone.addInitScript(() => { window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
  const builder = await builderPhone.newPage(); watch(builder, 'builder390');
  await builder.goto(pathToFileURL(builderFile).href); await builder.locator('#builder-notice').waitFor(); await sleep(400);
  const builderLines = [await noOverflow(builder, 'Builder file 390')];
  for (const menuName of ['save', 'json', 'excel']) {
    await builder.locator(`.banner-menu[data-menu=${menuName}] .menu-trigger`).click(); await sleep(250);
    builderLines.push(await noOverflow(builder, `Builder file 390 (${menuName} menu open)`));
    await builder.mouse.click(5, 700); await sleep(200);
  }
  const primary = builder.locator('#builder-notice #builder-save-copy');
  assert.equal(await primary.isVisible(), true);
  assert.equal(await primary.innerText(), 'Save copy to return');
  const primaryBox = await primary.boundingBox();
  assert.ok(primaryBox.y < 300 && primaryBox.x >= 0 && primaryBox.x + primaryBox.width <= 390, 'primary button near the top, in view: ' + JSON.stringify(primaryBox));
  await builder.screenshot({ path: path.join(shots, 'round5-builder-primary-390.png') });
  const saved = builder.waitForEvent('download'); await primary.click();
  const copy = await saved; const copyPath = path.join(temp, 'returned.html'); await copy.saveAs(copyPath);
  const copyHtml = await readFile(copyPath, 'utf8');
  assert.match(copyHtml, /id="builder-notice"/); assert.ok(copyHtml.length > 100000);
  console.log(builderLines.join('; '));
  console.log('Builder primary button: visible at y=' + Math.round(primaryBox.y) + ', saved copy ' + copy.suggestedFilename() + ' (' + copyHtml.length + ' chars)');
  // With the File System Access API (Edge / Chrome desktop) Save copy opens the save-file picker, as Save as does.
  const builderDesktop = await desktop.newPage(); watch(builderDesktop, 'builder1440');
  await builderDesktop.addInitScript(() => { window.__pickerCalls = []; window.showSaveFilePicker = async options => { window.__pickerCalls.push(options.suggestedName); throw new DOMException('cancelled', 'AbortError'); }; });
  await builderDesktop.goto(pathToFileURL(builderFile).href); await builderDesktop.locator('#builder-save-copy').waitFor(); await sleep(300);
  await builderDesktop.locator('#builder-save-copy').click(); await sleep(300);
  const pickerCalls = await builderDesktop.evaluate(() => window.__pickerCalls);
  assert.equal(pickerCalls.length, 1); assert.match(pickerCalls[0], /\.html$/);
  console.log('Builder primary button (1440, File System Access API): save picker opened with ' + pickerCalls[0]);
  await builderDesktop.screenshot({ path: path.join(shots, 'round5-builder-primary-1440.png') });

  assert.deepEqual(problems, []);
  console.log('Round 5 browser smoke: PASS; console errors=0, unexpected 4xx/5xx=0');
} finally {
  await browser?.close(); await hub.close();
}
