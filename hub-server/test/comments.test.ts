import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createHub } from '../src/app.ts';
import { PcfStorage, scriptJSON } from '../src/pcf-storage.ts';
import { blankContent, type PcfData } from '../src/pcf-model.ts';

// Tests exercise GET HTTP routes, never a pre-warmed ProjectComments instance.
const project = 'p9-comments-a', otherProject = 'p9-comments-b';
const apiToken = 'phase9-api-token-do-not-export', adminPassword = 'phase9-admin-do-not-export';
const day = 86_400_000;
const dateAgo = (days: number) => new Date(Date.now() - days * day).toISOString().slice(0, 10);
const content = (text = '', images: any[] = []) => ({ ...blankContent(), text, html: text, images });
function round(number: number, owner = '', reply = '', overrides: Record<string, any> = {}) {
  return { id: randomUUID(), number, initiator: 'Reviewer 王', responder: 'Builder 李', owner: content(owner), reply: content(reply),
    createdAt: dateAgo(10) + 'T00:00:00.000Z', updatedAt: dateAgo(2) + 'T00:00:00.000Z', ...overrides };
}
function comment(owner = 'Owner fixture', overrides: Record<string, any> = {}) {
  return { id: randomUUID(), number: 1, page: '', tags: [], status: 'open', createdAt: dateAgo(10) + 'T00:00:00.000Z',
    updatedAt: dateAgo(2) + 'T00:00:00.000Z', rounds: [round(1, owner)], ...overrides };
}
function documentData(comments: any[], overrides: Record<string, any> = {}): PcfData {
  return { schemaVersion: '1.0', appVersion: '2.6', documentId: randomUUID(), updatedAt: new Date().toISOString(),
    project: { name: 'Phase 9 isolated test', planNo: 'P9-001', planTitle: 'Test drawing', currentRound: 1, revision: 'A', approval: 'Under review' },
    comments: comments.map((c, i) => ({ ...c, number: i + 1 })), nextCommentNumber: comments.length + 1,
    deleted: [], circulation: [], approvalHistory: [], settings: { fontSize: 15, autoSaveSeconds: 60 }, roundRegister: [],
    hub: { rev: 1, entities: {}, tombstones: [], lastChange: { clientId: 'fixture', clientName: 'Phase 9 fixture', ip: '127.0.0.1', ops: [] } }, ...overrides };
}
function html(data: PcfData) {
  // Complete small HTML avoids writing the large template 500 times in perf setup.
  return '<!doctype html><html><head><meta charset="UTF-8"><title>Phase 9</title></head><body>' +
    '<script id="pcf-data" type="application/json">' + scriptJSON(data) + '</script>' +
    '<script id="pahub-context" type="application/json">' + JSON.stringify({ token: apiToken, capability: 'private-capability-do-not-export' }) + '</script></body></html>';
}
async function fixture(token = '') {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-phase9-comments-'));
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'ADMIN_PASSWORD'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), API_TOKEN: token, ADMIN_PASSWORD: adminPassword });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  const cleanup = async () => {
    try { await hub?.close(); } finally {
      for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
      const resolved = path.resolve(dir);
      assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('pahub-phase9-comments-'));
      await rm(resolved, { recursive: true, force: true });
    }
  };
  try {
    hub = await createHub({ middleware: (_req, _res, next) => next() });
    const liveHub = hub, db = liveHub.db.sqlite, storage = new PcfStorage(db, dir);
    db.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run(project, 'Phase 9 A');
    db.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run(otherProject, 'Phase 9 B');
    const origin = 'http://127.0.0.1:' + liveHub.port;
    const auth: Record<string, string> = token ? { Authorization: 'Bearer ' + token } : {};
    const get = (p = project, filters = new URLSearchParams(), suffix = 'comments', headers: Record<string, string> = auth) =>
      fetch(origin + '/api/projects/' + p + '/' + suffix + '?' + filters, { headers, signal: AbortSignal.timeout(15_000) });
    const query = async (filters = new URLSearchParams(), p = project) => {
      const response = await get(p, filters); assert.equal(response.status, 200, 'comments GET must succeed');
      return await response.json() as any;
    };
    const drawing = (id: string, p = project, overrides: Record<string, string> = {}) => {
      const meta = { drawingNo: 'P9-' + id, title: 'Drawing ' + id, discipline: 'Hull', status: 'Under Review', ...overrides };
      db.prepare('INSERT INTO drawings(id,project_id,drawing_no,title,discipline,status,current_round) VALUES (?,?,?,?,?,?,?)')
        .run(id, p, meta.drawingNo, meta.title, meta.discipline, meta.status, 'A'); return meta;
    };
    const store = async (id: string, data: PcfData, p = project, index = true) => {
      const file = storage.file(p, id); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, html(data));
      if (index) storage.load(p, id); return file;
    };
    return { hub: liveHub, db, storage, origin, auth, get, query, drawing, store, cleanup, dir };
  } catch (error) { await cleanup(); throw error; }
}
const params = (values: Record<string, string>) => new URLSearchParams(values);
const ids = (result: any) => result.comments.map((row: any) => row.commentId).sort();

// Central-directory sizes support ZIP writers using local data descriptors.
function zipText(bytes: Buffer): Map<string, string> {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'xlsx must be a ZIP');
  let offset = bytes.readUInt32LE(end + 16); const files = new Map<string, string>();
  for (let n = 0; n < bytes.readUInt16LE(end + 10); n++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10), length = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'), local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + length); assert.ok(method === 0 || method === 8, 'supported xlsx ZIP compression');
    files.set(name, (method === 8 ? inflateRawSync(compressed) : compressed).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
function xmlText(value: string) {
  return value.replace(/<[^>]*>/g, '').replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function sheetRows(files: Map<string, string>) {
  const sheet = files.get('xl/worksheets/sheet1.xml'); assert.ok(sheet, 'xlsx contains comments worksheet');
  const shared = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1]));
  return [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row =>
    [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => ({
      type: cell[1].match(/\bt="([^"]+)"/)?.[1] || '',
      value: /\bt="s"/.test(cell[1]) ? shared[Number(cell[2].match(/<v>(\d+)<\/v>/)?.[1])] : xmlText(cell[2]),
    })));
}

test('phase 9: JSON and Excel require API_TOKEN; projects are isolated and no-PCF drawings are harmless', async () => {
  const f = await fixture(apiToken); try {
    const a = comment('Only project A'), b = comment('Only project B');
    f.drawing('auth-a'); f.drawing('auth-b', otherProject); f.drawing('without-pcf');
    await f.store('auth-a', documentData([a])); await f.store('auth-b', documentData([b]), otherProject);
    for (const suffix of ['comments', 'comments.xlsx']) {
      const unauthorizedHeaders: Record<string, string>[] = [{}, { Authorization: 'Bearer wrong' }];
      for (const headers of unauthorizedHeaders) {
        const response = await f.get(project, new URLSearchParams(), suffix, headers);
        assert.equal(response.status, 401); await response.arrayBuffer();
      }
      const response = await f.get(project, new URLSearchParams(), suffix);
      assert.equal(response.status, 200); await response.arrayBuffer();
    }
    assert.deepEqual(ids(await f.query()), [a.id]);
    assert.deepEqual(ids(await f.query(new URLSearchParams(), otherProject)), [b.id]);
    assert.equal(await stat(f.storage.file(project, 'without-pcf')).catch(() => null), null, 'GET must not create PCFs');
  } finally { await f.cleanup(); }
});

test('phase 9: project with no PCF returns empty rows/statistics/options without body DB state', async () => {
  const f = await fixture(); try {
    f.drawing('empty');
    const before = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const result = await f.query(); assert.deepEqual(result.comments, []);
    assert.deepEqual([result.statistics.total, result.statistics.open, result.statistics.closed], [0, 0, 0]);
    for (const key of ['disciplines', 'drawingStatuses', 'commentStatuses', 'rounds', 'tags']) assert.ok(Array.isArray(result.options[key]));
    assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
    assert.deepEqual(f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), before, 'GET must not add a comments-body table');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pcf_index').get()!.n, 0);
  } finally { await f.cleanup(); }
});

test('phase 9: corrupted JSON and invalid PCF are skipped with drawingNo warnings, never hide healthy rows', async () => {
  const f = await fixture(); try {
    const healthy = comment('Still available');
    f.drawing('healthy'); f.drawing('bad-json', project, { drawingNo: '损坏-JSON' }); f.drawing('bad-shape', project, { drawingNo: 'P9-BAD-SHAPE' });
    await f.store('healthy', documentData([healthy]));
    await mkdir(path.dirname(f.storage.file(project, 'bad-json')), { recursive: true });
    await writeFile(f.storage.file(project, 'bad-json'), '<html><script id="pcf-data" type="application/json">{broken</script></html>');
    await f.store('bad-shape', documentData([], { comments: null }), project, false);
    const result = await f.query(); assert.deepEqual(ids(result), [healthy.id]);
    for (const [drawingId, drawingNo] of [['bad-json', '损坏-JSON'], ['bad-shape', 'P9-BAD-SHAPE']]) {
      const warning = result.warnings.find((w: any) => w.drawingId === drawingId);
      assert.ok(warning, drawingId + ' must produce a warning'); assert.equal(warning.drawingNo, drawingNo); assert.ok(warning.message.length > 0);
    }
    assert.ok(!JSON.stringify(result).includes(f.dir), 'warnings must not expose server filesystem paths');
  } finally { await f.cleanup(); }
});

test('phase 9: HTML mtime invalidates cached bodies even when hub/index revision is unchanged', async () => {
  const f = await fixture(); try {
    f.drawing('mtime'); const data = documentData([comment('Before mtime')]), file = await f.store('mtime', data);
    assert.equal((await f.query()).comments[0].ownerComment, 'Before mtime');
    data.comments[0].rounds[0].owner = content('After mtime');
    const previous = await stat(file); await writeFile(file, html(data)); await utimes(file, previous.atime, new Date(previous.mtimeMs + 2000));
    assert.equal((await f.query()).comments[0].ownerComment, 'After mtime');
  } finally { await f.cleanup(); }
});

test('phase 9: index/HTML rev invalidates cache with identical mtime and file size', async () => {
  const f = await fixture(); try {
    f.drawing('revision'); const data = documentData([comment('original')]), file = await f.store('revision', data);
    assert.equal((await f.query()).comments[0].ownerComment, 'original');
    const previous = await stat(file); data.comments[0].rounds[0].owner = content('rev-only'); data.hub.rev++;
    await writeFile(file, html(data)); f.storage.load(project, 'revision'); await utimes(file, previous.atime, previous.mtime);
    assert.equal((await stat(file)).size, previous.size, 'rev-only fixture preserves size');
    assert.equal((await f.query()).comments[0].ownerComment, 'rev-only');
  } finally { await f.cleanup(); }
});

test('phase 9: file deletion evicts stale rows and recreation at the same path is discovered', async () => {
  const f = await fixture(); try {
    f.drawing('recreate'); const old = comment('Old deleted body'), fresh = comment('Recreated body');
    const file = await f.store('recreate', documentData([old])); assert.deepEqual(ids(await f.query()), [old.id]);
    await unlink(file); assert.deepEqual(ids(await f.query()), []);
    await f.store('recreate', documentData([fresh], { hub: { rev: 2, entities: {}, tombstones: [], lastChange: { clientId: 'fixture', clientName: 'fixture', ip: '', ops: [] } } }));
    assert.deepEqual(ids(await f.query()), [fresh.id]);
  } finally { await f.cleanup(); }
});

test('phase 9: deleted records/drawings and round tombstones are excluded from rows and full search', async () => {
  const f = await fixture(); try {
    f.drawing('live'); f.drawing('deleted-drawing');
    const live = comment('Active marker'), deleted = comment('deleted-only-secret'), hidden = comment('hidden-drawing-secret');
    const removedRound = round(2, 'round-tombstone-secret');
    live.rounds.push(removedRound);
    const data = documentData([live, deleted], { deleted: [ { id: randomUUID(), type: 'comment', data: deleted }, { id: randomUUID(), type: 'round', parentId: live.id, data: removedRound } ] });
    data.hub.tombstones = [{ id: deleted.id, type: 'comment', clock: 1 }, { id: removedRound.id, type: 'round', parentId: live.id, clock: 1 }];
    await f.store('live', data); await f.store('deleted-drawing', documentData([hidden]));
    f.db.prepare('UPDATE drawings SET _deleted=1 WHERE id=?').run('deleted-drawing');
    const result = await f.query(); assert.deepEqual(ids(result), [live.id]); assert.equal(result.statistics.total, 1);
    assert.equal(result.comments[0].round, 1, 'tombstoned latest round must not become the row round');
    for (const q of ['deleted-only-secret', 'round-tombstone-secret', 'hidden-drawing-secret']) assert.deepEqual(ids(await f.query(params({ q }))), []);
  } finally { await f.cleanup(); }
});

test('phase 9: one latest-round row uses newest nonempty owner/reply, business dates, Chinese and images', async () => {
  const f = await fixture(); try {
    f.drawing('unicode', project, { title: '燃气供给系统图' });
    const longOwner = '核查中文长意见：' + '请核实燃气管路和阀门。'.repeat(350), longReply = '回复😀'.repeat(150) + 'full-reply-tail-only-marker';
    const r1 = round(1, 'older-owner-full-search-only', 'older-reply-full-search-only');
    r1.owner.images = [{ id: randomUUID(), name: '附件示意图.png', mime: 'image/png', data: 'data:image/png;base64,AA==', width: 1, height: 1 }];
    const r2 = round(2, longOwner, longReply, { initiator: '审图员王', updatedAt: dateAgo(1) + 'T00:00:00.000Z' });
    const r3 = round(3, '', '', { initiator: '' }), c = comment('', { rounds: [r3, r1, r2] });
    await f.store('unicode', documentData([c], { roundRegister: [ { round: 1, ownerDate: '2026-01-01', replyDate: '2026-01-02' }, { round: 2, ownerDate: '2026-02-03', replyDate: '2026-02-04' }, { round: 3, ownerDate: '', replyDate: '' } ] }));
    const result = await f.query(); assert.equal(result.comments.length, 1); const row = result.comments[0];
    assert.equal(row.round, 3); assert.equal(row.ownerName, '审图员王'); assert.equal(row.ownerComment, longOwner);
    assert.equal(row.builderReply, Array.from(longReply).slice(0, 200).join('')); assert.equal(Array.from(row.builderReply).length, 200);
    assert.equal(row.ownerDate, '2026-02-03'); assert.equal(row.builderReplyDate, '2026-02-04'); assert.equal(row.hasImages, true);
    assert.equal(row.drawingTitle, '燃气供给系统图');
    for (const q of ['OLDER-OWNER-FULL-SEARCH-ONLY', 'older-reply-full-search-only', '燃气管路', 'full-reply-tail-only-marker', '审图员王', '燃气供给系统图']) assert.deepEqual(ids(await f.query(params({ q }))), [c.id], 'full text query: ' + q.slice(0, 40));
    assert.ok(!JSON.stringify(result).includes('data:image/'), 'summary must not send attachment payloads');
  } finally { await f.cleanup(); }
});

test('phase 9: absent business dates fall back to creation/round update and closed age is null', async () => {
  const f = await fixture(); try {
    f.drawing('fallback'); const createdAt = dateAgo(16) + 'T00:00:00.000Z', updatedAt = dateAgo(3) + 'T12:00:00.000Z';
    const open = comment('Fallback dates', { createdAt, rounds: [round(1, 'Fallback dates', 'Fallback reply', { createdAt, updatedAt })] });
    const closed = comment('Closed fixture', { status: 'Closed', createdAt });
    await f.store('fallback', documentData([open, closed]));
    const result = await f.query(), row = result.comments.find((r: any) => r.commentId === open.id);
    assert.equal(row.ownerDate.slice(0, 10), createdAt.slice(0, 10)); assert.equal(row.builderReplyDate.slice(0, 10), updatedAt.slice(0, 10));
    assert.equal(row.openDays, Math.floor((Date.now() - Date.parse(createdAt)) / day));
    const closedRow = result.comments.find((r: any) => r.commentId === closed.id);
    assert.equal(closedRow.status.toLowerCase(), 'closed'); assert.equal(closedRow.openDays, null);
  } finally { await f.cleanup(); }
});

test('phase 9: ageing boundaries, strictly-older filter, case-insensitive Closed and statistics match active rows', async () => {
  const f = await fixture(); try {
    f.drawing('age-hull'); f.drawing('age-machinery', project, { discipline: 'Machinery', status: 'Waiting Reply' });
    const ages = [0, 7, 8, 14, 15, 30, 31], active = ages.map(age => comment('Age ' + age, { createdAt: dateAgo(age) + 'T00:00:00.000Z', rounds: [round(2, 'Age ' + age)] }));
    const closed = comment('Uppercase closed', { status: 'CLOSED', createdAt: dateAgo(90) + 'T00:00:00.000Z' });
    await f.store('age-hull', documentData([...active, closed])); await f.store('age-machinery', documentData([comment('Machinery age', { createdAt: dateAgo(20) + 'T00:00:00.000Z' })]));
    const result = await f.query(), stats = result.statistics;
    assert.deepEqual([stats.total, stats.open, stats.closed], [9, 8, 1]);
    assert.deepEqual(Object.fromEntries(stats.ageing.map((r: any) => [r.band, r.count])), { '0–7': 2, '8–14': 2, '15–30': 3, '>30': 1 });
    assert.equal(stats.byDiscipline.reduce((n: number, r: any) => n + r.count, 0), stats.total);
    assert.equal(stats.byRound.reduce((n: number, r: any) => n + r.count, 0), stats.total);
    assert.equal(stats.byDrawingStatus.reduce((n: number, r: any) => n + r.count, 0), stats.total);
    assert.equal(stats.byDiscipline.find((r: any) => r.discipline === 'Hull' && r.status.toLowerCase() === 'closed').count, 1);
    const top = stats.topDrawings.find((r: any) => r.drawingId === 'age-hull');
    assert.deepEqual([top.drawingNo, top.open, top.closed, top.total], ['P9-age-hull', 7, 1, 8]);
    const older = await f.query(params({ discipline: 'Hull', openOlderThanDays: '14' }));
    assert.deepEqual(ids(older), active.filter((_, i) => ages[i] > 14).map(c => c.id).sort());
    const normalized = result.comments.find((r: any) => r.commentId === closed.id); assert.equal(normalized.status.toLowerCase(), 'closed'); assert.equal(normalized.openDays, null);
  } finally { await f.cleanup(); }
});

test('phase 9: combined filters intersect and Excel exports exactly the filtered subset', async () => {
  const f = await fixture(apiToken); try {
    f.drawing('filter-hull'); f.drawing('filter-machinery', project, { discipline: 'Machinery', status: 'Waiting Reply' });
    const selected = comment('Unique selected 中文 export marker', { tags: ['Safety'], rounds: [round(2, 'Unique selected 中文 export marker', 'Reply')] });
    const closed = comment('Unique excluded closed marker', { tags: ['Safety'], status: 'closed', rounds: [round(2, 'Unique excluded closed marker')] });
    const wrongTag = comment('Unique excluded tag marker', { tags: ['Structure'], rounds: [round(2, 'Unique excluded tag marker')] });
    const wrongRound = comment('Unique excluded round marker', { tags: ['Safety'] });
    const wrongDrawing = comment('Unique excluded machinery marker', { tags: ['Safety'], rounds: [round(2, 'Unique excluded machinery marker')] });
    await f.store('filter-hull', documentData([selected, closed, wrongTag, wrongRound])); await f.store('filter-machinery', documentData([wrongDrawing]));
    const filters = { discipline: 'Hull', drawingStatus: 'Under Review', commentStatus: 'open', round: 'B', tag: 'Safety', q: 'Unique', openOlderThanDays: '7' };
    const result = await f.query(params(filters)); assert.deepEqual(ids(result), [selected.id]);
    assert.deepEqual(ids(await f.query(params({ ...filters, round: '2' }))), [selected.id]);
    assert.deepEqual(ids(await f.query(params({ discipline: 'Hull', commentStatus: 'closed', round: 'B', tag: 'Safety', q: 'Unique' }))), [closed.id]);
    for (const [key, value] of Object.entries({ discipline: 'Electrical', drawingStatus: 'Approved', commentStatus: 'closed', round: 'C', tag: 'Missing', q: 'not-present', openOlderThanDays: '100' })) {
      assert.deepEqual(ids(await f.query(params({ ...filters, [key]: value }))), [], 'combined filter ' + key);
    }
    const response = await f.get(project, params(filters), 'comments.xlsx'); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
    assert.match(response.headers.get('content-disposition') || '', /attachment/i);
    const files = zipText(Buffer.from(await response.arrayBuffer())), rows = sheetRows(files);
    assert.equal(rows.length, 2, 'one header plus the single filtered comment');
    assert.ok(rows[1].some(cell => cell.value === selected.rounds[0].owner.text));
    const workbookText = [...files.values()].join('\n');
    for (const c of [closed, wrongTag, wrongRound, wrongDrawing]) assert.ok(!workbookText.includes(c.rounds[0].owner.text));
    const all = await f.query();
    for (const value of ['Hull', 'Machinery']) assert.ok(all.options.disciplines.includes(value));
    for (const value of ['Safety', 'Structure']) assert.ok(all.options.tags.includes(value));
    assert.ok(all.options.rounds.includes(2)); assert.ok(all.options.commentStatuses.includes('closed'));
  } finally { await f.cleanup(); }
});

test('phase 9: Excel formula-leading user fields are string cells and no credentials/body payload leak', async () => {
  const f = await fixture(apiToken); try {
    const dangerous = ['=HYPERLINK("https://invalid.example","x")', '+SUM(1,2)', '-1+2', '@SUM(1,2)'];
    f.drawing('formula', project, { drawingNo: '=P9-FORMULA', title: '+Dangerous title' });
    const comments = dangerous.map(value => comment(value, { rounds: [round(1, value, value, { initiator: '@Reviewer' })], tags: ['-FormulaTag'] }));
    await f.store('formula', documentData(comments));
    const json = await f.query(), response = await f.get(project, new URLSearchParams(), 'comments.xlsx');
    assert.equal(response.status, 200); const files = zipText(Buffer.from(await response.arrayBuffer()));
    const allXml = [...files.values()].join('\n'), rows = sheetRows(files);
    assert.equal(rows.length, comments.length + 1);
    for (const [name, value] of files) if (/^xl\/worksheets\//.test(name)) assert.doesNotMatch(value, /<f(?:\s|>)/, 'no executable formulas in ' + name);
    for (const value of [...dangerous, '=P9-FORMULA', '+Dangerous title', '@Reviewer', JSON.stringify(['-FormulaTag'])]) {
      const cells = rows.slice(1).flat().filter(cell => cell.value === value || cell.value === "'" + value);
      assert.ok(cells.length >= 1, 'formula-like content retained as text: ' + value);
      assert.ok(cells.every(cell => ['s', 'str', 'inlineStr'].includes(cell.type)), 'formula-like values must be typed strings');
    }
    for (const secret of [apiToken, adminPassword, 'private-capability-do-not-export', 'pahub-context', 'data:image/']) {
      assert.ok(!allXml.includes(secret)); assert.ok(!JSON.stringify(json).includes(secret));
    }
    assert.ok(json.comments.every((row: any) => !('hub' in row) && !('rounds' in row) && !('capability' in row)));
    const columns = f.db.prepare('PRAGMA table_info(pcf_index)').all().map(row => String(row.name));
    assert.ok(!columns.some(name => /^(?:body|html|owner_comment|builder_reply|comments_json)$/i.test(name)), 'index must not persist bodies');
    assert.ok(!(await readFile(path.join(f.dir, 'papc.db'))).includes(Buffer.from(dangerous[0])), 'comment bodies are not in the DB file');
    assert.ok(!(await readFile(path.join(f.dir, 'papc.db-wal')).catch(() => Buffer.alloc(0))).includes(Buffer.from(dangerous[0])), 'comment bodies are not in the WAL');
  } finally { await f.cleanup(); }
});

test('phase 9: Excel preserves Chinese/emoji opinion longer than 32767 units via continuation rows', async () => {
  const f = await fixture(); try {
    f.drawing('long-excel'); const owner = '😀中文意见\n'.repeat(12_000);
    const c = comment(owner); c.rounds[0].owner.images.push({ id: randomUUID(), name: '示意.png', mime: 'image/png', data: 'data:image/png;base64,AA==' });
    await f.store('long-excel', documentData([c]));
    const result = await f.query(); assert.equal(result.comments[0].ownerComment, owner); assert.equal(result.comments[0].hasImages, true);
    const response = await f.get(project, new URLSearchParams(), 'comments.xlsx'); assert.equal(response.status, 200);
    const files = zipText(Buffer.from(await response.arrayBuffer())), rows = sheetRows(files);
    const headers = rows[0].map(cell => cell.value), ownerColumn = headers.indexOf('Owner comment text'), partColumn = headers.indexOf('Part');
    assert.ok(ownerColumn >= 0 && partColumn >= 0); assert.ok(rows.length > 2);
    const parts = rows.slice(1).sort((a, b) => Number(a[partColumn].value) - Number(b[partColumn].value));
    assert.equal(parts.map(row => row[ownerColumn].value).join(''), owner);
    for (const row of parts) assert.ok(row[ownerColumn].value.length <= 32767);
    assert.ok(![...files.values()].join('').includes('data:image/'));
  } finally { await f.cleanup(); }
});

test('phase 9: ETag revalidates cached JSON, remains authenticated and changes after PCF write', async () => {
  const f = await fixture(apiToken); try {
    f.drawing('etag'); const c = comment('original etag marker');
    await f.store('etag', documentData([c]));
    const first = await f.get(), etag = first.headers.get('etag'); assert.ok(etag);
    const body = await first.text();
    const same = await f.get(); assert.equal(same.headers.get('etag'), etag); assert.equal(await same.text(), body);
    const notModified = await f.get(project, new URLSearchParams(), 'comments', { ...f.auth, 'If-None-Match': 'W/' + etag });
    assert.equal(notModified.status, 304); assert.equal(await notModified.text(), '');
    assert.equal((await f.get(project, new URLSearchParams(), 'comments', { 'If-None-Match': etag! })).status, 401);
    c.rounds[0].owner.text = 'updated etag marker'; await f.store('etag', documentData([c]));
    const changed = await f.get(project, new URLSearchParams(), 'comments', { ...f.auth, 'If-None-Match': etag! });
    assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), etag);
    assert.match((await changed.json() as any).comments[0].ownerComment, /updated etag/);
  } finally { await f.cleanup(); }
});

test('phase 9: tags including Cost Affect are discovered dynamically and cached filters stay independent', async () => {
  const f = await fixture(); try {
    f.drawing('tags'); const cost = comment('cost marker', { tags: ['Cost Affect', '新增标签'] }), safety = comment('safety marker', { tags: ['Safety'] });
    await f.store('tags', documentData([cost, safety]));
    const all = await f.query(); assert.deepEqual(new Set(all.options.tags), new Set(['Cost Affect', '新增标签', 'Safety']));
    const filtered = await f.query(params({ tag: 'Cost Affect' })); assert.deepEqual(ids(filtered), [cost.id]);
    assert.equal(filtered.statistics.total, 1); assert.equal((await f.query()).statistics.total, 2);
    assert.deepEqual(ids(await f.query(params({ tag: '新增标签' }))), [cost.id]);
    Object.assign(safety, { tags: ['Future tag'] }); await f.store('tags', documentData([cost, safety]));
    const updated = await f.query(); assert.ok(updated.options.tags.includes('Future tag')); assert.ok(!updated.options.tags.includes('Safety'));
    assert.equal((await f.query(params({ tag: 'Safety' }))).statistics.total, 0);
  } finally { await f.cleanup(); }
});

test('comments cache reparses only the changed PCF', async () => {
  const oldProfile = process.env.PAHUB_COMMENTS_PROFILE;
  process.env.PAHUB_COMMENTS_PROFILE = '1';
  const info = console.info, profiles: any[] = [];
  console.info = (...args: any[]) => { if (args[0] === 'Comments profile') profiles.push(args[1]); else info(...args); };
  const f = await fixture();
  try {
    for (const id of ['cache-a', 'cache-b']) { f.drawing(id); await f.store(id, documentData([comment(id)])); }
    await f.query(); assert.equal(profiles.at(-1).parsedFiles, 2);
    await f.query(); assert.equal(profiles.at(-1).parsedFiles, 0);
    await f.store('cache-a', documentData([comment('changed-cache-marker')]));
    const changed = await f.query();
    assert.equal(profiles.at(-1).parsedFiles, 1);
    assert.ok(changed.comments.some((row: any) => row.ownerComment === 'changed-cache-marker'));
    await f.query(); assert.equal(profiles.at(-1).parsedFiles, 0);
  } finally {
    await f.cleanup(); console.info = info;
    if (oldProfile === undefined) delete process.env.PAHUB_COMMENTS_PROFILE; else process.env.PAHUB_COMMENTS_PROFILE = oldProfile;
  }
});

test('phase 9: drawing metadata changes invalidate aggregate and serialized result caches', async () => {
  const f = await fixture(); try {
    f.drawing('metadata'); await f.store('metadata', documentData([comment('metadata marker')]));
    const first = await f.query(); assert.equal(first.comments[0].discipline, 'Hull');
    f.db.prepare('UPDATE drawings SET discipline=?,title=?,status=? WHERE id=?').run('Electrical', 'Renamed drawing', 'Approved', 'metadata');
    const updated = await f.query(); assert.equal(updated.comments[0].drawingTitle, 'Renamed drawing');
    assert.deepEqual(updated.options.disciplines, ['Electrical']); assert.deepEqual(updated.statistics.byDrawingStatus, [{ drawingStatus: 'Approved', count: 1 }]);
    assert.equal((await f.query(params({ discipline: 'Hull' }))).comments.length, 0);
  } finally { await f.cleanup(); }
});

test('phase 9: 500 drawings × 30 authoritative comments, actual HTTP cold <3s and warm <300ms', { timeout: 60_000 }, async t => {
  const f = await fixture(); try {
    const expected = 500 * 30;
    for (let drawing = 0; drawing < 500; drawing++) {
      const id = 'perf-' + String(drawing).padStart(3, '0'); f.drawing(id);
      const comments = Array.from({ length: 30 }, (_, n) => comment('性能检查 ' + drawing + '/' + n, { tags: ['Performance'], rounds: [round(1, '性能检查 ' + drawing + '/' + n, 'Builder reply ' + n)] }));
      await f.store(id, documentData(comments));
    }
    // No route/class query before this timing; GET and full JSON parsing included.
    const coldStart = performance.now(), cold = await f.query(), coldMs = performance.now() - coldStart;
    const warmStart = performance.now(), warmResponse = await f.get(), warm = await warmResponse.json() as any, warmMs = performance.now() - warmStart;
    const conditionalStart = performance.now();
    const conditional = await f.get(project, new URLSearchParams(), 'comments', { 'If-None-Match': warmResponse.headers.get('etag')! });
    assert.equal(conditional.status, 304); await conditional.arrayBuffer();
    const conditionalMs = performance.now() - conditionalStart;
    t.diagnostic(JSON.stringify({ route: '/api/projects/' + project + '/comments', drawings: 500, comments: expected, coldMs: +coldMs.toFixed(2), warmMs: +warmMs.toFixed(2), etag304Ms: +conditionalMs.toFixed(2) }));
    assert.equal(cold.comments.length, expected); assert.equal(warm.comments.length, expected);
    assert.equal(new Set(cold.comments.map((row: any) => row.commentId)).size, expected); assert.equal(cold.statistics.total, expected);
    assert.ok(coldMs < 3000, 'cold actual HTTP GET ' + coldMs.toFixed(2) + 'ms exceeds <3000ms');
    assert.ok(warmMs < 300, 'warm actual HTTP GET ' + warmMs.toFixed(2) + 'ms exceeds <300ms');
  } finally { await f.cleanup(); }
});
