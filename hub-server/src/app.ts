import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import worker from '@pahub/worker';
import { readConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { PcfStorage } from './pcf-storage.ts';
import { PcfApi } from './pcf-api.ts';
import { PcfBuilderReplies } from './pcf-builder-replies.ts';
import { safeId } from './pcf-model.ts';
import { ProjectComments } from './comments-register.ts';
import { exportCommentsExcel } from './comments-excel.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

// Compare fixed-length digests so neither value nor length leaks through timing.
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function basicAuthAllows(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const [scheme, encoded] = header.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return false;
  return safeEqual(Buffer.from(encoded, 'base64').toString('utf8'), expected);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function sendFetch(response: Response, req: IncomingMessage, res: ServerResponse) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (req.method === 'HEAD' || !response.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0') || decoded.includes('\\')) throw Object.assign(new Error('Invalid path'), { status: 400 });
  const rootReal = await realpath(root);
  let target = path.resolve(rootReal, '.' + decoded);
  const within = (file: string) => file === rootReal || file.startsWith(rootReal + path.sep);
  if (!within(target)) throw Object.assign(new Error('Forbidden'), { status: 403 });
  let info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    // Missing assets must be 404, not index.html masquerading as JavaScript.
    if (path.extname(decoded)) { res.writeHead(404); res.end('Not found'); return; }
    target = path.join(rootReal, 'index.html');
    info = await stat(target);
  }
  if (!within(await realpath(target))) throw Object.assign(new Error('Forbidden'), { status: 403 });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(target), res);
}

export async function createHub(options: { middleware?: Middleware; host?: '127.0.0.1' } = {}) {
  const config = readConfig();
  if (!options.middleware) await stat(path.join(config.distDir, 'index.html'));
  const db = openDatabase(config.dbPath);
  const env = { ...config.env, PAPC_DB: db };
  const pcf = new PcfApi(new PcfStorage(db.sqlite, config.dataDir), config.env.API_TOKEN);
  const builderReplies = new PcfBuilderReplies(pcf.storage, pcf.exchange, pcf.realtime, config.env.ADMIN_PASSWORD);
  const comments = new ProjectComments(pcf.storage);
  const server = createServer((req, res) => {
    void (async () => {
      // Optional Basic Auth gate for everything, including static assets and SSE.
      if (config.basicAuth && !basicAuthAllows(req.headers.authorization, config.basicAuth)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="PAhub", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Unauthorized'); return;
      }
      // Host headers never control routing or API prefix rewriting.
      const url = new URL(req.url || '/', 'http://pahub.local');
      const commentsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/comments(\.xlsx)?$/);
      if (commentsMatch) {
        if (config.env.API_TOKEN && req.headers.authorization !== 'Bearer ' + config.env.API_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
        }
        if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
        const projectId = safeId(decodeURIComponent(commentsMatch[1]));
        const result = comments.query(projectId, url.searchParams);
        if (commentsMatch[2]) {
          const workbook = await exportCommentsExcel(result);
          res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="Comments-' + projectId + '.xlsx"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(workbook);
        } else {
          const { body, etag } = comments.json(result);
          const unchanged = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W[/]/, '') === etag || value.trim() === '*');
          res.writeHead(unchanged ? 304 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' }); res.end(unchanged ? undefined : body);
        }
        return;
      }
      const projectEvents = url.pathname.match(/^\/api\/projects\/([^/]+)\/events$/);
      if (projectEvents && req.method === 'GET') {
        if (config.env.API_TOKEN && req.headers.authorization !== 'Bearer ' + config.env.API_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
        }
        const projectId = safeId(decodeURIComponent(projectEvents[1]));
        const abort = new AbortController(); res.once('close', () => abort.abort());
        await sendFetch(pcf.realtime.projectStream(projectId, abort.signal), req, res); return;
      }
      const repliesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/builder-replies(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (repliesMatch) {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const body = await readBody(req, config.bodyLimit), projectId = safeId(decodeURIComponent(repliesMatch[1])), action = repliesMatch[2], setId = repliesMatch[3], fileId = repliesMatch[4];
        const bearerOK = !config.env.API_TOKEN || headers.get('Authorization') === 'Bearer ' + config.env.API_TOKEN;
        let payload: unknown;
        if (req.method === 'GET' && setId === 'file' && action && fileId) {
          const reply = builderReplies.getFile(projectId, decodeURIComponent(action), decodeURIComponent(fileId));
          if (!bearerOK && !pcf.validScopedCredential(headers.get('X-PCF-Token'), projectId, reply.drawingId)) {
            res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
          }
          await sendFetch(new Response(reply.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }), req, res); return;
        }
        if (!bearerOK) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        if (req.method === 'POST' && action === 'preview' && !setId) {
          const form = await new Request(url, { method: 'POST', headers, body }).formData();
          payload = await builderReplies.preview(projectId, form);
        } else if (req.method === 'GET' && action === 'pending' && !setId) payload = builderReplies.pending(projectId);
        else if (req.method === 'POST' && setId === 'skip') {
          const match = url.pathname.match(/^\/api\/projects\/[^/]+\/builder-replies\/([^/]+)\/skip$/);
          if (!match) { res.writeHead(404); res.end(); return; }
          const input = JSON.parse(body?.toString('utf8') || '{}');
          payload = builderReplies.skip(projectId, decodeURIComponent(match[1]), input.fileId);
        }
        else if (req.method === 'POST' && setId === 'apply') {
          const match = url.pathname.match(/^\/api\/projects\/[^/]+\/builder-replies\/([^/]+)\/apply$/);
          if (!match) { res.writeHead(404); res.end(); return; }
          const input = JSON.parse(body?.toString('utf8') || '{}');
          payload = builderReplies.apply(projectId, decodeURIComponent(match[1]), input.fileIds, input.batchId);
        } else { res.writeHead(404); res.end(); return; }
        const response = Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
        await sendFetch(response, req, res); return;
      }
      if (url.pathname.startsWith('/api/pcf/') || url.pathname.startsWith('/pcf/')) {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const body = await readBody(req, config.bodyLimit);
        const abort = new AbortController(); res.once('close', () => abort.abort());
        await sendFetch(await pcf.handle(new Request(url, { method: req.method, headers, body, signal: abort.signal }), req.socket.remoteAddress || ''), req, res);
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        url.pathname = url.pathname.slice(4) || '/';
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const body = await readBody(req, config.bodyLimit);
        const request = new Request(url, { method: req.method, headers, body });
        let response = await worker.fetch(request, env);
        const projectWrite = url.pathname.match(/^\/projects\/([^/]+)(?:\/(.*))?$/);
        if (projectWrite && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') && response.ok) {
          const projectId = safeId(decodeURIComponent(projectWrite[1]));
          let drawingIds: string[] = [];
          if (projectWrite[2] === 'review-tracker') {
            try { drawingIds = Object.keys(JSON.parse(body?.toString('utf8') || '{}')); } catch {}
          } else if (!projectWrite[2] && body?.length) {
            try {
              const input = JSON.parse(body.toString('utf8'));
              drawingIds = req.method === 'PATCH'
                ? [...(input.updatedDrawings || []).map((d: any) => d.id), ...Object.keys(input.reviewTracker || {})]
                : (input.project?.drawings || []).map((d: any) => d.id);
            } catch {}
          }
          const fields = projectWrite[2] === 'review-tracker' ? ['reviewTracker'] : ['project-data'];
          for (const drawingId of [...new Set(drawingIds.filter((id): id is string => typeof id === 'string'))]) pcf.realtime.projectChanged(projectId, drawingId, fields);
        }
        if (url.pathname === '/admin' && response.headers.get('Content-Type')?.includes('text/html')) {
          const html = (await response.text()).replaceAll('/admin/api', '/api/admin/api').replaceAll('/admin/auth', '/api/admin/auth');
          const mapped = new Headers(response.headers);
          mapped.delete('Content-Length');
          response = new Response(html, { status: response.status, headers: mapped });
        }
        await sendFetch(response, req, res);
      } else if (options.middleware) {
        await new Promise<void>((resolve, reject) => {
          res.once('finish', resolve);
          options.middleware!(req, res, error => {
            if (error) reject(error);
            else { res.writeHead(404); res.end('Not found'); resolve(); }
          });
        });
      } else {
        await serveStatic(req, res, config.distDir, url.pathname);
      }
    })().catch(error => {
      if (res.destroyed && error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      console.error('PAhub request failed:', error);
      if (res.headersSent) res.destroy();
      else { res.writeHead(error.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(error.status ? error.message : 'Internal server error'); }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, options.host || '0.0.0.0', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { db.sqlite.close(); throw error; }
  const address = server.address() as import('node:net').AddressInfo;
  console.log('PAhub listening on http://' + address.address + ':' + address.port + ' (pid ' + process.pid + ')');
  console.log('PAhub database: ' + config.dbPath);
  return {
    server, db, port: address.port,
    close: async () => {
      pcf.realtime.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.sqlite.close();
    },
  };
}
