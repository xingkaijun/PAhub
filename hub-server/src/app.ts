import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdminApi } from './admin-api.ts';
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


export async function createHub(options: { middleware?: Middleware; host?: '127.0.0.1' } = {}) {
  const config = readConfig();
  if (!options.middleware) await stat(path.join(config.distDir,'index.html'));
  const db = openDatabase(config.dbPath);
  const pcf = new PcfApi(new PcfStorage(db.sqlite,config.dataDir),config.env.API_TOKEN);
  const router = new Router(config.env);
  registerPcfRoutes(router,pcf,config.env.ADMIN_PASSWORD);
  const writer = new ProjectWriter(pcf.storage,pcf.realtime);
  registerProjectRoutes(router,writer);
  registerTrackerRoutes(router,writer);
  registerActivityRoutes(router,db.sqlite);
  registerSystemRoutes(router,db.sqlite);
  const admin = new AdminApi(db.sqlite,config.dbPath,config.env.ADMIN_PASSWORD,writer);
  router.add({ pattern: /^\/api\/admin(?:\/|$)/, auth: 'none', handle: ctx => admin.handle(ctx.request) });
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
