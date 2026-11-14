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
import {migratePcfJsonAtStartup} from './pcf-json-migration.ts';
import {createAdminSession,registerAdminSessionRoutes} from './admin-session.ts';
import {migrateProjectPasswords} from './project-password.ts';
import {createProjectSession} from './project-session.ts';
import {createIdentity,createProductionVerifier,requestUser} from './identity.ts';
import type {KjxVerifier} from './kjx-auth-client.ts';
import {ADMIN_POLICIES} from './capabilities.ts';

export async function createHub(options: {middleware?: Middleware;host?: '127.0.0.1';verifier?: KjxVerifier} = {}) {
 const config=readConfig();
 // No listener or live SQLite connection exists while migration/backup runs.
 migratePcfJsonAtStartup(config.dataDir,config.dbPath);
 const db=openDatabase(config.dbPath);
 try { migrateProjectPasswords(db,config.dataDir); } catch (error) { db.close(); throw error; }
 const legacyAdmin=createAdminSession({password:config.env.ADMIN_PASSWORD,apiToken:config.env.API_TOKEN});
 const adminSession=config.identity.mode==='kjx' ? {...legacyAdmin,isAdmin:(request:Request)=>requestUser(request)?.role==='admin'} : legacyAdmin;
 const projectSession=createProjectSession(db,adminSession);
 const pcf=new PcfApi(new PcfStorage(db,config.dataDir),config.env.API_TOKEN,adminSession,projectSession,{mode:config.identity.mode,grantSecret:config.grantSecret});
 const authenticate=config.identity.mode==='kjx' ? createIdentity(options.verifier || createProductionVerifier(config.identity),db) : undefined;
 const router=new Router({...config.env,adminSession,projectSession,identity:config.identity,authenticate}),writer=new ProjectWriter(pcf.storage,pcf.realtime);
 registerAdminSessionRoutes(router,adminSession);
 registerPcfRoutes(router,pcf,config.env.ADMIN_PASSWORD);
 registerProjectRoutes(router,writer);
 registerTrackerRoutes(router,writer);
 registerActivityRoutes(router,db);
 registerSystemRoutes(router,db);
 const admin=new AdminApi(db,config.dbPath,config.env.ADMIN_PASSWORD,writer,config.identity.publicUrl);
 router.add({pattern:/^\/api\/admin(?:\/|$)/,auth:'none',policies:ADMIN_POLICIES,handle:ctx=>admin.handle(ctx.request)});
 try {
  const hub=await listenHub(router,config,pcf.realtime,options);
  return {...hub,db,writer,router,pcf,close:async()=>{await hub.close();db.close();}};
 }catch(error){pcf.realtime.close();db.close();throw error;}
}
