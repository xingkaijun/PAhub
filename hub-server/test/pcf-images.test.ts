import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.ts';
import { ROOT_DIR, PCF_HISTORY_RECENT_LIMIT } from '../src/config.ts';
import { PcfStorage, parseHTML, replaceData } from '../src/pcf-storage.ts';
import { blankContent } from '../src/pcf-model.ts';
import { migratePcfImages } from '../src/pcf-image-migration.ts';
import { comparableImages, eachImageList } from '../src/pcf-images.ts';
import { historyBucket, historyEntries, pruneHistory } from '../src/pcf-history.ts';
import { createHub } from '../src/app.ts';

const p = 'proj-test-001', d = 'dwg-005', d2 = 'dwg-001';
const actor = (clientId: string) => ({ clientId, clientName: clientId, ip: '127.0.0.1' });
// Distinct tiny "PNG"/"JPEG" payloads; the store only needs valid base64 with an allowed MIME prefix.
const png = (seed: string) => 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(seed)]).toString('base64');
const jpeg = (seed: string) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from(seed)]).toString('base64');
const sha = (dataURL: string) => createHash('sha256').update(Buffer.from(dataURL.split(',')[1], 'base64')).digest('hex');
const image = (id: string, data: string) => ({ id, name: id + (data.startsWith('data:image/png') ? '.png' : '.jpg'), mime: data.slice(5, data.indexOf(';')), data, width: 40, height: 30 });
const imageFiles = (dir: string) => { const root = path.join(dir, 'pcf', p, '.images'); return existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort() : []; };

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-images-'));
  const db = openDatabase(path.join(dir, 'papc.db'));
  db.exec(readFileSync(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  let at = Date.parse('2026-11-09T02:00:00Z');
  const storage = new PcfStorage(db, dir, () => at);
  const ops = (doc: string, list: any[], who = 'A') => { const live = storage.load(p, doc); return storage.ops(p, doc, { batchId: randomUUID(), baseRev: live.rev, ops: list }, actor(who)); };
  return { dir, db, storage, ops, tick(ms: number) { at += ms; }, get at() { return at; } };
}

test('saved inline images become deduplicated content-addressed files; JSON and history keep references only', () => {
  const f = fixture(); try {
    f.storage.create(p, d, actor('A'));
    const a = png('one'), b = jpeg('two');
    f.ops(d, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }, { type: 'comment.add', id: 'c2', roundIdNew: 'r2' }]);
    f.ops(d, [
      { type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'owner', baseRev: 0, value: { ...blankContent(), text: 'see', images: [image('i1', a), image('i2', b)] } },
      { type: 'content.set', commentId: 'c2', roundId: 'r2', side: 'owner', baseRev: 0, value: { ...blankContent(), text: 'same', images: [image('i3', a)] } },
    ]);
    const json = readFileSync(f.storage.file(p, d), 'utf8');
    assert.doesNotMatch(json, /data:image\//);
    const stored = f.storage.load(p, d).data.comments[0].rounds[0].owner.images;
    assert.deepEqual(stored[0], { id: 'i1', name: 'i1.png', mime: 'image/png', hash: sha(a), width: 40, height: 30 });
    assert.equal(stored[1].hash, sha(b));
    // Same bytes in another round (and another drawing) are stored once per project, with the right extension.
    f.storage.create(p, d2, actor('A'));
    f.ops(d2, [{ type: 'comment.add', id: 'x1', roundIdNew: 'y1' }]);
    f.ops(d2, [{ type: 'content.set', commentId: 'x1', roundId: 'y1', side: 'owner', baseRev: 0, value: { ...blankContent(), images: [image('k1', a)] } }]);
    assert.deepEqual(imageFiles(f.dir), [sha(a) + '.png', sha(b) + '.jpeg'].sort());
    assert.deepEqual(f.storage.images.read(p, sha(a))!.bytes, Buffer.from(a.split(',')[1], 'base64'));
    // Text-only saves keep references; history snapshots carry no image bytes.
    for (let i = 0; i < 5; i++) { f.tick(11 * 60000); f.ops(d, [{ type: 'project.set', field: 'planTitle', value: 'T' + i, baseRev: f.storage.load(p, d).data.hub.entities['project:planTitle']?.rev ?? 0 }], 'U' + i); }
    const history = f.storage.history(p, d);
    assert.ok(history.length >= 5);
    for (const entry of history) assert.doesNotMatch(readFileSync(path.join(f.storage.historyDir(p, d), entry.filename), 'utf8'), /data:image\//);
    // Hydrated copies (offline exports) get the original data URLs back.
    const hydrated = f.storage.loadHydrated(p, d).data.comments[0].rounds[0].owner.images;
    assert.deepEqual(hydrated, [image('i1', a), image('i2', b)]);
    // A reference to bytes the project does not have is rejected.
    assert.throws(() => f.ops(d, [{ type: 'content.set', commentId: 'c2', roundId: 'r2', side: 'reply', baseRev: 0, value: { ...blankContent(), images: [{ id: 'z', name: 'z.png', mime: 'image/png', hash: 'f'.repeat(64), width: 1, height: 1 }] } }]), /Unknown image reference/);
    assert.deepEqual(comparableImages({ images: [image('i1', a)] }), { images: [stored[0]] });
  } finally { f.db.close(); }
});

function legacyFixture() {
  const f = fixture();
  f.storage.create(p, d, actor('A'));
  const a = png('legacy-a'.repeat(200)), b = png('legacy-b'.repeat(200));
  f.ops(d, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }]);
  f.ops(d, [{ type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'owner', baseRev: 0, value: { ...blankContent(), text: 'legacy', images: [image('i1', a), image('i2', b)] } }]);
  // Rewrite the document and a history snapshot in the pre-round-4 inline form and drop the image files.
  const inline = f.storage.loadHydrated(p, d).data;
  writeFileSync(f.storage.file(p, d), JSON.stringify(inline));
  const historyDir = f.storage.historyDir(p, d); mkdirSync(historyDir, { recursive: true });
  const snapshot = path.join(historyDir, '1-' + (f.at - 86400000) + '-' + randomUUID() + '.json');
  writeFileSync(snapshot, JSON.stringify({ ...inline, hub: { ...inline.hub, rev: 1 } }));
  const imagesDir = path.join(f.dir, 'pcf', p, '.images');
  rmSync(imagesDir, { recursive: true, force: true });
  return { ...f, a, b, inline, snapshot, imagesDir };
}

test('legacy inline documents still load and are converted on their next save', () => {
  const f = legacyFixture(); try {
    const before = readFileSync(f.storage.file(p, d), 'utf8');
    assert.match(before, /data:image\/png/);
    const loaded = f.storage.load(p, d).data.comments[0].rounds[0].owner.images;
    assert.deepEqual(loaded.map((x: any) => x.hash), [sha(f.a), sha(f.b)]);
    assert.equal(readFileSync(f.storage.file(p, d), 'utf8'), before, 'reading never rewrites the JSON');
    assert.deepEqual(f.storage.images.read(p, sha(f.a))!.bytes, Buffer.from(f.a.split(',')[1], 'base64'), 'load restores the bytes from the inline copy');
    f.tick(11 * 60000);
    f.ops(d, [{ type: 'project.set', field: 'planTitle', value: 'after legacy', baseRev: f.storage.load(p, d).data.hub.entities['project:planTitle']?.rev ?? 0 }], 'B');
    assert.doesNotMatch(readFileSync(f.storage.file(p, d), 'utf8'), /data:image\//);
    const newest = f.storage.history(p, d)[0];
    assert.doesNotMatch(readFileSync(path.join(f.storage.historyDir(p, d), newest.filename), 'utf8'), /data:image\//, 'the legacy previous version is snapshotted as references');
    // Restoring the old inline snapshot works and stores references.
    const restored = f.storage.replace(p, d, { baseRev: f.storage.load(p, d).rev }, actor('restore'), 1);
    assert.equal(restored.data.comments[0].rounds[0].owner.images[0].hash, sha(f.a));
  } finally { f.db.close(); }
});

test('image migration backs up, converts documents and snapshots, round-trips exactly and is idempotent', () => {
  const f = legacyFixture(); try {
    const docBefore = readFileSync(f.storage.file(p, d), 'utf8'), snapBefore = readFileSync(f.snapshot, 'utf8');
    const namesBefore = historyEntries(f.storage.historyDir(p, d)).map(e => e.filename).sort();
    const dry = migratePcfImages({ dataDir: f.dir, dryRun: true });
    assert.equal(dry.converted, 2); assert.equal(dry.images, 4); assert.equal(dry.backupDir, null);
    assert.equal(readFileSync(f.storage.file(p, d), 'utf8'), docBefore, 'dry run writes nothing');
    const run = migratePcfImages({ dataDir: f.dir, now: new Date('2026-11-09T03:00:00Z') });
    assert.equal(run.converted, 2); assert.equal(run.documents, 1); assert.equal(run.snapshots, 1); assert.equal(run.uniqueImages, 2);
    assert.ok(run.bytesAfter < run.bytesBefore);
    assert.equal(readFileSync(path.join(run.backupDir!, p, d + '.json'), 'utf8'), docBefore);
    assert.equal(readFileSync(path.join(run.backupDir!, path.relative(path.join(f.dir, 'pcf'), f.snapshot)), 'utf8'), snapBefore);
    for (const file of [f.storage.file(p, d), f.snapshot]) assert.doesNotMatch(readFileSync(file, 'utf8'), /data:image\//);
    assert.deepEqual(f.storage.loadHydrated(p, d).data, f.inline, 'converted document re-inlines to the original');
    assert.deepEqual(imageFiles(f.dir), [sha(f.a) + '.png', sha(f.b) + '.png'].sort());
    const again = migratePcfImages({ dataDir: f.dir });
    assert.equal(again.converted, 0); assert.equal(again.backupDir, null);
    assert.deepEqual(historyEntries(f.storage.historyDir(p, d)).map(e => e.filename).sort(), namesBefore, 'snapshot filenames (rev and time) unchanged');
  } finally { f.db.close(); }
});

test('history retention: latest 50, daily under 30 days, weekly to 180 days, monthly beyond', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-retention-bands-'));
  const now = Date.parse('2026-11-09T04:00:00Z'), day = 86400000;
  // Two snapshots a day (03:00 and 09:00 Shanghai) for 400 days.
  let rev = 0;
  for (let i = 400; i >= 1; i--) for (const hour of [19, 1]) {
    const at = now - i * day + (hour - 4) * 3600000;
    writeFileSync(path.join(dir, ++rev + '-' + at + '-' + randomUUID() + '.json'), '{}');
  }
  pruneHistory(dir, now);
  const kept = historyEntries(dir), latest = kept.slice(0, PCF_HISTORY_RECENT_LIMIT);
  assert.equal(latest[0].rev, rev, 'newest kept');
  for (let k = 0; k < PCF_HISTORY_RECENT_LIMIT; k++) assert.equal(kept[k].rev, rev - k, 'latest 50 kept in full');
  const older = kept.slice(PCF_HISTORY_RECENT_LIMIT), bands = { day: 0, week: 0, month: 0 } as Record<string, number>;
  const seen = new Set<string>();
  for (const entry of older) {
    const bucket = historyBucket(entry.savedAt, now); assert.ok(!seen.has(bucket), 'one snapshot per bucket: ' + bucket); seen.add(bucket);
    bands[bucket.split(':')[0]]++;
  }
  // The latest 50 cover the newest 25 days; days 26-29 add one each, then weekly then monthly.
  assert.ok(bands.day >= 3 && bands.day <= 5, JSON.stringify(bands));
  assert.ok(bands.week >= 20 && bands.week <= 22, JSON.stringify(bands));
  assert.ok(bands.month >= 7 && bands.month <= 9, JSON.stringify(bands));
  // The kept one in each bucket is the newest in it.
  const all = new Map<string, number>(); for (const entry of older) all.set(historyBucket(entry.savedAt, now), entry.rev);
  assert.equal(historyBucket(new Date(now - 10 * day).toISOString(), now).startsWith('day:'), true);
  assert.equal(historyBucket(new Date(now - 31 * day).toISOString(), now).startsWith('week:'), true);
  assert.equal(historyBucket(new Date(now - 181 * day).toISOString(), now).startsWith('month:'), true);
  assert.ok(kept.length < 100, 'kept ' + kept.length + ' of 800');
  // Pruning again at the same time is stable.
  pruneHistory(dir, now); assert.equal(historyEntries(dir).length, kept.length);
});

test('image endpoint, self-contained Builder export, import back to references without false ownerTampered', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-images-api-'));
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'PAHUB_BASIC_AUTH'], old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), API_TOKEN: '', PAHUB_BASIC_AUTH: '' });
  const hub = await createHub({ host: '127.0.0.1', middleware: (_req: any, _res: any, next: any) => next() });
  try {
    hub.db.exec(readFileSync(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
    const origin = 'http://127.0.0.1:' + hub.port, route = origin + '/api/pcf/' + p + '/' + d + '/';
    const api = async (tail: string, method = 'GET', body?: any) => { const r = await fetch(route + tail, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify({ clientId: 'img', ...body }) : undefined }); return { status: r.status, value: await r.json() as any }; };
    await api('create', 'POST', {}); let live = (await api('data')).value;
    const ops = async (list: any[]) => { const r = await api('ops', 'POST', { baseRev: live.rev, batchId: randomUUID(), ops: list }); assert.equal(r.status, 200, JSON.stringify(r.value)); live = r.value; };
    const owner = png('owner-drawing'), reply = jpeg('builder-photo');
    await ops([{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }]);
    await ops([{ type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'owner', baseRev: 0, value: { ...blankContent(), text: 'Owner', images: [image('own', owner)] } }]);
    assert.equal(live.data.comments[0].rounds[0].owner.images[0].hash, sha(owner));
    // Image endpoint: right type, immutable cache, 404 for unknown hashes, no traversal.
    const got = await fetch(origin + '/pcf/' + p + '/' + d + '/images/' + sha(owner));
    assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.match(got.headers.get('cache-control')!, /max-age=31536000, immutable/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), Buffer.from(owner.split(',')[1], 'base64'));
    assert.equal((await fetch(origin + '/pcf/' + p + '/' + d + '/images/' + 'a'.repeat(64))).status, 404);
    assert.equal((await fetch(origin + '/pcf/' + p + '/' + d + '/images/..%2f..%2fpapc.db')).status, 404);
    // Builder export is self-contained: the image is inline again.
    const record = (await api('exports', 'POST', {})).value;
    const html = await (await fetch(route + 'exports/' + record.exportId + '/download')).text(), offline = parseHTML(html);
    assert.deepEqual(offline.comments[0].rounds[0].owner.images, [image('own', owner)]);
    assert.doesNotMatch(html, /\/images\/[a-f0-9]{64}/);
    // The Builder adds a reply photo; the owner image is untouched and must not count as tampering.
    offline.comments[0].rounds[0].reply = { ...blankContent(), text: 'Builder reply', images: [image('rep', reply)] };
    const returned = replaceData(html, offline);
    const preview = (await api('imports', 'POST', { step: 'preview', html: returned })).value;
    assert.equal(preview.ownerTampered, false); assert.deepEqual(preview.conflicts, []);
    assert.deepEqual(preview.automatic.map((x: any) => x.field).sort(), ['body', 'images']);
    const applied = await api('imports', 'POST', { step: 'apply', html: returned, previewToken: preview.previewToken, batchId: randomUUID(), choices: {} });
    assert.equal(applied.status, 200, JSON.stringify(applied.value));
    const round = applied.value.data.comments[0].rounds[0];
    assert.equal(round.owner.images[0].hash, sha(owner)); assert.equal(round.reply.images[0].hash, sha(reply)); assert.equal(round.reply.images[0].mime, 'image/jpeg');
    assert.doesNotMatch(readFileSync(path.join(dir, 'pcf', p, d + '.json'), 'utf8'), /data:image\//);
    assert.equal((await fetch(origin + '/pcf/' + p + '/' + d + '/images/' + sha(reply))).headers.get('content-type'), 'image/jpeg');
    // A changed owner image in the returned file is still detected.
    const tampered = parseHTML(html); tampered.comments[0].rounds[0].owner.images = [image('own', png('different'))];
    assert.equal((await api('imports', 'POST', { step: 'preview', html: replaceData(html, tampered) })).value.ownerTampered, true);
    // Complete copy: inline on download, no conflicts on return, references after apply.
    const completeHTML = await (await fetch(route + 'download')).text(), complete = parseHTML(completeHTML);
    let inlineCount = 0; eachImageList(complete, list => { inlineCount += list.filter((x: any) => typeof x.data === 'string').length; });
    assert.equal(inlineCount, 2);
    complete.project.planTitle = 'Complete offline';
    const back = replaceData(completeHTML, complete), cp = await api('imports', 'POST', { step: 'preview', html: back });
    assert.equal(cp.status, 200, JSON.stringify(cp.value)); assert.deepEqual(cp.value.conflicts, []);
    const ca = await api('imports', 'POST', { step: 'apply', html: back, previewToken: cp.value.previewToken, batchId: randomUUID(), choices: {} });
    assert.equal(ca.status, 200, JSON.stringify(ca.value)); assert.equal(ca.value.data.project.planTitle, 'Complete offline');
    assert.equal(ca.value.data.comments[0].rounds[0].reply.images[0].hash, sha(reply));
    assert.doesNotMatch(readFileSync(path.join(dir, 'pcf', p, d + '.json'), 'utf8'), /data:image\//);
  } finally { await hub.close(); for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
