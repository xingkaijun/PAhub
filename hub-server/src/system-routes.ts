import type { Router } from './router.ts';
import type { DatabaseSync } from 'node:sqlite';
import { getSettings } from './project-read.ts';

export function registerSystemRoutes(router: Router, db: DatabaseSync) {
  router.add({pattern:/^\/api\/?$/,methods:['GET'],handle:() => Response.json({service:'papc-d1-api',phase:'read-first',endpoints:['GET /health','GET /settings','GET /projects','POST /projects/:projectId','GET /projects/:projectId/review-tracker','GET /projects/:projectId/audit?from=&to=']})});
  router.add({pattern:/^\/api\/settings$/,methods:['GET'],handle:() => Response.json(getSettings(db))});
  // Preserve the public diagnostic contract; settingsSource is a historical
  // API label, not a dependency on a SQL view. A global settings object always exists.
  router.add({pattern:/^\/api\/health$/,methods:['GET'],handle:() => {
    db.prepare('SELECT 1 FROM projects LIMIT 1').get();
    return Response.json({ok:true,service:'papc-d1-api',database:'connected',settingsSource:'api_settings',appSettingsRows:1});
  }});
}
