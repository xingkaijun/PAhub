// Local development / P4-8 acceptance only. Not imported by any build entrypoint.
import { createServer, request as forward } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createKjxTestSigner } from '../hub-server/src/kjx-auth-client.ts';

export const DEV_ROLES = ['viewer', 'reviewer', 'manager', 'admin'];
export async function startDevProxy({ port = 0, upstream, directoryUnavailable = false } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('The kjx development proxy refuses NODE_ENV=production');
  const signer = createKjxTestSigner();
  // Accounts, signing keys and service credentials exist only in memory per run.
  const users = Object.fromEntries(DEV_ROLES.map(role => [role, {
    id: randomUUID(), username: randomUUID(), name: 'Acceptance ' + role,
    role, title: 'Local acceptance', disciplines: ['HULL', 'MACH', 'ELEC', 'OUTFIT'], active: true,
  }]));
  const clientId = randomUUID(), clientSecret = randomBytes(32).toString('base64url');
  const serviceToken = randomBytes(32).toString('base64url');
  let target;
  const setUpstream = raw => {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Proxy upstream must be a local HTTP server');
    target = url;
  };
  if (upstream) setUpstream(upstream);
  const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/.well-known/jwks.json') return json(res, 200, signer.jwks());
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      let text = ''; req.on('data', bytes => { text += bytes; if (text.length > 8192) req.destroy(); });
      req.on('end', () => {
        const form = new URLSearchParams(text);
        if (directoryUnavailable) return json(res, 503, { error: 'development_directory_unavailable' });
        if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return json(res, 401, { error: 'invalid_client' });
        json(res, 200, { access_token: serviceToken, token_type: 'Bearer', expires_in: 600 });
      }); return;
    }
    if (url.pathname === '/api/directory/users') {
      if (directoryUnavailable) return json(res, 503, { error: 'development_directory_unavailable' });
      if (req.headers.authorization !== 'Bearer ' + serviceToken) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, Object.values(users));
    }
    if (url.pathname === '/__dev/role') {
      const role = url.searchParams.get('role');
      if (!DEV_ROLES.includes(role)) return json(res, 400, { error: 'Choose viewer, reviewer, manager or admin' });
      return json(res, 200, { role, name: users[role].name }, { 'Set-Cookie': 'kjx_dev_role=' + role + '; Path=/; HttpOnly; SameSite=Strict' });
    }
    if (!target) return json(res, 503, { error: 'development_backend_not_started' });
    const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('kjx_dev_role='));
    const selected = cookie?.slice('kjx_dev_role='.length);
    const headers = { ...req.headers, host: target.host };
    // Emulate nginx auth_request: overwrite, never trust a client-supplied identity.
    delete headers['x-auth-token']; delete headers['x-auth-user'];
    if (DEV_ROLES.includes(selected)) {
      const user = users[selected];
      headers['x-auth-token'] = signer.signUser('pahub', { sub: user.id, username: user.username, name: user.name, title: user.title, disciplines: user.disciplines, role: user.role });
    }
    const outgoing = forward(new URL(req.url || '/', target), { method: req.method, headers }, response => {
      res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
    });
    outgoing.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'development_backend_unavailable' }); else res.destroy(); });
    res.on('close', () => outgoing.destroy()); req.pipe(outgoing);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, signer, users, clientId, clientSecret, setUpstream, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = await startDevProxy({ port: Number(process.env.KJX_DEV_PROXY_PORT || 8082), upstream: process.env.KJX_DEV_UPSTREAM || 'http://127.0.0.1:8080', directoryUnavailable: process.env.KJX_DEV_DIRECTORY_UNAVAILABLE === '1' });
  console.log('Development proxy listening at ' + proxy.origin + '; select a role at /__dev/role?role=reviewer');
  // CLI use: configure backend KJX_JWKS_URL to this origin + /.well-known/jwks.json.
  // Directory credentials are intentionally not printed; acceptance launcher wires them in memory.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await proxy.close(); process.exit(0); });
}
