import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { ROOT_DIR } from '../src/config.ts';

const PCF_MANAGED = '由 PCF 管理';
const SERVER_ROUND = '由服务端状态流转管理';

// React's scheduler creates a MessageChannel in the browser bundle. Node keeps those
// ports alive, so capture and close them or the test process never exits.
const schedulerChannels: MessageChannel[] = [];
const NativeMessageChannel = globalThis.MessageChannel;
(globalThis as any).MessageChannel = class extends MessageChannel {
  constructor() { super(); schedulerChannels.push(this); }
};
after(() => {
  for (const channel of schedulerChannels) { channel.port1.close(); channel.port2.close(); }
  (globalThis as any).MessageChannel = NativeMessageChannel;
});

let uiPromise: Promise<any> | undefined;

function loadUi() {
  if (!uiPromise) {
    uiPromise = (async () => {
      const result = await build({
        stdin: {
          contents: [
            "export { DrawingRow } from './components/DrawingRow';",
            "export { CommandBar, manualFieldBlockMessage } from './components/CommandBar';",
            "export { renderToStaticMarkup } from 'react-dom/server.browser';",
            "export { createElement } from 'react';",
            "export { useStore } from './store';",
          ].join('\n'),
          resolveDir: ROOT_DIR,
          loader: 'tsx',
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        logLevel: 'silent',
        define: { 'import.meta.env': JSON.stringify({ MODE: 'hub', VITE_DATA_API_TOKEN: '' }) },
      });
      const code = Buffer.from(result.outputFiles[0].contents).toString('base64');
      return import('data:text/javascript;base64,' + code);
    })();
  }
  return uiPromise;
}

function drawing(hasPcf?: boolean) {
  return {
    id: 'dwg-1', customId: '001', drawingNo: 'D-001', title: 'Test drawing', discipline: 'Hull',
    assignees: [], status: 'Reviewing', currentRound: 'B', version: '3',
    manualCommentsCount: 12, manualOpenCommentsCount: 4,
    logs: [], remarks: [], statusHistory: [],
    ...(hasPcf === undefined ? {} : { hasPcf }),
  };
}

function renderDrawing(ui: any, hasPcf?: boolean) {
  const element = ui.createElement(ui.DrawingRow, {
    drawing: drawing(hasPcf),
    activeProjectId: 'proj-1',
    isExpanded: false,
    onToggleExpand() {},
    updateDrawing() {},
    deleteDrawing() {},
    toggleRemarkStatus() {},
    reviewers: [],
    derivedDisciplines: ['Hull'],
  });
  return new JSDOM('<div id="root">' + ui.renderToStaticMarkup(element) + '</div>').window.document;
}

test('DrawingRow marks PCF-owned version, round and comment counts read-only', async () => {
  const ui = await loadUi();
  const document = renderDrawing(ui, true);
  const version = document.querySelector('input[type="text"]') as HTMLInputElement;
  assert.equal(version.readOnly, true);
  assert.equal(version.value, '3');
  assert.equal(version.getAttribute('title'), PCF_MANAGED);
  const counts = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
  assert.deepEqual(counts.map(input => input.value), ['12', '4']);
  for (const input of counts) {
    assert.equal(input.readOnly, true);
    assert.equal(input.getAttribute('title'), PCF_MANAGED);
  }
  const round = Array.from(document.querySelectorAll('span')).find(span => span.textContent === 'B');
  assert.ok(round, 'current round is rendered');
  assert.equal(round!.getAttribute('title'), PCF_MANAGED);
});

test('DrawingRow leaves manual fields editable when the drawing has no PCF', async () => {
  const ui = await loadUi();
  const document = renderDrawing(ui, false);
  const version = document.querySelector('input[type="text"]') as HTMLInputElement;
  assert.equal(version.readOnly, false);
  assert.equal(version.getAttribute('title'), null);
  const counts = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
  assert.equal(counts.length, 2);
  for (const input of counts) {
    assert.equal(input.readOnly, false);
    assert.equal(input.getAttribute('title'), null);
  }
  const round = Array.from(document.querySelectorAll('span')).find(span => span.textContent === 'B');
  assert.ok(round);
  assert.equal(round!.getAttribute('title'), null);
});

test('DrawingRow keeps PCF-managed values visible and read-only in edit mode', async () => {
  const ui = await loadUi();
  const initial = ui.useStore.getInitialState();
  const wasEditMode = initial.isEditMode;
  try {
    // renderToStaticMarkup reads zustand's server snapshot, which is getInitialState().
    initial.isEditMode = true;
    const document = renderDrawing(ui, true);
    const version = document.querySelector('input[type="text"]') as HTMLInputElement;
    assert.equal(version.disabled, false);
    assert.equal(version.readOnly, true);
    assert.equal(version.value, '3');
    const counts = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    assert.deepEqual(counts.map(input => input.value), ['12', '4']);
    for (const input of counts) {
      assert.equal(input.disabled, false);
      assert.equal(input.readOnly, true);
    }
  } finally {
    initial.isEditMode = wasEditMode;
  }
});

test('CommandBar blocks PCF-owned comment and version commands, including mixed batches', async () => {
  const { manualFieldBlockMessage } = await loadUi();
  assert.match(manualFieldBlockMessage([{ customId: '001', hasPcf: true }], 'comments'), new RegExp(PCF_MANAGED));
  assert.match(manualFieldBlockMessage([{ customId: '001', hasPcf: true }], 'version'), new RegExp(PCF_MANAGED));
  assert.match(manualFieldBlockMessage([{ customId: '001' }, { customId: '002', hasPcf: true }], 'version'), new RegExp(PCF_MANAGED));
  assert.match(manualFieldBlockMessage([{ customId: '001' }, { customId: '002', hasPcf: true }], 'comments'), new RegExp(PCF_MANAGED));
  assert.equal(manualFieldBlockMessage([{ customId: '001', hasPcf: false }], 'comments'), null);
  assert.equal(manualFieldBlockMessage([{ customId: '001', hasPcf: false }], 'version'), null);
  const code = await readFile(path.join(ROOT_DIR, 'components/CommandBar.tsx'), 'utf8');
  assert.doesNotMatch(code, /\bconfirm\s*\(/);
});

test('CommandBar always routes round changes to the PCF or server owner', async () => {
  const { manualFieldBlockMessage } = await loadUi();
  assert.match(manualFieldBlockMessage([{ customId: '001', hasPcf: true }], 'round'), new RegExp(PCF_MANAGED));
  assert.match(manualFieldBlockMessage([{ customId: '001', hasPcf: false }], 'round'), new RegExp(SERVER_ROUND));
});
