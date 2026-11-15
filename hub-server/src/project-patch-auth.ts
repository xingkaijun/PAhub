import type { DatabaseSync } from 'node:sqlite';
import type { RequestUser } from './identity.ts';
import { hasPermission, type Capability } from './capabilities.ts';
import {authorizeTracker} from './tracker-auth.ts';
import { DRAWING_COLUMNS } from './drawing-revision.ts';

// Check the complete request under the PATCH transaction, before even implicit creation.
// Unknown keys require admin rather than inheriting permission from a nearby known key.
export function authorizeProjectPatch(db: DatabaseSync, project: string, body: Record<string, any>, user: RequestUser) {
  const require = (capability: Capability) => {
    if (!hasPermission(user, capability)) throw Object.assign(new Error('forbidden'), { status: 403, body: { ok: false, capability } });
  };
  const existingProject = db.prepare('SELECT name FROM projects WHERE id=?').get(project);
  if (!existingProject) require('project.create');
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'projectName':
        // Every browser delta carries this unchanged label; PATCH never renames an existing project.
        if (existingProject && value !== existingProject.name) require('settings.write');
        break;
      case 'updatedDrawings':
        for (const drawing of value || []) {
          const existing = drawing.id && db.prepare('SELECT 1 FROM drawings WHERE project_id=? AND id=?').get(project,drawing.id);
          require(existing ? 'drawing.update' : 'bulk.import');
          const envelope = new Set(['id', 'rev', 'baseRev', 'base', 'changes', 'remarkOps']);
          for (const field of Object.keys(drawing)) if (!envelope.has(field)) classify(field);
          for (const field of Object.keys(drawing.changes || {})) classify(field);
          // Existing drawing assignments are business updates; team definitions live in conf.
          function classify(field: string) {
            if (Object.hasOwn(DRAWING_COLUMNS, field) || ['assignees','remarks','statusHistory','logs'].includes(field)) require('drawing.update');
            else if (field !== 'id') require('admin.only');
          }
        }
        break;
      case 'deletedDrawingIds':
        for (const _id of value || []) require('drawing.void');
        break;
      case 'conf':
        for (const field of Object.keys(value || {})) require(!existingProject && ['reviewers','disciplineDefaults','defaultAssignees','holidays','roundACycle','otherRoundsCycle','displayName','autoSyncInterval','projectSummary'].includes(field) ? 'project.create' : ['reviewers','disciplineDefaults','defaultAssignees'].includes(field) ? 'team.setup' : ['holidays','roundACycle','otherRoundsCycle','displayName','autoSyncInterval','projectSummary'].includes(field) ? 'project.settings' : 'settings.write');
        break;
      case 'confBase':
        // Conflict baselines are not persisted, but unknown keys still fail closed.
        for (const field of Object.keys(value || {})) if (!Object.hasOwn(body.conf || {},field)) require('admin.only');
        break;
      case 'reviewTracker':
        authorizeTracker(db,project,value,user,false);
        break;
      default: require('admin.only');
    }
  }
}
