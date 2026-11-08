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
test('hosted toolbar: centered capsules, personal capsule on the right, original nodes kept',()=>{
  const f=fixture(); try {
    const ids=['pahub-export','pahub-import','pahub-exchange','save-btn','save-menu-btn','json-menu-btn','excel-menu-btn','more-btn','help-btn','theme-btn','pahub-name'];
    const nodes=ids.map(id=>f.doc.getElementById(id)!); let clicks=0;
    nodes.forEach(node=>node.addEventListener('click',()=>clicks++));
    f.mount();
    const toolbar=f.doc.querySelector('.pahub-toolbar')!;
    assert.equal(toolbar.querySelectorAll(':scope > .capsule').length,2);
    for (const [i,id] of ids.entries()) { assert.equal(f.doc.getElementById(id),nodes[i]); assert.ok(nodes[i].closest('.capsule')); nodes[i].click(); }
    assert.equal(clicks,ids.length);
    const personal=f.doc.querySelector('.banner-actions > .capsule.personal')!;
    assert.deepEqual([...personal.children].map(el=>el.id),['pahub-name','help-btn','theme-btn']);
    for (const id of ['pahub-name','help-btn','theme-btn']) assert.ok(!f.doc.getElementById(id)!.closest('.pahub-toolbar'));
    assert.equal(f.doc.getElementById('more-btn')!.textContent,'File Options');
    assert.equal(f.doc.getElementById('pahub-name')!.textContent,'Set Nickname');
    assert.equal(f.doc.getElementById('pahub-exchange')!.textContent,'Shipyard Correspondence');
    assert.ok(!f.doc.getElementById('save-state')!.closest('.pahub-toolbar'));
    for (const key of ['save','json','excel']) {
      const trigger=f.doc.getElementById(key+'-menu-btn')!, panel=f.doc.getElementById(key+'-menu-panel')!;
      trigger.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      assert.equal(trigger.getAttribute('aria-expanded'),'true');
      assert.equal(f.doc.activeElement,panel.querySelector('button'));
      panel.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert.equal(trigger.getAttribute('aria-expanded'),'false');
    }
    f.mount(); assert.equal(f.doc.querySelectorAll('.pahub-toolbar').length,1);
  } finally {f.dom.window.close();}
});
test('Import/Export are one split button: Export is the default, Import lives in its menu',()=>{
  const f=fixture(); try {
    let exported=0, imported=0;
    f.doc.getElementById('pahub-export')!.addEventListener('click',()=>exported++);
    f.doc.getElementById('pahub-import')!.addEventListener('click',()=>imported++);
    f.mount();
    const io=f.doc.getElementById('pahub-io')!, trigger=f.doc.getElementById('pahub-io-menu-btn')!, panel=f.doc.getElementById('pahub-io-panel')!;
    assert.equal(io.firstElementChild!.id,'pahub-export');
    assert.equal(f.doc.getElementById('pahub-import')!.parentElement,panel);
    assert.equal(panel.hidden,true);
    f.doc.getElementById('pahub-export')!.click(); assert.equal(exported,1);
    trigger.click(); assert.equal(panel.hidden,false); assert.equal(trigger.getAttribute('aria-expanded'),'true');
    f.doc.getElementById('pahub-io-export')!.click(); assert.equal(exported,2); assert.equal(panel.hidden,true);
    trigger.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    assert.equal(panel.hidden,false); assert.equal(f.doc.activeElement,f.doc.getElementById('pahub-io-export'));
    panel.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    assert.equal(f.doc.activeElement,f.doc.getElementById('pahub-import'));
    f.doc.getElementById('pahub-import')!.click(); assert.equal(imported,1); assert.equal(panel.hidden,true);
    trigger.click(); f.doc.body.click(); assert.equal(panel.hidden,true);
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
