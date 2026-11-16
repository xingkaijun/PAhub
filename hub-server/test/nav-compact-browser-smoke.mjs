// Fixture-only interactive header regression against the production hub build.
// PAHUB_NAV_DEV=1 uses Vite; PAHUB_NAV_STANDALONE=1 also selects its standalone mode.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {createHub} from '../dist/app.mjs';
import {createKjxTestSigner, createKjxVerifier} from '../src/kjx-auth-client.ts';
const keys = ['PORT','AUTH_MODE','PAHUB_DATA_DIR','PAPC_DB_PATH','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET'];
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const dir = await mkdtemp(path.join(tmpdir(), 'nav-compact-'));
let browser, hub, vite;
try {
  browser = await chromium.launch({headless: true, channel: process.env.PAHUB_BROWSER_CHANNEL || 'chromium'});
  await mkdir('hub-server/test/artifacts', {recursive: true});
  for (const mode of ['kjx', 'legacy']) {
    Object.assign(process.env, {PORT:'0', AUTH_MODE:mode, PAHUB_DATA_DIR:path.join(dir, mode), PAPC_DB_PATH:path.join(dir, mode+'.db'), API_TOKEN:'', ADMIN_PASSWORD:'', PAHUB_BASIC_AUTH:''});
    delete process.env.PCF_GRANT_SECRET;
    const signer = createKjxTestSigner();
    hub = await createHub({host:'127.0.0.1', verifier:createKjxVerifier({jwksUrl:'http://test', issuer:'https://auth.kjxing.com', audience:'pahub', fetch:signer.fetch})});
    hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql', 'utf8'));
    hub.db.prepare('UPDATE projects SET name=?').run('SINOCHEM');
    if (mode === 'kjx') hub.db.prepare('INSERT OR IGNORE INTO project_team_reviewers VALUES(?,?)').run('proj-test-001', 'reviewer');
    let origin = 'http://127.0.0.1:'+hub.port;
    if (process.env.PAHUB_NAV_DEV) {
      vite = await createServer({mode: process.env.PAHUB_NAV_STANDALONE ? 'development' : 'hub', server:{port:0, host:'127.0.0.1', proxy:{'/api':{target:origin, changeOrigin:true}}}});
      await vite.listen(); origin = 'http://127.0.0.1:'+vite.httpServer.address().port;
    }
    hub.router.options.identity.publicOrigin = origin;
    for (const role of mode === 'kjx' ? ['admin','reviewer'] : ['legacy']) {
      const context = await browser.newContext({viewport:{width:1920,height:1000}, extraHTTPHeaders:mode === 'kjx' ? {'X-Auth-Token':signer.signUser('pahub',{sub:role, username:role, name:'Kevin', role})} : {}});
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin+'/?project=proj-test-001');
      await page.locator('[data-drawing-list-root]').waitFor();
      const nav = page.locator('[data-primary-nav]');
      const inspect = async width => {
        await page.setViewportSize({width,height:1000});
        await page.waitForTimeout(180); // let ResizeObserver + rAF settle
        return page.evaluate(() => {
          const nav = document.querySelector('[data-primary-nav]'), slot = nav.parentElement;
          const rect = nav.getBoundingClientRect(), header = nav.closest('header').getBoundingClientRect();
          const buttons = [...nav.querySelectorAll('button')];
          const controls = [...nav.closest('header').children].at(-1).getBoundingClientRect();
          const probe = document.querySelector('[data-nav-probe]');
          return {compact:nav.dataset.compact, scroll:nav.scrollWidth, client:nav.clientWidth,
            overflow:getComputedStyle(nav).overflowX, available:slot.clientWidth-32, expanded:probe?.offsetWidth,
            inside:buttons.every(button => {const r=button.getBoundingClientRect(); return r.left>=rect.left && r.right<=rect.right; }),
            separate:rect.right<=controls.left && controls.right<=header.right,
            labels:buttons.every(button => getComputedStyle(button.querySelector('.nav-label')).display === (nav.dataset.compact==='true'?'none':'block')),
            named:buttons.every(button => button.title && button.getAttribute('aria-label')),
            selected:buttons.filter(button => button.getAttribute('aria-current') === 'page').length,
            count:buttons.length};
        });
      };
      for (const width of [1920,1600,1366,1280,1600,1920,2560]) {
        const result = await inspect(width);
        assert.ok(result.scroll <= result.client+1, JSON.stringify(result));
        assert.equal(result.overflow, 'hidden'); assert.equal(result.inside, true);
        assert.equal(result.separate, true); assert.equal(result.labels, true);
        assert.equal(result.named, true); assert.equal(result.selected, 1);
        assert.equal(result.count, mode==='kjx' && role==='reviewer' ? 6 : 7);
        if (result.available < result.expanded) assert.equal(result.compact, 'true');
        if (result.available >= result.expanded+24) assert.equal(result.compact, 'false');
        console.log(mode, role, width, JSON.stringify(result));
        if (width<=1920) await page.screenshot({path:`hub-server/test/artifacts/nav-compact-${mode}-${role}-${width}.png`});
      }
      // CSS zoom and changing identity width must trigger the same measured path.
      await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
      const zoomed = await inspect(1280);
      assert.equal(zoomed.inside, true); assert.equal(zoomed.separate, true);
      assert.ok(zoomed.scroll <= zoomed.client+1);
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
      if (mode === 'kjx') {
        await page.evaluate(() => {
          const account = [...document.querySelectorAll('header button')].find(button => button.textContent.includes('Account'));
          account.previousElementSibling.firstChild.textContent = 'Kevin Very Long Display Name ';
        });
        const longName = await inspect(1280);
        assert.equal(longName.inside, true); assert.equal(longName.separate, true);
        await page.evaluate(() => {
          const account = [...document.querySelectorAll('header button')].find(button => button.textContent.includes('Account'));
          account.previousElementSibling.firstChild.textContent = 'Kevin ';
        });
      }
      // Mode transition must preserve the actual DOM button/focus and active highlight.
      await nav.getByRole('button',{name:'Guide',exact:true}).click();
      await inspect(1280);
      assert.equal(await nav.getByRole('button',{name:'Guide',exact:true}).getAttribute('aria-current'), 'page');
      assert.match(await nav.getByRole('button',{name:'Guide',exact:true}).getAttribute('class'), /bg-white text-teal-700/);
      await nav.getByRole('button',{name:'Inventory',exact:true}).focus();
      await inspect(2560);
      assert.equal(await nav.getByRole('button',{name:'Inventory',exact:true}).evaluate(button => button===document.activeElement), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
    await vite?.close(); vite = undefined; await hub.close(); hub = undefined;
  }
  console.log('nav compact browser: all widths, role-dependent tabs, standalone/hosted, resize reversal, focus and selection PASS');
} finally {
  await vite?.close(); await browser?.close(); await hub?.close(); await rm(dir,{recursive:true,force:true});
  for (const [key,value] of Object.entries(prior)) if(value===undefined) delete process.env[key]; else process.env[key]=value;
}
