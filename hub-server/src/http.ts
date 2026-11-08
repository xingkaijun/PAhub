import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function sendFetch(response: Response, req: IncomingMessage, res: ServerResponse) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (req.method === 'HEAD' || !response.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
}
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw Object.assign(new Error('Method not allowed'), { status: 405 });
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0') || decoded.includes('\\')) throw Object.assign(new Error('Invalid path'), { status: 400 });
  const rootReal = await realpath(root);
  let target = path.resolve(rootReal, '.' + decoded);
  const within = (file: string) => file === rootReal || file.startsWith(rootReal + path.sep);
  if (!within(target)) throw Object.assign(new Error('Forbidden'), { status: 403 });
  let info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    if (path.extname(decoded)) throw Object.assign(new Error('Not found'), { status: 404 });
    target = path.join(rootReal, 'index.html'); info = await stat(target);
  }
  if (!within(await realpath(target))) throw Object.assign(new Error('Forbidden'), { status: 403 });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Content-Length': info.size,
    'Cache-Control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(target), res);
}
