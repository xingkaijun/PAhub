// Run after npm run hub:build: node hub-server/test/lobby-browser-smoke.mjs
// Real browser, real hub server (fixture data), for the Project Access Hall (Blueprint lobby, the default selector):
//  1. at 1440 and 390: the hall shows with no ?lobby parameter, the PG logo is visible (and large), every project has a
//     card, the entry points are there (refresh, manual book icon, offline mode), no horizontal overflow;
//  2. clicking a card plays the book opening (closed book fills the screen, then the cover opens) and lands on Inventory
//     with its drawings, still without horizontal overflow;
//  3. a password-protected project: the prompt appears only once the closed book is up; a wrong password asks again,
//     the right one opens Inventory; cancelling returns to the hall with every card usable;
//  4. prefers-reduced-motion: the hall fades straight to Inventory;
//  5. no console errors and no unexpected 4xx/5xx (the expected 401s of the password check are allowed).
// Screenshots go to hub-server/test/artifacts/lobby-*.png.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-lobby-e2e-'));
const shots = path.join(root, 'hub-server/test/artifacts'); await mkdir(shots, { recursive: true });
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: '' });
const hub = await createHub({ host: '127.0.0.1' }); let browser;
const origin = 'http://127.0.0.1:' + hub.port, NAME = 'PG-VLEC-H2684', LOCKED = 'PG-LOCK-H0001', SECRET = 'open-sesame';
const problems = [];
const watch = (page, label) => {
  page.on('pageerror', error => problems.push(label + ' pageerror: ' + error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // The browser logs every non-2xx fetch as a console error; the password check's 401s are expected.
    if (/status of 401/.test(message.text())) return;
    problems.push(label + ' console: ' + message.text());
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() === 401 && url.pathname === '/api/projects/proj-lock-001') return;
    if (response.status() >= 400) problems.push(label + ' ' + response.status() + ' ' + url.pathname);
  });
};
const widths = page => page.evaluate(() => ({
  vw: document.documentElement.clientWidth,
  sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, document.querySelector('.pl-scroll')?.scrollWidth || 0),
}));
const card = (page, name) => page.locator('[data-pl-card]').filter({ has: page.locator('[data-pl-name]', { hasText: new RegExp('^' + name + '$') }) });
const inventory = async page => {
  await page.waitForFunction(() => !document.querySelector('.pl-root'), null, { timeout: 15000 });
  await page.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor({ timeout: 15000 });
};

try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  // A second, password-protected project: same drawings, a project password in its settings.
  hub.db.exec(`INSERT INTO projects (id, name, storage_path, last_updated) VALUES ('proj-lock-001', '${LOCKED}', NULL, datetime('now'))`);
  hub.db.exec(`INSERT INTO project_settings (project_id, setting_key, setting_value) VALUES ('proj-lock-001', 'password', '${SECRET}')`);
  const cols = 'custom_id, drawing_no, discipline, title, status, version, current_round, review_deadline, manual_comments_count, manual_open_comments_count, received_date, category';
  hub.db.exec(`INSERT INTO drawings (id, project_id, ${cols}) SELECT 'lock-' || id, 'proj-lock-001', ${cols} FROM drawings WHERE project_id='proj-test-001'`);

  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });
  for (const [w, h, label] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, ...(w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage(); watch(page, 'lobby' + w);

    // 1. the hall, no ?lobby parameter
    await page.goto(origin + '/');
    await page.getByRole('dialog', { name: 'Project Access Hall' }).waitFor();
    await card(page, NAME).waitFor();
    await page.waitForTimeout(900);
    const logo = await page.locator('.pl-root .pl-logo').first().boundingBox();
    assert.ok(logo && logo.width >= (w < 600 ? 50 : 70), `${label}: PG logo ${JSON.stringify(logo)}`);
    assert.equal(await page.locator('.pl-root .pl-logo img').first().evaluate(img => img.complete && img.naturalWidth > 0), true, 'PG logo image loaded');
    assert.equal(await card(page, NAME).count(), 1); assert.equal(await card(page, LOCKED).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Refresh project list' }).isVisible(), true);
    assert.equal(await page.locator('.pl-root a[href="/manual/"]').first().isVisible(), true, 'manual book icon');
    assert.ok(await page.locator('.pl-root').getByText(/offline/i).count() > 0, 'offline mode entry');
    const before = await widths(page);
    assert.ok(before.sw <= before.vw, `${label} hall scrollWidth ${before.sw} > ${before.vw}`);
    await page.screenshot({ path: path.join(shots, `lobby-hall-${w}.png`) });

    // 2. click -> closed book -> cover opens -> Inventory
    const t0 = Date.now();
    await card(page, NAME).click();
    await page.waitForFunction(() => document.querySelector('.pl-root')?.dataset.phase === 'revealing', null, { polling: 'raf', timeout: 15000 });
    const tBook = Date.now() - t0;
    await inventory(page);
    const tDone = Date.now() - t0;
    assert.ok(tDone < 6000, `${label}: click to Inventory took ${tDone} ms`);
    const after = await widths(page);
    assert.ok(after.sw <= after.vw, `${label} Inventory scrollWidth ${after.sw} > ${after.vw}`);
    await page.screenshot({ path: path.join(shots, `lobby-inventory-${w}.png`) });
    console.log(`${label} ${w}: hall shown without ?lobby, PG logo ${Math.round(logo.width)}px, scrollWidth ${before.sw}/${before.vw}; click -> book up ${tBook} ms -> Inventory ${tDone} ms, scrollWidth ${after.sw}/${after.vw}`);

    // 3. password-protected project (desktop only; the flow is the same on phones)
    if (w === 1440) {
      // Record the hall's phase at the moment each prompt opens (the page is frozen while it is open).
      await page.addInitScript(() => {
        const original = window.prompt.bind(window);
        window.__promptPhases = [];
        window.prompt = (...args) => { window.__promptPhases.push(document.querySelector('.pl-root')?.dataset.phase || 'gone'); return original(...args); };
      });
      await page.goto(origin + '/'); await card(page, LOCKED).waitFor(); await page.waitForTimeout(600);
      const prompts = [];
      let answers = ['wrong', null];
      page.on('dialog', async dialog => {
        prompts.push({ message: dialog.message() });
        const answer = answers.shift();
        if (answer === null || answer === undefined) await dialog.dismiss(); else await dialog.accept(answer);
      });
      await card(page, LOCKED).click();
      await page.waitForFunction(() => document.querySelector('.pl-root')?.dataset.phase === 'idle', null, { timeout: 15000 });
      assert.equal(prompts.length, 2, 'asked twice: ' + JSON.stringify(prompts));
      const phases = await page.evaluate(() => window.__promptPhases);
      prompts.forEach((prompt, i) => { prompt.phase = phases[i]; });
      assert.match(prompts[0].message, /Protected/); assert.match(prompts[1].message, /Incorrect/);
      assert.equal(prompts[0].phase, 'launching', 'prompt came after the book, phase ' + prompts[0].phase);
      assert.equal(await card(page, NAME).isVisible(), true, 'hall usable after cancel');
      console.log('password: prompt shown during phase ' + prompts[0].phase + ', wrong password asked again, cancel -> back to the hall');
      answers = [SECRET];
      await card(page, LOCKED).click();
      await inventory(page);
      assert.equal(prompts.length, 3); assert.match(prompts[2].message, /Protected/);
      console.log('password: right password -> Inventory');
    }
    await context.close();
  }

  // 4. reduced motion
  const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await reduced.newPage(); watch(page, 'lobby-reduced');
  await page.goto(origin + '/'); await card(page, NAME).waitFor();
  const t0 = Date.now();
  await card(page, NAME).click();
  await inventory(page);
  const tReduced = Date.now() - t0;
  assert.ok(tReduced < 2500, 'reduced motion took ' + tReduced + ' ms');
  console.log('reduced motion: fade straight to Inventory in ' + tReduced + ' ms');
  await reduced.close();

  assert.deepEqual(problems, [], 'browser problems:\n' + problems.join('\n'));
  console.log('console errors: 0, unexpected 4xx/5xx: 0');
  console.log('lobby browser smoke: PASS');
} finally {
  await browser?.close();
  await hub.close();
}
