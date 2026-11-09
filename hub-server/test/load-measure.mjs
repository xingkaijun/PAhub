// Load measurement (not part of hub:test): node hub-server/test/load-measure.mjs [label]
// Run after npm run hub:build. Builds a temp hub with the fixture project grown to 3000 drawings, then counts in a
// real browser how many full-project / tracker requests and transferred bytes each step costs:
//   open project; switch Tracker -> Inventory; another client saves a PCF (comment.add via /ops).
// Also measures raw on-the-wire sizes (identity vs gzip vs br) of index.html, the main JS, the project JSON and the
// online PCF page. Prints a JSON summary.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const label = process.argv[2] || 'run';
const N = Number(process.env.PAHUB_MEASURE_DRAWINGS || 3000);
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-measure-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub({ host: '127.0.0.1' });
const origin = 'http://127.0.0.1:' + hub.port, P = 'proj-test-001', NAME = 'PG-VLEC-H2684';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function seed() {
  const db = hub.db;
  const disciplines = ['Structure', 'Piping', 'Electrical', 'Hull', 'Machinery', 'Outfitting'];
  const statuses = ['Reviewing', 'Waiting Reply', 'Approved', 'Pending'];
  const ins = db.prepare(`INSERT INTO drawings (id, project_id, custom_id, drawing_no, discipline, title, status, version, current_round, review_deadline, manual_comments_count, manual_open_comments_count, received_date, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'A', 'A', datetime('now', '+7 days'), ?, ?, '2026-04-01', 'A')`);
  const asg = db.prepare('INSERT OR IGNORE INTO drawing_assignees (drawing_id, reviewer_id) VALUES (?, ?)');
  const rem = db.prepare("INSERT INTO drawing_remarks (id, project_id, drawing_id, content, created_at, resolved) VALUES (?, ?, ?, ?, datetime('now'), 0)");
  const hist = db.prepare("INSERT INTO drawing_status_history (id, drawing_id, content, created_at) VALUES (?, ?, ?, datetime('now'))");
  db.exec('BEGIN');
  for (let i = 7; i <= N; i++) {
    const id = 'dwg-' + String(i).padStart(4, '0'), no = 'MS-' + String(i).padStart(5, '0');
    ins.run(id, P, no, no, disciplines[i % 6], 'Load test drawing ' + i + ' general arrangement and details', statuses[i % 4], i % 9, i % 3);
    asg.run(id, ['engineer_a', 'engineer_b', 'senior_eng_c'][i % 3]);
    hist.run('h-' + id, id, 'Status: Pending -> Reviewing | Round: A -> A');
    if (i % 4 === 0) rem.run('r-' + id, P, id, 'Remark for drawing ' + i);
  }
  db.exec('COMMIT');
}

function raw(pathname, encoding, post) {
  return new Promise((resolve, reject) => {
    const headers = encoding ? { 'Accept-Encoding': encoding } : {};
    if (post) headers['Content-Type'] = 'application/json';
    const req = http.request(origin + pathname, { method: post ? 'POST' : 'GET', headers }, res => {
      let bytes = 0; res.on('data', c => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes, encoding: res.headers['content-encoding'] || 'identity', cache: res.headers['cache-control'] || '' }));
    });
    req.on('error', reject);
    req.end(post ? JSON.stringify({ password: null }) : undefined);
  });
}

const isProject = u => u.pathname === '/api/projects/' + P;
const isTracker = u => u.pathname === '/api/projects/' + P + '/review-tracker';
const isDrawings = u => u.pathname === '/api/projects/' + P + '/drawings';

let browser;
try {
  hub.db.exec(await readFile(path.join(root, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  // Drawings table may lack some columns on older schemas; fall back gracefully.
  try { seed(); } catch (error) { hub.db.exec('ROLLBACK'); throw error; }
  const count = hub.db.prepare('SELECT COUNT(*) n FROM drawings WHERE project_id = ?').get(P).n;

  browser = await chromium.launch({ headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('pahub.clientName', 'Measure'));
  const page = await context.newPage();
  const log = [];
  // 'response' (not 'requestfinished', which Chromium does not report for some bodyless 304s).
  page.on('response', async response => {
    const request = response.request();
    const u = new URL(request.url());
    if (!u.pathname.startsWith('/api/')) return;
    // Log first (sizes() can stay pending for some 304s), then fill in the transferred bytes.
    const entry = { method: request.method(), path: u.pathname, search: u.search, size: 0, status: 0 };
    log.push(entry);
    entry.status = response.status();
    try { const s = await Promise.race([request.sizes(), sleep(3000).then(() => null)]); if (s) entry.size = s.responseBodySize + s.responseHeadersSize; } catch {}
  });
  const mark = () => log.length;
  const summarize = from => {
    const slice = log.slice(from);
    const pick = f => slice.filter(e => e.method === 'GET' && f(new URL(origin + e.path)));
    const proj = slice.filter(e => e.method === 'POST' && isProject(new URL(origin + e.path))), tr = pick(isTracker), dr = pick(isDrawings);
    return {
      fullProject: proj.length, fullProject304: proj.filter(e => e.status === 304).length, fullProjectBytes: proj.reduce((a, e) => a + e.size, 0),
      tracker: tr.length, trackerBytes: tr.reduce((a, e) => a + e.size, 0),
      drawingsById: dr.length, drawingsByIdBytes: dr.reduce((a, e) => a + e.size, 0),
      apiRequests: slice.length, apiBytes: slice.reduce((a, e) => a + e.size, 0),
    };
  };

  await page.goto(origin + '/'); await page.waitForLoadState('networkidle'); await sleep(500);
  let m = mark();
  await page.getByRole('button', { name: new RegExp(NAME) }).first().click();
  await page.locator('td', { hasText: /^MS-00010$/ }).first().waitFor({ timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState('networkidle'); await sleep(2500);
  const open = summarize(m);

  m = mark();
  await page.getByRole('button', { name: /^Tracker$/ }).click(); await page.waitForLoadState('networkidle'); await sleep(1500);
  await page.getByRole('button', { name: /^Inventory$/ }).click(); await page.waitForLoadState('networkidle'); await sleep(2500);
  const tabs = summarize(m);

  // Another client creates + saves an online PCF for dwg-001 (adds a comment).
  const api = (route, body) => fetch(origin + '/api/pcf/' + P + '/' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify({ clientId: 'measure-other', clientName: 'Other', ...body }) : undefined }).then(r => r.json());
  await api('dwg-001/create', {}); await sleep(2500);
  m = mark();
  const live = await api('dwg-001/data');
  await api('dwg-001/ops', { baseRev: live.rev, batchId: randomUUID(), ops: [{ type: 'comment.add', id: 'measure-c1', roundIdNew: 'measure-r1' }] });
  await sleep(3000); await page.waitForLoadState('networkidle');
  const pcfSave = summarize(m);

  const html = await (await fetch(origin + '/')).text();
  const js = (html.match(/\/assets\/[^"']+\.js/) || [])[0];
  const css = (html.match(/\/assets\/[^"']+\.css/) || [])[0];
  const sizes = {};
  for (const [name, p] of [['index.html', '/'], ['main JS', js], ['main CSS', css], ['project JSON', '/api/projects/' + P], ['online PCF', '/pcf/' + P + '/dwg-001']]) {
    if (!p) continue;
    const post = name === 'project JSON';
    sizes[name] = { path: p, identity: await raw(p, '', post), gzip: await raw(p, 'gzip', post), br: await raw(p, 'br, gzip', post) };
  }
  const out = JSON.stringify({ label, drawings: count, open, tabs, pcfSave, sizes, log }, null, 2);
  if (process.env.PAHUB_MEASURE_OUT) await (await import('node:fs/promises')).writeFile(process.env.PAHUB_MEASURE_OUT, out);
  else console.log(out);
} finally {
  await browser?.close(); await hub.close();
}
