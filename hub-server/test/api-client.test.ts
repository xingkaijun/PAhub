import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from '../src/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApiClient, downloadFilename } from '../../services/api/apiClient';
import { createProjectsApi } from '../../services/api/projectsApi';
import { createPcfApi } from '../../services/api/pcfApi';
import { createBuilderRepliesApi } from '../../services/api/builderRepliesApi';
import { commentsQuery, createCommentsApi } from '../../services/api/commentsApi';
import type { Project } from '../../types';

function fixture(respond: (url: string, init: RequestInit) => Promise<Response> | Response = () => Response.json({})) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createApiClient({ baseUrl: '/nested/api', origin: 'https://hub.test', fetch: async (input, init) => {
    const call = { url: String(input), init: init || {} }; calls.push(call); return respond(call.url, call.init);
  } });
  return { client, calls };
}

test('apiClient resolves a trimmed base, preserves encoded IDs and leaves authentication optional', async () => {
  const { client, calls } = fixture();
  const signal = new AbortController().signal;
  await createProjectsApi(client).loadProject({ id: 'p /中文' } as Project, 'guard', signal);
  assert.equal(calls[0].url, 'https://hub.test/nested/api/projects/p%20%2F%E4%B8%AD%E6%96%87');
  assert.equal(new Headers(calls[0].init.headers).has('Authorization'), false);
  assert.equal(new Headers(calls[0].init.headers).get('Content-Type'), 'application/json');
  assert.equal(calls[0].init.body, JSON.stringify({ password: 'guard' }));
  assert.strictEqual(calls[0].init.signal, signal);
  const absolute = createApiClient({ baseUrl: ' https://remote.test/custom/api/ ' });
  assert.equal(absolute.url('health'), 'https://remote.test/custom/api/health');
});

test('apiClient uses configured token for JSON and streams, preserving caller headers', async () => {
  let headers: Headers | undefined;
  const client = createApiClient({ baseUrl: 'https://hub.test/api', token: ' optional-token ', fetch: async (_input, init) => {
    headers = new Headers(init?.headers); return Response.json({ ok: true });
  } });
  assert.equal(client.hasToken(), true);
  await client.request('events', { headers: { Accept: 'text/event-stream' } });
  assert.equal(headers!.get('Authorization'), 'Bearer optional-token');
  assert.equal(headers!.get('Accept'), 'text/event-stream');
  assert.equal(headers!.has('Content-Type'), false);
});

test('apiClient sends multipart data untouched without an incorrect JSON content type', async () => {
  const { client, calls } = fixture(() => Response.json({ importSetId: 's', files: [] }));
  const file = new File(['<html>'], 'reply.html', { type: 'text/html' });
  await createBuilderRepliesApi(client).preview('p', [file]);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).has('Content-Type'), false);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal((calls[0].init.body as FormData).getAll('files').length, 1);
});

test('apiClient parses JSON errors and legacy text while preserving HTTP status', async () => {
  for (const response of [Response.json({ error: 'PASSWORD_REQUIRED' }, { status: 401 }), new Response('PASSWORD_REQUIRED', { status: 401 }), Response.json({ message: 'PASSWORD_REQUIRED' }, { status: 401 })]) {
    const { client } = fixture(() => response);
    await assert.rejects(client.json('settings'), error => error instanceof ApiError && error.status === 401 && error.message === 'PASSWORD_REQUIRED');
  }
  const { client } = fixture(() => new Response('', { status: 502 }));
  await assert.rejects(client.request('health'), /API request failed: 502/);
});

test('apiClient preserves network cancellation and successful 204 responses', async () => {
  const { client } = fixture((_url, init) => {
    init.signal?.throwIfAborted(); return new Response(null, { status: 204 });
  });
  assert.equal(await client.json('empty'), undefined);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.request('cancelled', { signal: controller.signal }), error => error instanceof DOMException && error.name === 'AbortError');
});

test('projectsApi turns 404 into ProjectNotFoundError (no local copy handed back) and does not hide password errors', async () => {
  // The local new-project fallback moved to the store (only for projects never read from the server).
  const project = { id: 'new' } as Project;
  const { client } = fixture(() => Response.json({ error: 'Not found' }, { status: 404 }));
  await assert.rejects(createProjectsApi(client).loadProject(project), (error: any) => error?.code === 'PROJECT_NOT_FOUND' && error.projectId === 'new');
  const denied = fixture(() => Response.json({ error: 'PASSWORD_REQUIRED' }, { status: 401 }));
  await assert.rejects(createProjectsApi(denied.client).loadProject(project), /PASSWORD_REQUIRED/);
});

test('projectsApi delta, tracker, audit and heartbeat use original routes and payloads', async () => {
  const { client, calls } = fixture(url => url.endsWith('heartbeat') ? Response.json({ adminLastSeen: '2026-11-09' }) : Response.json({ success: true, entries: [], truncated: false }));
  const api = createProjectsApi(client);
  await api.saveDelta('p', { updatedDrawings: [{ id: 'd', changes: { title: 'Edited' } }] });
  await api.saveReviewTracker('p', { d: { A: { done: true } } });
  await api.loadAuditLog('p', '2026-11-09T00:00:00+08:00', '2026-11-10T00:00:00+08:00');
  await api.sendHeartbeat('p');
  assert.equal(await api.getHeartbeat('p'), '2026-11-09');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].init.body as string), { d: { A: { done: true } } });
  assert.equal(new URL(calls[2].url).searchParams.get('from'), '2026-11-09T00:00:00+08:00');
  assert.equal(calls[3].init.body, undefined);
});

test('pcfApi only creates token sessions when enabled and downloads batches with safe filenames', async () => {
  const { client, calls } = fixture(() => new Response('zip', { headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%2Fexport.zip" } }));
  const api = createPcfApi(client);
  await api.ensureSession('p', 'd'); assert.equal(calls.length, 0);
  const payload = { drawingIds: ['d'], batchId: 'batch', clientId: 'client', clientName: 'Reviewer' };
  const file = await api.exportBatch('p', payload);
  assert.equal(file.filename, '中文_export.zip'); assert.equal(await file.blob.text(), 'zip');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), payload);
  let route = '';
  const gated = createPcfApi(createApiClient({ baseUrl: 'https://hub.test/api', token: 'token', fetch: async input => { route = String(input); return Response.json({ ok: true }); } }));
  await gated.ensureSession('p /', 'd /');
  assert.equal(route, 'https://hub.test/api/pcf/p%20%2F/d%20%2F/session');
  assert.equal(downloadFilename(new Headers({ 'Content-Disposition': "attachment; filename=plain.zip; filename*=UTF-8''%broken" }), 'default.zip'), 'plain.zip');
});

test('builderRepliesApi pending, apply and skip preserve IDs and apply batch identity', async () => {
  const { client, calls } = fixture(() => Response.json({ results: [] }));
  const api = createBuilderRepliesApi(client);
  await api.pending('p'); await api.apply('p', 'set /', ['f'], 'batch'); await api.skip('p', 'set /', 'f');
  assert.ok(calls[0].url.endsWith('/builder-replies/pending'));
  assert.ok(calls[1].url.endsWith('/builder-replies/set%20%2F/apply'));
  assert.deepEqual(JSON.parse(calls[1].init.body as string), { fileIds: ['f'], batchId: 'batch' });
  assert.deepEqual(JSON.parse(calls[2].init.body as string), { fileId: 'f' });
});

test('commentsApi shares list/export filters, validates results and rejects proxy HTML exports', async () => {
  const payload = { comments: [], statistics: {}, options: {}, warnings: [] };
  const { client, calls } = fixture(url => url.includes('comments.xlsx') ? new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) : Response.json(payload));
  const api = createCommentsApi(client);
  const filters = { q: '  query & text  ', discipline: 'Hull', openOlderThanDays: 0 };
  assert.equal(commentsQuery(filters), 'discipline=Hull&q=query+%26+text&openOlderThanDays=0');
  assert.deepEqual(await api.fetchComments('p', filters), payload);
  await assert.rejects(api.exportCommentsXlsx('p', filters), /did not return an XLSX/);
  assert.equal(new URL(calls[0].url).search, new URL(calls[1].url).search);
  const invalid = fixture(() => Response.json({ comments: [] }));
  await assert.rejects(createCommentsApi(invalid.client).fetchComments('p'), /invalid comments register/);
});

test('commentsApi SSE handles split CRLF frames, invalidates changes only and aborts on stop', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const { client, calls } = fixture((_url, init) => {
    signal = init.signal;
    signal?.addEventListener('abort', () => controller?.error(new DOMException('Aborted', 'AbortError')));
    return new Response(stream);
  });
  const states: string[] = []; let stale = 0;
  const stop = createCommentsApi(client).subscribeToCommentChanges('p', () => stale++, state => states.push(state));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const encoder = new TextEncoder();
    controller!.enqueue(encoder.encode('event: presence\r\ndata: {}\r\n\r\nevent: drawing-'));
    controller!.enqueue(encoder.encode('changed\r\ndata: {"drawingId":"d"}\r\n\r\nevent: drawing-changed\ndata: not-json\n\n'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stale, 1);
    assert.deepEqual(states, ['connecting', 'live']);
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init.headers).get('Accept'), 'text/event-stream');
    stop(); assert.equal(signal?.aborted, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(states, ['connecting', 'live']);
  } finally { stop(); }
});


test('frontend entry, components and slices never bypass the shared API transport', async () => {
  const files = ['App.tsx', 'store.ts'];
  for (const directory of ['components', 'store']) {
    for (const name of await readdir(path.join(ROOT_DIR, directory))) {
      if (/\.tsx?$/.test(name)) files.push(directory + '/' + name);
    }
  }
  for (const file of files) {
    const source = await readFile(path.join(ROOT_DIR, file), 'utf8');
    assert.equal(/\bfetch\s*\(/.test(source), false, file + ' bypasses apiClient');
    assert.equal(/VITE_DATA_API_(?:TOKEN|BASE_URL)/.test(source), false, file + ' duplicates API configuration');
    assert.equal(/AppRepository|HubApiRepository/.test(source), false, file + ' uses a retired forwarding repository');
  }
});
