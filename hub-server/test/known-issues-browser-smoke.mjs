// Run after npm run hub:build: node hub-server/test/known-issues-browser-smoke.mjs
// Real browser, real hub server with ADMIN_PASSWORD set, covering the seven fixes from the manual's "known issues":
//  1. scripts/seed-test-project.mjs seeds a project through the current API (admin sign-in, PATCH, PCF import);
//  2. the Guide page describes reviewers/administrators, ADMIN_PASSWORD, auto-save + Save Now, live updates
//     and no longer mentions an edit-mode lock or "no manual save button";
//  3. Bulk Load keeps commas in the title;
//  4. the trash button asks first (drawing number + title); Cancel keeps the drawing, OK deletes it;
//  5. Log -> Export PDF works with every non-local request blocked (no CDN);
//  6. Tracker -> Export CSV has the drawing number in the Drawing No column;
//  7. a reviewer sees Void disabled in Shipyard correspondence; an administrator can void.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-known-issues-e2e-'));
const shots = path.join(root, 'hub-server/test/artifacts'); await mkdir(shots, { recursive: true });
const PASSWORD = 'known-issues-admin-pass';
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: PASSWORD });
const hub = await createHub({ host: '127.0.0.1' }); let browser;
const origin = 'http://127.0.0.1:' + hub.port, P = 'proj-test-001', NAME = 'PG-VLEC-H2684';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const problems = [];
const watch = (page, label, allowed = () => false) => {
  page.on('pageerror', error => problems.push(label + ' pageerror: ' + error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(label + ' console: ' + message.text()); });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && !allowed(url, response.status())) problems.push(label + ' ' + response.status() + ' ' + url.pathname);
  });
};
const runSeed = (env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/seed-test-project.mjs'), origin], { cwd: root, env: { ...process.env, ...env } });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  child.on('error', reject); child.on('exit', code => resolve({ code, out }));
});
const signIn = async context => {
  const res = await context.request.post(origin + '/api/session', { data: { password: PASSWORD } });
  assert.equal(res.status(), 200, 'admin sign-in');
};

try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  // Give dwg-001 a drawing number that differs from its ID so the CSV check is meaningful.
  hub.db.prepare("UPDATE drawings SET drawing_no='H2684-STR-001' WHERE id='dwg-001'").run();
  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });

  // 1. seed script
  const denied = await runSeed({ ADMIN_PASSWORD: '', PAHUB_ADMIN_PASSWORD: '' });
  assert.notEqual(denied.code, 0); assert.match(denied.out, /ADMIN_PASSWORD=<管理员密码>/);
  const seeded = await runSeed({ ADMIN_PASSWORD: PASSWORD });
  assert.equal(seeded.code, 0, seeded.out.slice(-1500));
  const summary = JSON.parse(seeded.out.slice(seeded.out.indexOf('{\n')));
  assert.equal(summary['图纸数'], 100); assert.equal(summary['意见数'], 300); assert.equal(summary['解析警告'], 0);
  const again = await runSeed({ ADMIN_PASSWORD: PASSWORD });
  assert.equal(again.code, 0, again.out.slice(-1500));
  assert.deepEqual(JSON.parse(again.out.slice(again.out.indexOf('{\n'))), summary, 'a second run gives the same project');
  console.log(`Seed script: without password exit ${denied.code} with the ADMIN_PASSWORD hint; with password exit 0, ${summary['图纸数']} drawings, ${summary['意见数']} comments, ${summary['解析警告']} warnings; second run identical`);

  // Administrator context
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await admin.addInitScript(() => localStorage.setItem('pahub.clientName', 'KnownIssues'));
  await signIn(admin);
  const page = await admin.newPage(); watch(page, 'admin');
  await page.goto(origin + '/');
  await page.getByRole('button', { name: new RegExp(NAME + '(?! 演示项目)') }).first().click();
  await page.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor(); await sleep(800);

  // 2. Guide
  await page.getByRole('button', { name: /^Guide$/ }).click();
  // Guide opens the Chinese manual (/manual/) by default; the English guide is one tab away.
  const manualFrame = await (await page.getByTestId('manual-frame').elementHandle()).contentFrame();
  await manualFrame.locator('h1').waitFor();
  const manual = await manualFrame.locator('main').innerText();
  await page.getByRole('tab', { name: 'English' }).click();
  await page.getByText('1. Server Data, Saving & Sign-in').waitFor();
  const guide = await page.locator('main').innerText();
  for (const needle of ['ADMIN_PASSWORD', 'Save Now', 'Live updates', 'Administrator', 'Reviewer', '15 minutes']) assert.ok(guide.includes(needle), 'Guide mentions ' + needle);
  for (const stale of [/edit[- ]mode lock/i, /no manual save/i, /Version 4\.0-Cloud/]) assert.doesNotMatch(guide, stale);
  for (const needle of ['实时推送', '访客', '管理员', '15 分钟', 'ADMIN_PASSWORD', 'Save Now']) assert.ok(manual.includes(needle), 'Chinese manual mentions ' + needle);
  assert.doesNotMatch(manual, /无需寻找保存按钮/);
  await page.screenshot({ path: path.join(shots, 'known-issues-guide.png') });
  console.log('Guide: Chinese manual and English guide describe sign-in, auto-save + Save Now, live updates; no edit-mode lock / no-save-button text');
  await page.getByRole('button', { name: /^Inventory$/ }).click();
  await page.locator('td', { hasText: /^DW-A-001$/ }).first().waitFor();

  // 3. Bulk Load with commas in the title
  await page.getByRole('button', { name: /Bulk Load/ }).first().click();
  await page.locator('#bulk-entry-title').waitFor();
  await page.locator('textarea').fill('KI-101, H2684-KI-101, Hull, Midship section, frames 50-80, rev. A\n"KI-102","H2684-KI-102","Piping","Fuel oil, ""FO"" transfer"');
  await page.getByRole('button', { name: 'Execute Import' }).click();
  await page.locator('td', { hasText: /^KI-101$/ }).first().waitFor();
  const row101 = page.locator('tr', { has: page.locator('td', { hasText: /^KI-101$/ }) }).first();
  assert.match(await row101.innerText(), /Midship section, frames 50-80, rev\. A/);
  const row102 = page.locator('tr', { has: page.locator('td', { hasText: /^KI-102$/ }) }).first();
  assert.match(await row102.innerText(), /Fuel oil, "FO" transfer/);
  // Save explicitly; normal cadence is fifteen minutes.
  await page.getByRole('button',{name:'Save Now',exact:true}).click();
  let stored;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    stored = hub.db.prepare("SELECT title FROM drawings WHERE project_id=? AND custom_id='KI-101'").get(P);
    if (stored) break;
  }
  assert.equal(stored?.title, 'Midship section, frames 50-80, rev. A');
  console.log('Bulk Load: title saved in full: "' + stored.title + '"; quoted CSV row kept "Fuel oil, \\"FO\\" transfer"');

  // 4. delete asks first
  const dialogs = [];
  let answer = false;
  const onDialog = async dialog => { dialogs.push(dialog.message()); answer ? await dialog.accept() : await dialog.dismiss(); };
  page.on('dialog', onDialog);
  const trash = row101.getByRole('button', { name: 'Delete drawing' });
  const cellsBefore = await page.locator('td', { hasText: /^KI-101$/ }).count();
  await trash.click(); await sleep(300);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /Drawing No: H2684-KI-101/); assert.match(dialogs[0], /Title: Midship section, frames 50-80, rev\. A/);
  assert.ok(cellsBefore > 0); assert.equal(await page.locator('td', { hasText: /^KI-101$/ }).count(), cellsBefore, 'Cancel keeps the drawing');
  await sleep(3500); assert.ok(hub.db.prepare("SELECT 1 FROM drawings WHERE project_id=? AND custom_id='KI-101'").get(P), 'Cancel: still on the server after the auto-save delay');
  answer = true;
  await trash.click();
  for (let i = 0; i < 40 && await page.locator('td', { hasText: /^KI-101$/ }).count() > 0; i++) await sleep(100);
  assert.equal(await page.locator('td', { hasText: /^KI-101$/ }).count(), 0, 'OK removes the row');
  await page.getByRole('button',{name:'Save Now',exact:true}).click();
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = !hub.db.prepare("SELECT 1 FROM drawings WHERE project_id=? AND custom_id='KI-101'").get(P); }
  assert.ok(gone, 'deleted on the server after confirming');
  page.off('dialog', onDialog);
  console.log('Delete: confirm shows "' + dialogs[0].split('\n').slice(2, 4).join(' / ') + '"; Cancel kept it, OK deleted it (server row gone)');

  // 6. Tracker CSV
  await page.getByRole('button', { name: /^Tracker$/ }).click();
  await page.getByText('Export CSV').first().waitFor(); await sleep(500);
  const csvDownload = page.waitForEvent('download');
  await page.getByText('Export CSV').first().click();
  const csvFile = path.join(temp, 'tracker.csv'); await (await csvDownload).saveAs(csvFile);
  const csv = (await readFile(csvFile, 'utf8')).replace(/^\uFEFF/, '');
  const lines = csv.split(/\r?\n/);
  const header = lines[0].split(',');
  assert.deepEqual(header.slice(0, 4), ['No', 'ID', 'Drawing No', 'Title']);
  const line001 = lines.find(line => line.split(',')[1] === 'DW-A-001');
  assert.ok(line001, csv.slice(0, 400));
  assert.equal(line001.split(',')[2], 'H2684-STR-001');
  assert.ok(!/,dwg-0\d\d,/.test(csv), 'no internal ids in the CSV');
  console.log('Tracker CSV: header ' + header.slice(0, 4).join(',') + '; DW-A-001 row -> Drawing No ' + line001.split(',')[2]);

  // 5. Log -> Export PDF with the network outside the hub blocked
  const external = [];
  await admin.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    external.push(url.href); return route.abort();
  });
  await page.getByRole('button', { name: /^Log$/ }).click();
  await page.getByText('Export PDF').first().waitFor(); await sleep(500);
  const pdfDownload = page.waitForEvent('download', { timeout: 30000 });
  await page.getByText('Export PDF').first().click();
  const pdf = await pdfDownload; const pdfFile = path.join(temp, 'log.pdf'); await pdf.saveAs(pdfFile);
  const pdfBytes = await readFile(pdfFile);
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdfBytes.length > 2000);
  assert.deepEqual(external.filter(url => /cdn|unpkg|jsdelivr|cloudflare/.test(url)), [], 'no CDN requests');
  await admin.unroute('**/*');
  console.log(`Log Export PDF (offline): ${pdf.suggestedFilename()} ${pdfBytes.length} bytes, starts with %PDF-, external requests blocked=${external.length}${external.length ? ' (' + [...new Set(external.map(u => new URL(u).host))].join(', ') + ')' : ''}`);

  // 7. Void: reviewer disabled, administrator can void
  const exported = await admin.request.post(origin + `/api/pcf/${P}/dwg-005/create`, { data: {} });
  assert.equal(exported.status(), 200);
  const exp = await admin.request.post(origin + `/api/pcf/${P}/dwg-005/exports`, { data: { clientId: 'e2e', mode: 'builder' } });
  assert.equal(exp.status(), 200);
  const exportId = (await exp.json()).exportId;
  const reviewer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const rpage = await reviewer.newPage(); watch(rpage, 'reviewer');
  await rpage.goto(origin + `/pcf/${P}/dwg-005`); await rpage.locator('#pahub-exchange').waitFor();
  await rpage.locator('#pahub-exchange').click();
  const rVoid = rpage.locator(`.exchange-void[data-export-id="${exportId}"]`); await rVoid.waitFor();
  assert.equal(await rVoid.isDisabled(), true, 'reviewer: Void disabled');
  assert.match(await rVoid.getAttribute('title'), /Administrator permission required/);
  assert.match(await rpage.locator('body').innerText(), /Voiding requires administrator sign-in/);
  const denyVoid = await reviewer.request.post(origin + `/api/pcf/${P}/dwg-005/exports/${exportId}/void`, { data: {} });
  assert.equal(denyVoid.status(), 403);
  await rpage.screenshot({ path: path.join(shots, 'known-issues-void-reviewer.png') });
  const apage = await admin.newPage(); watch(apage, 'admin-pcf');
  apage.on('dialog', dialog => dialog.accept());
  await apage.goto(origin + `/pcf/${P}/dwg-005`); await apage.locator('#pahub-exchange').waitFor();
  await apage.locator('#pahub-exchange').click();
  const aVoid = apage.locator(`.exchange-void[data-export-id="${exportId}"]`); await aVoid.waitFor();
  assert.equal(await aVoid.isDisabled(), false, 'administrator: Void enabled');
  await aVoid.click();
  await apage.locator('td', { hasText: 'Voided' }).first().waitFor();
  const records = await (await admin.request.get(origin + `/api/pcf/${P}/dwg-005/exports`)).json();
  assert.equal(records.find(x => x.export_id === exportId).status, 'void');
  console.log('Void: reviewer button disabled (title "' + (await rVoid.getAttribute('title')) + '"), API 403; administrator voided it in the page');

  assert.deepEqual(problems.filter(p => !/^reviewer 403 \/api\/pcf\/.*\/void$/.test(p)), []);
  console.log('Known-issues browser smoke: PASS; console errors=0, unexpected 4xx/5xx=0');
} finally {
  await browser?.close(); await hub.close();
}
