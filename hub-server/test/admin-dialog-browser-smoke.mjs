// After npm run hub:build: node hub-server/test/admin-dialog-browser-smoke.mjs
// Actual app + isolated fixture DB; screenshots at 1920 and 1366. No live services or credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-admin-dialog-'));
const shots = path.join(root, 'hub-server/test/artifacts');
await mkdir(shots, { recursive: true });
const password = randomBytes(24).toString('hex');
const env = { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), PAPC_DIST_DIR: path.join(root, 'dist'), API_TOKEN: '', ADMIN_PASSWORD: password, NODE_ENV: 'production' };
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
let hub, browser;
const problems = [];

// Geometry + hit testing verifies corners, navigation, sticky CommandBar and footer are underneath.
async function checkOverlay(page, title) {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  const geometry = await dialog.evaluate(element => {
    const overlay = element.parentElement;
    const box = overlay.getBoundingClientRect(), panel = element.getBoundingClientRect();
    const style = getComputedStyle(overlay);
    const w = innerWidth, h = innerHeight;
    const points = [[2, 2], [w - 2, 2], [2, h - 2], [w - 2, h - 2]];
    for (const selector of ['#root > div > header', '#root main input[placeholder^="Terminal"]', '#root > div > footer']) {
      const target = document.querySelector(selector);
      if (!target) throw new Error('Missing background element: ' + selector);
      const rect = target.getBoundingClientRect();
      points.push([rect.x + rect.width / 2, rect.y + rect.height / 2]);
    }
    const badges = [...document.querySelectorAll('#root span')].filter(node => /@001/.test(node.textContent));
    if (!badges.length) throw new Error('Missing CommandBar hints');
    for (const badge of badges) {
      const rect = badge.getBoundingClientRect();
      if (rect.width && rect.height) points.push([rect.x + rect.width / 2, rect.y + rect.height / 2]);
    }
    return {
      x: box.x, y: box.y, width: box.width, height: box.height, w, h,
      centered: Math.abs(panel.x + panel.width / 2 - w / 2) < 1 && Math.abs(panel.y + panel.height / 2 - h / 2) < 1,
      bodyPortal: overlay.parentElement === document.body,
      covered: points.every(([x, y]) => overlay.contains(document.elementFromPoint(x, y))),
      position: style.position, zIndex: Number(style.zIndex), blur: style.backdropFilter,
      color: style.backgroundColor, bodyOverflow: document.body.style.overflow,
      htmlOverflow: document.documentElement.style.overflow, backgroundInert: document.querySelector('#root').inert,
    };
  });
  assert.equal(geometry.bodyPortal, true);
  assert.equal(geometry.position, 'fixed');
  assert.deepEqual([geometry.x, geometry.y, geometry.width, geometry.height], [0, 0, geometry.w, geometry.h]);
  assert.equal(geometry.centered, true);
  assert.equal(geometry.covered, true, 'navigation, commands, hints, footer and corners all behind overlay');
  assert.ok(geometry.zIndex > 10001);
  assert.match(geometry.blur, /blur\(/);
  assert.notEqual(geometry.color, 'rgba(0, 0, 0, 0)');
  assert.equal(geometry.bodyOverflow, 'hidden');
  assert.equal(geometry.htmlOverflow, 'hidden');
  assert.equal(geometry.backgroundInert, true);
  return dialog;
}

try {
  hub = await createHub({ host: '127.0.0.1' });
  assert.ok(![8080, 8081, 8082].includes(hub.port));
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const origin = 'http://127.0.0.1:' + hub.port;
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });

  for (const [width, height] of [[1920, 1080], [1366, 768]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(() => localStorage.setItem('pahub.clientName', 'DialogFixture'));
    // Never send browser requests to live/external services (including the remote logo).
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0f766e"/></svg>' }));
    const page = await context.newPage();
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) problems.push(response.status() + ' ' + new URL(response.url()).pathname); });
    await page.goto(origin);
    await page.getByRole('button', { name: /PG-VLEC-H2684/ }).first().click();
    await expect(page.locator('td', { hasText: /^DW-A-001$/ }).first()).toBeVisible();
    await expect(page.locator('input[placeholder="Terminal commands require administrator sign-in"]')).toBeVisible();
    const inventoryLogin = page.getByRole('button', { name: 'Admin Sign-in', exact: true });
    const navLogin = page.locator('header [data-admin-session]').first();

    // This opener lives inside the filtered/clipped inventory surface: the original regression.
    await inventoryLogin.click();
    const dialog = await checkOverlay(page, 'Administrator Sign-in');
    await expect(page.locator('#admin-password')).toBeFocused();
    await page.screenshot({ path: path.join(shots, `admin-login-${width}.png`) });
    const beforeScroll = await page.locator('main').evaluate(element => element.scrollTop);
    await page.mouse.move(20, height / 2);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('main').evaluate(element => element.scrollTop), beforeScroll, 'background does not scroll');
    await page.keyboard.press('Tab'); // Cancel (submit disabled while empty).
    await page.keyboard.press('Tab'); // Wrap to Close instead of background navigation.
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(inventoryLogin).toBeFocused();
    assert.deepEqual(await page.evaluate(() => [document.body.style.overflow, document.documentElement.style.overflow, document.querySelector('#root').inert]), ['', '', false]);

    // Header opener and backdrop click share the same full-viewport behaviour.
    await navLogin.click();
    await checkOverlay(page, 'Administrator Sign-in');
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await expect(navLogin).toBeFocused();

    // Enter submits to the actual server. Production over HTTP must retain a usable non-Secure cookie.
    await inventoryLogin.click();
    await page.locator('#admin-password').fill(password);
    const signedIn = page.waitForResponse(response => response.url() === origin + '/api/session' && response.request().method() === 'POST');
    await page.keyboard.press('Enter');
    assert.equal((await signedIn).status(), 200);
    await expect(dialog).toHaveCount(0);
    await expect(navLogin).toHaveAttribute('data-admin-session', 'admin');
    const cookie = (await context.cookies()).find(cookie => cookie.name === 'pahub_admin');
    assert.ok(cookie);
    assert.equal(cookie.secure, false);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    const session = await context.request.get(origin + '/api/session');
    assert.equal((await session.json()).admin, true);

    // Other affected dialogs now use the exact same portal and coverage checks.
    for (const [opener, title] of [['Bulk Load', 'Fleet Bulk Entry'], ['Team Setup', 'Team Setup']]) {
      await page.getByRole('button', { name: opener, exact: true }).click();
      const other = await checkOverlay(page, title);
      await page.keyboard.press('Escape');
      await expect(other).toHaveCount(0);
    }
    // Existing Builder Replies portal remains above the header/CommandBar too.
    await page.getByRole('button', { name: 'Import Builder Replies' }).click();
    await checkOverlay(page, 'Import Builder Replies');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await context.close();
    console.log(`${width}x${height}: full-screen dim/blur including navigation, commands/hints and footer; centered; focus/Tab/Esc/backdrop/scroll lock/Enter PASS; production HTTP cookie PASS; Bulk Load/Team Setup/Builder Replies PASS`);
  }
  assert.deepEqual(problems, []);
  console.log('Admin dialog browser smoke: PASS; console/page errors=0, unexpected HTTP errors=0');
} finally {
  await browser?.close();
  await hub?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
