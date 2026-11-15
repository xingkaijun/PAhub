import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHub } from '../src/app.ts';
import { createKjxTestSigner, createKjxVerifier } from '../src/kjx-auth-client.ts';
import { KjxDirectory, type DirectoryOptions } from '../src/kjx-directory.ts';
import { parseHTML } from '../src/pcf-html.ts';
import { standaloneHTML } from '../src/pcf-exchange.ts';
import { currentTemplate, renderTemplate, upgradeFile, TEMPLATE_VERSION } from '../src/pcf-template.ts';
import { initData } from '../src/pcf-model.ts';
import { writeAudit } from '../src/audit.ts';
import { actorExport, actorLabel, actorOptions, filterActor } from '../../lib/auditActors.ts';

const P='proj-test-001',D='dwg-001',base='/api/pcf/'+P+'/'+D;
const person=(id:string,role='reviewer',disciplines=['HULL'])=>({id,username:id,name:'Name '+id,title:null,disciplines,role,active:true});
const people=[person('other'),person('manager','manager'),person('admin','admin'),person('viewer','viewer'),{...person('inactive'),active:false}];
function fakeDirectory(options: { status?: number; timeout?: boolean; directoryTimeout?: boolean; directoryStatus?: number }={}) {
  const calls: {url:string;init?:RequestInit}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);calls.push({url,init});
    if(options.timeout || options.directoryTimeout && !url.endsWith('/oauth/token'))return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted'))));
    if(url.endsWith('/oauth/token'))return options.status ? new Response('invalid client',{status:options.status}) : Response.json({access_token:randomBytes(24).toString('hex'),expires_in:600});
    return options.directoryStatus ? new Response('invalid token',{status:options.directoryStatus}) : Response.json(people);
  };
  return {calls,options:{clientId:'test-client',clientSecret:randomBytes(24).toString('hex'),internalUrl:'http://directory.test',fetch:fetcher,timeoutMs:20,warn:()=>{}} satisfies DirectoryOptions};
}
async function fixture(mode:'legacy'|'kjx'='kjx',directory?:DirectoryOptions) {
  const keys=['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','PAPC_DIST_DIR','AUTH_MODE','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET','ALLOW_CORS_ORIGIN','PAHUB_PUBLIC_ORIGIN'];
  const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const dir=await mkdtemp(path.join(tmpdir(),'pahub-t6-'));
  Object.assign(process.env,{PORT:'0',PAHUB_DATA_DIR:dir,PAPC_DB_PATH:path.join(dir,'papc.db'),PAPC_DIST_DIR:path.join(process.cwd(),'dist'),AUTH_MODE:mode,API_TOKEN:'',ADMIN_PASSWORD:'',PAHUB_BASIC_AUTH:'',ALLOW_CORS_ORIGIN:'',PAHUB_PUBLIC_ORIGIN:'https://pahub.kjxing.com'});delete process.env.PCF_GRANT_SECRET;
  const signer=createKjxTestSigner();
  const hub=await createHub({host:'127.0.0.1',verifier:createKjxVerifier({jwksUrl:'http://kjx.test',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch}),directory:directory || {clientId:undefined,clientSecret:undefined}});
  hub.db.exec(await readFile('hub-server/test/fixtures/seed-test-data.sql','utf8'));
  if(mode==='kjx')for(const id of ['owner','other','importer'])hub.db.prepare('INSERT OR IGNORE INTO project_team_reviewers VALUES(?,?)').run(P,id);
  hub.db.prepare('UPDATE drawings SET discipline=? WHERE id=?').run('Hull',D);
  const request=(url:string,role='admin',body?:unknown,claims:Record<string,unknown>={})=>fetch('http://127.0.0.1:'+hub.port+url,{method:body ? 'POST':'GET',headers:{'X-Auth-Token':signer.signUser('pahub',{sub:'owner',username:'owner',name:'Owner Name',role,...claims}),Origin:'https://pahub.kjxing.com','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const ops=(role:string,ops:any[],claims={})=>request(base+'/ops',role,{clientId:'client',baseRev:hub.pcf.storage.load(P,D).rev,ops},claims);
  await request('/pcf/'+P+'/'+D,'reviewer');
  return {hub,request,ops,dir,cleanup:async()=>{await hub.close();for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(dir,{recursive:true,force:true});}};
}

test('T6 directory: service audience, roles, mapped discipline, 5-minute cache and coalescing',async()=>{
  const fake=fakeDirectory();let now=0;
  const directory=new KjxDirectory({...fake.options,now:()=>now});
  const results=await Promise.all([directory.list('Hull'),directory.list('Unknown'),directory.list('Hull')]);
  assert.equal(fake.calls.length,2);
  assert.equal(results[0].ok,true);if(results[0].ok)assert.deepEqual(results[0].users.map(p=>p.id),['other','manager','admin']);
  assert.equal(new URL(fake.calls[1].url).searchParams.get('role'),null);
  assert.equal(new URL(fake.calls[1].url).searchParams.get('app'),'pahub');
  assert.equal(new URLSearchParams(String(fake.calls[0].init?.body)).get('audience'),'kjx-auth');
  assert.ok(fake.calls[1].init?.headers);
  now=299999;await directory.list();assert.equal(fake.calls.length,2);
  now=300001;await directory.list();assert.equal(fake.calls.length,3);
});

test('T6 directory: token 401, timeout, missing configuration and failure backoff fall back safely',async()=>{
  for(const options of [{status:401},{timeout:true},{directoryTimeout:true},{directoryStatus:401}]) {
    const fake=fakeDirectory(options);let now=0,warnings=0;
    const directory=new KjxDirectory({...fake.options,now:()=>now,warn:()=>{warnings++;}});
    assert.deepEqual(await directory.list(),{ok:false,fallback:true});
    const count=fake.calls.length;
    assert.deepEqual(await directory.list(),{ok:false,fallback:true});assert.equal(fake.calls.length,count);assert.equal(warnings,1);
    now=60001;await directory.list();assert.ok(fake.calls.length>count);
  }
  assert.deepEqual(await new KjxDirectory({}).list(),{ok:false,fallback:true});
});

test('T6 directory routes: only admin sees team directory, PCF candidates allow managers, legacy absent',async()=>{
  const fake=fakeDirectory();const f=await fixture('kjx',fake.options);
  try {
    for(const role of ['viewer','reviewer','manager'])assert.equal((await f.request('/api/team/directory',role)).status,403);
    const response=await f.request('/api/team/directory?discipline=Hull','admin');assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.users.length,3);
    const candidates=await f.request(base+'/initiators','manager');assert.equal(candidates.status,200);
    const candidateBody=await candidates.json();assert.equal(candidateBody.users.length,3);for(const person of candidateBody.users)assert.deepEqual(Object.keys(person).sort(),['id','name']);
    assert.equal((await f.request(base+'/initiators','reviewer')).status,403);
  }finally{await f.cleanup();}
  const legacy=await fixture('legacy',fake.options);
  try {assert.equal((await legacy.request('/api/team/directory')).status,404);assert.equal((await legacy.request(base+'/initiators')).status,404);}finally{await legacy.cleanup();}
});

test('T6 initiator: spoofed creator ignored, resolved manager assignment works, unknown target rejects zero writes',async()=>{
  const fake=fakeDirectory();const f=await fixture('kjx',fake.options);
  try {
    const added=await f.ops('reviewer',[{type:'comment.add',id:'C',roundIdNew:'R',initiator:'Forged',initiatorId:'other'}]);assert.equal(added.status,200);
    let round=f.hub.pcf.storage.load(P,D).data.comments[0].rounds[0];assert.equal(round.initiatorId,'owner');assert.equal(round.initiator,'Owner Name');
    const assign=await f.ops('manager',[{type:'round.meta',commentId:'C',roundId:'R',field:'initiator',initiatorId:'other',value:'Forged',baseRev:0}]);
    assert.equal(assign.status,200);assert.equal((await assign.json()).applied.length,1);
    round=f.hub.pcf.storage.load(P,D).data.comments[0].rounds[0];assert.equal(round.initiatorId,'other');assert.equal(round.initiator,'Name other');
    const before=f.hub.pcf.storage.load(P,D);
    const unknown=await f.ops('manager',[{type:'comment.add',id:'never',roundIdNew:'never-round'},{type:'round.meta',commentId:'C',roundId:'R',field:'initiator',initiatorId:'missing',value:'Missing',baseRev:before.data.hub.entities['round:R:initiator'].rev}]);
    assert.equal(unknown.status,400);assert.deepEqual(f.hub.pcf.storage.load(P,D),before);
    const reviewer=await f.ops('reviewer',[{type:'round.meta',commentId:'C',roundId:'R',field:'initiator',initiatorId:'owner',baseRev:0,value:'Owner Name'}]);assert.equal(reviewer.status,403);
  }finally{await f.cleanup();}
});

test('PCF close/reopen stores the authenticated user and survives reload and export', async () => {
  const f = await fixture();
  try {
    for (const id of ['closer', 'second']) f.hub.db.prepare('INSERT OR IGNORE INTO project_team_reviewers VALUES(?,?)').run(P, id);
    await f.ops('reviewer', [{ type: 'comment.add', id: 'C', roundIdNew: 'R' }]);
    const close = await f.ops('manager', [{ type: 'comment.status', commentId: 'C', value: 'closed', baseRev: 0, closedBy: 'Forged', closedById: 'forged' }], { sub: 'closer', name: 'Actual Closer' });
    assert.equal(close.status, 200);
    let result = await close.json(); assert.equal(result.data.comments[0].closedBy, 'Actual Closer'); assert.equal(result.data.comments[0].closedById, 'closer');
    const loaded = await (await f.request(base + '/data')).json(); assert.equal(loaded.data.comments[0].closedBy, 'Actual Closer');
    const html = await (await f.request('/pcf/' + P + '/' + D)).text(); assert.equal(parseHTML(html).comments[0].closedById, 'closer');
    const exported = await (await f.request(base + '/exports', 'manager', {})).json();
    const copy = parseHTML(await (await f.request(base + '/exports/' + exported.exportId + '/download', 'manager')).text());
    assert.equal(copy.comments[0].closedBy, 'Actual Closer');
    const reopen = await f.ops('manager', [{ type: 'comment.status', commentId: 'C', value: 'open', baseRev: loaded.data.hub.entities['comment:C:status'].rev }]);
    assert.equal(reopen.status, 200); result = await reopen.json(); assert.equal(result.data.comments[0].closedBy, undefined);
    const reclose = await f.ops('manager', [{ type: 'comment.status', commentId: 'C', value: 'closed', baseRev: result.data.hub.entities['comment:C:status'].rev }], { sub: 'second', name: 'Second Closer' });
    assert.equal(reclose.status, 200); assert.equal((await reclose.json()).data.comments[0].closedBy, 'Second Closer');
  } finally { await f.cleanup(); }
});

test('T6 initiator: directory outage permits a validated project-team snapshot, never manual identities',async()=>{
  const f=await fixture();
  try {
    await f.ops('reviewer',[{type:'comment.add',id:'C',roundIdNew:'R'}]);
    f.hub.db.prepare('INSERT INTO reviewers VALUES(?,?)').run('team-user','Team Snapshot');
    f.hub.db.prepare('INSERT INTO discipline_defaults VALUES(?,?,?)').run(P,'Hull','team-user');
    const response=await f.ops('manager',[{type:'round.meta',commentId:'C',roundId:'R',field:'initiator',initiatorId:'team-user',baseRev:0,value:'Forged'}]);assert.equal(response.status,200);
    assert.equal(f.hub.pcf.storage.load(P,D).data.comments[0].rounds[0].initiator,'Team Snapshot');
    assert.equal((await f.ops('manager',[{type:'round.meta',commentId:'C',roundId:'R',field:'initiator',initiatorId:'manual-name',baseRev:0,value:'Manual'}])).status,400);
  }finally{await f.cleanup();}
});

test('T6 Builder import audit exposes verified importer and legacy API omits actor fields',async()=>{
  const f=await fixture();
  try {
    await f.ops('reviewer',[{type:'comment.add',id:'C',roundIdNew:'R'}]);
    const exported=await (await f.request(base+'/exports','manager',{})).json();
    const returned=parseHTML(await (await f.request(base+'/exports/'+exported.exportId+'/download','manager')).text());
    returned.comments[0].rounds[0].reply={text:'Reply',html:'',fill:'',images:[]};const html=standaloneHTML(returned);
    const preview=await (await f.request(base+'/imports','manager',{step:'preview',html})).json();
    assert.equal((await f.request(base+'/imports','manager',{step:'apply',html,previewToken:preview.previewToken,batchId:randomUUID()},{sub:'importer',name:'Importer Name'})).status,200);
    const row=f.hub.db.prepare("SELECT * FROM audit_log WHERE action='BUILDER_REPLY'").get()!;
    assert.equal(row.actor_id,'importer');assert.equal(row.actor_name,'Importer Name');
    const log=await (await f.request('/api/projects/'+P+'/audit?from=2000&to=2100','reviewer')).json();
    assert.ok(log.entries.some((e:any)=>e.action==='BUILDER_REPLY'&&e.actorId==='importer'&&e.actorName==='Importer Name'));
    assert.equal(f.hub.pcf.storage.load(P,D).data.comments[0].rounds[0].responderId,undefined);
  }finally{await f.cleanup();}
  const legacy=await fixture('legacy');
  try {
    writeAudit(legacy.hub.db,{table:'drawings',rowId:D,projectId:P,action:'STATUS',detail:{from:'Pending',to:'Reviewing'}});
    const log=await (await legacy.request('/api/projects/'+P+'/audit?from=2000&to=2100')).json();assert.ok(log.entries.length);assert.equal(Object.hasOwn(log.entries[0],'actorId'),false);
  }finally{await legacy.cleanup();}
});

test('T6 Actor options, filtering, CSV/Copy and PDF report markup include identity without cross-person merging',async()=>{
  const rows=[{actorId:'a',actorName:'Alex',detail:'One'},{actorId:'b',actorName:'B, "Name"',detail:'Two'},{actorId:null,actorName:null,detail:'Old'}];
  assert.equal(actorLabel(rows[2]),'—');assert.equal(actorOptions(rows).length,2);
  assert.deepEqual(filterActor(rows,'a'),[rows[0]]);
  assert.match(actorExport(['Detail'],rows,row=>[row.detail],true),/"Actor"/);
  assert.match(actorExport(['Detail'],rows,row=>[row.detail],true),/"B, ""Name"""/);
  assert.match(actorExport(['Detail'],rows,row=>[row.detail],false),/Actor/);
  const source=await readFile('components/DailyLogReport.tsx','utf8');assert.match(source,/print-actor-log/);assert.match(source,/actorLabel\(row\)/);assert.match(source,/row\.actorId \|\| ''/);
});

test('T6 template dry-run and fec6429 readers preserve IDs without a persistent template bump',async()=>{
  const data=initData(parseHTML(currentTemplate()));
  data.comments=[];data.deleted=[];data.nextCommentNumber=1;
  const {applyOps}=await import('../src/pcf-model.ts');
  applyOps(data,[{type:'comment.add',id:'C',roundIdNew:'R'}],{clientId:'client',clientName:'',ip:''},2,{sub:'creator',name:'Creator'});
  const html=renderTemplate(data),dir=await mkdtemp(path.join(tmpdir(),'pahub-t6-upgrade-')),file=path.join(dir,'new.html');
  try {
    await writeFile(file,html);assert.equal(upgradeFile(file,true).status,'current');assert.equal(await readFile(file,'utf8'),html);assert.equal(TEMPLATE_VERSION,6);
    const baselineReader=execFileSync('git',['show','fec6429:hub-server/src/pcf-html.ts'],{encoding:'utf8'});
    const baselineModel=execFileSync('git',['show','fec6429:hub-server/src/pcf-model.ts'],{encoding:'utf8'});
    assert.equal(baselineReader.replace(/\r\n/g,'\n'),(await readFile('hub-server/src/pcf-html.ts','utf8')).replace(/\r\n/g,'\n'));
    assert.match(baselineModel,/for \(const side of \['owner', 'reply'\]\) r\[side\] = cleanContent\(r\[side\]\)/);
    const read=parseHTML(html);assert.equal(read.comments[0].rounds[0].initiatorId,'creator');assert.equal(initData(read).comments[0].rounds[0].initiatorId,'creator');
    // Execute the actual fec6429 model and reader, not just their current equivalent.
    const oldDir=path.join(dir,'baseline');await mkdir(oldDir);
    for(const name of ['pcf-model.ts','pcf-v26.ts','pcf-html.ts'])await writeFile(path.join(oldDir,name),execFileSync('git',['show','fec6429:hub-server/src/'+name],{encoding:'utf8'}).replace('../../lib/rounds.ts',path.join(process.cwd(),'lib/rounds.ts').replace(/\\/g,'/')));
    await writeFile(path.join(oldDir,'entry.ts'),"export {initData} from './pcf-model.ts'; export {parseHTML} from './pcf-html.ts';");
    const bundle=await build({entryPoints:[path.join(oldDir,'entry.ts')],bundle:true,platform:'node',format:'esm',write:false});
    const old=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
    assert.equal(old.initData(old.parseHTML(html)).comments[0].rounds[0].initiatorId,'creator');
    assert.equal(old.initData(JSON.parse(JSON.stringify(data))).comments[0].rounds[0].initiatorId,'creator');
    const legacyFile=path.join(dir,'old.html'),legacy=html.replace('name="pahub-template-version" content="6"','name="pahub-template-version" content="5"');
    await writeFile(legacyFile,legacy);assert.equal(upgradeFile(legacyFile,true).status,'would-upgrade');assert.equal(await readFile(legacyFile,'utf8'),legacy);
    const pcfDir=path.join(dir,'pcf','project');await mkdir(pcfDir,{recursive:true});await writeFile(path.join(pcfDir,'drawing.html'),html);
    const cli=JSON.parse(execFileSync(process.execPath,['hub-server/scripts/upgrade-pcf.mjs','--dry-run'],{encoding:'utf8',env:{...process.env,PAHUB_DATA_DIR:dir}}));
    assert.equal(cli.dryRun,true);assert.equal(cli.files,1);assert.equal(await readFile(path.join(pcfDir,'drawing.html'),'utf8'),html);
  }finally{await rm(dir,{recursive:true,force:true});}
});
