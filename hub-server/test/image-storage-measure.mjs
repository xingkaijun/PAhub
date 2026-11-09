// Image storage measurement (not part of hub:test): node hub-server/test/image-storage-measure.mjs [label] [repoRoot]
// Run after npm run hub:build in repoRoot (default: this checkout). One PCF with 20 PNG attachments of 1-3 MB
// (random bytes, so they do not compress), then 10 saves that each change a little text (a different user each
// time, so every save keeps a history snapshot). Reports save latency, PCF JSON size, history size and how many
// bytes opening the online PCF transfers (br), first open and repeat open (the browser keeps immutable images).
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const label = process.argv[2] || 'run';
const repo = path.resolve(process.argv[3] || fileURLToPath(new URL('../..', import.meta.url)));
const { createHub } = await import(pathToFileURL(path.join(repo, 'hub-server/dist/app.mjs')).href);
const temp = await mkdtemp(path.join(tmpdir(), 'pahub-image-measure-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '' });
const hub = await createHub({ host: '127.0.0.1', middleware: (_q, _s, next) => next() });
const p = 'proj-test-001', d = 'dwg-005';
const dirSize = async dir => { let total = 0, count = 0; for (const e of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) if (e.isFile()) { total += (await stat(path.join(e.parentPath, e.name))).size; count++; } return { total, count }; };
// Raw bytes on the wire (body after Content-Encoding) plus status/headers.
const wire = (pathname, headers = {}) => new Promise((ok, no) => {
  http.get({ host: '127.0.0.1', port: hub.port, path: pathname, headers: { 'Accept-Encoding': 'br, gzip', ...headers } }, res => {
    let bytes = 0; res.on('data', c => { bytes += c.length; }); res.on('end', () => ok({ status: res.statusCode, bytes, headers: res.headers }));
  }).on('error', no);
});
try {
  hub.db.exec(await readFile(path.join(repo, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const route = 'http://127.0.0.1:' + hub.port + '/api/pcf/' + p + '/' + d + '/';
  const api = async (tail, method = 'GET', body) => { const r = await fetch(route + tail, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const v = await r.json(); if (!r.ok) throw Error(tail + ' ' + r.status + ' ' + JSON.stringify(v).slice(0, 300)); return v; };
  await api('create', 'POST', { clientId: 'setup' });
  let live = await api('data');
  const ops = async (list, clientId) => { const t = performance.now(); live = await api('ops', 'POST', { clientId, clientName: clientId, baseRev: live.rev, batchId: randomUUID(), ops: list }); return performance.now() - t; };
  // Deterministic sizes 1.0-3.0 MB.
  const sizes = Array.from({ length: 20 }, (_, i) => Math.round((1 + (i % 5) * 0.5) * 1024 * 1024));
  const image = (i) => ({ id: 'img' + i, name: 'photo-' + i + '.png', mime: 'image/png', data: 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(sizes[i] - 8)]).toString('base64'), width: 4000, height: 3000 });
  await ops(Array.from({ length: 4 }, (_, c) => ({ type: 'comment.add', id: 'c' + c, roundIdNew: 'r' + c })), 'setup');
  const blank = { html: '', text: '', color: 'default', images: [] };
  const t0 = performance.now();
  // One comment (5 images) per request: all 20 at once would exceed the 51 MB request limit.
  let uploadMs = 0;
  for (let c = 0; c < 4; c++) uploadMs += await ops([{ type: 'content.set', commentId: 'c' + c, roundId: 'r' + c, side: 'owner', baseRev: 0, value: { ...blank, text: 'Owner ' + c, html: 'Owner ' + c, images: [0, 1, 2, 3, 4].map(k => image(c * 5 + k)) } }], 'uploader');
  const imageBytes = sizes.reduce((a, b) => a + b, 0);
  const saves = [];
  for (let i = 0; i < 10; i++) {
    const rev = live.data.hub.entities['project:planTitle']?.rev ?? 0;
    saves.push(await ops([{ type: 'project.set', field: 'planTitle', value: 'Plan title edit ' + i, baseRev: rev }], 'editor-' + i));
  }
  const jsonSize = (await stat(path.join(temp, 'pcf', p, d + '.json'))).size;
  const history = await dirSize(path.join(temp, 'pcf', p, '.history', d));
  const images = await dirSize(path.join(temp, 'pcf', p, '.images'));
  // Online PCF open: page HTML (br), then every image it references (first open), repeat open = page only.
  const page = await wire('/pcf/' + p + '/' + d);
  const refs = [...new Set(live.data.comments.flatMap(c => c.rounds.flatMap(r => [...r.owner.images, ...r.reply.images])).filter(im => im.hash && im.data === undefined).map(im => im.hash))];
  let imageWire = 0, cacheControl = null;
  for (const h of refs) { const r = await wire('/pcf/' + p + '/' + d + '/images/' + h); imageWire += r.bytes; cacheControl = r.headers['cache-control']; }
  const sorted = [...saves].sort((a, b) => a - b);
  console.log(JSON.stringify({
    label, commit: process.env.MEASURE_COMMIT || null, images: 20, imageBytes,
    uploadSaveMs: Math.round(uploadMs), textSaveMs: { each: saves.map(x => Math.round(x)), mean: Math.round(saves.reduce((a, b) => a + b, 0) / saves.length), median: Math.round((sorted[4] + sorted[5]) / 2), max: Math.round(sorted[9]) },
    pcfJsonBytes: jsonSize, historySnapshots: history.count, historyBytes: history.total, imageStore: images,
    onlineOpen: { pageBytes: page.bytes, pageEncoding: page.headers['content-encoding'] || 'identity', pageCache: page.headers['cache-control'], imageRequests: refs.length, imageBytes: imageWire, imageCache: cacheControl, firstOpenBytes: page.bytes + imageWire, repeatOpenBytes: page.bytes + (cacheControl?.includes('immutable') ? 0 : imageWire) },
    elapsedMs: Math.round(performance.now() - t0),
  }, null, 2));
} finally { await hub.close(); }
