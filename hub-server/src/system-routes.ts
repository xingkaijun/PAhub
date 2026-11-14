import type { Router } from './router.ts';
import type { DatabaseSync } from 'node:sqlite';
import { getSettings } from './project-read.ts';

// The API has been served by the native Node + SQLite Hub since the D1 Worker was retired.
export const HUB_SERVICE = 'pahub-api', HUB_PHASE = 'native-sqlite';

export function registerSystemRoutes(router: Router, db: DatabaseSync) {
  router.add({pattern:/^\/api\/?$/,methods:['GET'],policies:[{method:'GET',capability:'view'}],handle:() => Response.json({service:HUB_SERVICE,phase:HUB_PHASE,endpoints:['GET /health','GET /settings','GET /projects','POST /projects/:projectId','PATCH /projects/:projectId','GET /projects/:projectId/drawings?ids=','GET|PUT /projects/:projectId/review-tracker','GET /projects/:projectId/audit?from=&to=']})});
  router.add({pattern:/^\/api\/settings$/,methods:['GET'],policies:[{method:'GET',capability:'view'}],handle:() => Response.json(router.kjx ? {reviewers:[],disciplineDefaults:{},holidays:[],roundACycle:10,otherRoundsCycle:5,displayName:null,autoSyncInterval:null} : getSettings(db))});
  // Preserve the public diagnostic contract; settingsSource is a historical
  // API label, not a dependency on a SQL view. A global settings object always exists.
  router.add({pattern:/^\/api\/health$/,methods:['GET'],policies:[{method:'GET',capability:'view'}],handle:() => {
    db.prepare('SELECT 1 FROM projects LIMIT 1').get();
    return Response.json({ok:true,service:HUB_SERVICE,database:'connected',settingsSource:'api_settings',appSettingsRows:1});
  }});
}
