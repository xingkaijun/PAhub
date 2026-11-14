// Security regression: untrusted Builder evidence downloads, while the controlled
// PCF page still fetches it as a blob and opens the import preview in both modes.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHub } from '../dist/app.mjs';
import { createKjxTestSigner, createKjxVerifier } from '../src/kjx-auth-client.ts';

const root=fileURLToPath(new URL('../..',import.meta.url));
const P='proj-test-001', D='dwg-001', base='/api/pcf/'+P+'/'+D;
const keys=['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','AUTH_MODE','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','ALLOW_CORS_ORIGIN','PCF_GRANT_SECRET','PAHUB_PUBLIC_ORIGIN'];
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const browser=await chromium.launch({headless:true,channel:process.env.PAHUB_BROWSER_CHANNEL || 'chromium'});
try {
  for(const mode of ['legacy','kjx']) {
    const dir=await mkdtemp(path.join(tmpdir(),'pahub-handoff-e2e-'));
    let hub, manager, admin;
    try {
      Object.assign(process.env,{PORT:'0',PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),AUTH_MODE:mode,API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:'',ALLOW_CORS_ORIGIN:'',PAHUB_PUBLIC_ORIGIN:'https://pahub.kjxing.com'});
      delete process.env.PCF_GRANT_SECRET;
      const signer=createKjxTestSigner();
      const verifier=createKjxVerifier({jwksUrl:'http://kjx.test/jwks',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch});
      hub=await createHub({host:'127.0.0.1',verifier});
      const origin='http://127.0.0.1:'+hub.port;
      hub.router.options.identity.publicOrigin=origin;
      hub.db.exec(await readFile(path.join(root,'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
      if(mode==='kjx')hub.db.prepare('INSERT INTO project_team_reviewers VALUES(?,?)').run(P,'manager');
      hub.db.prepare('UPDATE drawings SET discipline=? WHERE id=?').run('Hull',D);
      const headers=role=>mode==='kjx' ? {'X-Auth-Token':signer.signUser('pahub',{sub:role,username:role,name:'Test '+role,role})} : {};
      manager=await browser.newContext({acceptDownloads:true,extraHTTPHeaders:headers('manager')});
      admin=await browser.newContext({acceptDownloads:true,extraHTTPHeaders:headers('admin')});
      const post=async(context,tail,data)=>{
        const response=await context.request.post(origin+base+'/'+tail,{headers:{Origin:origin},data});
        assert.equal(response.status(),200,tail+' '+await response.text());
        return response.json();
      };
      await post(admin,'create',{});
      const live=await (await admin.request.get(origin+base+'/data')).json();
      await post(admin,'ops',{clientId:'setup',baseRev:live.rev,ops:[{type:'comment.add',id:'handoff-comment',roundIdNew:'handoff-round'}]});
      const exported=await post(manager,'exports',{});
      const exportedHTML=await (await manager.request.get(origin+base+'/exports/'+exported.exportId+'/download')).text();
      const data=JSON.parse(exportedHTML.match(/<script\b[^>]*id=["']pcf-data["'][^>]*>([\s\S]*?)<\/script>/i)[1]);
      data.comments[0].rounds[0].reply={text:'Handoff Builder reply',html:'Handoff Builder reply',fill:'',images:[]};
      const uploaded='<html><head><script>window.uploadedBuilderScriptExecuted=true;</script></head><body><script id="pcf-data" type="application/json">'+JSON.stringify(data).replace(/</g,'\\u003c')+'</script></body></html>';
      const preview=await manager.request.post(origin+'/api/projects/'+P+'/builder-replies/preview',{headers:{Origin:origin},multipart:{files:{name:'untrusted-builder.html',mimeType:'text/html',buffer:Buffer.from(uploaded)}}});
      assert.equal(preview.status(),200);
      const set=await preview.json();assert.equal(set.files[0].category,'clean');
      const evidence=origin+'/api/projects/'+P+'/builder-replies/'+set.importSetId+'/file/'+set.files[0].id;
      const response=await admin.request.get(evidence);
      assert.equal(response.headers()['content-type'],'application/octet-stream');
      assert.match(response.headers()['content-disposition'],/^attachment;/);
      assert.equal(response.headers()['content-security-policy'],'sandbox');
      assert.equal(response.headers()['x-content-type-options'],'nosniff');
      assert.equal(await response.text(),uploaded);
      const page=await admin.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/');
      const downloadEvent=page.waitForEvent('download');
      await page.goto(evidence).catch(error=>{assert.match(error.message,/Download is starting|ERR_ABORTED/);});
      const download=await downloadEvent;
      assert.equal(download.suggestedFilename(),'builder-reply.html');
      assert.equal(await page.evaluate(()=>window.uploadedBuilderScriptExecuted),undefined);
      await page.addInitScript(()=>document.addEventListener('change',event=>{
        if(event.target.id==='pahub-import-file') window.handoffFileType=event.target.files[0]?.type;
      },true));
      await page.goto(origin+'/pcf/'+P+'/'+D+'?builderReplySet='+set.importSetId+'&builderReplyFile='+set.files[0].id);
      await page.locator('#import-apply').waitFor();
      assert.equal(await page.evaluate(()=>window.handoffFileType),'text/html');
      assert.match(await page.locator('#modal-body').innerText(),/Automatic merges \(1\)/);
      assert.equal(await page.evaluate(()=>window.uploadedBuilderScriptExecuted),undefined);
      await page.locator('#import-apply').click();
      await page.waitForFunction(()=>!document.querySelector('#modal').open);
      assert.equal(await page.locator('.editor[data-side="reply"]').first().innerText(),'Handoff Builder reply');
      assert.deepEqual(errors,[]);
      console.log(mode+': evidence navigates as attachment without executing uploaded script; fetch/blob handoff opens preview and applies Builder reply');
    } finally {
      await manager?.close();await admin?.close();await hub?.close();await rm(dir,{recursive:true,force:true});
    }
  }
} finally {
  await browser.close();
  for(const [key,value]of Object.entries(previous)) if(value===undefined)delete process.env[key];else process.env[key]=value;
}
