import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '@pahub/worker';
import { readConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { PcfStorage } from './pcf-storage.ts';
import { PcfApi } from './pcf-api.ts';
import { writeDrawing } from './drawing-write.ts';
import { Router, basicAuthResponse, caughtError, logRequest, errorResponse } from './router.ts';
import { registerPcfRoutes } from './pcf-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { ProjectWriter } from './project-write.ts';
import { registerTrackerRoutes } from './tracker-routes.ts';
import { registerActivityRoutes } from './activity-routes.ts';
import { registerSystemRoutes } from './system-routes.ts';
import { readBody, sendFetch, serveStatic, type Middleware } from './http.ts';

function readOnlyQuery(dbPath: string, sql: string): Record<string, unknown>[] {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    reader.exec('PRAGMA query_only = ON');
    return reader.prepare(sql).all().map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,value instanceof Uint8Array ? Array.from(value) : value])));
  } finally { reader.close(); }
}

export async function createHub(options: { middleware?: Middleware; host?: '127.0.0.1' } = {}) {
  const config = readConfig();
  if (!options.middleware) await stat(path.join(config.distDir,'index.html'));
  const db = openDatabase(config.dbPath);
  const pcf = new PcfApi(new PcfStorage(db.sqlite,config.dataDir),config.env.API_TOKEN);
  const env = { ...config.env, PAPC_DB: db, ADMIN_SQL: (sql: string) => readOnlyQuery(config.dbPath,sql), DRAWING_WRITE: (p: string,d: any) => writeDrawing(pcf.storage,pcf.realtime,p,d) };
  const router = new Router(config.env);
  registerPcfRoutes(router,pcf,config.env.ADMIN_PASSWORD);
  const writer = new ProjectWriter(pcf.storage,pcf.realtime);
  registerProjectRoutes(router,writer);
  registerTrackerRoutes(router,writer);
  registerActivityRoutes(router,db.sqlite);
  registerSystemRoutes(router,db.sqlite);
  // Temporary fallback while modules are migrated in order.
  router.add({ pattern: /^\/api(?:\/|$)/, auth: 'none', handle: async ctx => {
    const url = new URL(ctx.request.url); url.pathname = url.pathname.slice(4) || '/';
    let response = await worker.fetch(new Request(url,ctx.request),env);
    if (url.pathname === '/admin' && response.headers.get('Content-Type')?.includes('text/html')) {
      const html = (await response.text()).replaceAll('/admin/api','/api/admin/api').replaceAll('/admin/auth','/api/admin/auth');
      const headers = new Headers(response.headers); headers.delete('Content-Length');
      response = new Response(html,{ status:response.status,headers });
    }
    return response;
  } });
  const server = createServer((req,res) => {
    logRequest(req,res);
    void (async () => {
      const denied = basicAuthResponse(req.headers.authorization,config.basicAuth);
      if (denied) { await sendFetch(denied,req,res); return; }
      const url = new URL(req.url || '/','http://pahub.local');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/pcf/')) {
        const headers = new Headers();
        for (const [key,value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key,Array.isArray(value) ? value.join(', ') : value);
        headers.set('X-Hub-Remote-Address',req.socket.remoteAddress || '');
        const body = await readBody(req,config.bodyLimit);
        const abort = new AbortController(); res.once('close',() => abort.abort());
        await sendFetch(await router.handle(new Request(url,{ method:req.method,headers,body,signal:abort.signal })),req,res);
      } else if (options.middleware) {
        await new Promise<void>((resolve,reject) => {
          res.once('finish',resolve);
          options.middleware!(req,res,error => {
            if (error) reject(error);
            else { void sendFetch(errorResponse('Not found',404),req,res).then(resolve,reject); }
          });
        });
      } else await serveStatic(req,res,config.distDir,url.pathname);
    })().catch(error => {
      if (res.destroyed && error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      if (res.headersSent) res.destroy(); else void sendFetch(caughtError(error),req,res);
    });
  });
  try {
    await new Promise<void>((resolve,reject) => {
      server.once('error',reject);
      server.listen(config.port,options.host || '0.0.0.0',() => { server.off('error',reject); resolve(); });
    });
  } catch (error) { pcf.realtime.close(); db.sqlite.close(); throw error; }
  const address = server.address() as import('node:net').AddressInfo;
  console.log('PAhub listening on http://' + address.address + ':' + address.port + ' (pid ' + process.pid + ')');
  console.log('PAhub database: ' + config.dbPath);
  return { server,db,port:address.port,close: async () => {
    pcf.realtime.close();
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    db.sqlite.close();
  } };
}
