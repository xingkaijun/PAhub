// Run after npm run hub:build: node hub-server/test/manual-browser-smoke.mjs
// Real browser, real hub server (fixture data), for the Chinese operations manual page:
//  1. /manual/ and /manual are served as the manual (not the app shell); every screenshot it references is a file under
//     /manual/img/ that answers 200 as an image, and the page holds no base64 images;
//  2. standalone at 390px: every image has loaded (naturalWidth > 0), no horizontal overflow, and the numbered step
//     lists (ol.steps) keep a readable width (no text squeezed into a narrow column);
//  3. in the app: phones get a header link to /manual/; Guide shows the Chinese manual by default in a frame, the
//     frame's images load, at 390px neither the page nor the frame overflows; the English toggle shows the English guide;
//  4. the project selector links to the manual; the standalone page's "返回平台" goes back to /.
// Screenshots go to hub-server/test/artifacts/manual-*.png.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-manual-e2e-'));
const shots = path.join(root, 'hub-server/test/artifacts'); await mkdir(shots, { recursive: true });
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: '' });
const hub = await createHub({ host: '127.0.0.1' }); let browser;
const origin = 'http://127.0.0.1:' + hub.port, NAME = 'PG-VLEC-H2684';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const problems = [];
const watch = (page, label) => {
  page.on('pageerror', error => problems.push(label + ' pageerror: ' + error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(label + ' console: ' + message.text()); });
  page.on('response', response => { if (response.status() >= 400) problems.push(label + ' ' + response.status() + ' ' + new URL(response.url()).pathname); });
};
const widths = target => target.evaluate(() => ({
  vw: document.documentElement.clientWidth,
  sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
}));
const imageState = target => target.evaluate(async () => {
  const images = [...document.querySelectorAll('img')];
  for (const image of images) { image.loading = 'eager'; image.scrollIntoView(); }
  await Promise.all(images.map(image => image.complete ? null : new Promise(done => { image.onload = image.onerror = done; })));
  window.scrollTo(0, 0);
  return images.map(image => ({ src: image.getAttribute('src'), w: image.naturalWidth }));
});
const stepWidths = target => target.evaluate(() => [...document.querySelectorAll('ol.steps > li')].map(li => Math.round(li.getBoundingClientRect().width)));

try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));

  // 1. HTTP
  const html = await (await fetch(origin + '/manual/')).text();
  assert.match(html, /<title>PAhub 操作手册<\/title>/); assert.doesNotMatch(html, /base64,/); assert.doesNotMatch(html, /id="root"/);
  assert.match(await (await fetch(origin + '/manual')).text(), /<title>PAhub 操作手册<\/title>/);
  const sources = [...new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(match => match[1]))];
  const shotsInPage = sources.filter(src => src.startsWith('/manual/img/'));
  assert.ok(shotsInPage.length >= 20, 'manual screenshots: ' + shotsInPage.length);
  for (const src of sources) {
    const response = await fetch(origin + src);
    assert.equal(response.status, 200, src); assert.match(response.headers.get('content-type') || '', /^image\//, src);
    assert.ok((await response.arrayBuffer()).byteLength > 1000, src);
  }
  for (const id of ['flow', 'perm', 'inv', 'pcf', 'builder', 'ops', 'known']) assert.match(html, new RegExp('<h2 id="' + id + '"'), id);
  console.log('HTTP: /manual/ and /manual serve the manual, ' + sources.length + ' images (' + shotsInPage.length + ' screenshots) all 200, no base64');

  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // 2. standalone at 390px
  const page = await mobile.newPage(); watch(page, 'manual390');
  await page.goto(origin + '/manual/'); await page.locator('h1').waitFor();
  const images = await imageState(page);
  assert.deepEqual(images.filter(image => image.w === 0), [], 'all images loaded');
  const standalone = await widths(page);
  assert.ok(standalone.sw <= standalone.vw, `standalone scrollWidth ${standalone.sw} > viewport ${standalone.vw}`);
  const steps = await stepWidths(page);
  assert.ok(steps.length >= 10, 'ol.steps items: ' + steps.length);
  assert.ok(Math.min(...steps) >= 250, 'narrowest step item ' + Math.min(...steps) + 'px');
  assert.equal(await page.locator('header.bar').isVisible(), true);
  await page.screenshot({ path: path.join(shots, 'manual-standalone-390.png') });
  await page.locator('#perm').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shots, 'manual-standalone-390-perm.png') });
  await page.locator('a.back').click(); await page.waitForURL(origin + '/'); 
  console.log(`Standalone 390: ${images.length} images loaded, scrollWidth=${standalone.sw} viewport=${standalone.vw}, ${steps.length} step items, narrowest ${Math.min(...steps)}px; 返回平台 -> /`);

  // 4. project selector link
  const selectorLink = page.locator('a[href="/manual/"]').first();
  await selectorLink.waitFor(); assert.equal(await selectorLink.getAttribute('target'), '_blank');
  console.log('Project selector: book icon links to /manual/ (new tab)');

  // 3. in the app. Phones have no tab bar, so a 390px phone gets a header link to /manual/; the Guide tab itself is
  //    opened at desktop width and then checked at 390px.
  await page.getByRole('button', { name: new RegExp(NAME + '(?! 演示项目)') }).first().click();
  await page.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor({ state: 'attached' }); await sleep(500);
  const phoneLink = page.getByTestId('mobile-manual-link');
  assert.equal(await phoneLink.isVisible(), true, 'phone header shows the manual link');
  assert.equal(await phoneLink.getAttribute('href'), '/manual/');
  const linkBox = await phoneLink.boundingBox(); assert.ok(linkBox.x >= 0 && linkBox.x + linkBox.width <= 390, 'phone manual link in view ' + JSON.stringify(linkBox));
  const phoneHeader = await widths(page); assert.ok(phoneHeader.sw <= phoneHeader.vw, `inventory 390 scrollWidth ${phoneHeader.sw}`);
  console.log('Phone header (390): manual link visible at x=' + Math.round(linkBox.x) + ', href /manual/');

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wide = await desktop.newPage(); watch(wide, 'manual-app');
  await wide.goto(origin + '/');
  await wide.getByRole('button', { name: new RegExp(NAME + '(?! 演示项目)') }).first().click();
  await wide.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor();
  await wide.getByRole('button', { name: /^Guide$/ }).click();
  const wideFrame = wide.getByTestId('manual-frame'); await wideFrame.waitFor();
  const wideInner = await (await wideFrame.elementHandle()).contentFrame(); await wideInner.locator('h1').waitFor();
  assert.equal(await wideInner.locator('header.bar').isVisible(), false, 'embedded manual hides its own header');
  const wideImages = await imageState(wideInner);
  assert.deepEqual(wideImages.filter(image => image.w === 0), [], 'all frame images loaded');
  const wideBox = await wideFrame.boundingBox(); assert.ok(wideBox.height >= 500, 'desktop frame height ' + wideBox.height);
  await sleep(300); await wide.screenshot({ path: path.join(shots, 'manual-in-app-1440.png') });
  console.log(`In app 1440: Guide shows the manual frame ${Math.round(wideBox.width)}x${Math.round(wideBox.height)}, ${wideImages.length} images loaded`);

  await wide.setViewportSize({ width: 390, height: 844 }); await sleep(600);
  const frameElement = wide.getByTestId('manual-frame');
  const frame = await (await frameElement.elementHandle()).contentFrame();
  const box = await frameElement.boundingBox(); assert.ok(box.height >= 400, 'frame height at 390 ' + box.height);
  const inner = await widths(frame), outer = await widths(wide);
  assert.ok(inner.sw <= inner.vw, `frame scrollWidth ${inner.sw} > ${inner.vw}`);
  assert.ok(outer.sw <= outer.vw, `page scrollWidth ${outer.sw} > ${outer.vw}`);
  const frameSteps = await stepWidths(frame);
  assert.ok(Math.min(...frameSteps) >= 200, 'narrowest step item in frame ' + Math.min(...frameSteps) + 'px');
  await wide.screenshot({ path: path.join(shots, 'manual-in-app-390.png') });
  console.log(`In app 390: frame ${Math.round(box.width)}x${Math.round(box.height)}, frame scrollWidth=${inner.sw}/${inner.vw}, page scrollWidth=${outer.sw}/${outer.vw}, narrowest step ${Math.min(...frameSteps)}px`);
  await wide.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
  await wide.getByRole('tab', { name: 'English' }).click();
  await wide.getByTestId('english-guide').getByText('1. Server Data, Saving & Sign-in').waitFor();
  await wide.setViewportSize({ width: 390, height: 844 }); await sleep(400);
  const english = await widths(wide); assert.ok(english.sw <= english.vw, `English guide scrollWidth ${english.sw} > ${english.vw}`);
  await wide.setViewportSize({ width: 1440, height: 900 });
  await wide.getByRole('tab', { name: '中文手册' }).click(); await wide.getByTestId('manual-frame').waitFor();
  console.log(`English toggle: original English guide shown (390 scrollWidth=${english.sw}/${english.vw}); back to 中文手册`);

  assert.deepEqual(problems, []);
  console.log('Manual browser smoke: PASS; console errors=0, 4xx/5xx=0');
} finally {
  await browser?.close(); await hub.close();
}
