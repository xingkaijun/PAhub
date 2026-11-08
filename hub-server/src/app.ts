import {AdminApi} from './admin-api.ts';
import {readConfig} from './config.ts';
import {openDatabase} from './database.ts';
import {PcfStorage} from './pcf-storage.ts';
import {PcfApi} from './pcf-api.ts';
import {Router} from './router.ts';
import {registerPcfRoutes} from './pcf-routes.ts';
import {registerProjectRoutes} from './project-routes.ts';
import {ProjectWriter} from './project-write.ts';
import {registerTrackerRoutes} from './tracker-routes.ts';
import {registerActivityRoutes} from './activity-routes.ts';
import {registerSystemRoutes} from './system-routes.ts';
import {listenHub} from './listener.ts';
import type {Middleware} from './http.ts';

export async function createHub(options: {middleware?: Middleware;host?: '127.0.0.1'} = {}) {
 const config=readConfig(),db=openDatabase(config.dbPath);
 const pcf=new PcfApi(new PcfStorage(db,config.dataDir),config.env.API_TOKEN);
 const router=new Router(config.env),writer=new ProjectWriter(pcf.storage,pcf.realtime);
 registerPcfRoutes(router,pcf,config.env.ADMIN_PASSWORD);
 registerProjectRoutes(router,writer);
 registerTrackerRoutes(router,writer);
 registerActivityRoutes(router,db);
 registerSystemRoutes(router,db);
 const admin=new AdminApi(db,config.dbPath,config.env.ADMIN_PASSWORD,writer);
 router.add({pattern:/^\/api\/admin(?:\/|$)/,auth:'none',handle:ctx=>admin.handle(ctx.request)});
 try {
  const hub=await listenHub(router,config,pcf.realtime,options);
  return {...hub,db,close:async()=>{await hub.close();db.close();}};
 }catch(error){pcf.realtime.close();db.close();throw error;}
}
