import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData } from '../src/pcf-html.ts';
import { completeData } from '../src/pcf-complete-merge.ts';
import { standaloneHTML } from '../src/pcf-exchange.ts';

const template = readFileSync(path.join(ROOT_DIR, 'pcf/template/PG-PCF-hub.html'), 'utf8');
function browser(html: string, context?: any) {
  const errors: string[] = [], console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'http://pahub.test/pcf/p/d', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console, beforeParse(w) {
    (w as any).structuredClone = structuredClone; Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
    (w as any).ResizeObserver = class { observe() {} disconnect() {} }; w.HTMLElement.prototype.scrollIntoView = () => {};
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    if (context) (w as any).PAHUB = context;
    (w as any).fetch = async () => ({ ok: true, json: async () => ({ online: [] }) });
  } });
  return { dom, w: dom.window, errors };
}
function data() {
  const value = parseHTML(template); value.hub = { rev: 1, entities: {} };
  value.circulation = [{ id: 'kept-circ', round: 1, kind: 'sent', date: '2026-11-08' }];
  value.approvalHistory = [{ id: 'kept-approval', at: '2026-11-08', from: 'Not submitted', to: 'Under review', source: 'manual', reason: 'kept' }];
  return value;
}

test('standalone complete copy keeps history, exposes working external edition and removes hosted adapter', async () => {
  const value = completeData(data()); value.export = { mode: 'complete', exportId: randomUUID(), documentId: value.documentId, baseRev: 1, round: 1, exportedAt: '2026-11-08' };
  const html = standaloneHTML(value); assert.doesNotMatch(html, /PAhub adapter:|X-PCF-Token|pahub-context|clientId/);
  const b = browser(html);
  try {
    await new Promise(r => setTimeout(r, 10)); assert.deepEqual(b.errors, []);
    assert.ok(b.w.document.querySelector('#complete-copy-notice'));
    b.w.eval('window.exports=[];download=(blob,name)=>window.exports.push({blob,name});fileOptions()');
    b.w.document.querySelector<HTMLButtonElement>('[data-action="export-external-json"]')!.click();
    assert.equal(b.w.eval('exports.length'), 1);
    const blob = (b.w as any).exports[0].blob;
    const text = await new Promise<string>(resolve => { const r = new b.w.FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blob); });
    const external = JSON.parse(text); assert.deepEqual(external.circulation, []); assert.deepEqual(external.approvalHistory, []); assert.equal(external.export, undefined);
    assert.equal(b.w.eval('state.circulation.length'), 1, 'external export does not alter complete document');
  } finally { b.dom.window.close(); }
});

test('hosted complete preview guards newer local edits and sends scalar manual merge values as strings', async () => {
  const value = data(), b = browser(replaceData(template, value), { projectId: 'p', drawingId: 'd', rev: 1, apiBase: '/api' });
  try {
    await new Promise(r => setTimeout(r, 10));
    (b.w as any).preview = { exportId: randomUUID(), baseRev: 1, serverRev: 1, repeated: false, conflicts: [{ id: 'project/planTitle', field: 'planTitle', local: 'local title', server: 'server title', reason: 'Both changed', allowed: ['local','server','merge'] }], previewToken: 'test' };
    b.w.eval('savedRevision=editRevision;hubCompletePreview({json:{}},preview)');
    b.w.eval("state.project.planTitle='new local title';touch()");
    await (b.w.document.querySelector<HTMLButtonElement>('#import-apply') as any).onclick();
    assert.match(b.w.document.querySelector('#toast')!.textContent!, /Local data changed/);
    assert.equal(b.w.eval('state.project.planTitle'), 'new local title');
    b.w.eval('savedRevision=editRevision;hubDirty.clear();hubCompletePreview({json:{}},preview);hubPersist=async()=>{};hubExchangeRequest=async(t,body)=>{window.sent=body;return {rev:2,data:structuredClone(state)}}');
    const choice = b.w.document.querySelector<HTMLSelectElement>('.hub-choice')!; choice.value = 'merge'; choice.dispatchEvent(new b.w.Event('change'));
    b.w.document.querySelector<HTMLTextAreaElement>('.hub-merge-value')!.value = 'manual title';
    await (b.w.document.querySelector<HTMLButtonElement>('#import-apply') as any).onclick();
    assert.equal((b.w as any).sent.choices['project/planTitle'].value, 'manual title');
    assert.equal(b.w.eval('writeBusy'), false); assert.deepEqual(b.errors, []);
  } finally { b.dom.window.close(); }
});
