import { createReadStream } from 'node:fs';
import { stat, realpath, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlib } from 'node:zlib';

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
const brotliAsync = promisify(brotliCompress), gzipAsync = promisify(gzip);
// Bodies smaller than this are sent as-is: the encoding overhead is not worth it.
export const COMPRESS_MIN_BYTES = 1024;
export type Encoding = 'br' | 'gzip';
// Text types only; images, fonts, zip/xlsx and other already-compressed formats are never re-encoded.
export function compressibleType(contentType: string | null | undefined) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return type.startsWith('text/') && type !== 'text/event-stream' || type === 'application/json' || type === 'application/javascript'
    || type === 'application/xml' || type === 'image/svg+xml' || type.endsWith('+json');
}
// br is preferred over gzip; q=0 excludes an encoding.
export function negotiateEncoding(accept: string | string[] | undefined): Encoding | null {
  const offered = new Map<string, number>();
  for (const part of String(Array.isArray(accept) ? accept.join(',') : accept || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    offered.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const ok = (name: string) => (offered.get(name) ?? (offered.has('*') ? offered.get('*')! : 0)) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}
// Dynamic responses use a fast level; static files are compressed once at the highest level and kept in memory.
export function compressBody(body: Buffer, encoding: Encoding, best = false): Promise<Buffer> {
  if (encoding === 'br') return brotliAsync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: best ? 11 : 5, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length, [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT } });
  return gzipAsync(body, { level: best ? 9 : 6 });
}
function addVary(res: ServerResponse) {
  const current = String(res.getHeader('Vary') || '');
  if (!/(^|,)\s*accept-encoding\s*(,|$)/i.test(current)) res.setHeader('Vary', current ? current + ', Accept-Encoding' : 'Accept-Encoding');
}
export async function sendFetch(response: Response, req: IncomingMessage, res: ServerResponse) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (req.method === 'HEAD' || !response.body) { res.end(); return; }
  const type = response.headers.get('content-type');
  if (compressibleType(type) && !response.headers.has('content-encoding') && response.status !== 206) {
    addVary(res);
    const encoding = negotiateEncoding(req.headers['accept-encoding']);
    if (encoding) {
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length < COMPRESS_MIN_BYTES) { res.setHeader('Content-Length', body.length); res.end(body); return; }
      const compressed = await compressBody(body, encoding);
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', compressed.length);
      // ETag stays as the route set it (a hash of the JSON): Vary: Accept-Encoding keeps caches per encoding, and
      // the routes' If-None-Match checks (pcf-routes, etag.ts) keep matching whichever encoding the client got.
      res.end(compressed);
      return;
    }
  }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
}
const staticCache = new Map<string, { mtimeMs: number; size: number; body: Buffer }>();
const STATIC_CACHE_LIMIT = 64;
async function compressedStatic(file: string, info: { mtimeMs: number; size: number }, encoding: Encoding) {
  const key = encoding + ':' + file, hit = staticCache.get(key);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.body;
  const body = await compressBody(await readFile(file), encoding, true);
  if (staticCache.size >= STATIC_CACHE_LIMIT) staticCache.delete(staticCache.keys().next().value!);
  staticCache.set(key, { mtimeMs: info.mtimeMs, size: info.size, body });
  return body;
}
// Vite emits content-hashed names under /assets/ (index-BJsX14S3.js), so those never change and can be cached forever.
export function staticCacheControl(rootReal: string, target: string) {
  if (path.basename(target) === 'index.html') return 'no-cache';
  const rel = path.relative(rootReal, target).split(path.sep);
  if (rel.length === 2 && rel[0] === 'assets' && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(rel[1])) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
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
  const type = MIME[path.extname(target)] || 'application/octet-stream';
  const headers: Record<string, string | number> = { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': staticCacheControl(rootReal, target), 'X-Content-Type-Options': 'nosniff' };
  if (compressibleType(type)) {
    headers.Vary = 'Accept-Encoding';
    const encoding = info.size >= COMPRESS_MIN_BYTES ? negotiateEncoding(req.headers['accept-encoding']) : null;
    if (encoding) {
      const body = await compressedStatic(target, info, encoding);
      res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
      if (req.method === 'HEAD') res.end(); else res.end(body);
      return;
    }
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(target), res);
}
