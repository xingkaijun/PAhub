import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

test('manual separates current kjx operations from legacy screenshots and shared-password instructions',()=>{
 const html=readFileSync('public/manual/index.html','utf8');
 const dom=new JSDOM(html);try{
  const current=dom.window.document.querySelector('[data-manual-kjx]')!.textContent!;
  const legacy=dom.window.document.querySelector('div[data-manual-legacy]')!.textContent!;
  for(const text of ['Team Setup roster','Default Leads','Default Assignees','创建者自动加入','Unknown reviewer','Tracker 历史不删除','没有正式','Local Backup','Fix Deadline','403','Change password','My apps','Sign out'])assert.ok(current.includes(text),text);
  assert.match(current,/不再用项目密码/);assert.match(current,/manager 主管/);assert.match(current,/Inventory 只读/);
  assert.match(current,/不是 Default Leads 的单选下拉/);assert.match(legacy,/legacy 模式参考/);
  assert.match(html,/fetch\('\/api\/session'/);assert.match(html,/data-auth-mode="kjx".*data-manual-legacy/);
  const english=readFileSync('components/KjxManual.tsx','utf8');assert.match(english,/Inventory is read-only/);assert.match(english,/Unknown reviewer/);assert.match(english,/no formal user-facing project deletion/);
 }finally{dom.window.close();}
});
