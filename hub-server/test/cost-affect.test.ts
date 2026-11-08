import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { JSDOM, VirtualConsole } from 'jsdom';
import { openDatabase } from '../src/database.ts';
import { ROOT_DIR } from '../src/config.ts';
import { PcfStorage, parseHTML, replaceData } from '../src/pcf-storage.ts';
import { PcfExchange, externalData, standaloneHTML } from '../src/pcf-exchange.ts';
import { PcfBuilderReplies } from '../src/pcf-builder-replies.ts';
import { PcfRealtime } from '../src/pcf-realtime.ts';

function browser(html: string) {
  const errors: any[] = [], vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(html, { url: 'http://cost.test/pcf', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
    (w as any).structuredClone = structuredClone; (w as any).Blob = Blob;
    Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
    (w as any).ResizeObserver = class { observe() {} disconnect() {} };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
    w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
    w.HTMLDialogElement.prototype.close = function() { this.open = false; };
  } });
  return { dom, w: dom.window, errors };
}
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-cost-tag-')), db = openDatabase(path.join(dir, 'papc.db'));
  db.sqlite.exec(readFileSync(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
  const storage = new PcfStorage(db.sqlite, dir), actor = { clientId: 'cost-test', clientName: 'Owner', ip: '127.0.0.1' };
  const p = 'proj-test-001', d = 'dwg-005', cid = randomUUID(), rid = randomUUID();
  storage.create(p, d, actor);
  storage.ops(p, d, { baseRev: 1, ops: [{ type: 'comment.add', id: cid, roundIdNew: rid }, { type: 'comment.add', id: randomUUID(), roundIdNew: randomUUID() }] }, actor);
  const setTags = (tags: string[]) => { const current = storage.load(p, d); return storage.ops(p, d, { baseRev: current.rev, ops: [{ type: 'comment.meta', commentId: cid, baseRev: current.data.hub.entities['comment:' + cid + ':meta']?.rev || 0, value: { tags } }] }, actor); };
  return { dir, db, storage, actor, p, d, cid, rid, setTags };
}
function zipText(bytes: Buffer) {
  let offset = 0, text = '';
  while (offset + 30 < bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), start = offset + 30 + nameLength + extra;
    const body = bytes.subarray(start, start + size);
    if (name.endsWith('.xml')) text += (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    offset = start + size;
  }
  return text;
}

test('Cost Affect UI add/remove, server persistence, filter, JSON, Builder, Excel and print Excel', async () => {
  const f = fixture(), b = browser(standaloneHTML(externalData(f.storage.load(f.p, f.d).data)));
  let reopened: ReturnType<typeof browser> | undefined, builder: ReturnType<typeof browser> | undefined;
  try {
    const selector = '.comment[data-cid="' + f.cid + '"] [data-tag="Cost Affect"]';
    b.w.document.querySelector<HTMLButtonElement>(selector)!.click();
    assert.equal(b.w.document.querySelector(selector)!.getAttribute('aria-pressed'), 'true');
    b.w.document.querySelector<HTMLButtonElement>(selector)!.click(); assert.equal(b.w.eval('state.comments[0].tags.length'), 0);
    b.w.document.querySelector<HTMLButtonElement>(selector)!.click();
    f.setTags(['Cost Affect']); assert.deepEqual(f.storage.load(f.p, f.d).data.comments[0].tags, ['Cost Affect']);
    f.setTags([]); assert.deepEqual(f.storage.load(f.p, f.d).data.comments[0].tags, []); f.setTags(['Cost Affect']);
    const data = externalData(f.storage.load(f.p, f.d).data), json = JSON.parse(JSON.stringify(data));
    assert.deepEqual(json.comments[0].tags, ['Cost Affect']); assert.equal(json.schemaVersion, '1.0');
    reopened = browser(standaloneHTML(json));
    assert.equal(reopened.w.document.querySelector(selector)!.getAttribute('aria-pressed'), 'true');
    const filter = reopened.w.document.querySelector<HTMLSelectElement>('#tag-filter')!;
    filter.value = 'Cost Affect'; filter.dispatchEvent(new reopened.w.Event('change', { bubbles: true }));
    assert.equal(reopened.w.document.querySelectorAll('#comments .comment').length, 1);
    for (const theme of ['light', 'dark']) {
      reopened.w.document.documentElement.dataset.theme = theme;
      assert.ok(reopened.w.document.querySelector(selector)!.classList.contains('active'));
    }
    const workbook: any = await reopened.w.eval('PCFExport.build(structuredClone(state))');
    assert.match(zipText(Buffer.from(await workbook.blob.arrayBuffer())), /Cost Affect/);
    const print: any = await reopened.w.eval('PCFPrint.build(structuredClone(state))');
    assert.match(zipText(Buffer.from(await print.blob.arrayBuffer())), /Properties: Cost Affect/);
    const exchange = new PcfExchange(f.storage), record = exchange.create(f.p, f.d, f.actor);
    const exported = exchange.download(f.p, f.d, record.exportId).html;
    assert.deepEqual(parseHTML(exported).comments[0].tags, ['Cost Affect']);
    builder = browser(exported);
    const badge = builder.w.document.querySelector<HTMLButtonElement>(selector)!;
    assert.equal(badge.textContent, 'Cost Affect'); assert.equal(badge.disabled, true); assert.ok(badge.classList.contains('active'));
    for (const current of [b, reopened, builder]) assert.deepEqual(current.errors, []);
  } finally { b.dom.window.close(); reopened?.dom.window.close(); builder?.dom.window.close(); f.db.sqlite.close(); }
});
test('batch import summary preserves authoritative Cost Affect even when returned tags are tampered', async () => {
  const f = fixture(), realtime = new PcfRealtime(); try {
    f.setTags(['Cost Affect']);
    const exchange = new PcfExchange(f.storage), record = exchange.create(f.p, f.d, f.actor), html = exchange.download(f.p, f.d, record.exportId).html;
    const data = parseHTML(html); data.comments[0].tags = ['FAKE'];
    data.comments[0].rounds[0].reply.text = 'Builder reply'; data.comments[0].rounds[0].reply.html = 'Builder reply';
    const form = new FormData(); form.append('files', new Blob([replaceData(html, data)]), 'reply.html');
    const replies = new PcfBuilderReplies(f.storage, exchange, realtime);
    const preview = await replies.preview(f.p, form);
    assert.deepEqual(preview.files[0].tags, ['Cost Affect']); assert.equal(preview.files[0].ownerTampered, true);
  } finally { realtime.close(); f.db.sqlite.close(); }
});
