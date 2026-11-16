import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const outfile = path.resolve('hub-server/dist/config-ui-components.mjs');
await build({stdin:{contents:`export {Settings} from './components/Settings'; export {useStore} from './store'; export {createElement} from 'react'; export {renderToStaticMarkup} from 'react-dom/server';`,resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':JSON.stringify({MODE:'hub',VITE_DATA_API_BASE_URL:'/api'})}});
const ui = await import(pathToFileURL(outfile).href);
const reviewers = [{id:'a',name:'Alice'}, {id:'b',name:'Bob'}];
function render(mode='kjx', role='admin') {
  const permissions = role==='admin' ? ['settings.write','project.settings','team.setup'] : role==='manager' ? ['project.settings','team.setup'] : [];
  const conf = {reviewers, disciplineDefaults:{Hull:'a', Outfitting:'b'}, defaultAssignees:{Accommodation:['a']}, holidays:[], roundACycle:14, otherRoundsCycle:7, projectSummary:{ships:[{hullNumber:'H1234'}]}};
  ui.useStore.setState({session:{mode,admin:role==='admin',permissions,user:{id:role,role}},isEditMode:role==='admin'||role==='manager',activeProjectId:'p',data:{...ui.useStore.getState().data,projects:[{id:'p',name:'Fixture',conf,drawings:[{id:'d',discipline:'Hull'}]}]}});
  Object.assign(ui.useStore.getInitialState(), ui.useStore.getState()); // Align Zustand SSR snapshot with fixture.
  return new JSDOM(ui.renderToStaticMarkup(ui.createElement(ui.Settings))).window.document;
}

test('Config combines both sections, standardizes all native controls and retains role visibility', () => {
  for (const mode of ['kjx','legacy']) for (const role of ['admin','manager','reviewer','viewer']) {
    const doc = render(mode, role);
    const text = doc.body.textContent!;
    const section = [...doc.querySelectorAll('section')].find(node=>node.textContent!.includes('Data Management'))!;
    assert.match(section.textContent!, /Project Configuration/);
    assert.equal(doc.querySelectorAll('h2').length, 7);
    for (const input of doc.querySelectorAll('input:not([type=range]):not([type=file]),select')) {
      assert.match(input.className, /text-\[10px\]/); assert.match(input.className, /font-black/); assert.match(input.className, /rounded-full/); assert.match(input.className, /focus:ring-4/);
    }
    for (const label of doc.querySelectorAll('label')) assert.match(label.className, /text-\[9px\]/);
    assert.equal(text.includes('Local Restore'), mode==='legacy');
    assert.equal(text.includes('Save to Cloud'), mode==='legacy');
    assert.equal(text.includes('Local Backup'), mode==='legacy'||role==='admin');
    assert.equal(text.includes('Fix Deadline'), mode==='legacy'||role==='admin');
    assert.equal(!!doc.querySelector('#config-project-password'), mode==='legacy');
    assert.equal(doc.querySelector<HTMLButtonElement>('[aria-label="Select team members"]')!.disabled, role==='reviewer'||role==='viewer');
  }
});

test('Default Leads lists all configured/drawn disciplines with roster-only choices and clear option', () => {
  for (const mode of ['kjx','legacy']) {
    const doc = render(mode);
    const rows = doc.querySelectorAll('table[aria-label="Default leads by discipline"] tbody tr');
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.children.length, 2);
      assert.deepEqual([...row.querySelectorAll('option')].map(option=>option.value), ['',...(mode==='kjx'?['a','b']:['Alice','Bob'])]);
    }
    assert.equal(doc.querySelector<HTMLSelectElement>('[aria-label="Select Hull lead"]')!.value, mode==='kjx'?'a':'Alice');
    assert.equal(doc.querySelectorAll('[aria-label^="Remove member "]').length, 2);
  }
});
