import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

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

export async function createHub(options: { middleware?: Middleware } = {}) {
  const config = readConfig();
  if (!options.middleware) await stat(path.join(config.distDir, 'index.html'));
  const db = openDatabase(config.dbPath);
  const env = { ...config.env, PAPC_DB: db };
  const pcf = new PcfApi(new PcfStorage(db.sqlite, config.dataDir), config.env.API_TOKEN);
  const server = createServer((req, res) => {
    void (async () => {
      // Host headers never control routing or API prefix rewriting.
      const url = new URL(req.url || '/', 'http://pahub.local');
      if (url.pathname.startsWith('/api/pcf/') || url.pathname.startsWith('/pcf/')) {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const body = await readBody(req, config.bodyLimit);
        await sendFetch(await pcf.handle(new Request(url, { method: req.method, headers, body }), req.socket.remoteAddress || ''), req, res);
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
      console.error('PAhub request failed:', error);
      if (res.headersSent) res.destroy();
      else { res.writeHead(error.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(error.status ? error.message : 'Internal server error'); }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { db.sqlite.close(); throw error; }
  const address = server.address() as import('node:net').AddressInfo;
  console.log('PAhub listening on http://0.0.0.0:' + address.port + ' (pid ' + process.pid + ')');
  console.log('PAhub database: ' + config.dbPath);
  return {
    server, db, port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.sqlite.close();
    },
  };
}
