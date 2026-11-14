import {createServer} from 'node:http';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import type {PcfRealtime} from './pcf-realtime.ts';
import type {readConfig} from './config.ts';
import {Router,basicAuthResponse,caughtError,logRequest,errorResponse} from './router.ts';
import {readBody,sendFetch,serveStatic,type Middleware} from './http.ts';

export async function listenHub(router: Router, config: ReturnType<typeof readConfig>, realtime: PcfRealtime, options: {middleware?: Middleware;host?: '127.0.0.1'}) {
 if(!options.middleware)await stat(path.join(config.distDir,'index.html'));
 const server=createServer((req,res)=>{
  logRequest(req,res);
  void(async()=>{
   const denied=router.kjx ? undefined : basicAuthResponse(req.headers.authorization,config.basicAuth);
   if(denied){await sendFetch(denied,req,res);return;}
   const url=new URL(req.url || '/','http://pahub.local');
   if(router.kjx && !(url.pathname==='/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/pcf/'))){
    const headers=new Headers();
    for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
    const request=new Request(url,{method:req.method,headers});
    const denied=await router.authenticate(request) || router.originDenied(request) || router.transportDenied(request);
    if(denied){await sendFetch(denied,req,res);return;}
   }
   if(url.pathname==='/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/pcf/')){
    const headers=new Headers();
    for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
    headers.set('X-Hub-Remote-Address',req.socket.remoteAddress || '');
    const body=await readBody(req,config.bodyLimit),abort=new AbortController();res.once('close',()=>abort.abort());
    await sendFetch(await router.handle(new Request(url,{method:req.method,headers,body,signal:abort.signal})),req,res);
   }else if(options.middleware){
    await new Promise<void>((resolve,reject)=>{
     res.once('finish',resolve);options.middleware!(req,res,error=>{
      if(error)reject(error);else void sendFetch(errorResponse('Not found',404),req,res).then(resolve,reject);
     });
    });
   }else await serveStatic(req,res,config.distDir,url.pathname);
  })().catch((error:unknown)=>{
   if(res.destroyed && (error as {code?:string})?.code==='ERR_STREAM_PREMATURE_CLOSE')return;
   if(res.headersSent)res.destroy();else void sendFetch(caughtError(error),req,res);
  });
 });
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);server.listen(config.port,options.host || '0.0.0.0',()=>{server.off('error',reject);resolve();});
 });
 const address=server.address() as import('node:net').AddressInfo;
 console.log('PAhub listening on http://'+address.address+':'+address.port+' (pid '+process.pid+')');
 console.log('PAhub database: '+config.dbPath);
 // Make the development convenience visible so an exposed deployment cannot miss it.
 if(!router.kjx && !config.env.ADMIN_PASSWORD?.trim())console.warn('WARNING: ADMIN_PASSWORD is not set. Every visitor is treated as an administrator; set ADMIN_PASSWORD before exposing PAhub.');
 return {server,port:address.port,close:async()=>{realtime.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
