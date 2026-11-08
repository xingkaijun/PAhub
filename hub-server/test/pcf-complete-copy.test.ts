import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML } from '../src/pcf-storage.ts';
import { blankContent } from '../src/pcf-model.ts';
import { completeData, mergeComplete } from '../src/pcf-complete-merge.ts';

const content = (text: string) => ({ ...blankContent(), text, html: '<b>' + text + '</b>' });
function documentFixture(): any {
  return {
    schemaVersion: '1.0', documentId: randomUUID(), updatedAt: '2026-11-01T00:00:00.000Z',
    project: { name: 'PG-TEST', planTitle: 'Offline copy', planNo: 'DW-001', revision: 'B', folder: '', approval: 'Under review', currentRound: 2 },
    comments: [{
      id: 'c1', number: 1, page: '1', tags: ['pipe'], status: 'open', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
      rev: 7, statusRev: 5, metaRev: 4,
      rounds: [{ id: 'r1', number: 2, initiator: 'Owner A', responder: 'Builder B', minHeight: 120, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', rev: 9, ownerRev: 3, replyRev: 8, owner: content('Owner text'), reply: content('Builder text') }],
    }],
    deleted: [{ id: 'legacy-c', type: 'comment', parentNumber: 9, deletedAt: '2026-09-01T00:00:00.000Z', rev: 2, data: { id: 'legacy-c', number: 9, page: '', tags: [], status: 'open', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', rounds: [] } }],
    circulation: [{ id: 'circ-1', kind: 'round-registration', round: 2, revision: 'B', ownerDate: '2026-10-01', replyDate: '', date: '2026-10-01', approval: 'Under review', note: 'Registered', updatedAt: '2026-10-03T00:00:00.000Z', rev: 6 }],
    settings: { fontSize: 15, autoSaveSeconds: 60 },
    nextCommentNumber: 2,
    roundRegister: [{ id: 'round-register-2', round: 2, revision: 'B', ownerRef: 'REF-1', ownerDate: '2026-10-01', replyRef: '', replyDate: '', updatedAt: '2026-10-03T00:00:00.000Z', rev: 4 }],
    approvalHistory: [{ id: 'approval-1', at: '2026-10-04T00:00:00.000Z', round: 2, from: 'Not submitted', to: 'Under review', source: 'auto', reason: 'Open comments added', rev: 11 }],
    approvalControl: { lastOpen: 1, source: 'auto', reason: 'Open comments added' },
    hub: { rev: 12, entities: { 'round:r1:owner': { rev: 3, clientId: 'someone', clientName: 'Owner', at: '2026-10-02T00:00:00.000Z' } }, tombstones: [], receipts: [{ id: 'receipt' }], lastChange: { clientId: 'someone', ip: '10.0.0.1' } },
  };
}

test('complete copies strip Hub clocks/receipts/client IDs/IPs but keep business histories', () => {
  const source = documentFixture();
  const copy = completeData(source);
  assert.equal(copy.hub, undefined);
  assert.equal(copy.export, undefined);
  for (const key of ['rev', 'statusRev', 'metaRev', 'ownerRev', 'replyRev']) {
    assert.equal(copy.comments[0][key], undefined, key);
    assert.equal(copy.comments[0].rounds[0][key], undefined, key);
  }
  assert.equal(copy.circulation[0].rev, undefined);
  assert.equal(copy.approvalHistory[0].rev, undefined);
  assert.equal(copy.roundRegister[0].rev, undefined);
  // Business data, including timestamps, is preserved exactly.
  assert.equal(copy.circulation[0].updatedAt, '2026-10-03T00:00:00.000Z');
  assert.equal(copy.roundRegister[0].updatedAt, '2026-10-03T00:00:00.000Z');
  assert.equal(copy.comments[0].updatedAt, '2026-10-02T00:00:00.000Z');
  assert.equal(copy.comments[0].rounds[0].owner.text, 'Owner text');
  assert.equal(copy.deleted[0].rev, undefined);
  assert.equal(copy.deleted[0].data.id, 'legacy-c');
  assert.equal(copy.deleted[0].deletedAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(copy.approvalHistory.map((x: any) => x.id), ['approval-1']);
  assert.deepEqual(copy.circulation.map((x: any) => x.id), ['circ-1']);
  assert.equal(copy.project.folder, '');
  assert.doesNotMatch(JSON.stringify(copy), /clientId|clientName|"ip"|receipts|ownerHmac/);
});

test('complete merge keeps server additions, merges disjoint fields and reports explicit conflicts', () => {
  const base = documentFixture();
  const local = structuredClone(base), server = structuredClone(base);
  // Local offline edits: own reply, a new local comment and a new round on c1.
  local.comments[0].rounds[0].reply = content('Offline reply');
  local.comments.push({ id: 'c-local', number: 2, page: '', tags: [], status: 'open', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', rounds: [{ id: 'r-local', number: 2, initiator: '', responder: '', minHeight: 0, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', owner: content('Local comment'), reply: blankContent() }] });
  // Server changes: different field on the same round, a server comment, and a server-side edit elsewhere.
  server.comments[0].rounds[0].owner = content('Server owner edit');
  server.comments.push({ id: 'c-server', number: 2, page: '', tags: [], status: 'open', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', rounds: [] });
  server.circulation.push({ id: 'circ-server', kind: 'round-registration', round: 3, revision: 'C', date: '2026-11-06', approval: 'Under review', note: 'Server round' });
  const preview = mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(server) });
  assert.equal(preview.conflicts.length, 0);
  const merged = preview.data;
  assert.equal(merged.comments.find((c: any) => c.id === 'c1').rounds[0].reply.text, 'Offline reply');
  assert.equal(merged.comments.find((c: any) => c.id === 'c1').rounds[0].owner.text, 'Server owner edit');
  assert.deepEqual(merged.comments.map((c: any) => c.id).sort(), ['c-local', 'c-server', 'c1']);
  assert.ok(merged.circulation.some((x: any) => x.id === 'circ-server'));
  assert.ok(merged.circulation.some((x: any) => x.id === 'circ-1'));
  assert.equal(merged.nextCommentNumber, 3);

  // Same reply changed on both sides: explicit conflict, no silent overwrite.
  const conflicting = structuredClone(server);
  conflicting.comments[0].rounds[0].reply = content('Server competing reply');
  const conflicted = mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(conflicting) });
  const conflict = conflicted.conflicts.find((x: any) => x.path === 'comments/c1/rounds/r1/reply');
  assert.ok(conflict);
  assert.equal(conflict.allowed.join(','), 'local,server,merge');
  const chosen = mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(conflicting), choices: { [conflict.id]: { choice: 'local' } } });
  assert.equal(chosen.conflicts[0].id, conflict.id);
  assert.equal(chosen.data.comments[0].rounds[0].reply.text, 'Offline reply');
  const manual = mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(conflicting), choices: { [conflict.id]: { choice: 'merge', value: content('Merged reply') } } });
  assert.equal(manual.data.comments[0].rounds[0].reply.text, 'Merged reply');
  assert.throws(() => mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(conflicting), choices: {} }), /decision/i);

  // Server deletions are final and cannot be restored from the returning copy.
  const deleted = structuredClone(server);
  deleted.comments = deleted.comments.filter((c: any) => c.id !== 'c1');
  const deletion = mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(deleted) });
  const deletedConflict = deletion.conflicts.find((x: any) => x.commentId === 'c1' || x.roundId === 'r1');
  assert.ok(deletedConflict);
  assert.deepEqual(deletedConflict.allowed, ['server']);
  assert.throws(() => mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(deleted), choices: { [deletedConflict.id]: { choice: 'local' } } }), /decision/i);
  const kept = mergeComplete({ base: completeData(base), local: completeData(local), server: completeData(deleted), choices: { [deletedConflict.id]: { choice: 'server' } } });
  assert.ok(!kept.data.comments.some((c: any) => c.id === 'c1'));
});

function offline(html: string) {
  const errors: any[] = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', (e: any) => errors.push(e));
  const dom = new JSDOM(html, { url: 'file:///PCF.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, beforeParse(w) {
    (w as any).structuredClone = structuredClone; (w as any).Blob = Blob;
    (w as any).ResizeObserver = class { observe() {} disconnect() {} };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(value) { this.textContent = value; } });
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  } });
  return { dom, w: dom.window, errors };
}

test('complete copy export/import merges through the API, preserves circulation/approval/deleted and rejects replacement', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-complete-'));
  const old = Object.fromEntries(['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'ADMIN_PASSWORD'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: '', ADMIN_PASSWORD: '' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    hub = await createHub(); hub.db.exec(await readFile(path.join(ROOT_DIR, 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
    const endpoint = '/api/pcf/proj-test-001/dwg-005';
    const api = async (tail: string, method = 'GET', body?: any) => {
      const response = await fetch('http://127.0.0.1:' + hub!.port + endpoint + '/' + tail, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let value: any; try { value = JSON.parse(text); } catch { value = text; }
      return { status: response.status, value, headers: response.headers };
    };
    const externalEndpoint = '/api/pcf/proj-test-001/dwg-005';
    const apiText = async (tail: string, method = 'GET') => {
      const response = await fetch('http://127.0.0.1:' + hub!.port + externalEndpoint + '/' + tail, { method });
      return { status: response.status, text: await response.text(), headers: response.headers };
    };
    // Use the PCF API without a token for simplicity; create and seed business history.
    const created = await apiText('create', 'POST');
    assert.equal(created.status, 200);
    const data = JSON.parse((await apiText('data')).text);
    let live = data;
    const ops = async (operations: any[]) => {
      const result = await api('ops', 'POST', { clientId: 'owner', clientName: 'Owner', baseRev: live.rev, ops: operations });
      assert.equal(result.status, 200); assert.deepEqual(result.value.conflicts, []); live = result.value; return live;
    };
    await ops([
      { type: 'comment.add', id: 'c1', roundIdNew: 'r1' },
      { type: 'comment.add', id: 'c2', roundIdNew: 'r2' },
    ]);
    await ops([
      { type: 'content.set', commentId: 'c1', roundId: 'r1', side: 'owner', baseRev: 0, value: content('OWNER_ONE') },
      { type: 'content.set', commentId: 'c2', roundId: 'r2', side: 'owner', baseRev: 0, value: content('OWNER_TWO') },
      { type: 'history.set', field: 'circulation', baseRev: 0, value: [{ id: 'circ-seed', kind: 'round-registration', round: 2, revision: 'B', ownerDate: '2026-11-01', date: '2026-11-01', approval: 'Under review', note: 'Seed' }] },
    ]);
    // Closing every comment records an automatic approval history entry.
    await ops([
      { type: 'comment.status', commentId: 'c1', baseRev: live.data.hub.entities['comment:c1:status']?.rev ?? 0, value: 'closed' },
      { type: 'comment.status', commentId: 'c2', baseRev: live.data.hub.entities['comment:c2:status']?.rev ?? 0, value: 'closed' },
    ]);
    assert.ok(live.data.approvalHistory.length > 0, 'approval history exists');
    assert.ok(live.data.circulation.length > 0, 'circulation exists');
    // Reopen c2 so it can be compared after return.
    await ops([{ type: 'comment.status', commentId: 'c2', baseRev: live.data.hub.entities['comment:c2:status'].rev, value: 'open' }]);

    const exportResponse = await api('exports', 'POST', { mode: 'complete' });
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.value.mode, 'complete');
    assert.equal(exportResponse.value.baseRev, live.rev);
    const download = await apiText('exports/' + exportResponse.value.exportId + '/download');
    assert.equal(download.status, 200);
    const completeHTML = download.text;
    const exported = parseHTML(completeHTML);
    assert.equal(exported.export.mode, 'complete');
    assert.equal(exported.hub, undefined);
    assert.ok(exported.circulation.some((x: any) => x.id === 'circ-seed'));
    assert.ok(exported.approvalHistory.length > 0);
    assert.doesNotMatch(completeHTML, /clientId|clientName|pahub-context|"[^"]*ip"[^"]*:/);
    const exportedText = completeHTML;
    // Offline complete edition opens and keeps its history; builder mode must not apply.
    const browser = offline(completeHTML);
    try {
      assert.deepEqual(browser.errors, []);
      assert.equal(browser.w.document.querySelector('#builder-notice'), null);
      assert.equal(browser.w.eval('state.export.mode'), 'complete');
      assert.equal((browser.w.eval('state.approvalHistory.length') as number) > 0, true);
    } finally { browser.dom.window.close(); }

    // JSON complete copy too.
    const jsonDownload = await apiText('exports/' + exportResponse.value.exportId + '/download?format=json');
    assert.equal(jsonDownload.status, 200);
    const exportedJSON = JSON.parse(jsonDownload.text);
    assert.equal(exportedJSON.export.mode, 'complete');
    assert.equal(exportedJSON.hub, undefined);
    assert.ok(exportedJSON.approvalHistory.length > 0);
    assert.ok(exportedJSON.circulation.some((x: any) => x.id === 'circ-seed'));

    // Local offline edits: owner on c1, plus a new local comment; server edits c2 and adds a comment.
    const localData = parseHTML(completeHTML);
    localData.comments.find((c: any) => c.id === 'c1').rounds[0].owner = content('OFFLINE_OWNER');
    localData.comments.push({ id: 'c-local', number: 3, page: '', tags: [], status: 'open', createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z', rounds: [{ id: 'r-local', number: 2, initiator: '', responder: '', minHeight: 0, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z', owner: content('LOCAL_ADD'), reply: blankContent() }] });
    localData.nextCommentNumber = 4;
    const localJSON = structuredClone(localData);
    await ops([
      { type: 'content.set', commentId: 'c2', roundId: 'r2', side: 'owner', baseRev: live.data.hub.entities['round:r2:owner'].rev, value: content('SERVER_TWO') },
      { type: 'comment.add', id: 'c-server', roundIdNew: 'r-server' },
    ]);
    // A server-side deletion after export must not be resurrected.
    await ops([{ type: 'comment.status', commentId: 'c1', baseRev: live.data.hub.entities['comment:c1:status'].rev, value: 'open' }]);
    await ops([{ type: 'record.delete', commentId: 'c1', deleteId: 't1', baseRev: live.data.hub.entities['comment:c1:record'].rev }]);
    assert.ok(live.data.hub.tombstones.some((t: any) => t.id === 'c1'));

    // The local copy still contains c1; the merged document keeps it deleted.
    const preview = await api('imports', 'POST', { step: 'preview', html: completeHTML });
    assert.equal(preview.status, 200);
    assert.equal(preview.value.mode, 'complete');
    assert.equal(preview.value.ownerTampered, false);
    assert.equal(preview.value.resolution, undefined);
    const returned = parseHTML(completeHTML);
    returned.comments = returned.comments.filter((c: any) => c.id !== 'c1');
    const localWithDelete = structuredClone(returned);
    localWithDelete.comments.find((c: any) => c.id === 'c2')!.rounds[0].owner = content('OFFLINE_TWO');
    localWithDelete.comments.push(localData.comments.find((c: any) => c.id === 'c-local'));
    localWithDelete.nextCommentNumber = 4;
    localWithDelete.approvalControl.lastOpen = localWithDelete.comments.filter((c: any) => c.status === 'open').length;
    const preview2 = await api('imports', 'POST', { step: 'preview', json: localWithDelete });
    assert.equal(preview2.status, 200);
    assert.equal(preview2.value.mode, 'complete');
    const decisions = Object.fromEntries(preview2.value.conflicts.map((x: any) => [x.id, { choice: x.commentId === 'c1' || x.roundId === 'r1' || x.allowed.join() === 'server' ? 'server' : 'local' }]));
    const applyBody = { step: 'apply', json: localWithDelete, previewToken: preview2.value.previewToken, batchId: randomUUID(), choices: decisions };
    const applied = await api('imports', 'POST', applyBody);
    assert.equal(applied.status, 200, JSON.stringify(applied.value));
    assert.equal(applied.value.applied[0].type, 'document.merge');
    const merged = (await api('data')).value;
    assert.ok(!merged.data.comments.some((c: any) => c.id === 'c1'), 'server tombstone respected');
    assert.equal(merged.data.comments.find((c: any) => c.id === 'c2').rounds[0].owner.text, 'OFFLINE_TWO');
    assert.ok(merged.data.comments.some((c: any) => c.id === 'c-local'), 'local addition kept');
    assert.ok(merged.data.comments.some((c: any) => c.id === 'c-server'), 'server addition kept');
    assert.ok(merged.data.circulation.some((x: any) => x.id === 'circ-seed'), 'circulation preserved');
    assert.ok(merged.data.approvalHistory.length > 0, 'approval history preserved');
    assert.equal(merged.data.hub.rev, merged.rev);
    assert.equal(merged.data.export, undefined);
    // Exact batch replay and status update.
    const replay = await api('imports', 'POST', applyBody);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.value, applied.value);
    // Replacement through PUT must reject exported copies.
    const replacement = await api('document', 'PUT', { clientId: 'owner', baseRev: merged.rev, data: parseHTML(completeHTML), importJSON: true });
    assert.equal(replacement.status, 409);
    // A serialized JSON copy merges as well, and unknown export IDs are rejected.
    const applyPlain = { step: 'preview', json: exportedJSON };
    const plainPreview = await api('imports', 'POST', applyPlain);
    assert.equal(plainPreview.status, 200);
    const forged = structuredClone(exportedJSON); forged.export.exportId = randomUUID();
    assert.equal((await api('imports', 'POST', { step: 'preview', json: forged })).status, 409);
    console.log('Complete copy: internals stripped; histories/legacy data preserved; merge keeps both additions and server tombstones; replay identical; PUT replacement rejected');
    console.log('Complete test data: ' + temp);
  } finally {
    await hub?.close();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
