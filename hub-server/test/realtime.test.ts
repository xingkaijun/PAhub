import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { createHub } from '../src/app.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData } from '../src/pcf-storage.ts';
import { applyOps, initData, blankContent, type PcfData } from '../src/pcf-model.ts';
import { PcfRealtime } from '../src/pcf-realtime.ts';

const actor = (id: string) => ({ clientId: id, clientName: id + '工', ip: '127.0.0.1' });
const value = (text: string) => ({ ...blankContent(), text, html: '<b>' + text + '</b>' });
const contentOp = (data: PcfData, side: string, text: string) => ({ type: 'content.set', commentId: 'c1', roundId: 'r1', side, baseRev: data.hub.entities['round:r1:' + side]?.rev || 0, value: value(text) });
async function sse(url: string, extra: Record<string, string> = {}) {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal, headers: extra }); assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function next(type: string) {
    const timeout = setTimeout(() => abort.abort(new Error('SSE event timeout: ' + type)), 4000);
    try {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) { const part = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (part.includes('event: ' + type + '\n')) return JSON.parse(part.split('\ndata: ')[1]); continue; }
        const chunk = await reader.read(); if (chunk.done) throw Error('SSE closed'); buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(timeout); }
  }
  return { next, close: () => abort.abort() };
}

test('two real SSE clients: changed clocks, presence release, reconnect and durable batch idempotency', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pahub-realtime-'));
  const old = Object.fromEntries(['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: temp, PAPC_DB_PATH: path.join(temp, 'papc.db'), API_TOKEN: 'rt-secret' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined, a: Awaited<ReturnType<typeof sse>> | undefined, b: Awaited<ReturnType<typeof sse>> | undefined;
  try {
    hub = await createHub(); hub.db.sqlite.exec(await readFile(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
    let base = 'http://127.0.0.1:' + hub.port; const route = '/api/pcf/proj-test-001/dwg-005';
    const api = async (tail: string, body?: any) => { const response = await fetch(base + route + '/' + tail, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer rt-secret', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); assert.equal(response.status, 200); return response.json(); };
    await api('create', {});
    const page = await fetch(base + '/pcf/proj-test-001/dwg-005', { headers: { Authorization: 'Bearer rt-secret' } }).then(r => r.text());
    const grant = JSON.parse(page.match(/window\.PAHUB=([^<]*)<\/script>/)![1]).credential;
    assert.equal((await fetch(base + route + '/events?clientId=bad')).status, 401);
    assert.equal((await fetch(base + '/api/pcf/proj-test-001/dwg-004/events?credential=' + grant)).status, 401);
    a = await sse(base + route + '/events?clientId=A&clientName=A工&rev=1&credential=' + grant);
    b = await sse(base + route + '/events?clientId=B&clientName=B工&rev=1&credential=' + grant);
    assert.equal((await a.next('hello')).rev, 1); assert.equal((await b.next('hello')).rev, 1);
    const batch = { batchId: randomUUID(), ...actor('A'), baseRev: 1, ops: [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }, contentOp({ hub: { entities: {} } }, 'owner', 'A body')] };
    const [first, parallel] = await Promise.all([api('ops', batch), api('ops', batch)]);assert.deepEqual(parallel, first);const event = await b.next('changed');
    assert.equal(event.rev, first.rev); assert.equal(event.clientId, 'A'); assert.ok(event.entities.some((x: any) => x.entity === 'round:r1:owner' && x.clock.rev === first.rev));
    assert.equal((await a.next('changed')).clientId, 'A');
    const duplicate = await api('ops', batch); assert.deepEqual(duplicate, first); assert.equal(duplicate.data.comments.length, 1);
    await api('presence', { ...actor('A'), entity: 'round:r1:owner' });
    let presence; do { presence = await b.next('presence'); } while (!presence.online.some((x: any) => x.clientId === 'A' && x.entity === 'round:r1:owner'));
    assert.equal(presence.online.find((x: any) => x.clientId === 'A').clientName, 'A工');
    a.close(); a = undefined;
    do { presence = await b.next('presence'); } while (presence.online.some((x: any) => x.clientId === 'A'));
    const project = await fetch(base + '/api/pcf/proj-test-001/presence', { headers: { Authorization: 'Bearer rt-secret' } }).then(r => r.json()); assert.equal(project.drawings['dwg-005'].length, 1);
    b.close(); b = undefined;
    const second = await api('ops', { batchId: randomUUID(), ...actor('A'), baseRev: first.rev, ops: [contentOp(first.data, 'owner', 'newer')] });
    b = await sse(base + route + '/events?clientId=B&credential=' + grant, { 'Last-Event-ID': String(first.rev) });
    const hello = await b.next('hello'); assert.equal(hello.rev, second.rev); assert.equal(hello.resync, true); assert.equal((await api('data')).data.comments[0].rounds[0].owner.text, 'newer');
    assert.deepEqual(await api('ops', batch), first); // exact old response after another revision
    const conflictBatch = { ...batch, batchId: randomUUID(), ops: [{ ...contentOp(first.data,'owner','BODY_NEVER_SQL'),baseRev:0 }] };
    const rejected = await api('ops', conflictBatch); assert.equal(rejected.conflicts.length,1);assert.deepEqual(await api('ops',conflictBatch),rejected);
    for (const table of hub.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) assert.ok(!JSON.stringify(hub.db.sqlite.prepare('SELECT * FROM "' + table.name + '"').all()).includes('BODY_NEVER_SQL'));
    console.log('Concurrent duplicate batch applies once; conflict-only receipt exact replay at unchanged rev; body sentinel absent from every SQLite table');
    b.close(); b = undefined; await hub.close(); hub = await createHub(); base = 'http://127.0.0.1:' + hub.port;
    assert.deepEqual(await api('ops', batch), first); assert.equal((await api('data')).data.comments.length, 1);
    const collision = await fetch(base + route + '/ops', { method: 'POST', headers: { Authorization: 'Bearer rt-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...batch, ops: [] }) }); assert.equal(collision.status, 409);
    console.log('SSE A->B: rev=2 round:r1:owner clock=2; scoped credential 401 cross-drawing; presence focus+disconnect; Last-Event-ID rev=3 resync=true; same batch exact reply before/after restart, comment count=1');
  } finally { a?.close(); b?.close(); await hub?.close(); for (const [k,v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('remote delete renumbers surviving comment without replacing its focused editor', async () => {
  const b=await setup();try{
    await b.w.eval('hubRecovery');applyOps(b.remote,[{type:'comment.add',id:'c2',roundIdNew:'r2'}],actor('B'),++b.remote.hub.rev);await b.w.eval('hubChanged({clientId:"B",rev:'+b.remote.hub.rev+'})');
    const focused=b.w.document.querySelector<HTMLElement>('.editor[data-cid="c2"][data-side="reply"]')!;focused.focus();
    applyOps(b.remote,[{type:'record.delete',commentId:'c1',deleteId:'deleted-first',baseRev:b.remote.hub.entities['comment:c1:record'].rev}],actor('B'),++b.remote.hub.rev);await b.w.eval('hubChanged({clientId:"B",rev:'+b.remote.hub.rev+'})');
    assert.equal(b.w.document.querySelectorAll('#comments .comment').length,1);assert.equal(b.w.document.querySelector('.comment')!.id,'comment-1');assert.equal(b.w.document.querySelector('.editor[data-cid="c2"][data-side="reply"]'),focused);assert.equal(b.w.document.activeElement,focused);assert.match(b.w.document.querySelector('#index-list')!.textContent!,/C-0001/);
    console.log('Remote delete #1: surviving UUID c2 renumbered #1; index C-0001; same focused reply DOM node');
  }finally{b.dom.window.close();}
});

test('SSE ping every 25 seconds and shutdown cancels streams', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const live = new PcfRealtime();
  try {
    const response=live.stream('p/d',actor('A'),1,1,new AbortController().signal),reader=response.body!.getReader();
    await reader.read(); await reader.read(); t.mock.timers.tick(24999);
    let received=false; const pending=reader.read().then(result=>{received=true;return result;});await Promise.resolve();assert.equal(received,false);
    t.mock.timers.tick(1);const result=await pending;assert.match(new TextDecoder().decode(result.value),/event: ping/);
    live.close();assert.equal((await reader.read()).done,true);console.log('SSE heartbeat: none at 24,999ms; ping at 25,000ms; shutdown closes stream');
  } finally { live.close(); }
});

test('restored dirty-only edits conflict normally; discard is document-scoped', async () => {
  const b=await setup();let reopened:ReturnType<typeof browser>|undefined;
  try {
    await b.w.eval('hubRecovery');type(b,'owner','dirty only before refresh');await b.w.eval('hubPersistChain');
    const ownDocument=b.remote.documentId;b.mutate('owner','server changed while closed');b.dom.window.close();
    reopened=browser(b.html,structuredClone(b.remote),b.database,b.fetchMock);await new Promise(resolve=>setTimeout(resolve,50));
    reopened.w.document.querySelector<HTMLButtonElement>('#hub-offline-retry')!.click();await reopened.w.eval('hubRecovery');await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(reopened.w.eval('hubBlocked'),true);assert.ok(reopened.w.document.querySelector('#hub-resolve'));assert.match(reopened.w.document.querySelector('.hub-conflict')!.textContent!,/server changed while closed/);
    await reopened.w.eval('hubReload()');await reopened.w.eval('hubPersistChain');
    type(reopened,'owner','discard me');await reopened.w.eval('hubPersistChain');reopened.dom.window.close();
    reopened=browser(b.html,structuredClone(b.remote),b.database,b.fetchMock);await new Promise(resolve=>setTimeout(resolve,50));reopened.w.document.querySelector<HTMLButtonElement>('#hub-offline-discard')!.click();await reopened.w.eval('hubRecovery');await reopened.w.eval('hubPersistChain');
    const record=await reopened.w.eval('hubDB().then(db=>new Promise(resolve=>{const r=db.transaction("documents").objectStore("documents").get(state.documentId);r.onsuccess=()=>resolve(r.result)}))');assert.equal(record,undefined);
    assert.equal(reopened.w.eval('state.documentId'),ownDocument);assert.equal(reopened.w.eval('hubBlocked'),false);assert.deepEqual(reopened.errors,[]);
    console.log('IndexedDB dirty-only refresh -> latest server conflict; explicit discard removes document record');
  } finally { b.dom.window.close();reopened?.dom.window.close(); }
});

test('presence TTL releases editing and online entries after 60s', () => {
  let time = 0; const live = new PcfRealtime(undefined, () => time); const events: any[] = [];
  const unsub = live.bus.subscribe('p/d', e => events.push(e));
  try { live.update('p/d', actor('A'), 'round:r1:owner'); time = 59999; assert.equal(live.list('p/d').length, 1); time = 60000; assert.equal(live.list('p/d').length, 0); assert.deepEqual(events.at(-1).data.online, []); console.log('presence TTL: 59,999ms retained; 60,000ms released'); } finally { unsub(); live.close(); }
});

class FakeEvents {
  listeners = new Map<string, (event: any) => void>(); static instances: FakeEvents[] = [];
  constructor(_url: string) { FakeEvents.instances.push(this); }
  addEventListener(type: string, callback: (event: any) => void) { this.listeners.set(type, callback); }
  emit(type: string, data: any) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  close() {}
}
function browser(html: string, initial: PcfData, database: IDBFactory, fetchMock: any) {
  const errors: Error[] = [], console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(replaceData(html, initial), { url: 'http://pahub.test/pcf/p/d', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console, beforeParse(w) {
    Object.assign(w, { structuredClone, indexedDB: database, EventSource: FakeEvents, fetch: fetchMock, PAHUB: { projectId: 'p', drawingId: 'd', rev: initial.hub.rev, apiBase: '/api' } });
    (w as any).ResizeObserver = class { observe() {} disconnect() {} }; w.HTMLElement.prototype.scrollIntoView = () => {};
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
    w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open',''); }; w.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
  } });
  return { dom, w: dom.window, errors };
}
async function setup(database = new IDBFactory(), supplied?: PcfData) {
  const html = await readFile(path.join(ROOT_DIR, 'pcf/template/PG-PCF-hub.html'), 'utf8');
  let remote = supplied || initData(parseHTML(html)); if (!supplied) { remote.comments = []; remote.hub = { rev: 1, entities: {} }; applyOps(remote, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }], actor('seed'), 1); }
  let fail = false; const batches = new Map<string, any>();
  const fetchMock = async (url: string, options?: any) => {
    if (String(url).includes('/presence')) return { ok: true, json: async () => ({ online: [] }) };
    if (String(url).endsWith('/data')) return { ok: true, json: async () => ({ rev: remote.hub.rev, data: structuredClone(remote) }) };
    if (fail) throw Error('offline');
    const body = JSON.parse(options.body); if (batches.has(body.batchId)) return { ok: true, json: async () => structuredClone(batches.get(body.batchId)) };
    const result = applyOps(remote, body.ops, actor(body.clientId), remote.hub.rev + 1); if (result.applied.length) remote.hub.rev++;
    const response = { rev: remote.hub.rev, ...result, data: structuredClone(remote) }; batches.set(body.batchId, response); return { ok: true, json: async () => structuredClone(response) };
  };
  const b = browser(html, structuredClone(remote), database, fetchMock);
  const mutate = (side: string, text: string) => { const result = applyOps(remote, [contentOp(remote, side, text)], actor('B'), remote.hub.rev + 1); assert.equal(result.conflicts.length, 0); remote.hub.rev++; };
  return { ...b, html, database, get remote() { return remote; }, fetchMock, mutate, offline: (value: boolean) => fail = value };
}
function type(b: any, side: string, text: string) { const ed = b.w.document.querySelector('.editor[data-side="' + side + '"]')! as HTMLElement; ed.innerHTML = '<b>' + text + '</b>'; ed.dispatchEvent(new b.w.Event('input', { bubbles: true })); return ed; }

test('hosted live updates preserve clean editor identity, dirty clocks, focus and self-event filtering; structural index', async () => {
  const b = await setup(); try {
    await b.w.eval('hubRecovery'); const owner = b.w.document.querySelector('.editor[data-side="owner"]')! as HTMLElement, reply = b.w.document.querySelector('.editor[data-side="reply"]'); owner.focus();
    b.mutate('owner','remote focused'); b.mutate('reply','remote reply'); await b.w.eval('hubChanged({clientId:"B",rev:' + b.remote.hub.rev + '})');
    assert.equal(b.w.document.querySelector('.editor[data-side="owner"]'), owner); assert.equal(b.w.document.activeElement, owner); assert.equal(owner.textContent, ''); assert.equal(b.w.document.querySelector('.editor[data-side="reply"]'), reply); assert.equal(reply!.textContent, 'remote reply');
    type(b,'owner','local dirty'); const baseClock = b.w.eval('hubClock(hubBase,"round:r1:owner")'); b.mutate('owner','other dirty update'); await b.w.eval('hubChanged({clientId:"B",rev:' + b.remote.hub.rev + '})'); assert.equal(owner.textContent,'local dirty'); assert.equal(b.w.eval('hubClock(hubBase,"round:r1:owner")'),baseClock); assert.ok(b.w.document.querySelector('.hub-remote-update'));
    const before = b.w.eval('hubRev'); assert.equal(await b.w.eval('hubChanged({clientId:hubClient,rev:999})'),false); assert.equal(b.w.eval('hubRev'),before);
    b.w.eval('hubOnline=[{clientId:hubClient,clientName:"self",entity:"round:r1:owner"},{clientId:"B",clientName:"B工",entity:"round:r1:owner"}];hubShowPresence()'); assert.match(b.w.document.querySelector('.hub-soft-lock')!.textContent!,/B工/); assert.doesNotMatch(b.w.document.querySelector('.hub-soft-lock')!.textContent!,/self/);
    applyOps(b.remote,[{type:'comment.add',id:'c2',roundIdNew:'r2'}],actor('B'),++b.remote.hub.rev); await b.w.eval('hubChanged({clientId:"B",rev:' + b.remote.hub.rev + '})'); assert.equal(b.w.document.querySelectorAll('#index-list .index-entry').length,2);
    applyOps(b.remote,[{type:'record.delete',commentId:'c2',deleteId:'del-c2',baseRev:b.remote.hub.entities['comment:c2:record'].rev}],actor('B'),++b.remote.hub.rev); await b.w.eval('hubChanged({clientId:"B",rev:' + b.remote.hub.rev + '})'); assert.equal(b.w.document.querySelectorAll('#index-list .index-entry').length,1);
    assert.deepEqual(b.errors,[]); console.log('jsdom changed: clean sibling patched in place, focused node unchanged, dirty value+clock retained, own event ignored, self presence hidden, add/delete index synchronized');
  } finally { b.dom.window.close(); }
});

test('conflict dialog resolves mine/server/manual paths and bulk selectors', async () => {
  const b = await setup(); try {
    await b.w.eval('hubRecovery');
    for (const choice of ['mine','server','merge']) {
      type(b,'owner','my '+choice); b.w.eval('state.comments[0].rounds[0].owner.images=[{id:"mine-image",name:"mine.png",mime:"image/png",data:"data:image/png;base64,AA==",width:1,height:1}]');
      b.mutate('owner','server '+choice); b.remote.comments[0].rounds[0].owner.images=[{id:'server-image',name:'server.png',mime:'image/png',data:'data:image/png;base64,AA==',width:1,height:1}]; await b.w.eval('hubSave()');
      assert.ok(b.w.document.querySelector('#hub-resolve')); assert.match(b.w.document.querySelector('.hub-conflict')!.textContent!,/B工/); assert.ok(b.w.document.querySelector('.hub-diff ins')); assert.ok(b.w.document.querySelector('.hub-preview b')); assert.match(b.w.document.querySelector('.hub-conflict')!.textContent!,/mine.png/); assert.match(b.w.document.querySelector('.hub-conflict')!.textContent!,/server.png/);
      if (choice==='mine') b.w.document.querySelector<HTMLButtonElement>('#hub-all-mine')!.click();
      if (choice==='server') b.w.document.querySelector<HTMLButtonElement>('#hub-all-server')!.click();
      if (choice==='merge') { const select=b.w.document.querySelector<HTMLSelectElement>('.hub-choice')!; select.value='merge'; select.dispatchEvent(new b.w.Event('change')); b.w.document.querySelector('.hub-merge-editor')!.innerHTML='<i>merged final</i>'; b.w.document.querySelector<HTMLSelectElement>('.hub-images')!.value='server'; }
      await b.w.eval('hubResolve()'); assert.equal(b.w.eval('hubBlocked'),false); assert.equal(b.remote.comments[0].rounds[0].owner.text,choice==='mine'?'my mine':choice==='server'?'server server':'merged final'); assert.equal(b.remote.comments[0].rounds[0].owner.images[0].name,choice==='mine'?'mine.png':'server.png');
    }
    assert.deepEqual(b.errors,[]); console.log('jsdom conflicts: rich previews + text diff + image filenames; all-mine -> server clock retry; all-server -> discard; manual merge -> merged final saved');
  } finally { b.dom.window.close(); }
});

test('IndexedDB dirty entities + unconfirmed UUID batch survive refresh and restore; discard and beforeunload', async () => {
  const b = await setup(); let reopened: ReturnType<typeof browser> | undefined;
  try {
    await b.w.eval('hubRecovery'); b.offline(true); type(b,'owner','offline retained'); await b.w.eval('hubSave()'); await b.w.eval('hubPersistChain');
    const record: any = await b.w.eval('hubDB().then(db=>new Promise(resolve=>{const r=db.transaction("documents").objectStore("documents").get(state.documentId);r.onsuccess=()=>resolve(r.result)}))'); assert.equal(record.queue.length,1); assert.ok(record.queue[0].body.batchId); assert.equal(record.local.comments[0].rounds[0].owner.text,'offline retained');
    const closing=new b.w.Event('beforeunload',{cancelable:true}); b.w.dispatchEvent(closing); assert.equal(closing.defaultPrevented,true);
    b.dom.window.close(); b.offline(false); reopened=browser(b.html,structuredClone(b.remote),b.database,b.fetchMock);
    // Wait for IndexedDB open+read, not hubRecovery (it waits for a human decision).
    await new Promise(resolve=>setTimeout(resolve,50)); assert.match(reopened.w.document.querySelector('#modal-body')!.textContent!,/Resubmission/); assert.ok(reopened.w.document.querySelector('#hub-offline-retry'));
    reopened.w.document.querySelector<HTMLButtonElement>('#hub-offline-retry')!.click(); await reopened.w.eval('hubRecovery'); await new Promise(resolve=>setTimeout(resolve,50)); await reopened.w.eval('hubPersistChain');
    assert.equal(b.remote.comments[0].rounds[0].owner.text,'offline retained'); assert.equal(reopened.w.eval('hubQueue.length'),0); assert.deepEqual(reopened.errors,[]);
    console.log('IndexedDB: unconfirmed UUID batch + base clocks + dirty local persisted; refreshed page recovery prompt; original batch replay saved once; beforeunload prevented');
  } finally { b.dom.window.close(); reopened?.dom.window.close(); }
});
