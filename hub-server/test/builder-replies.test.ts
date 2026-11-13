import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHub } from '../src/app.ts';
import { parseHTML, replaceData } from '../src/pcf-storage.ts';
import { blankContent } from '../src/pcf-model.ts';
import { createZip } from '../src/zip.ts';

const token = 'batch-test-token';
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pahub-builder-batch-'));
  const keys = ['PORT','PAHUB_DATA_DIR','PAPC_DB_PATH','PAPC_DIST_DIR','API_TOKEN','ADMIN_PASSWORD']; const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), PAPC_DIST_DIR: path.join(process.cwd(), 'dist'), API_TOKEN: token, ADMIN_PASSWORD: 'batch-admin' });
  const hub = await createHub({ middleware: (_req, _res, next) => next() }); hub.db.exec(await readFile(path.join(process.cwd(), 'hub-server/test/fixtures/seed-test-data.sql'), 'utf8'));
  const origin = 'http://127.0.0.1:' + hub.port, auth = { Authorization: 'Bearer ' + token };
  const post = async (url: string, value: any) => { const r = await fetch(origin + url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); return { status: r.status, value: await r.json() as any }; };
  const record = async (drawingId: string) => {
    const base = `/api/pcf/proj-test-001/${drawingId}/`;
    assert.equal((await post(base + 'create', {})).status, 200);
    let live = (await (await fetch(origin + base + 'data', { headers: auth })).json()) as any;
    const commentId = randomUUID(), roundId = randomUUID();
    assert.equal((await post(base + 'ops', { clientId: 'fixture', clientName: 'test', baseRev: live.rev, batchId: randomUUID(), ops: [ { type: 'comment.add', id: commentId, roundIdNew: roundId }, { type: 'content.set', commentId, roundId, side: 'owner', baseRev: 0, value: { ...blankContent(), text: 'Owner note' } } ] })).status, 200);
    const exported = await post(base + 'exports', {}); assert.equal(exported.status, 200);
    const download = await fetch(origin + base + 'exports/' + exported.value.exportId + '/download', { headers: auth });
    return { drawingId, base, exportId: exported.value.exportId, html: await download.text(), commentId, roundId };
  };
  const reply = (item: any, text: string, ownerTamper = false, appVersion?: string) => {
    const data = parseHTML(item.html); data.comments[0].rounds[0].reply = { ...blankContent(), text, html: text };
    if (ownerTamper) data.comments[0].rounds[0].owner.text = 'tampered owner';
    if (appVersion) data.appVersion = appVersion;
    return replaceData(item.html, data);
  };
  const preview = async (items: Array<{ name: string; body: string }>) => {
    const form = new FormData();
    for (const item of items) form.append('files', new Blob([item.body]), item.name);
    const r = await fetch(origin + '/api/projects/proj-test-001/builder-replies/preview', { method: 'POST', headers: auth, body: form });
    return { status: r.status, value: await r.json() as any };
  };
  const apply = async (setId: string, ids: string[], batchId = randomUUID()) => post(`/api/projects/proj-test-001/builder-replies/${setId}/apply`, { fileIds: ids, batchId });
  const cleanup = async () => { await hub.close(); for (const [k,v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v as string; };
  return { hub, origin, auth, post, record, reply, preview, apply, cleanup };
}

test('batch preview classifies clean, conflict, unmatched and ignores non-HTML; clean files update Waiting Reply and STATUS history', async () => {
  const f = await fixture(); try {
    const a = await f.record('dwg-001'), b = await f.record('dwg-002'), c = await f.record('dwg-003'), conflict = await f.record('dwg-004');
    for (const id of ['dwg-001','dwg-002','dwg-003']) f.hub.db.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id=?").run(id);
    const live = (await (await fetch(f.origin + conflict.base + 'data', { headers: f.auth })).json()) as any;
    await f.post(conflict.base + 'ops', { clientId: 'server', baseRev: live.rev, batchId: randomUUID(), ops: [{ type: 'content.set', commentId: conflict.commentId, roundId: conflict.roundId, side: 'reply', baseRev: 0, value: { ...blankContent(), text: 'server edit' } }] });
    const entries = [a,b,c].map((x,i) => ({ name: x.drawingId + '.html', data: f.reply(x, 'builder ' + i) }));
    const unmatchedHtml = f.reply(a, 'unmatched'), unmatchedData = parseHTML(unmatchedHtml); unmatchedData.export.exportId = randomUUID();
    entries.push({ name: 'conflict.html', data: f.reply(conflict, 'builder conflict') }, { name: 'unmatched.html', data: replaceData(unmatchedHtml, unmatchedData) }, { name: 'notes.txt', data: 'not html' });
    const zip = createZip(entries);
    const form = new FormData(); form.append('files', new Blob([zip]), 'replies.zip');
    const response = await fetch(f.origin + '/api/projects/proj-test-001/builder-replies/preview', { method: 'POST', headers: f.auth, body: form });
    const set = await response.json() as any; assert.equal(response.status, 200);
    assert.equal(set.files.filter((x:any) => x.category === 'clean').length, 3); assert.equal(set.files.filter((x:any) => x.category === 'conflict').length, 1);
    assert.equal(set.files.filter((x:any) => x.category === 'unmatched').length, 1);
    assert.equal(set.files.some((x:any) => x.fileName === 'notes.txt'), false);
    const applied = await f.apply(set.importSetId, set.files.filter((x:any) => x.category === 'clean').map((x:any) => x.id));
    assert.equal(applied.status, 200); assert.equal(applied.value.results.filter((x:any) => x.category === 'applied').length, 3);
    for (const id of ['dwg-001','dwg-002','dwg-003']) assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get(id) as any).status, 'Reviewing');
    assert.equal(f.hub.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='STATUS' AND detail LIKE '%Builder import%' AND project_id='proj-test-001'").get()?.n, 3);
  } finally { await f.cleanup(); }
});

test('same export is marked duplicate and repeated apply batch does not write twice', async () => {
  const f = await fixture(); try { const x = await f.record('dwg-001'), set = await f.preview([{name:'x.html',body:f.reply(x,'reply')}]); const row=set.value.files[0]; const batch=randomUUID();
    const first=await f.apply(set.value.importSetId,[row.id],batch); const rev=(await (await fetch(f.origin+x.base+'data',{headers:f.auth})).json() as any).rev;
    await f.apply(set.value.importSetId,[row.id],batch); assert.equal((await (await fetch(f.origin+x.base+'data',{headers:f.auth})).json() as any).rev,rev);
    const repeated=await f.preview([{name:'x-again.html',body:f.reply(x,'reply')}]); assert.equal(repeated.value.files[0].category,'duplicate'); assert.equal(first.value.results[0].category,'applied');
  } finally { await f.cleanup(); }
});

test('server edit after preview is re-merged and newly conflicting reply is not applied', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001'),set=await f.preview([{name:'x.html',body:f.reply(x,'builder')}]); const live=(await (await fetch(f.origin+x.base+'data',{headers:f.auth})).json()) as any;
    await f.post(x.base+'ops',{clientId:'other',baseRev:live.rev,batchId:randomUUID(),ops:[{type:'content.set',commentId:x.commentId,roundId:x.roundId,side:'reply',baseRev:0,value:{...blankContent(),text:'server'}}]});
    const result=await f.apply(set.value.importSetId,[set.value.files[0].id]); assert.equal(result.value.results[0].category,'conflict');
    const after=(await (await fetch(f.origin+x.base+'data',{headers:f.auth})).json() as any).data; assert.equal(after.comments[0].rounds[0].reply.text,'server');
  } finally { await f.cleanup(); }
});

test('Approved and Pending PAPC status remain unchanged after reply import', async () => {
  const f=await fixture(); try { const a=await f.record('dwg-003'),b=await f.record('dwg-004'); f.hub.db.prepare("UPDATE drawings SET status='Approved' WHERE id='dwg-003'").run();
    const set=await f.preview([{name:'a.html',body:f.reply(a,'a')},{name:'b.html',body:f.reply(b,'b')}]); const result=await f.apply(set.value.importSetId,set.value.files.map((x:any)=>x.id)); assert.equal(result.status,200);
    assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get('dwg-003') as any).status,'Approved'); assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get('dwg-004') as any).status,'Pending');
  } finally { await f.cleanup(); }
});

test('tampered Owner is reported while Builder reply remains automatically applicable', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001'),set=await f.preview([{name:'x.html',body:f.reply(x,'builder',true)}]); assert.equal(set.value.files[0].category,'owner-tampered');
    const result=await f.apply(set.value.importSetId,[set.value.files[0].id]); assert.equal(result.value.results[0].category,'applied');
    const data=(await (await fetch(f.origin+x.base+'data',{headers:f.auth})).json() as any).data; assert.equal(data.comments[0].rounds[0].owner.text,'Owner note'); assert.equal(data.comments[0].rounds[0].reply.text,'builder');
  } finally { await f.cleanup(); }
});

test('reply to a permanently deleted server comment stays a conflict and leaves evidence', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001'),live=(await (await fetch(f.origin+x.base+'data',{headers:f.auth})).json()) as any;
    await f.post(x.base+'ops',{clientId:'other',baseRev:live.rev,batchId:randomUUID(),ops:[{type:'record.delete',commentId:x.commentId,deleteId:randomUUID(),baseRev:live.data.hub.entities['comment:'+x.commentId+':record'].rev}]});
    const set=await f.preview([{name:'deleted.html',body:f.reply(x,'late reply')}]); assert.equal(set.value.files[0].category,'conflict');
    const result=await f.apply(set.value.importSetId,[set.value.files[0].id]); assert.equal(result.value.results[0].category,'conflict');
    const pending=await fetch(f.origin+'/api/projects/proj-test-001/builder-replies/pending',{headers:f.auth});assert.equal(pending.status,200);assert.ok((await pending.json() as any[]).some(row=>row.fileName==='deleted.html'));
  } finally { await f.cleanup(); }
});

test('zip-slip entries and foreign document files are rejected while valid sibling imports are retained', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001'), foreign=await f.record('dwg-002'), html=f.reply(x,'ok'), other=parseHTML(f.reply(foreign,'no')); other.documentId=randomUUID();
    const entries=[{name:'../escape.html',data:html},{name:'foreign.html',data:replaceData(f.reply(foreign,'no'),other)},{name:'ok.html',data:html}]; const zip=createZip(entries);
    const form=new FormData();form.append('files',new Blob([zip]),'mixed.zip');const r=await fetch(f.origin+'/api/projects/proj-test-001/builder-replies/preview',{method:'POST',headers:f.auth,body:form});const set=await r.json() as any;
    assert.ok(set.files.some((x:any)=>x.category==='unmatched'&&/Unsafe ZIP path/.test(x.reason)));assert.ok(set.files.some((x:any)=>x.category==='unmatched'&&/documentId/.test(x.reason)));assert.ok(set.files.some((x:any)=>x.category==='clean'));
    const crossProjectForm=new FormData();crossProjectForm.append('files',new Blob([html]),'foreign-project.html');const crossProject=await fetch(f.origin+'/api/projects/proj-other-999/builder-replies/preview',{method:'POST',headers:f.auth,body:crossProjectForm});const crossProjectSet=await crossProject.json() as any;
    assert.equal(crossProject.status,200);assert.equal(crossProjectSet.files[0].category,'unmatched');assert.match(crossProjectSet.files[0].reason,/No matching documentId\/exportId/);
  } finally { await f.cleanup(); }
});

test('ZIP expanded-size cap rejects a bomb entry without rejecting sibling files', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001'),html=f.reply(x,'valid'); const zip=Buffer.from(createZip([{name:'huge.html',data:html},{name:'valid.html',data:html}]));
    let central=-1;for(let i=0;i<zip.length-4;i++)if(zip.readUInt32LE(i)===0x02014b50){central=i;break;}assert.ok(central>=0);zip.writeUInt32LE(201*1024*1024,central+24);
    const form=new FormData();form.append('files',new Blob([zip]),'bomb.zip');const response=await fetch(f.origin+'/api/projects/proj-test-001/builder-replies/preview',{method:'POST',headers:f.auth,body:form});const set=await response.json() as any;
    assert.ok(set.files.some((row:any)=>row.category==='unmatched'&&/expanded size exceeds/.test(row.reason)));assert.ok(set.files.some((row:any)=>row.category==='clean'));
  } finally { await f.cleanup(); }
});

test('failed PCF write leaves PAPC status and export state unchanged', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001');f.hub.db.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run(); const set=await f.preview([{name:'x.html',body:f.reply(x,'reply')}]);
    f.hub.db.exec("CREATE TRIGGER fail_batch_reply BEFORE INSERT ON pcf_changes BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");
    const result=await f.apply(set.value.importSetId,[set.value.files[0].id]);assert.equal(result.value.results[0].category,'failed');
    assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get('dwg-001') as any).status,'Waiting Reply');assert.equal((f.hub.db.prepare('SELECT status FROM pcf_exports WHERE export_id=?').get(x.exportId) as any).status,'exported');
  } finally { await f.cleanup(); }
});

test('v4-style returned HTML remains importable', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001'),legacy=f.reply(x,'legacy reply',false,'2.4'),set=await f.preview([{name:'v4.html',body:legacy}]); assert.equal(set.status,200);assert.ok(['clean','owner-tampered'].includes(set.value.files[0].category));
    const result=await f.apply(set.value.importSetId,[set.value.files[0].id]);assert.equal(result.value.results[0].category,'applied');
  } finally { await f.cleanup(); }
});

test('single-drawing Import Builder reply also advances Waiting Reply to Reviewing with STATUS log', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001');f.hub.db.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run();
    const html=f.reply(x,'single reply'),base=x.base;const preview=await f.post(base+'imports',{step:'preview',html});assert.equal(preview.status,200);
    const applied=await f.post(base+'imports',{step:'apply',html,previewToken:preview.value.previewToken,batchId:randomUUID()});assert.equal(applied.status,200);
    assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get('dwg-001') as any).status,'Reviewing');
    assert.equal((f.hub.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='STATUS' AND row_id='dwg-001'").get() as any).n,1);
  } finally { await f.cleanup(); }
});

test('a reply import with no applied Builder changes does not advance Waiting Reply', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001');f.hub.db.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run();
    const html=f.reply(x,'');const preview=await f.post(x.base+'imports',{step:'preview',html});assert.equal(preview.status,200);
    const applied=await f.post(x.base+'imports',{step:'apply',html,previewToken:preview.value.previewToken,batchId:randomUUID()});assert.equal(applied.status,200);
    assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get('dwg-001') as any).status,'Waiting Reply');
    assert.equal((f.hub.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='STATUS' AND row_id='dwg-001'").get() as any).n,0);
  } finally { await f.cleanup(); }
});

const builderReplyRows = (f: any, drawingId: string) => (f.hub.db.prepare("SELECT detail FROM audit_log WHERE action='BUILDER_REPLY' AND project_id='proj-test-001' AND row_id=? ORDER BY id").all(drawingId) as any[]).map(r => JSON.parse(r.detail));

test('bulk Builder reply import writes one BUILDER_REPLY log row per applied file; replayed batch and re-import do not add another', async () => {
  const f=await fixture(); try { const a=await f.record('dwg-001'),b=await f.record('dwg-003');
    f.hub.db.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id='dwg-001'").run(); f.hub.db.prepare("UPDATE drawings SET status='Reviewing' WHERE id='dwg-003'").run();
    const set=await f.preview([{name:'a.html',body:f.reply(a,'a reply')},{name:'b.html',body:f.reply(b,'b reply')}]); const batch=randomUUID();
    const first=await f.apply(set.value.importSetId,set.value.files.map((x:any)=>x.id),batch); assert.equal(first.value.results.filter((x:any)=>x.category==='applied').length,2);
    const [ra]=builderReplyRows(f,'dwg-001'),[rb]=builderReplyRows(f,'dwg-003');
    assert.equal(ra.exportId,a.exportId);assert.equal(ra.batchId,batch);assert.equal(ra.replies,1);assert.equal(ra.round,'A');assert.equal(ra.status,'Waiting Reply -> Reviewing');assert.equal(ra.via,'bulk');assert.equal(ra.source,'Builder reply import (bulk)');assert.ok(ra.customId);assert.ok(ra.drawingNo);
    assert.equal(rb.status,'unchanged (Reviewing)');assert.equal(rb.replies,1);
    // Status rule unchanged: only Waiting Reply moved.
    assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get('dwg-001') as any).status,'Reviewing');assert.equal((f.hub.db.prepare('SELECT status FROM drawings WHERE id=?').get('dwg-003') as any).status,'Reviewing');
    await f.apply(set.value.importSetId,set.value.files.map((x:any)=>x.id),batch);
    const again=await f.preview([{name:'a-again.html',body:f.reply(a,'a reply')}]);assert.equal(again.value.files[0].category,'duplicate');
    await f.apply(again.value.importSetId,[again.value.files[0].id]);
    assert.equal(builderReplyRows(f,'dwg-001').length,1);assert.equal(builderReplyRows(f,'dwg-003').length,1);
    // The Daily Log server query returns it.
    const audit=await fetch(f.origin+'/api/projects/proj-test-001/audit?'+new URLSearchParams({from:'2000-01-01T00:00:00.000Z',to:'2100-01-01T00:00:00.000Z'}),{headers:f.auth});assert.equal(audit.status,200);
    const entries=(await audit.json() as any).entries.filter((e:any)=>e.action==='BUILDER_REPLY');
    assert.equal(entries.length,2);const ea=entries.find((e:any)=>e.drawingId==='dwg-001');assert.equal(ea.source,'Builder reply import (bulk)');assert.equal(ea.detail.status,'Waiting Reply -> Reviewing');assert.equal(ea.customId,ra.customId);
  } finally { await f.cleanup(); }
});

test('single-file Builder reply import writes one BUILDER_REPLY log row; a replayed apply request does not write a second', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-002');f.hub.db.prepare("UPDATE drawings SET status='Reviewing' WHERE id='dwg-002'").run();
    const html=f.reply(x,'single reply');const preview=await f.post(x.base+'imports',{step:'preview',html});assert.equal(preview.status,200);
    const body={step:'apply',html,previewToken:preview.value.previewToken,batchId:randomUUID()};
    assert.equal((await f.post(x.base+'imports',body)).status,200);assert.equal((await f.post(x.base+'imports',body)).status,200);
    const rows=builderReplyRows(f,'dwg-002');assert.equal(rows.length,1);
    assert.equal(rows[0].status,'unchanged (Reviewing)');assert.equal(rows[0].replies,1);assert.equal(rows[0].round,'A');assert.equal(rows[0].exportId,x.exportId);assert.equal(rows[0].via,'pcf');assert.equal(rows[0].source,'Builder reply import (PCF)');
    assert.equal((f.hub.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='STATUS' AND row_id='dwg-002'").get() as any).n,0);
  } finally { await f.cleanup(); }
});

test('single-file import from Waiting Reply logs the status move; an import with no applied replies logs nothing', async () => {
  const f=await fixture(); try { const x=await f.record('dwg-001'),y=await f.record('dwg-004');
    for (const id of ['dwg-001','dwg-004']) f.hub.db.prepare("UPDATE drawings SET status='Waiting Reply' WHERE id=?").run(id);
    for (const [item,text] of [[x,'reply'],[y,'']] as const) { const html=f.reply(item,text);const preview=await f.post(item.base+'imports',{step:'preview',html});
      assert.equal((await f.post(item.base+'imports',{step:'apply',html,previewToken:preview.value.previewToken,batchId:randomUUID()})).status,200); }
    assert.equal(builderReplyRows(f,'dwg-001')[0].status,'Waiting Reply -> Reviewing');assert.equal(builderReplyRows(f,'dwg-004').length,0);
  } finally { await f.cleanup(); }
});
