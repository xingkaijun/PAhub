import { createHash } from 'node:crypto';

// Validator over the exact JSON body (kept as-is when http.ts compresses the response).
export const etagOf = (body: string) => '"' + createHash('sha256').update(body).digest('base64url').slice(0, 32) + '"';

// If-None-Match may list several tags, weak or strong, or '*'; the weak comparison is enough for a full-body 304.
export function etagMatches(header: string | null, etag: string) {
  return (header || '').split(',').some(value => { const tag = value.trim(); return tag === '*' || tag.replace(/^W\//, '') === etag; });
}

// JSON response that answers 304 with no body when the client already holds this exact payload.
export function conditionalJson(request: Request, data: unknown) {
  const body = JSON.stringify(data), etag = etagOf(body);
  const unchanged = etagMatches(request.headers.get('if-none-match'), etag);
  return new Response(unchanged ? null : body, { status: unchanged ? 304 : 200, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff',
  } });
}
