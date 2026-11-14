import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../src/app.ts';
import { createKjxTestSigner, createKjxVerifier } from '../src/kjx-auth-client.ts';
import { authorizeOps, OP_CAPABILITIES } from '../src/pcf-op-auth.ts';
import { CAPABILITIES, TRANSPORT_POLICIES, type Capability } from '../src/capabilities.ts';
import { identityConfig, type RequestUser } from '../src/identity.ts';
import { readConfig } from '../src/config.ts';
import { PcfApi } from '../src/pcf-api.ts';
import { initializeIdentitySchema, writeAudit } from '../src/audit.ts';
import { kjxDiscipline } from '../src/discipline-map.ts';
import { JSDOM } from 'jsdom';
import { createApiClient } from '../../services/api/apiClient';
import { parseHTML, replaceData } from '../src/pcf-storage.ts';
import { blankContent } from '../src/pcf-model.ts';

const PUBLIC = 'https://pahub.kjxing.com';
const PROJECT = 'proj-test-001', DRAWING = 'dwg-001';
const pcf = '/api/pcf/' + PROJECT + '/' + DRAWING;
const user = (role: RequestUser['role'], id = 'owner'): RequestUser => ({ id, username: id, name: 'Test ' + role, title: null, disciplines: [], role, sid: '' });
const roles = ['admin','manager','reviewer','viewer',null] as const;
async function fixture(mode: 'legacy' | 'kjx' = 'kjx') {
  const keys = ['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','PAPC_DIST_DIR','AUTH_MODE','API_TOKEN','ADMIN_PASSWORD','PAHUB_BASIC_AUTH','PCF_GRANT_SECRET','ALLOW_CORS_ORIGIN','PAHUB_PUBLIC_ORIGIN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const dir = await mkdtemp(path.join(tmpdir(),'pahub-kjx-'));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir,'papc.db'), PAPC_DIST_DIR: path.join(process.cwd(),'dist'), AUTH_MODE: mode, API_TOKEN: '', ADMIN_PASSWORD: '', PAHUB_BASIC_AUTH: '', ALLOW_CORS_ORIGIN: '', PAHUB_PUBLIC_ORIGIN: PUBLIC });
  delete process.env.PCF_GRANT_SECRET;
  const signer = createKjxTestSigner();
  const verifier = createKjxVerifier({ jwksUrl:'http://kjx.test/jwks',issuer:'https://auth.kjxing.com',audience:'pahub',fetch:signer.fetch });
  const hub = await createHub({verifier});
  hub.db.exec(await readFile(path.join(process.cwd(),'hub-server/test/fixtures/seed-test-data.sql'),'utf8'));
  if (mode==='kjx') hub.db.prepare('UPDATE drawings SET discipline=? WHERE id=?').run('Hull',DRAWING);
  const origin = 'http://127.0.0.1:' + hub.port;
  const request = (url: string, role: typeof roles[number] = 'admin', init: RequestInit = {}, claims: Record<string,unknown> = {}) => {
    const headers = new Headers(init.headers);
    if (role) headers.set('X-Auth-Token',signer.signUser('pahub',{sub:'owner',username:'tester',name:'Test '+role,role,...claims}));
    if (['POST','PUT','PATCH','DELETE'].includes(init.method || 'GET') && !headers.has('Origin') && !headers.has('Referer')) headers.set('Origin',PUBLIC);
    return fetch(origin+url,{...init,headers,redirect:'manual'});
  };
  const json = (body: unknown, method = 'POST'): RequestInit => ({method,body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
  const cleanup = async () => {
    await hub.close();
    for (const [key,value] of Object.entries(previous)) if (value===undefined) delete process.env[key]; else process.env[key]=value;
    await rm(dir,{recursive:true,force:true});
  };
  return {hub,signer,origin,request,json,cleanup,dir};
}

const opCases = [
  { type:'comment.add', id:'new-comment', roundIdNew:'new-round' },
  { type:'round.add', commentId:'C', id:'new-round' },
  { type:'content.set', commentId:'C', roundId:'R', side:'owner', value:{text:'Changed'} },
  { type:'comment.status', commentId:'C', value:'closed' },
  { type:'comment.meta', commentId:'C', value:{page:'2'} },
  { type:'round.meta', commentId:'C', roundId:'R', field:'minHeight', value:30 },
  { type:'project.set', field:'planTitle', value:'Title' },
  { type:'settings.set', field:'theme', value:'light' },
  { type:'roundRegister.set', round:1, value:{} },
  { type:'record.delete', commentId:'C' },
  { type:'record.restore', deleteId:'deleted' },
  { type:'rounds.addAll', round:2 },
  { type:'history.set', field:'approvalHistory', value:[] },
];

test('kjx: all 13 operation kinds × roles × own/other/missing ownership fail closed', () => {
  assert.equal(opCases.length,13);
  assert.deepEqual(new Set(opCases.map(op=>op.type)),new Set(Object.keys(OP_CAPABILITIES)));
  for (const role of roles) for (const ownership of ['owner','other',undefined]) for (const op of opCases) {
    const doc = {comments:[{id:'C',rounds:[{id:'R',initiatorId:ownership}]}]};
    const expected = role==='admin' || role==='manager' || role==='reviewer' && (['comment.add','round.add'].includes(op.type) || ownership==='owner' && ['content.set','comment.status','comment.meta','round.meta'].includes(op.type));
    assert.equal(authorizeOps(role ? user(role) : null,[op],doc).ok,expected,`${role}/${ownership}/${op.type}`);
  }
  const doc = {comments:[{id:'C',rounds:[{id:'R',initiatorId:'owner'}]}]};
  for (const op of [
    {type:'content.set',commentId:'C',roundId:'R',side:'reply'},
    ...['initiator','responder','initiatorId'].map(field=>({type:'round.meta',commentId:'C',roundId:'R',field})),
  ]) assert.equal(authorizeOps(user('reviewer'),[op],doc).ok,false);
  for (const role of roles) assert.equal(authorizeOps(role ? user(role) : null,[{type:'new.op'}],doc).ok,false);
  const mixed = {comments:[{id:'C',rounds:[{id:'R',initiatorId:'owner'},{id:'other',initiatorId:'other'}]}]};
  assert.equal(authorizeOps(user('reviewer'),[{type:'comment.status',commentId:'C'}],mixed).ok,false);
});

test('kjx: identity failure cases, health-only exemption, session and throttled user cache', async () => {
  const f=await fixture();
  try {
    assert.equal((await f.request('/api/health',null)).status,200);
    const invalid = [
      undefined,
      f.signer.signUser('nbins',{role:'admin'}),
      f.signer.signUser('pahub',{role:'admin'},{now:Date.now()-3600000}),
      f.signer.sign({iss:'https://auth.kjxing.com',aud:'pahub',sub:'client:test',exp:9e9},{typ:'svc+jwt'}),
      createKjxTestSigner().signUser('pahub',{role:'admin'}),
    ];
    for (const value of invalid) {
      const headers: Record<string,string> = value ? {'X-Auth-Token':value} : {};
      const response=await fetch(f.origin+'/api/session',{headers});
      assert.equal(response.status,401);
      assert.equal((await response.json()).error,'unauthenticated');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    }
    assert.equal((await f.request('/api/session','admin',{}, {role:'unknown'})).status,403);
    const page=await f.request('/?project=test',null);
    assert.equal(page.status,302);
    assert.equal(new URL(page.headers.get('Location')!).searchParams.get('path'),'/?project=test');
    for (const role of ['admin','manager','reviewer','viewer'] as const) {
      const session=await (await f.request('/api/session',role,{}, {sub:role})).json();
      assert.equal(session.mode,'kjx');assert.equal(session.user.role,role);
      assert.equal(session.admin,role==='admin');assert.equal(session.isAdmin,role==='admin');
      assert.equal(session.permissions.includes('admin.console'),role==='admin');
      assert.equal(session.auth.logoutUrl,'https://auth.kjxing.com/logout');
    }
    const first=f.hub.db.prepare('SELECT * FROM kjx_users WHERE id=?').get('reviewer');
    await f.request('/api/session','reviewer',{}, {sub:'reviewer',name:'Updated'});
    assert.deepEqual(f.hub.db.prepare('SELECT * FROM kjx_users WHERE id=?').get('reviewer'),first);
    for (const method of ['POST','DELETE']) assert.equal((await f.request('/api/session','reviewer',{method})).status,410);
    assert.equal((await f.request('/api/admin/auth','admin',{method:'POST'})).status,410);
    assert.equal((await f.request('/api/admin/auth','reviewer',{method:'POST'})).status,403);
  } finally {await f.cleanup();}
});

// Independent, literal method/path expectations transcribed from T1 §1/B, with
// approved T2 decision overrides. Never generate these from policies or their samples.
// null means the inventory's unsupported/fail-closed path, not an allowed role.
type RouteExample = readonly [method: string, path: string, capability: Capability | 'route.unregistered', minimum: RequestUser['role'] | null];
const ROUTE_EXAMPLES: readonly RouteExample[] = [
  ['GET','/api/session','view','viewer'],
  ['POST','/api/session','view','viewer'],
  ['DELETE','/api/session','view','viewer'],
  ['GET','/api','view','viewer'],
  ['GET','/api/','view','viewer'],
  ['GET','/api/settings','view','viewer'],
  ['GET','/api/health','view','viewer'],
  ['GET','/api/projects','view','viewer'],
  ['POST','/api/projects/proj-test-001/unlock','view','viewer'],
  ['POST','/api/projects/proj-test-001','view','viewer'],
  ['PATCH','/api/projects/proj-test-001','drawing.update','manager'],
  ['GET','/api/projects/proj-test-001/drawings','view','viewer'],
  ['POST','/api/projects/proj-test-001/drawings/dwg-001/status','drawing.update','manager'],
  ['GET','/api/projects/proj-test-001/comments','view','viewer'],
  ['GET','/api/projects/proj-test-001/comments.xlsx','view','viewer'],
  ['GET','/api/projects/proj-test-001/events','view','viewer'],
  ['GET','/api/projects/proj-test-001/review-tracker','view','viewer'],
  ['PUT','/api/projects/proj-test-001/review-tracker','admin.only','admin'],
  ['GET','/api/projects/proj-test-001/audit','view','viewer'],
  ['GET','/api/projects/proj-test-001/heartbeat','view','viewer'],
  ['PUT','/api/projects/proj-test-001/heartbeat','admin.only','admin'],
  ['GET','/api/projects/proj-test-001/builder-replies/pending','builder.import_reply','manager'],
  ['POST','/api/projects/proj-test-001/builder-replies/preview','builder.import_reply','manager'],
  ['POST','/api/projects/proj-test-001/builder-replies/11111111-1111-4111-8111-111111111111/apply','builder.import_reply','manager'],
  ['POST','/api/projects/proj-test-001/builder-replies/11111111-1111-4111-8111-111111111111/skip','builder.import_reply','manager'],
  ['GET','/api/projects/proj-test-001/builder-replies/11111111-1111-4111-8111-111111111111/file/22222222-2222-4222-8222-222222222222','builder.import_reply','manager'],
  ['DELETE','/api/projects/proj-test-001/builder-replies/pending','route.unregistered',null],
  ['GET','/api/pcf/proj-test-001/index','view','viewer'],
  ['GET','/api/pcf/proj-test-001/presence','view','viewer'],
  ['POST','/api/pcf/proj-test-001/exports/batch','builder.export','manager'],
  ['GET','/pcf/proj-test-001/dwg-001','view','viewer'],
  ['HEAD','/pcf/proj-test-001/dwg-001','view','viewer'],
  ['GET','/pcf/proj-test-001/dwg-001/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','view','viewer'],
  ['HEAD','/pcf/proj-test-001/dwg-001/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','view','viewer'],
  ['POST','/api/pcf/proj-test-001/dwg-001/session','view','viewer'],
  ['GET','/api/pcf/proj-test-001/dwg-001/events','view','viewer'],
  ['GET','/api/pcf/proj-test-001/dwg-001/meta','view','viewer'],
  ['GET','/api/pcf/proj-test-001/dwg-001/data','view','viewer'],
  ['GET','/api/pcf/proj-test-001/dwg-001/presence','view','viewer'],
  ['GET','/api/pcf/proj-test-001/dwg-001/exports','view','viewer'],
  ['GET','/api/pcf/proj-test-001/dwg-001/history','view','viewer'],
  ['POST','/api/pcf/proj-test-001/dwg-001/create','admin.only','admin'],
  ['POST','/api/pcf/proj-test-001/dwg-001/presence','pcf.presence','viewer'],
  ['POST','/api/pcf/proj-test-001/dwg-001/ops','pcf.comment.create','reviewer'],
  ['PUT','/api/pcf/proj-test-001/dwg-001/document','pcf.replace','manager'],
  ['POST','/api/pcf/proj-test-001/dwg-001/exports','builder.export','manager'],
  ['POST','/api/pcf/proj-test-001/dwg-001/imports','builder.import_reply','manager'],
  ['GET','/api/pcf/proj-test-001/dwg-001/download','builder.export','manager'],
  ['GET','/api/pcf/proj-test-001/dwg-001/exports/11111111-1111-4111-8111-111111111111/download','builder.export','manager'],
  ['POST','/api/pcf/proj-test-001/dwg-001/exports/11111111-1111-4111-8111-111111111111/void','drawing.void','admin'],
  ['POST','/api/pcf/proj-test-001/dwg-001/history/1/restore','history.restore','admin'],
  ['POST','/api/pcf/proj-test-001/dwg-001/unknown','route.unregistered',null],
  ['GET','/api/admin','admin.console','admin'],
  ['POST','/api/admin/auth','admin.console','admin'],
  ['GET','/api/admin/api/tables','admin.console','admin'],
  ['GET','/api/admin/api/tables/reviewers/schema','admin.console','admin'],
  ['GET','/api/admin/api/tables/reviewers','admin.console','admin'],
  ['POST','/api/admin/api/tables/reviewers','admin.console','admin'],
  ['PUT','/api/admin/api/tables/reviewers/engineer_a','admin.console','admin'],
  ['DELETE','/api/admin/api/tables/reviewers/engineer_a','admin.console','admin'],
  ['POST','/api/admin/api/sql','admin.console','admin'],
  ['GET','/api/admin/api/export','admin.console','admin'],
  ['POST','/api/admin/api/import','admin.console','admin'],
  ['GET','/api/admin/unknown','route.unregistered',null],
  ['GET','/','view','viewer'],
  ['HEAD','/','view','viewer'],
  ['GET','/manual/','view','viewer'],
  ['HEAD','/manual/','view','viewer'],
  ['GET','/pg-logo.jpg','view','viewer'],
  ['HEAD','/pg-logo.jpg','view','viewer'],
  ['OPTIONS','/api/projects','view','viewer'],
  ['OPTIONS','/api/admin/api/sql','view','viewer'],
  ['OPTIONS','/api/health','view','viewer'],
];

test('kjx: independent T1 method/path inventory and policies cover each other in both directions', async () => {
  const f=await fixture();
  try {
    const routes=f.hub.router.registeredRoutes();
    const policies=routes.flatMap(route=>{
      assert.ok(route.policies?.length,route.pattern.toString());
      for(const method of route.methods || []) assert.ok(route.policies.some(p=>p.method===method),route.pattern+' '+method);
      return route.policies.map(policy=>{
        assert.ok(Object.hasOwn(CAPABILITIES,policy.capability));
        return {policy,matches:(method:string,url:string)=>policy.method===method && route.pattern.test(url) && (!policy.pattern || policy.pattern.test(url))};
      });
    }).concat(TRANSPORT_POLICIES.map(policy=>({policy,matches:(method:string,url:string)=>policy.method===method && policy.pattern!.test(url)})));
    assert.equal(new Set(ROUTE_EXAMPLES.map(([method,url])=>method+' '+url)).size,ROUTE_EXAMPLES.length,'duplicate inventory instance');
    const checkCoverage=(examples:readonly RouteExample[],entries:typeof policies)=>{
      for(const [method,url,capability,minimum]of examples){
        const matched=entries.filter(entry=>entry.matches(method,url));
        assert.equal(matched.length,minimum===null ? 0 : 1,'inventory → policy: '+method+' '+url);
        if(minimum!==null) assert.equal(matched[0].policy.capability,capability,method+' '+url);
      }
      for(const entry of entries) assert.ok(examples.some(([method,url,,minimum])=>minimum!==null && entry.matches(method,url)),'policy → inventory: '+entry.policy.method+' '+entry.policy.pattern);
    };
    checkCoverage(ROUTE_EXAMPLES,policies);
    // Prove both guards detect omissions instead of deriving their expectations from policy samples.
    assert.throws(()=>checkCoverage(ROUTE_EXAMPLES.filter(([method,url])=>!(method==='GET'&&url==='/api/session')),policies),/policy → inventory/);
    assert.throws(()=>checkCoverage(ROUTE_EXAMPLES,policies.filter(entry=>!entry.matches('GET','/api/session'))),/inventory → policy/);
    const rank={viewer:0,reviewer:1,manager:2,admin:3};
    for(const [method,url,capability,minimum]of ROUTE_EXAMPLES) for(const role of roles){
      const abort=new AbortController();
      try{
        const init:RequestInit={method,signal:abort.signal};
        if(['POST','PUT','PATCH'].includes(method)){init.body='{}';init.headers={'Content-Type':'application/json'};}
        const response=await f.request(url,role,init);
        if(!role) assert.equal(response.status,method==='GET'&&url==='/api/health' ? 200 : url==='/api'||url.startsWith('/api/') ? 401 : 302,method+' '+url);
        else if(minimum===null || rank[role]<rank[minimum]){
          assert.equal(response.status,403,role+' '+method+' '+url);
          if(method!=='HEAD') assert.equal((await response.json()).capability,capability);
        }else assert.notEqual(response.status,403,role+' '+method+' '+url);
      }finally{abort.abort();}
    }
    f.hub.router.add({pattern:/^\/api\/unregistered$/,methods:['POST'],handle:()=>Response.json({ok:true})});
    const denied=await f.request('/api/unregistered','admin',{method:'POST'});
    assert.equal(denied.status,403);assert.equal((await denied.json()).capability,'route.unregistered');
  } finally {await f.cleanup();}
});

for (const mode of ['legacy','kjx'] as const) test(`${mode}: uploaded Builder HTML is a sandboxed attachment and fetch/blob stays byte-identical`, async () => {
  const f=await fixture(mode);
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'admin');
    const current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    await f.request(pcf+'/ops','admin',f.json({clientId:'setup',baseRev:current.rev,ops:[{type:'comment.add',id:'attachment-comment',roundIdNew:'attachment-round'}]}));
    const exported=await (await f.request(pcf+'/exports','manager',f.json({}))).json();
    const html=await (await f.request(pcf+'/exports/'+exported.exportId+'/download','manager')).text();
    const data=parseHTML(html);
    data.comments[0].rounds[0].reply={...blankContent(),text:'Builder attachment reply'};
    const uploaded=replaceData(html,data).replace('</head>','<script>window.uploadedBuilderScriptExecuted=true;</script></head>');
    const form=new FormData();form.append('files',new Blob([uploaded]),'untrusted-builder.html');
    const preview=await f.request('/api/projects/'+PROJECT+'/builder-replies/preview','manager',{method:'POST',body:form});
    assert.equal(preview.status,200);
    const set=await preview.json();assert.equal(set.files[0].category,'clean');
    const response=await f.request('/api/projects/'+PROJECT+'/builder-replies/'+set.importSetId+'/file/'+set.files[0].id,'admin');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('Content-Type'),'application/octet-stream');
    assert.equal(response.headers.get('Content-Disposition'),'attachment; filename="builder-reply.html"');
    assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
    assert.equal(response.headers.get('Content-Security-Policy'),'sandbox');
    const blob=await response.blob();assert.equal(await blob.text(),uploaded);
    const file=new File([blob],'builder-reply.html',{type:'text/html'});
    assert.equal(file.type,'text/html');assert.deepEqual(parseHTML(await file.text()),data);
    const handoff=await (await f.request('/pcf/'+PROJECT+'/'+DRAWING+'?builderReplySet='+set.importSetId+'&builderReplyFile='+set.files[0].id,'admin')).text();
    assert.match(handoff,/const blob=await response\.blob\(\),file=new File\(\[blob\],"builder-reply\.html",\{type:"text\/html"\}\)/);
  } finally {await f.cleanup();}
});

test('kjx: PATCH authorization is per-entry and atomically rejects mixed/unknown/implicit creation', async () => {
  const f=await fixture();
  try {
    const before=f.hub.db.prepare('SELECT * FROM drawings WHERE id=?').get(DRAWING);
    for (const body of [
      {updatedDrawings:[{id:DRAWING,changes:{title:'Forbidden batch'}}],conf:{holidays:[]}},
      {updatedDrawings:[{id:DRAWING,changes:{title:'Forbidden batch',unknown:'x'}}]},
      {updatedDrawings:[{id:DRAWING,changes:{title:'Forbidden batch'}}],deletedDrawingIds:['dwg-002']},
      {updatedDrawings:[{id:DRAWING,changes:{title:'Forbidden batch'}}],reviewTracker:{[DRAWING]:{}}},
      {updatedDrawings:[{id:DRAWING,changes:{title:'Forbidden batch'}}],unknown:'x'},
    ]) {
      const response=await f.request('/api/projects/'+PROJECT,'manager',f.json(body,'PATCH'));
      assert.equal(response.status,403,JSON.stringify(body));
      assert.deepEqual(f.hub.db.prepare('SELECT * FROM drawings WHERE id=?').get(DRAWING),before);
    }
    assert.equal((await f.request('/api/projects/implicit','manager',f.json({},'PATCH'))).status,403);
    assert.equal(f.hub.db.prepare('SELECT 1 FROM projects WHERE id=?').get('implicit'),undefined);
    assert.equal((await f.request('/api/projects/'+PROJECT,'manager',f.json({updatedDrawings:[{id:DRAWING,changes:{title:'Manager title'}}]},'PATCH'))).status,200);
    assert.equal(f.hub.db.prepare('SELECT title FROM drawings WHERE id=?').get(DRAWING)?.title,'Manager title');
  } finally {await f.cleanup();}
});

test('kjx: HTTP ops denial is atomic, old rounds are not own, audit is one row per batch', async () => {
  const f=await fixture();
  try {
    assert.equal((await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer')).status,200);
    const start=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const body={clientId:'client',baseRev:start.rev,ops:[{type:'comment.add',id:'C',roundIdNew:'R'},{type:'settings.set',field:'theme',value:'light',baseRev:0}]};
    const denied=await f.request(pcf+'/ops','reviewer',f.json(body));
    assert.equal(denied.status,403);assert.equal((await denied.json()).op,1);
    assert.equal(f.hub.pcf.storage.load(PROJECT,DRAWING).rev,start.rev);
    assert.equal(f.hub.pcf.storage.load(PROJECT,DRAWING).data.comments.length,0);
    const count=Number(f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n);
    const added=await f.request(pcf+'/ops','reviewer',f.json({...body,ops:[body.ops[0],{type:'comment.add',id:'C2',roundIdNew:'R2'}]}));
    assert.equal(added.status,200);
    assert.equal(Number(f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n),count+1);
    const audit=f.hub.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get()!;
    assert.equal(audit.actor_id,'owner');assert.equal(audit.actor_name,'Test reviewer');
    assert.deepEqual(JSON.parse(String(audit.op_types)),['comment.add','comment.add']);
    // Exercise an actual pre-identity round, not a newly attributed kjx round.
    const old=f.hub.pcf.storage.load(PROJECT,DRAWING);
    for (const comment of old.data.comments) for (const round of comment.rounds) delete round.initiatorId;
    await writeFile(f.hub.pcf.storage.file(PROJECT,DRAWING),JSON.stringify(old.data));
    const current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const edit=await f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:current.rev,ops:[{type:'content.set',commentId:'C',roundId:'R',side:'owner',value:{text:'Denied'},baseRev:0}]}));
    assert.equal(edit.status,403);assert.equal(f.hub.pcf.storage.load(PROJECT,DRAWING).rev,current.rev);
    const expectedTypes = ['comment.add','round.add','content.set','comment.status','comment.meta','round.meta','project.set','settings.set','roundRegister.set','record.delete','record.restore','rounds.addAll','history.set'];
    for (const role of roles) for (const op of opCases) {
      const before=f.hub.pcf.storage.load(PROJECT,DRAWING);
      const payload={clientId:'matrix-client',baseRev:before.rev,ops:[{...op,baseRev:0}]};
      const response=await f.request(pcf+'/ops',role,f.json(payload));
      const allowed=role==='admin'||role==='manager'||role==='reviewer'&&['comment.add','round.add'].includes(op.type);
      if (!role) assert.equal(response.status,401);
      else if (!allowed) {assert.equal(response.status,403,role+'/'+op.type);assert.equal(f.hub.pcf.storage.load(PROJECT,DRAWING).rev,before.rev);}
      else assert.notEqual(response.status,403,role+'/'+op.type);
    }
    assert.deepEqual(opCases.map(op=>op.type),expectedTypes);
    f.hub.db.prepare('UPDATE drawings SET discipline=? WHERE id=?').run('Unknown discipline',DRAWING);
    const noDiscipline=await f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:current.rev,ops:[{type:'comment.add',id:'unmapped',roundIdNew:'unmapped-round'}]}));
    assert.equal(noDiscipline.status,403);
    const unknown=await f.request(pcf+'/ops','admin',f.json({clientId:'client',baseRev:current.rev,ops:[{type:'unknown'}]}));
    assert.equal(unknown.status,403);
  } finally {await f.cleanup();}
});

test('kjx: owned-round HTTP edits succeed only for owner-side and matching user', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'admin');
    let current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const added=await f.request(pcf+'/ops','reviewer',f.json({clientId:'setup',baseRev:current.rev,ops:[{type:'comment.add',id:'owned-comment',roundIdNew:'owned-round',initiator:'Forged',initiatorId:'other',responderId:'other'}]}));
    assert.equal(added.status,200);
    current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    assert.equal(current.data.comments[0].rounds[0].initiatorId,'owner');
    assert.equal(current.data.comments[0].rounds[0].initiator,'Test reviewer');
    assert.equal(current.data.comments[0].rounds[0].responderId,undefined);
    const submit=async(role:typeof roles[number],op:Record<string,unknown>,claims={})=>{
      const latest=f.hub.pcf.storage.load(PROJECT,DRAWING);
      return f.request(pcf+'/ops',role,f.json({clientId:'editor',baseRev:latest.rev,ops:[{...op,commentId:'owned-comment',roundId:'owned-round',baseRev:0}]}),claims);
    };
    const changed=await submit('reviewer',{type:'content.set',side:'owner',value:{text:'Own edit',html:'',images:[]}});
    assert.equal(changed.status,200);assert.equal((await changed.json()).applied.length,1);
    assert.equal((await submit('reviewer',{type:'content.set',side:'owner',value:{text:'Other edit'}},{sub:'other'})).status,403);
    assert.equal((await submit('reviewer',{type:'content.set',side:'reply',value:{text:'Reply'}})).status,403);
    assert.equal((await submit('reviewer',{type:'round.meta',field:'initiator',value:'Someone'})).status,403);
    assert.equal((await submit('reviewer',{type:'round.meta',field:'minHeight',value:200})).status,200);
    assert.equal((await submit('reviewer',{type:'comment.meta',value:{page:'7'}})).status,200);
    assert.equal((await submit('reviewer',{type:'comment.status',value:'closed'})).status,200);
    const presence=await f.request(pcf+'/presence','reviewer',f.json({clientId:'presence-client',clientName:'Forged name'}));
    assert.equal(presence.status,200);
    assert.equal((await presence.json()).online.find((entry:any)=>entry.clientId==='presence-client').clientName,'Test reviewer');
  } finally {await f.cleanup();}
});

test('kjx integration: create and edit in one batch uses only verified ownership', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    const current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const response=await f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:current.rev,requestActor:{sub:'forged',name:'Forged'},ops:[
      {type:'comment.add',id:'C',roundIdNew:'R',initiatorId:'forged',initiator:'Forged'},
      {type:'content.set',commentId:'C',roundId:'R',side:'owner',baseRev:0,value:{text:'Own content',html:'',images:[]}},
      {type:'round.meta',commentId:'C',roundId:'R',field:'minHeight',baseRev:0,value:80},
      {type:'comment.meta',commentId:'C',baseRev:0,value:{page:'5'}},
    ]}));
    assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.applied.length,4);
    const round=result.data.comments[0].rounds[0];
    assert.equal(round.initiatorId,'owner');assert.equal(round.initiator,'Test reviewer');
    assert.equal(round.owner.text,'Own content');assert.equal(round.minHeight,80);
    const latest=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const next=await f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:latest.rev,ops:[
      {type:'round.add',commentId:'C',id:'R2',baseRev:latest.data.hub.entities['comment:C:record'].rev,initiatorId:'forged'},
      {type:'content.set',commentId:'C',roundId:'R2',side:'owner',baseRev:0,value:{text:'Second round',html:'',images:[]}},
    ]}));
    assert.equal(next.status,200);assert.equal((await next.json()).applied.length,2);
    const saved=f.hub.pcf.storage.load(PROJECT,DRAWING).data.comments[0].rounds[1];
    assert.equal(saved.initiatorId,'owner');assert.equal(saved.responderId,undefined);
  } finally {await f.cleanup();}
});

test('kjx integration: all-round ownership gates status/meta and foreign/old edits are atomic', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    const submit=async(role:typeof roles[number],ops:any[],claims={})=>{
      const latest=f.hub.pcf.storage.load(PROJECT,DRAWING);
      return f.request(pcf+'/ops',role,f.json({clientId:'client',baseRev:latest.rev,ops}),claims);
    };
    assert.equal((await submit('reviewer',[{type:'comment.add',id:'C',roundIdNew:'R'}])).status,200);
    assert.equal((await submit('reviewer',[{type:'round.add',commentId:'C',id:'R2'}])).status,200);
    for (const op of [{type:'comment.meta',value:{page:'2'}},{type:'comment.status',value:'closed'}]) {
      const response=await submit('reviewer',[{...op,commentId:'C',baseRev:0}]);
      assert.equal(response.status,200);assert.equal((await response.json()).applied.length,1);
    }
    const closed=f.hub.pcf.storage.load(PROJECT,DRAWING);
    assert.equal((await submit('reviewer',[{type:'comment.status',commentId:'C',value:'open',baseRev:closed.data.hub.entities['comment:C:status'].rev}])).status,200);
    assert.equal((await submit('reviewer',[{type:'round.add',commentId:'C',id:'foreign',initiatorId:'owner'}],{sub:'other'})).status,200);
    let current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    assert.equal(current.data.comments[0].rounds[2].initiatorId,'other');
    for (const roundId of ['foreign','legacy']) {
      if (roundId==='legacy') {
        // The default storage API models offline/legacy creation with no request actor.
        f.hub.pcf.storage.ops(PROJECT,DRAWING,{baseRev:current.rev,ops:[{type:'round.add',commentId:'C',id:'legacy'}]},{clientId:'offline',clientName:'',ip:''});
        current=f.hub.pcf.storage.load(PROJECT,DRAWING);
        assert.equal(current.data.comments[0].rounds.at(-1).initiatorId,undefined);
      }
      for (const op of [
        {type:'content.set',roundId,side:'owner',value:{text:'Forbidden',html:'',images:[]}},
        {type:'round.meta',roundId,field:'minHeight',value:400},
        {type:'comment.status',value:'closed'}, {type:'comment.meta',value:{page:'Forbidden'}},
      ]) {
        const before=f.hub.pcf.storage.load(PROJECT,DRAWING);
        const response=await submit('reviewer',[
          {type:'content.set',commentId:'C',roundId:'R',side:'owner',baseRev:0,value:{text:'Must not land',html:'',images:[]}},
          {...op,commentId:'C',baseRev:0},
        ]);
        assert.equal(response.status,403);assert.equal((await response.json()).op,1);
        assert.deepEqual(f.hub.pcf.storage.load(PROJECT,DRAWING),before);
      }
    }
    const manager=await submit('manager',[{type:'content.set',commentId:'C',roundId:'legacy',side:'owner',baseRev:0,value:{text:'Manager edit',html:'',images:[]}}]);
    assert.equal(manager.status,200);assert.equal((await manager.json()).applied.length,1);
  } finally {await f.cleanup();}
});

test('kjx integration: round.add plus comment.status projects ownership atomically', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    let current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const submit=(ops:any[],claims={})=>f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:current.rev,ops}),claims);
    const created=await submit([{type:'comment.add',id:'C',roundIdNew:'R'}]);assert.equal(created.status,200);
    current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const changed=await submit([
      {type:'round.add',commentId:'C',id:'R2',baseRev:current.data.hub.entities['comment:C:record'].rev,initiatorId:'other'},
      {type:'comment.status',commentId:'C',baseRev:0,value:'closed'},
    ]);
    assert.equal(changed.status,200);assert.equal((await changed.json()).applied.length,2);
    current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    assert.equal(current.data.comments[0].status,'closed');
    assert.equal(current.data.comments[0].rounds[1].initiatorId,'owner');
    assert.equal((await submit([{type:'comment.status',commentId:'C',baseRev:current.data.hub.entities['comment:C:status'].rev,value:'open'}])).status,200);
    current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    assert.equal((await submit([{type:'round.add',commentId:'C',id:'foreign'}],{sub:'other'})).status,200);
    for (const [type,value] of [['comment.status','closed'],['comment.meta',{page:'Forbidden'}]] as const) {
      current=f.hub.pcf.storage.load(PROJECT,DRAWING);
      const before=current;
      const auditCount=f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n;
      const denied=await submit([
        {type:'round.add',commentId:'C',id:'must-not-exist',baseRev:current.data.hub.entities['comment:C:record'].rev},
        {type,commentId:'C',baseRev:current.data.hub.entities['comment:C:'+(type==='comment.status'?'status':'meta')]?.rev || 0,value},
      ]);
      assert.equal(denied.status,403);assert.equal((await denied.json()).op,1);
      assert.deepEqual(f.hub.pcf.storage.load(PROJECT,DRAWING),before);
      assert.equal(f.hub.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n,auditCount);
    }
  } finally {await f.cleanup();}
});

test('kjx integration: bulk rounds use manager identity and ignore submitted participants', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    let current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    assert.equal((await f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:current.rev,ops:[{type:'comment.add',id:'C',roundIdNew:'R'}]}))).status,200);
    current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const body={clientId:'client',baseRev:current.rev,ops:[{type:'rounds.addAll',number:2,baseRev:0,initiatorId:'forged',rounds:[{commentId:'C',id:'R2',recordRev:current.data.hub.entities['comment:C:record'].rev,initiatorId:'forged',responderId:'forged'}]}]};
    assert.equal((await f.request(pcf+'/ops','reviewer',f.json(body))).status,403);
    assert.deepEqual(f.hub.pcf.storage.load(PROJECT,DRAWING),current);
    const response=await f.request(pcf+'/ops','manager',f.json(body),{sub:'manager-id',name:'Manager Name'});
    assert.equal(response.status,200);assert.equal((await response.json()).applied.length,1);
    const round=f.hub.pcf.storage.load(PROJECT,DRAWING).data.comments[0].rounds[1];
    assert.equal(round.initiatorId,'manager-id');assert.equal(round.initiator,'Manager Name');assert.equal(round.responderId,undefined);
  } finally {await f.cleanup();}
});

test('kjx integration: duplicate/tombstoned IDs never grant ownership in a batch', () => {
  const doc={comments:[{id:'C',rounds:[{id:'R',initiatorId:'other'}]}],hub:{tombstones:[{id:'dead'}]}};
  for (const op of [
    {type:'comment.add',id:'C',roundIdNew:'R'},
    {type:'round.add',commentId:'C',id:'R'},
  ]) {
    const result=authorizeOps(user('reviewer'),[op,{type:'content.set',commentId:'C',roundId:'R',side:'owner'}],doc);
    assert.equal(result.ok,false);if (!result.ok) assert.equal(result.opIndex,1);
  }
  assert.equal(authorizeOps(user('reviewer'),[
    {type:'round.add',commentId:'C',id:'dead'},
    {type:'content.set',commentId:'C',roundId:'dead',side:'owner'},
  ],doc).ok,false);
  assert.equal(doc.comments[0].rounds.length,1);
});

test('kjx integration: round metadata cannot rewrite identity for any role', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    let current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    await f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:current.rev,ops:[{type:'comment.add',id:'C',roundIdNew:'R'}]}));
    for (const role of ['reviewer','manager','admin'] as const) for (const field of ['initiatorId','responderId','initiator']) {
      current=f.hub.pcf.storage.load(PROJECT,DRAWING);
      const response=await f.request(pcf+'/ops',role,f.json({clientId:'client',baseRev:current.rev,ops:[{type:'round.meta',commentId:'C',roundId:'R',field,value:'forged',baseRev:current.data.hub.entities['round:R:'+field]?.rev || 0}]}));
      if (role==='reviewer') assert.equal(response.status,403);
      else {assert.equal(response.status,200);assert.equal((await response.json()).applied.length,field==='initiator'?1:0);}
      const round=f.hub.pcf.storage.load(PROJECT,DRAWING).data.comments[0].rounds[0];
      assert.equal(round.initiatorId,'owner');assert.equal(round.responderId,undefined);
      if (field!=='initiator') assert.equal(f.hub.pcf.storage.load(PROJECT,DRAWING).rev,current.rev);
    }
  } finally {await f.cleanup();}
});

test('kjx integration: builder and complete export/import preserve IDs without assigning a responder', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    const start=f.hub.pcf.storage.load(PROJECT,DRAWING);
    await f.request(pcf+'/ops','reviewer',f.json({clientId:'client',baseRev:start.rev,ops:[{type:'comment.add',id:'C',roundIdNew:'R'}]}));
    const {parseHTML}=await import('../src/pcf-html.ts');
    const {standaloneHTML}=await import('../src/pcf-exchange.ts');
    const {randomUUID}=await import('node:crypto');
    const exported=await (await f.request(pcf+'/exports','manager',f.json({mode:'builder'}))).json();
    const returned=parseHTML(await (await f.request(pcf+'/exports/'+exported.exportId+'/download','manager')).text());
    const round=returned.comments[0].rounds[0];
    assert.equal(round.initiatorId,'owner');assert.equal(round.responderId,undefined);
    round.reply={text:'Builder reply',html:'',fill:'',images:[]};
    const html=standaloneHTML(returned);
    const preview=await (await f.request(pcf+'/imports','manager',f.json({step:'preview',html}))).json();
    assert.equal(preview.ownerTampered,false);
    const applied=await f.request(pcf+'/imports','manager',f.json({step:'apply',html,previewToken:preview.previewToken,batchId:randomUUID()}));
    assert.equal(applied.status,200);
    const saved=f.hub.pcf.storage.load(PROJECT,DRAWING).data.comments[0].rounds[0];
    assert.equal(saved.reply.text,'Builder reply');assert.equal(saved.initiatorId,'owner');assert.equal(saved.responderId,undefined);
    // Complete copies retain both optional IDs when an existing responder is known.
    const current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    current.data.comments[0].rounds[0].responderId='builder-existing';
    await writeFile(f.hub.pcf.storage.file(PROJECT,DRAWING),JSON.stringify(current.data));
    const complete=await (await f.request(pcf+'/download?format=json','manager')).json();
    complete.comments[0].rounds[0].owner.text='Offline owner edit';
    const completePreview=await (await f.request(pcf+'/imports','manager',f.json({step:'preview',json:complete}))).json();
    const merged=await f.request(pcf+'/imports','manager',f.json({step:'apply',json:complete,previewToken:completePreview.previewToken,batchId:randomUUID()}));
    assert.equal(merged.status,200);
    const final=f.hub.pcf.storage.load(PROJECT,DRAWING).data.comments[0].rounds[0];
    assert.equal(final.initiatorId,'owner');assert.equal(final.responderId,'builder-existing');assert.equal(final.owner.text,'Offline owner edit');
  } finally {await f.cleanup();}
});

test('kjx integration: replay identity is bound and legacy HTTP remains anonymous', async () => {
  const f=await fixture();
  try {
    await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    const {randomUUID}=await import('node:crypto');
    const current=f.hub.pcf.storage.load(PROJECT,DRAWING);
    const body={clientId:'shared-client',baseRev:current.rev,batchId:randomUUID(),ops:[{type:'comment.add',id:'C',roundIdNew:'R'}]};
    const first=await f.request(pcf+'/ops','reviewer',f.json(body));assert.equal(first.status,200);
    const replay=await f.request(pcf+'/ops','reviewer',f.json(body));assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),await first.json());
    assert.equal((await f.request(pcf+'/ops','reviewer',f.json(body),{sub:'other'})).status,409);
    assert.equal(f.hub.pcf.storage.load(PROJECT,DRAWING).data.comments[0].rounds[0].initiatorId,'owner');
  } finally {await f.cleanup();}
  const legacy=await fixture('legacy');
  try {
    await legacy.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer');
    const current=legacy.hub.pcf.storage.load(PROJECT,DRAWING);
    const response=await legacy.request(pcf+'/ops','reviewer',legacy.json({clientId:'legacy',baseRev:current.rev,requestActor:{sub:'forged',name:'Forged'},ops:[{type:'comment.add',id:'C',roundIdNew:'R',initiatorId:'forged'}]}));
    assert.equal(response.status,200);
    const round=(await response.json()).data.comments[0].rounds[0];
    assert.equal(Object.hasOwn(round,'initiatorId'),false);assert.equal(Object.hasOwn(round,'responderId'),false);assert.equal(round.initiator,'');
    const latest=legacy.hub.pcf.storage.load(PROJECT,DRAWING);
    assert.equal((await legacy.request(pcf+'/ops','reviewer',legacy.json({clientId:'legacy',baseRev:latest.rev,ops:[{type:'round.meta',commentId:'C',roundId:'R',field:'initiatorId',baseRev:0,value:'forged'}]}))).status,400);
  } finally {await legacy.cleanup();}
});

test('kjx: Origin/Referer and CORS rules; configured CORS is explicit', async () => {
  const f=await fixture();
  try {
    for (const origin of ['', 'null', 'https://nbins.kjxing.com']) {
      const response=await f.request('/api/session','admin',{method:'POST',headers:{Origin:origin}});
      assert.equal(response.status,403);assert.equal((await response.json()).error,'bad_origin');
    }
    assert.equal((await f.request('/api/session','admin',{method:'POST',headers:{Referer:PUBLIC+'/page'}})).status,410);
    assert.equal((await f.request('/api/session','admin',{method:'POST',headers:{Origin:PUBLIC,Referer:'https://other.invalid'}})).status,410);
    assert.equal((await f.request('/api/health',null)).headers.get('Access-Control-Allow-Origin'),null);
    f.hub.router.options.ALLOW_CORS_ORIGIN='https://allowed.invalid';
    assert.equal((await f.request('/api/health',null)).headers.get('Access-Control-Allow-Origin'),'https://allowed.invalid');
  } finally {await f.cleanup();}
});

test('kjx: admin console ignores Bearer, works without legacy password and records actor', async () => {
  const f=await fixture();
  try {
    assert.equal((await f.request('/api/admin/api/tables','manager')).status,403);
    assert.equal((await f.request('/api/admin/api/tables','admin',{headers:{Authorization:'Bearer '+randomBytes(32).toString('hex')}})).status,200);
    const html=await (await f.request('/api/admin','admin')).text();
    assert.ok(html.includes('window.PAHUB_ADMIN_KJX=true'));
    const response=await f.request('/api/admin/api/tables/reviewers','admin',f.json({id:'kjx-new',display_name:'Test'}));
    assert.equal(response.status,200);
    const row=f.hub.db.prepare("SELECT * FROM audit_log WHERE action='INSERT' ORDER BY id DESC LIMIT 1").get()!;
    assert.equal(row.actor_id,'owner');assert.equal(row.actor_name,'Test admin');
  } finally {await f.cleanup();}
});

test('kjx: PCF grants bind users and never bypass identity; project passwords remain second gate', async () => {
  const f=await fixture();
  try {
    const page=await (await f.request('/pcf/'+PROJECT+'/'+DRAWING,'reviewer')).text();
    const context=JSON.parse(page.match(/window\.PAHUB=(.*?)<\/script>/s)![1]);
    assert.equal(f.hub.pcf.validScopedCredential(context.credential,PROJECT,DRAWING,'owner'),true);
    assert.equal(f.hub.pcf.validScopedCredential(context.credential,PROJECT,DRAWING,'other'),false);
    assert.equal((await f.request(pcf+'/data','reviewer',{headers:{'X-PCF-Token':context.credential}},{sub:'other'})).status,401);
    assert.equal((await f.request(pcf+'/data',null,{headers:{'X-PCF-Token':context.credential}})).status,401);
    assert.equal((await f.request(pcf+'/data','reviewer',{headers:{'X-PCF-Token':context.credential}})).status,200);
    const password=randomBytes(32).toString('hex');
    assert.equal((await f.request('/api/projects/'+PROJECT,'admin',f.json({conf:{password}},'PATCH'))).status,200);
    assert.equal((await f.request('/api/projects/'+PROJECT,'reviewer',f.json({}))).status,401);
    assert.equal((await f.request('/api/projects/'+PROJECT,'admin',f.json({}))).status,200);
    const unlocked=await f.request('/api/projects/'+PROJECT+'/unlock','reviewer',f.json({password}));
    assert.equal(unlocked.status,200);
    assert.equal((await f.request('/api/projects/'+PROJECT,'reviewer',{...f.json({}),headers:{Cookie:unlocked.headers.get('Set-Cookie')!.split(';')[0]}})).status,200);
  } finally {await f.cleanup();}
});

test('legacy: ignores forged identity header and preserves old authorization with additive session fields', async () => {
  const f=await fixture('legacy');
  try {
    const clean=await f.request('/api/session',null);
    const forged=await fetch(f.origin+'/api/session',{headers:{'X-Auth-Token':randomBytes(32).toString('hex')}});
    const body=await clean.json();assert.deepEqual(await forged.json(),body);
    assert.equal(body.mode,'legacy');assert.equal(body.admin,true);assert.equal(body.user,null);assert.equal(body.auth,null);
    assert.equal(clean.headers.get('Access-Control-Allow-Origin'),'*');
    assert.equal((await fetch(f.origin+'/api/projects/'+PROJECT,{method:'PATCH',body:JSON.stringify({updatedDrawings:[{id:DRAWING,changes:{title:'Legacy'}}]})})).status,200);
    assert.equal((await f.request('/api/session',null,{method:'POST'})).status,200);
    assert.equal((await f.request('/api/session',null,{method:'DELETE'})).status,200);
  } finally {await f.cleanup();}
});

test('audit: migration is idempotent, offline actor is null and only writeAudit owns audit INSERTs', async () => {
  const f=await fixture();
  try {
    initializeIdentitySchema(f.hub.db);initializeIdentitySchema(f.hub.db);
    writeAudit(f.hub.db,{table:'test',action:'SYSTEM'});
    const row=f.hub.db.prepare("SELECT * FROM audit_log WHERE action='SYSTEM'").get()!;
    assert.equal(row.actor_id,null);assert.equal(row.source,'background/offline');
    const dir=path.join(process.cwd(),'hub-server/src');
    for (const file of await readdir(dir)) if (file.endsWith('.ts') && file!=='audit.ts') {
      assert.doesNotMatch(await readFile(path.join(dir,file),'utf8'),/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`\[]?audit_log\b/i,file);
    }
  } finally {await f.cleanup();}
});

test('kjx: configured grant secret validates byte length and survives API object recreation', async () => {
  const f=await fixture();
  try {
    process.env.PCF_GRANT_SECRET='';assert.throws(()=>readConfig(),/at least 32 bytes/);
    process.env.PCF_GRANT_SECRET=randomBytes(32).toString('base64url');
    const secret=readConfig().grantSecret!;
    const one=new PcfApi(f.hub.pcf.storage,undefined,undefined,undefined,{mode:'legacy',grantSecret:secret});
    const two=new PcfApi(f.hub.pcf.storage,undefined,undefined,undefined,{mode:'legacy',grantSecret:secret});
    const session=await one.handle(new Request('http://test'+pcf+'/session',{method:'POST'}),'');
    const value=session.headers.get('Set-Cookie')!.split(';')[0].split('=').slice(1).join('=');
    assert.equal(two.validScopedCredential(value,PROJECT,DRAWING),true);
    one.realtime.close();two.realtime.close();
  } finally {await f.cleanup();}
});

test('kjx: model and multiplexed HTTP handlers cannot silently grow past policy coverage', async () => {
  const src=path.join(process.cwd(),'hub-server/src');
  const model=await readFile(path.join(src,'pcf-model.ts'),'utf8');
  const implemented=new Set([...model.matchAll(/case '([a-zA-Z]+\.[a-zA-Z]+)'/g)].map(match=>match[1]));
  assert.deepEqual(implemented,new Set(Object.keys(OP_CAPABILITIES)));
  const api=await readFile(path.join(src,'pcf-api.ts'),'utf8');
  const {PCF_POLICIES}=await import('../src/capabilities.ts');
  for(const match of api.matchAll(/case '(GET|POST|PUT|PATCH|DELETE) ([^']+)'/g)) {
    assert.ok(PCF_POLICIES.some(policy=>policy.method===match[1]&&policy.pattern!.test('/api/pcf/P/D/'+match[2])),match[0]);
  }
  const copied=await readFile(path.join(src,'kjx-auth-client.ts'),'utf8');
  assert.match(copied,/@ 0fef219d3d08be37bc691b243fffcb11e9d6d7c6/);
});

test('kjx: shared browser transport handles 401, permission denial, denied app and unavailable auth', async () => {
  const dom=new JSDOM('',{url:PUBLIC+'/drawings?project=P'});
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  const oldCustomEvent=Object.getOwnPropertyDescriptor(globalThis,'CustomEvent');
  Object.defineProperty(globalThis,'CustomEvent',{value:dom.window.CustomEvent,configurable:true});
  Object.defineProperty(globalThis,'window',{value:dom.window,configurable:true});
  try {
    const notices:string[]=[];
    dom.window.addEventListener('pahub:auth-notice',event=>notices.push(String((event as CustomEvent).detail)));
    for(const [status,body]of [[403,{error:'forbidden'}],[503,{error:'auth_unavailable'}]] as const){
      const client=createApiClient({baseUrl:PUBLIC+'/api',fetch:async()=>Response.json(body,{status})});
      await assert.rejects(client.request('test'));
    }
    assert.deepEqual(notices,["You don't have permission to do this.",'Sign-in service is temporarily unavailable. Try again in a minute.']);
    // jsdom deliberately cannot navigate; inject a tiny browser facade to capture targets.
    const assigned:string[]=[];
    Object.defineProperty(globalThis,'window',{value:{location:{pathname:'/drawings',search:'?project=P',assign:(url:string)=>assigned.push(url)}},configurable:true});
    for(const [status,body]of [[401,{error:'unauthenticated',login:'https://auth.kjxing.com/login'}],[403,{error:'forbidden',denied:'https://auth.kjxing.com/denied?app=pahub'}]] as const){
      const client=createApiClient({baseUrl:PUBLIC+'/api',fetch:async()=>Response.json(body,{status})});
      await assert.rejects(client.request('test'));
    }
    const login=new URL(assigned[0]);assert.equal(login.searchParams.get('path'),'/drawings?project=P');
    assert.equal(login.searchParams.get('app'),'pahub');assert.ok(login.search.endsWith('path=%2Fdrawings%3Fproject%3DP'));
    assert.equal(assigned[1],'https://auth.kjxing.com/denied?app=pahub');
  }finally{
    if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');
    if(oldCustomEvent)Object.defineProperty(globalThis,'CustomEvent',oldCustomEvent);else Reflect.deleteProperty(globalThis,'CustomEvent');
    dom.window.close();
  }
});

test('config: invalid modes/URLs fail closed and discipline mapping follows approved decision', () => {
  assert.equal(identityConfig({}).mode,'legacy');
  assert.throws(()=>identityConfig({AUTH_MODE:'invalid'}));
  assert.throws(()=>identityConfig({AUTH_MODE:'kjx',KJX_JWKS_URL:'bad-url'}));
  assert.throws(()=>identityConfig({AUTH_MODE:'kjx',KJX_AUDIENCE:''}));
  assert.equal(kjxDiscipline(' Accommodation '),'OUTFIT');assert.equal(kjxDiscipline('h U l l'),'HULL');
  assert.equal(kjxDiscipline('unknown'),undefined);
});
