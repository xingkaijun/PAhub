import type { DatabaseSync } from 'node:sqlite';
import type { RequestUser } from './identity.ts';
import { projectFromPath } from './project-session.ts';
import { hasPermission } from './capabilities.ts';
import {writeAudit} from './audit.ts';

// reviewers is global. Only project-scoped Team Setup links grant membership;
// individual drawing assignments, tracker rows, and names never grant access.
export function initializeMembershipSchema(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS project_team_reviewers (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, reviewer_id TEXT NOT NULL, PRIMARY KEY(project_id,reviewer_id))');
}
export function isProjectMember(db: DatabaseSync, project: string, user: RequestUser | undefined): boolean {
  if (!user || !user.id || user.id.startsWith('manual-')) return false;
  return !!db.prepare(`SELECT 1 FROM projects p WHERE p.id=? AND (
    EXISTS(SELECT 1 FROM discipline_defaults t WHERE t.project_id=p.id AND t.reviewer_id=?) OR
    EXISTS(SELECT 1 FROM discipline_default_assignees t WHERE t.project_id=p.id AND t.reviewer_id=?) OR
    EXISTS(SELECT 1 FROM project_team_reviewers t WHERE t.project_id=p.id AND t.reviewer_id=?))`).get(project,user.id,user.id,user.id);
}
export const canAccessProject = (db: DatabaseSync, project: string, user: RequestUser | undefined) => user?.role === 'admin' || isProjectMember(db,project,user);
export function membershipDenied(): Response {
  return Response.json({ok:false,error:'forbidden',capability:'project.member',message:'You no longer have access to this workspace. Ask a project administrator to add you to Team Setup.'},{status:403,headers:{'Cache-Control':'no-store'}});
}
export function requireProjectAccess(db: DatabaseSync, project: string, user: RequestUser | undefined) {
  if (!canAccessProject(db,project,user)) throw Object.assign(new Error('forbidden'),{status:403,body:{ok:false,capability:'project.member'}});
}
export function projectRequestDenied(db: DatabaseSync, request: Request, user: RequestUser | undefined): Response | undefined {
  const url = new URL(request.url), project = projectFromPath(url.pathname);
  if (project) {
    // Implicit creation is a deliberate exception only for the exact project PATCH.
    if (request.method==='PATCH' && /^\/api\/projects\/[^/]+$/.test(url.pathname) && hasPermission(user,'project.create') && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(project)) return;
    if (!canAccessProject(db,project,user)) return membershipDenied();
  }
  if (url.pathname==='/api/team/directory') {
    const id=url.searchParams.get('projectId');
    if (user?.role==='admin' && !id) return;
    if (!id || !canAccessProject(db,id,user)) return membershipDenied();
  }
}
export function projectRoster(db: DatabaseSync, project: string) {
  return db.prepare(`SELECT r.id,r.display_name AS name FROM reviewers r WHERE r.id IN (
    SELECT reviewer_id FROM project_team_reviewers WHERE project_id=? UNION
    SELECT reviewer_id FROM discipline_defaults WHERE project_id=? UNION
    SELECT reviewer_id FROM discipline_default_assignees WHERE project_id=?) ORDER BY r.display_name,r.id`).all(project,project,project);
}
export function saveProjectRoster(db: DatabaseSync, project: string, reviewers: {id:string;name:string}[]) {
  if(!Array.isArray(reviewers) || reviewers.some(person=>!person || typeof person.id!=='string' || !person.id || typeof person.name!=='string'))throw Object.assign(new Error('Invalid project roster'),{status:400});
  const before=projectRoster(db,project).map(person=>String(person.id));
  db.prepare('DELETE FROM project_team_reviewers WHERE project_id=?').run(project);
  for (const person of reviewers) {
    db.prepare('INSERT INTO reviewers(id,display_name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name').run(person.id,person.name);
    db.prepare('INSERT OR IGNORE INTO project_team_reviewers VALUES(?,?)').run(project,person.id);
  }
  writeAudit(db,{table:'project_team_reviewers',projectId:project,action:'TEAM_SETUP',detail:{before,after:reviewers.map(person=>person.id)}});
}
