import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData, scriptJSON } from '../src/pcf-storage.ts';
import { blankContent, entity, type PcfData } from '../src/pcf-model.ts';

const sentinel = 'PCF_BODY_ONLY__7b9c4e_正文<&>_never_SQL';
const content = (text: string) => ({ ...blankContent(), text, html: '<b>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</b>' });
function browser(html: string, context?: object, fetchMock?: any) {
  const errors: Error[] = [], console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(html, { url: 'http://pahub.test/pcf/proj-test-001/dwg-001', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console, beforeParse(w) {
    (w as any).structuredClone = structuredClone; Object.defineProperty(w.crypto, "randomUUID", { value: randomUUID });
    (w as any).ResizeObserver = class { observe() {} disconnect() {} };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    if (context) (w as any).PAHUB = context;
    if (fetchMock) w.fetch = fetchMock;
  } });
  return { dom, w: dom.window, errors };
}

test('PCF hosted API: create, entity concurrency, numbering, PAPC summary, history, credentials and recovery', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-pcf-'));
  const oldEnv = Object.fromEntries(['PORT', 'PAPC_DB_PATH', 'PAHUB_DATA_DIR', 'API_TOKEN'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAPC_DB_PATH: path.join(temp, 'papc.db'), PAHUB_DATA_DIR: temp, API_TOKEN: '' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    hub = await createHub(); hub.db.exec(await readFile(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
    let base = 'http://127.0.0.1:' + hub.port;
    const endpoint = '/api/pcf/proj-test-001/dwg-005';
    const api = async (tail: string, method = 'GET', body?: any, headers?: Record<string, string>) => {
      const response = await fetch(base + endpoint + '/' + tail, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value: any = await response.json(); return { status: response.status, value };
    };
    assert.equal((await api('meta')).status, 404);
    const created = await api('create', 'POST'); assert.equal(created.status, 200);
    assert.equal(created.value.rev, 1); assert.equal(created.value.current_round, 2);
    assert.deepEqual((await api('create', 'POST')).value, created.value);
    let doc = (await api('data')).value;
    assert.equal(doc.data.project.name, 'PG-VLEC-H2684'); assert.equal(doc.data.project.planNo, 'DW-E-005');
    assert.equal(doc.data.project.planTitle, 'Valve Schedule'); assert.equal(doc.data.project.revision, 'B');
    assert.equal(doc.data.project.currentRound, 2); assert.notEqual(doc.data.documentId, parseHTML(await readFile(path.join(ROOT_DIR, 'pcf/template/PG-PCF-hub.html'), 'utf8')).documentId);
    const page = await fetch(base + '/pcf/proj-test-001/dwg-005').then(r => r.text());
    assert.match(page, /window\.PAHUB=/); assert.equal(parseHTML(page).documentId, doc.data.documentId);
    assert.equal((await fetch(base + '/pcf/proj-test-001/dwg-004')).status, 200); // auto-create
    console.log('create -> data: project/title/planNo/revision/round B↔2 OK; page PAHUB + parseable #pcf-data OK');
    const post = (clientId: string, baseRev: number, ops: any[]) => api('ops', 'POST', { clientId, clientName: clientId, baseRev, ops });
    let both = await Promise.all([post('A', doc.rev, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }]), post('B', doc.rev, [{ type: 'comment.add', id: 'c2', roundIdNew: 'r2' }])]);
    assert.deepEqual(both.map(x => x.value.assigned[x.value.assigned.c1 ? 'c1' : 'c2'].number).sort(), [1, 2]);
    doc = (await api('data')).value; const common = doc.rev;
    both = await Promise.all([post('A', common, [{ type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'owner', baseRev: 0, value: content(sentinel) }]), post('B', common, [{ type: 'content.set', commentId: 'c2', roundId: 'r2', side: 'owner', baseRev: 0, value: content('B independent') }])]);
    assert.ok(both.every(x => x.status === 200 && x.value.applied.length === 1 && !x.value.conflicts.length));
    doc = (await api('data')).value;
    const seen = entity(doc.data, 'round:r1:owner').rev;
    const [a, b] = await Promise.all([
      post('A', doc.rev, [{ type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'owner', baseRev: seen, value: content(sentinel + '_A') }]),
      post('B', doc.rev, [{ type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'owner', baseRev: seen, value: content('B must not overwrite') }, { type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'reply', baseRev: 0, value: content('Independent reply') }]),
    ]);
    const winner = a.value.applied.some((op: any) => op.side === 'owner') ? 'A' : 'B';
    const loser = winner === 'A' ? b : a, winningText = winner === 'A' ? sentinel + '_A' : 'B must not overwrite';
    assert.equal(a.value.conflicts.length + b.value.conflicts.length, 1);
    assert.equal(loser.value.conflicts[0].updatedBy.clientId, winner);
    assert.equal(loser.value.conflicts[0].server.text, winningText);
    assert.equal(b.value.applied.filter((op: any) => op.side === 'reply').length, 1);
    doc = (await api('data')).value; assert.equal(doc.data.comments.find((c: any) => c.id === 'c1').rounds[0].owner.text, winningText);
    console.log('concurrency: different owners 2/2 applied; same owner conflict=1 + reply applied=1; simultaneous add numbers=1,2');
    const rounds = await post('A', doc.rev, [{ type: 'round.add', commentId: 'c2', id: 'r3' }, { type: 'roundRegister.set', round: 3, baseRev: 0, value: { revision: 'C', ownerDate: '2026-11-07', ownerRef: 'PG-R3' } }, { type: 'comment.status', commentId: 'c1', baseRev: 0, value: 'closed' }]);
    assert.equal(rounds.value.conflicts.length, 0); doc = rounds.value;
    const project: any = await fetch(base + '/api/projects/proj-test-001', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: null }) }).then(r => r.json());
    // Worker envelope is kept intact.
    const drawing = (project.project || project.data?.project || project).drawings.find((d: any) => d.id === 'dwg-005');
    assert.equal(drawing.manualCommentsCount, 2); assert.equal(drawing.manualOpenCommentsCount, 1); assert.equal(drawing.currentRound, 'C'); assert.equal(drawing.version, 'C');
    const audit: any = hub.db.prepare("SELECT detail FROM audit_log WHERE row_id='dwg-005' AND action='COMMENTS' ORDER BY id DESC LIMIT 1").get(); assert.equal(JSON.parse(audit.detail).source, 'PCF');
    // Inspect every user table and raw database/WAL bytes, not only the index table.
    for (const table of hub.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const name = String(table.name); const rows = hub.db.prepare('SELECT * FROM "' + name + '"').all(); assert.ok(!JSON.stringify(rows).includes('PCF_BODY_ONLY__7b9c4e'), 'body leaked to ' + name);
    }
    for (const name of ['papc.db', 'papc.db-wal']) { const bytes = await readFile(path.join(temp, name)); assert.equal(bytes.includes(Buffer.from('PCF_BODY_ONLY__7b9c4e')), false); }
    console.log('PAPC POST readback: comments=2 open=1 round=C version=C; COMMENTS audit OK; all SQL tables + DB/WAL sentinel matches=0');
    // Protected replied-round deletion + closed-comment guards.
    let result = await post('A', doc.rev, [{ type: 'record.delete', commentId: 'c1', roundId: 'r1', baseRev: entity(doc.data, 'round:r1:record').rev }]); assert.equal(result.value.conflicts.length, 1);
    result = await post('A', doc.rev, [{ type: 'record.delete', commentId: 'c2', deleteId: 'trash-c2', baseRev: entity(doc.data, 'comment:c2:record').rev }]);
    assert.equal(result.value.data.comments.length, 1); assert.deepEqual(result.value.data.deleted, []); assert.ok(result.value.data.hub.tombstones.some((x: any) => x.id === 'c2'));
    result = await post('A', result.value.rev, [{ type: 'record.restore', deleteId: 'trash-c2', baseRev: result.value.rev }]); assert.equal(result.value.conflicts.length, 1); assert.equal(result.value.data.comments.length, 1);
    const history = (await api('history')).value; assert.ok(history.length >= 1); assert.equal(history.at(-1).rev, 1);
    const restored = await api('history/1/restore', 'POST', { clientId: 'A', baseRev: result.value.rev });
    assert.equal(restored.status, 200); assert.equal(restored.value.data.comments.length, 0); assert.ok(restored.value.rev > result.value.rev);
    assert.equal((await api('document', 'PUT', { clientId: 'A', baseRev: 1, data: restored.value.data })).status, 409);
    const replacement = await api('document', 'PUT', { clientId: 'A', baseRev: restored.value.rev, data: restored.value.data }); assert.equal(replacement.status, 200);
    const download = await fetch(base + endpoint + '/download').then(r => r.text()); assert.doesNotMatch(download, /id="pahub-context"/); assert.equal(parseHTML(download).hub, undefined);
    console.log('history list + restore -> new revision; tombstone delete/restore + document baseRev 409 + independent download OK');
    // Simulate crash after authoritative file rename but before SQLite commit; read repairs metadata + audit once.
    const file = path.join(temp, 'pcf/proj-test-001/dwg-005.json');
    const stored = await readFile(file, 'utf8'), crashData = JSON.parse(stored); crashData.hub.rev++;
    crashData.hub.lastChange = { clientId: 'recovery', clientName: '', ip: '127.0.0.1', ops: [{ type: 'document.replace' }] };
    await writeFile(file, JSON.stringify(crashData), 'utf8'); assert.equal((await api('meta')).value.rev, crashData.hub.rev);
    assert.equal(hub.db.prepare("SELECT count(*) AS n FROM pcf_changes WHERE client_id='recovery'").get()!.n, 1);
    await api('meta'); assert.equal(hub.db.prepare("SELECT count(*) AS n FROM pcf_changes WHERE client_id='recovery'").get()!.n, 1);
    await hub.close(); hub = undefined;
    process.env.API_TOKEN = 'pcf-test-secret'; hub = await createHub(); base = 'http://127.0.0.1:' + hub.port;
    assert.equal((await api('data')).status, 401);
    const challenge = await fetch(base + '/pcf/proj-test-001/dwg-005'); assert.equal(challenge.status, 401); assert.doesNotMatch(await challenge.text(), /window\.PAHUB=/);
    const session = await api('session', 'POST', undefined, { Authorization: 'Bearer pcf-test-secret' }); assert.equal(session.status, 200);
    const rawSession = await fetch(base + endpoint + '/session', { method: 'POST', headers: { Authorization: 'Bearer pcf-test-secret' } });
    const cookie = rawSession.headers.get('set-cookie')!.split(';')[0];
    const authorizedHTML = await fetch(base + '/pcf/proj-test-001/dwg-005', { headers: { Cookie: cookie } }).then(r => r.text());
    const context = JSON.parse(authorizedHTML.match(/window\.PAHUB=([^<]*)<\/script>/)![1]);
    assert.doesNotMatch(authorizedHTML, /pcf-test-secret/);
    assert.equal((await api('data', 'GET', undefined, { 'X-PCF-Token': context.credential })).status, 200);
    assert.equal((await fetch(base + '/api/pcf/proj-test-001/dwg-004/data', { headers: { 'X-PCF-Token': context.credential } })).status, 401);
    assert.equal((await fetch(base + '/api/pcf/proj-test-001/index', { headers: { Authorization: 'Bearer pcf-test-secret' } })).status, 200);
    console.log('credentials: unauthenticated API/page=401; scoped signed credential=200; other drawing=401; no global token in HTML; crash recovery idempotent OK');
    console.log('PCF test artifacts: ' + temp);
  } finally { await hub?.close(); for (const [k, v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('PCF HTML JSON locator escapes delimiters and accepts attribute order/whitespace', () => {
  const html = '<html><head></head><script type="application/json" data-other="yes" id = "pcf-data">{}</script></html>';
  const data = { text: '<script>&</script>' }; const updated = replaceData(html, data);
  assert.deepEqual(parseHTML(updated), data); assert.ok(updated.includes(scriptJSON(data))); assert.equal((updated.match(/<\/script>/g) || []).length, 1);
  assert.throws(() => parseHTML(updated + '<script id="pcf-data" type="application/json">{}</script>'));
});

test('jsdom PCF template: offline original controls/save and hosted add/edit/save/download/conflicts', async () => {
  const html = await readFile(path.join(ROOT_DIR, 'pcf/template/PG-PCF-hub.html'), 'utf8');
  const original = await readFile(path.join(ROOT_DIR, 'pcf/template/PG-PCF-v2.6-source.html'), 'utf8');
  assert.equal(parseHTML(html).documentId, parseHTML(original).documentId);
  const offline = browser(html);
  try {
    assert.deepEqual(offline.errors, []); assert.ok(offline.w.document.querySelector('#save-btn')); assert.equal(offline.w.document.querySelector('#save-as-btn')!.textContent, 'Save as');
    let written = '', picker = 0;
    (offline.w as any).showSaveFilePicker = async () => { picker++; return { name: 'offline.html', getFile: async () => ({ lastModified: 1, size: 0 }), queryPermission: async () => 'granted', createWritable: async () => ({ write: async (blob: any) => { written = await new Promise<string>(resolve => { const reader = new offline.w.FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); }); }, close: async () => {} }) }; };
    (offline.w as any).showOpenFilePicker = () => {};
    await new Promise(resolve => setTimeout(resolve, 0)); offline.w.document.querySelector<HTMLButtonElement>('#add-btn')!.click(); await offline.w.eval('saveNew()');
    assert.equal(picker, 1); assert.equal(parseHTML(written).comments.length, 1); assert.deepEqual(offline.errors, []);
    console.log('jsdom offline: no errors, original buttons + local file picker/write + parseable saved HTML OK');
  } finally { offline.dom.window.close(); }
  const initial: PcfData = parseHTML(html); initial.hub = { rev: 1, entities: {} };
  let payload: any, remote = structuredClone(initial), conflict = false;
  let pause = false, release: (() => void) | undefined, entered: (() => void) | undefined;
  const hosted = browser(replaceData(html, initial), { projectId: 'proj-test-001', drawingId: 'dwg-001', rev: 1, apiBase: '/api', credential: 'test-grant' }, async (_url: string, options: any) => {
    if (!options.method) return { ok: true, json: async () => ({ rev: remote.hub.rev, data: remote }) };
    payload = JSON.parse(options.body); assert.equal(options.headers['X-PCF-Token'], 'test-grant');
    // Use the real operation model even in the fetch mock.
    const { applyOps } = await import('../src/pcf-model.ts');
    const result = applyOps(remote, payload.ops, { clientId: payload.clientId, clientName: payload.clientName, ip: '127.0.0.1' }, remote.hub.rev + 1);
    if (result.applied.length) remote.hub.rev++;
    if (pause) { pause = false; await new Promise<void>(resolve => { release = resolve; entered?.(); }); }
    if (conflict) result.conflicts.push({ op: { type: 'content.set' }, entity: 'round:test:owner', commentNumber: 1, updatedBy: { clientName: 'B' } });
    return { ok: true, json: async () => ({ rev: remote.hub.rev, ...result, data: structuredClone(remote) }) };
  });
  try {
    assert.deepEqual(hosted.errors, []); assert.ok(hosted.w.localStorage.getItem('pahub.clientId'));
    hosted.w.document.querySelector<HTMLButtonElement>('#add-btn')!.click();
    const editor = hosted.w.document.querySelector<HTMLElement>('.editor')!; editor.innerHTML = '<b>hosted edit</b>'; editor.dispatchEvent(new hosted.w.Event('input', { bubbles: true }));
    await hosted.w.eval('writeFile()');
    assert.ok(payload.ops.some((op: any) => op.type === 'comment.add'));
    assert.ok(payload.ops.some((op: any) => op.type === 'content.set' && op.side === 'owner' && op.value.text === 'hosted edit' && op.baseRev === 0));
    assert.match(hosted.w.document.querySelector('#save-state')!.textContent!, /Saved to server · rev 2/);
    assert.equal(hosted.w.eval('state.comments[0].number'), 1); assert.equal(hosted.w.eval('state.comments[0].rounds[0].ownerRev'), 2);
    // Snapshot must remove session credentials + nickname UI and work offline after download.
    const copy = String(hosted.w.eval('snapshotHTML(state)')); assert.doesNotMatch(copy, /id="pahub-context"|id="pahub-name"/);
    const reopened = browser(copy); try { assert.deepEqual(reopened.errors, []); assert.equal(reopened.w.document.querySelector('#save-as-btn')!.textContent, 'Save as'); } finally { reopened.dom.window.close(); }
    // Project, settings, circulation, round metadata and deletion are included via touch/global dirtiness.
    hosted.w.eval("state.project.planTitle='Changed';state.settings.fontSize=17;state.roundRegister[0].ownerDate='2026-11-07';touch();");
    await hosted.w.eval('writeFile()');
    assert.ok(['project.set', 'settings.set', 'roundRegister.set'].every(type => payload.ops.some((op: any) => op.type === type)));
    // Explicit registration with unchanged dates is still a saved circulation event.
    const priorCirculation = remote.circulation.length;
    hosted.w.eval('panelUnlocked=true;recordCirculation();modalAction();'); await hosted.w.eval('writeFile()');
    assert.ok(payload.ops.some((op: any) => op.type === 'history.set' && op.field === 'circulation'));
    assert.equal(remote.circulation.length, priorCirculation + 1);
    // Input arriving while a save response is pending must not be discarded or marked saved.
    hosted.w.eval("state.comments[0].rounds[0].owner.text='first in flight';touch(state.comments[0]);");
    pause = true; const ready = new Promise<void>(resolve => entered = resolve);
    const saving = hosted.w.eval('writeFile()'); await ready;
    hosted.w.eval("state.comments[0].rounds[0].owner.text='typed during fetch';touch(state.comments[0]);"); release!(); await saving;
    assert.equal(hosted.w.eval('state.comments[0].rounds[0].owner.text'), 'typed during fetch'); assert.equal(hosted.w.eval('dirty()'), true);
    await hosted.w.eval('writeFile()'); assert.equal(remote.comments[0].rounds[0].owner.text, 'typed during fetch'); assert.equal(hosted.w.eval('dirty()'), false);
    hosted.w.eval('addRound(state.comments[0])'); await hosted.w.eval('writeFile()'); assert.ok(payload.ops.some((op: any) => ['round.add','rounds.addAll'].includes(op.type)));
    hosted.w.eval("state.comments[0].rounds[1].initiator='Owner name';touch(state.comments[0]);"); await hosted.w.eval('writeFile()'); assert.ok(payload.ops.some((op: any) => op.type === 'round.meta'));
    hosted.w.eval('deleteRecord(state.comments[0],state.comments[0].rounds[1]);modalAction();'); await hosted.w.eval('writeFile()'); assert.ok(payload.ops.some((op: any) => op.type === 'record.delete'));
    assert.deepEqual(remote.deleted, []); assert.equal(hosted.w.eval('typeof restore'), 'undefined'); assert.equal(remote.comments[0].rounds.length, 1); assert.ok(remote.hub.tombstones.length);
    hosted.w.eval("setCommentStatus(state.comments[0],'closed')"); await hosted.w.eval('writeFile()'); assert.equal(remote.comments[0].status, 'closed');
    hosted.w.eval("setCommentStatus(state.comments[0],'open')"); await hosted.w.eval('writeFile()');
    conflict = true; hosted.w.eval("state.comments[0].rounds[0].owner.text='conflicting';touch(state.comments[0]);"); await hosted.w.eval('writeFile()');
    assert.ok(hosted.w.document.querySelector('#hub-reload')); await hosted.w.eval('hubReload()'); assert.equal(hosted.w.eval('hubBlocked'), false);
    assert.deepEqual(hosted.errors, []);
    console.log('jsdom hosted: clientId; add/content + project/settings/register/round.meta + status/delete/restore ops; in-flight edits retained; offline copy; conflict reload OK');
  } finally { hosted.dom.window.close(); }
});
