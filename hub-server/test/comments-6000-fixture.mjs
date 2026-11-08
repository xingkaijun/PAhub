// Run in PAhub-preview after hub:build. All fixture data lives under OS temp.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHub } from '../dist/app.mjs';
const dir = await mkdtemp(path.join(tmpdir(), 'pahub-comments-6000-'));
Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: '', PAHUB_COMMENTS_PROFILE: '1' });
const profiles = [], info = console.info;
console.info = (label, value) => { if (label === 'Comments profile') profiles.push(value); else info(label, value); };
const hub = await createHub({ host: '127.0.0.1' }), origin = 'http://127.0.0.1:' + hub.port;
const project = 'comments-6000', name = 'Comments 6000 Acceptance';
hub.db.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run(project, name);
const actor = { clientId: 'performance-fixture', clientName: 'Acceptance' };
const json = async (url, body) => { const response = await fetch(origin + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...actor }) } : {}); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
const content = text => ({ text, html: text, images: [] });
const first = {};
for (let d = 0; d < 200; d++) {
  const id = 'perf-' + String(d + 1).padStart(3, '0');
  hub.db.prepare('INSERT INTO drawings(id,project_id,drawing_no,title,discipline,status,current_round) VALUES (?,?,?,?,?,?,?)').run(id, project, 'PERF-' + id, 'Equipment specification ' + d, ['Hull','Machinery','Electrical'][d % 3], 'Reviewing', 'A');
  await json('/api/pcf/' + project + '/' + id + '/create', {});
  const ops = [];
  for (let c = 0; c < 30; c++) {
    const cid = randomUUID(), rid = randomUUID();
    if (!d && c === 1) Object.assign(first, { id, cid, rid });
    ops.push({ type: 'comment.add', id: cid, roundIdNew: rid },
      { type: 'content.set', commentId: cid, roundId: rid, side: 'owner', baseRev: 0, value: content('Review cost and safety of equipment ' + d + '/' + c + '. Confirm material specification and installation clearance.') },
      { type: 'content.set', commentId: cid, roundId: rid, side: 'reply', baseRev: 0, value: content('Builder response for equipment ' + d + '/' + c) },
      { type: 'comment.meta', commentId: cid, baseRev: 0, value: { tags: c % 3 === 0 ? ['Cost Affect'] : ['SPEC'] } });
    if (c % 4 === 0) ops.push({ type: 'comment.status', commentId: cid, baseRev: 0, value: 'closed' });
  }
  await json('/api/pcf/' + project + '/' + id + '/ops', { baseRev: 1, batchId: randomUUID(), ops });
  if (d % 50 === 49) console.log('Seeded PCFs:', d + 1);
}
const measure = async (suffix = 'comments', headers = {}) => {
  const offset = profiles.length, started = performance.now();
  const response = await fetch(origin + '/api/projects/' + project + '/' + suffix, { headers });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { ms: +(performance.now() - started).toFixed(2), bytes: bytes.length, status: response.status, etag: response.headers.get('etag'), profiles: profiles.slice(offset), body: bytes };
};
const cold = await measure(); assert.equal(JSON.parse(cold.body).comments.length, 6000); assert.equal(cold.profiles[0].parsedFiles, 200);
const warm = await measure(); assert.equal(warm.profiles[0].parsedFiles, 0);
const revalidate = await measure('comments', { 'If-None-Match': warm.etag }); assert.equal(revalidate.status, 304);
const current = await json('/api/pcf/' + project + '/' + first.id + '/data');
const saved = await json('/api/pcf/' + project + '/' + first.id + '/ops', { baseRev: current.rev, batchId: randomUUID(), ops: [{ type: 'content.set', commentId: first.cid, roundId: first.rid, side: 'owner', baseRev: current.data.hub.entities['round:' + first.rid + ':owner'].rev, value: content('Single changed PCF marker for incremental cache validation') }] });
assert.equal(saved.applied.length, 1); assert.equal(saved.conflicts.length, 0);
const changed = await measure(); assert.equal(changed.profiles[0].parsedFiles, 1);
assert.ok(JSON.parse(changed.body).comments.some(row => row.ownerComment.includes('incremental cache')));
const excel = await measure('comments.xlsx'); assert.equal(excel.status, 200);
const clean = ({ body, etag, ...result }) => result;
console.log(JSON.stringify({ url: origin, project, projectName: name, dataDir: dir, cold: clean(cold), warm: clean(warm), revalidate: clean(revalidate), changed: clean(changed), excel: clean(excel), comments: 6000, drawings: 200 }));
process.on('SIGINT', async () => { await hub.close(); process.exit(0); });
