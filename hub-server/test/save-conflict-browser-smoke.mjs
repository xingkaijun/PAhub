// Run after npm run hub:build: node hub-server/test/save-conflict-browser-smoke.mjs
// Two real browser pages against a real hub server (fixture data). Page A's autosave is held at the network
// layer until page B has saved, so A's save always reaches the server with the pre-B base:
//  1. same field (version of DW-A-001): A gets 409, the yellow conflict notice appears, B's value stays in the DB
//     and A's page switches to B's value;
//  2. different fields of DW-B-002 (A: version, B: discipline): both saves return 200 and both values are kept.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-conflict-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub({ host: '127.0.0.1' }); let browser;
const artifacts = path.join(root, 'hub-server/test/artifacts'); await mkdir(artifacts, { recursive: true });
const PROJECT = 'proj-test-001', PROJECT_NAME = 'PG-VLEC-H2684';
const row = (page, drawingNo) => page.locator('tr', { has: page.locator('td', { hasText: new RegExp('^' + drawingNo + '$') }) }).first();
const stored = id => hub.db.prepare('SELECT version, discipline, title FROM drawings WHERE id = ?').get(id);
const isSave = request => request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/projects/' + PROJECT;
const errors = [];

async function openEditor(context) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto('http://127.0.0.1:' + hub.port + '/');
  await page.getByRole('button', { name: new RegExp(PROJECT_NAME) }).first().click();
  await row(page, 'DW-A-001').waitFor();
  // ADMIN_PASSWORD is unset for this smoke, so the server reports every visitor as an administrator.
  await page.getByRole('button', { name: 'Administrator' }).first().waitFor();
  return page;
}

// Holds page's next save request until release() is called; resolves `held` once the request is parked.
async function holdNextSave(page) {
  let release, parked;
  const gate = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { parked = resolve; });
  let used = false;
  // Stays registered (unrouting from inside a running handler can let the parked request through).
  await page.route('**/api/projects/**', async route => {
    if (used || !isSave(route.request())) return route.fallback();
    used = true; parked(route.request().postDataJSON());
    await gate; await route.fallback();
  });
  return { held, release };
}

const nextSaveResponse = page => page.waitForResponse(response => isSave(response.request()), { timeout: 30_000 });

try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });
  const contexts = await Promise.all(['A', 'B'].map(async name => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(nick => localStorage.setItem('pahub.clientName', nick), name);
    return context;
  }));
  const [a, b] = [await openEditor(contexts[0]), await openEditor(contexts[1])];
  const before1 = stored('dwg-001');

  // 1. Same field.
  const holdA = await holdNextSave(a);
  await row(a, 'DW-A-001').locator('input[type=text]').first().fill('A-edit');
  const sentByA = await holdA.held;
  // A version edit also appends a statusHistory entry (updateDrawing); nothing else of the drawing is sent.
  assert.deepEqual(Object.keys(sentByA.updatedDrawings[0].changes).sort(), ['statusHistory', 'version'], 'A sends only the changed fields');
  const bSaved = nextSaveResponse(b);
  await row(b, 'DW-A-001').locator('input[type=text]').first().fill('B-edit');
  assert.equal((await bSaved).status(), 200);
  assert.equal(stored('dwg-001').version, 'B-edit');
  const aSaved = nextSaveResponse(a); holdA.release();
  const aResponse = await aSaved;
  assert.equal(aResponse.status(), 409, 'stale save on the same field is rejected');
  assert.equal((await aResponse.json()).code, 'DRAWING_CONFLICT');
  const notice = a.getByTestId('save-conflict');
  await notice.waitFor({ state: 'visible', timeout: 10_000 });
  const noticeText = await notice.innerText();
  assert.match(noticeText, /Save conflict/); assert.match(noticeText, /001/); assert.match(noticeText, /版本|version/i);
  await a.waitForFunction(() => [...document.querySelectorAll('tr')].some(tr => tr.textContent.includes('DW-A-001') && tr.querySelector('input[type=text]')?.value === 'B-edit'), null, { timeout: 10_000 });
  await a.screenshot({ path: path.join(artifacts, 'save-conflict-notice.png') });
  await notice.screenshot({ path: path.join(artifacts, 'save-conflict-notice-banner.png') });
  const after1 = stored('dwg-001');
  assert.equal(after1.version, 'B-edit', 'B value not overwritten');
  assert.equal(after1.discipline, before1.discipline); assert.equal(after1.title, before1.title);
  console.log('Same field: B 200, A 409, notice:', JSON.stringify(noticeText.replace(/\s*×\s*$/, '')), '| DB version:', after1.version);
  await a.getByRole('button', { name: 'Dismiss save conflict' }).click();
  await notice.waitFor({ state: 'detached' });
  // Let A's post-conflict reload settle before the next scenario.
  await a.waitForTimeout(1500);

  // 2. Different fields of the same drawing.
  const before2 = stored('dwg-002');
  const newDiscipline = before2.discipline === 'Piping' ? 'Structure' : 'Piping';
  const holdA2 = await holdNextSave(a);
  await row(a, 'DW-B-002').locator('input[type=text]').first().fill('A-version');
  const sent2 = await holdA2.held;
  assert.deepEqual(Object.keys(sent2.updatedDrawings.find(d => d.id === 'dwg-002').changes).sort(), ['statusHistory', 'version']);
  const bSaved2 = nextSaveResponse(b);
  await row(b, 'DW-B-002').locator('select').first().selectOption(newDiscipline);
  assert.equal((await bSaved2).status(), 200);
  const aSaved2 = nextSaveResponse(a); holdA2.release();
  assert.equal((await aSaved2).status(), 200, 'different fields merge');
  const after2 = stored('dwg-002');
  assert.equal(after2.version, 'A-version'); assert.equal(after2.discipline, newDiscipline);
  assert.equal(await a.getByTestId('save-conflict').count(), 0, 'no conflict notice for a clean merge');
  console.log('Different fields: A version + B discipline both kept:', JSON.stringify(after2));
  assert.deepEqual(errors, []);
  console.log('Save conflict browser smoke: PASS; pageerrors=0; screenshots hub-server/test/artifacts/save-conflict-notice*.png');
} finally {
  await browser?.close(); await hub.close();
}
