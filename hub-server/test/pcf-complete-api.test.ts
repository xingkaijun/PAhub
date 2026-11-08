import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHub } from '../src/app.ts';
import { PcfStorage } from '../src/pcf-storage.ts';
import { ROOT_DIR } from '../src/config.ts';
import { parseHTML, replaceData } from '../src/pcf-html.ts';

test('anonymous complete downloads record baselines; HTML/JSON return merges histories without changing PAPC status', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-complete-api-'));
  const keys = ['PORT', 'PAHUB_DATA_DIR', 'PAPC_DB_PATH', 'API_TOKEN', 'PAHUB_BASIC_AUTH'], old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PORT: '0', PAHUB_DATA_DIR: dir, PAPC_DB_PATH: path.join(dir, 'papc.db'), API_TOKEN: '', PAHUB_BASIC_AUTH: '' });
  let hub: Awaited<ReturnType<typeof createHub>> | undefined;
  try {
    hub = await createHub({ host: '127.0.0.1', middleware: (_req, _res, next) => next() });
    hub.db.sqlite.exec(readFileSync(path.join(ROOT_DIR, 'worker/sql/seed-test-data.sql'), 'utf8'));
    const p = 'proj-test-001', d = 'dwg-005', route = 'http://127.0.0.1:' + hub.port + '/api/pcf/' + p + '/' + d + '/';
    const api = async (tail: string, method = 'GET', body?: any) => {
      const response = await fetch(route + tail, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, value: await response.json() as any };
    };
    const storage = new PcfStorage(hub.db.sqlite, dir);
    await api('create', 'POST');
    const exported = await fetch(route + 'download'); assert.equal(exported.status, 200);
    const html = await exported.text(), offline = parseHTML(html); assert.equal(offline.export.mode, 'complete'); assert.equal(offline.hub, undefined);
    assert.doesNotMatch(html, /PAhub adapter:|id="pahub-context"|X-PCF-Token/);
    assert.equal((await api('exports')).value.length, 1);
    const jsonResponse = await fetch(route + 'exports/' + offline.export.exportId + '/download?format=json'); assert.equal(jsonResponse.status, 200); assert.deepEqual(await jsonResponse.json(), offline);
    const downloadJSON = await api('download?format=json'); assert.equal(downloadJSON.status, 200); assert.equal(downloadJSON.value.export.mode, 'complete');
    const source = storage.load(p, d); source.data.circulation.push({ id: 'server-history', round: 2, kind: 'sent', date: '2026-11-08', note: 'server addition' });
    storage.replace(p, d, { baseRev: source.rev, data: source.data }, { clientId: 'server', clientName: '', ip: '' });
    hub.db.sqlite.prepare("UPDATE drawings SET status='Waiting Reply' WHERE project_id=? AND id=?").run(p, d);
    offline.project.planTitle = 'Offline title';
    const returned = replaceData(html, offline);
    const replacement = await api('document', 'PUT', { baseRev: storage.load(p, d).rev, html: returned }); assert.equal(replacement.status, 409);
    const preview = await api('imports', 'POST', { step: 'preview', html: returned }); assert.equal(preview.status, 200, JSON.stringify(preview.value)); assert.equal(preview.value.mode, 'complete'); assert.deepEqual(preview.value.conflicts, []);
    const applied = await api('imports', 'POST', { step: 'apply', html: returned, previewToken: preview.value.previewToken, batchId: randomUUID(), choices: {} });
    assert.equal(applied.status, 200); assert.equal(applied.value.data.project.planTitle, 'Offline title'); assert.equal(applied.value.data.circulation.some((x: any) => x.id === 'server-history'), true);
    assert.equal(hub.db.sqlite.prepare('SELECT status FROM drawings WHERE project_id=? AND id=?').get(p, d)!.status, 'Waiting Reply');
    assert.equal(applied.value.data.export, undefined);
    const another = downloadJSON.value; another.project.planNo = 'JSON offline plan';
    const jsonPreview = await api('imports', 'POST', { step: 'preview', json: another }); assert.equal(jsonPreview.status, 200);
    const jsonApplied = await api('imports', 'POST', { step: 'apply', json: another, previewToken: jsonPreview.value.previewToken, batchId: randomUUID(), choices: {} });
    assert.equal(jsonApplied.status, 200); assert.equal(jsonApplied.value.data.project.planNo, 'JSON offline plan');
    assert.equal(jsonApplied.value.data.project.planTitle, 'Offline title');
    assert.equal(jsonApplied.value.data.circulation.some((x: any) => x.id === 'server-history'), true);
    assert.equal((await api('exports', 'POST', { mode: 'unknown' })).status, 400);
    const unknown = structuredClone(downloadJSON.value); unknown.export.exportId = randomUUID();
    assert.equal((await api('imports', 'POST', { step: 'preview', json: unknown })).status, 409);
  } finally {
    await hub?.close(); for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
});
