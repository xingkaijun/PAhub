import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { bannerToolbarHTML } from '../src/pcf-banner-toolbar.ts';

const template = readFileSync(new URL('../../pcf/template/PG-PCF-hub.html', import.meta.url), 'utf8');
function fixture(hosted = true) {
  const dom = new JSDOM(template, { runScripts:'outside-only', pretendToBeVisual:true });
  const w = dom.window, doc = w.document;
  if (hosted) {
    (w as any).PAHUB = {};
    const actions = doc.createElement('div'); actions.id = 'pahub-hosted-actions';
    for (const [id, label] of [['pahub-export','Export to Builder'],['pahub-import','Import Builder Reply'],['pahub-exchange','Shipyard correspondence']]) {
      const b = doc.createElement('button'); b.id=id; b.innerHTML='<span>'+label+'</span>'; actions.append(b);
    }
    doc.querySelector('.banner-actions')!.before(actions);
    const name = doc.createElement('button'); name.id='pahub-name'; name.textContent='Set nickname';
    doc.getElementById('save-state')!.after(name);
  }
  // Run the unmodified native menu handlers before moving their original nodes.
  w.eval('const $$=s=>[...document.querySelectorAll(s)];'+template.slice(template.indexOf('const bannerMenus='),template.indexOf('// Connection never writes.')));
  const html=bannerToolbarHTML('<body></body>');
  const script=new JSDOM(html).window.document.querySelector('script')!.textContent!;
  const mount=()=>{w.eval(script);doc.dispatchEvent(new w.Event('DOMContentLoaded'));};
  return { dom,w,doc,mount };
}
test('hosted toolbar moves original buttons, keeps grouping and native menu/keyboard behavior',()=>{
  const f=fixture(); try {
    const ids=['pahub-export','pahub-import','pahub-exchange','save-btn','save-menu-btn','json-menu-btn','excel-menu-btn','more-btn','help-btn','theme-btn','pahub-name'];
    const nodes=ids.map(id=>f.doc.getElementById(id)!); let clicks=0;
    nodes.forEach(node=>node.addEventListener('click',()=>clicks++));
    f.mount();
    assert.equal(f.doc.querySelectorAll('.pahub-toolbar > .toolbar-group').length,3);
    for (const [i,id] of ids.entries()) { assert.equal(f.doc.getElementById(id),nodes[i]); assert.ok(nodes[i].closest('.pahub-toolbar')); nodes[i].click(); }
    assert.equal(clicks,ids.length);
    assert.equal(f.doc.getElementById('more-btn')!.textContent,'File Options');
    assert.equal(f.doc.getElementById('pahub-name')!.textContent,'Set Nickname');
    assert.ok(!f.doc.getElementById('save-state')!.closest('.pahub-toolbar'));
    for (const key of ['save','json','excel']) {
      const trigger=f.doc.getElementById(key+'-menu-btn')!, panel=f.doc.getElementById(key+'-menu-panel')!;
      trigger.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      assert.equal(trigger.getAttribute('aria-expanded'),'true');
      assert.equal((panel as any).inert,false);
      assert.equal(f.doc.activeElement,panel.querySelector('button'));
      panel.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert.equal(trigger.getAttribute('aria-expanded'),'false');
      assert.equal((panel as any).inert,true); assert.equal(f.doc.activeElement,trigger);
    }
    f.mount(); assert.equal(f.doc.querySelectorAll('.pahub-toolbar').length,1);
  } finally {f.dom.window.close();}
});
test('standalone Builder/offline pages do not receive hosted toolbar presentation',()=>{
  const f=fixture(false);try{f.mount();assert.equal(f.doc.querySelector('.pahub-toolbar'),null);assert.equal(f.doc.querySelector('#pahub-banner-toolbar-style'),null);}finally{f.dom.window.close();}
});
test('toolbar injection is idempotent and leaves immutable v2.6 template data/version alone',()=>{
  const result=bannerToolbarHTML(template);assert.equal(bannerToolbarHTML(result),result);
  assert.equal(result.replace(/<script id="pahub-banner-toolbar">[\s\S]*?<\/script>\n/,''),template);
  assert.match(template,/name="pahub-template-version" content="6"/);
  assert.equal(bannerToolbarHTML('no body'),'no body');
});
