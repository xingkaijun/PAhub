import type { DatabaseSync } from 'node:sqlite';
import type { KjxDirectory, DirectoryPerson } from './kjx-directory.ts';
import { getKjxUser } from './kjx-users.ts';
import { fail, type Op } from './pcf-model.ts';
import type { RequestUser } from './identity.ts';

// Reviewers never get this resolver: submitted identity fields are ignored.
export async function resolveInitiatorOps(db: DatabaseSync, directory: KjxDirectory | undefined, project: string, user: RequestUser, ops: Op[]): Promise<Record<string, { id: string; name: string }> | undefined> {
  if (!['admin', 'manager'].includes(user.role)) return;
  const requests = ops.filter(op => op?.type === 'round.meta' && op.field === 'initiator' && op.initiatorId !== undefined);
  if (!requests.length) return;
  const remote = await directory?.list();
  const resolved = new Map<string, { id: string; name: string }>();
  for (const op of requests) {
    const id = op.initiatorId;
    if (typeof id !== 'string' || !id || id.startsWith('manual-')) fail('Unknown initiator');
    let person: Pick<DirectoryPerson, 'id' | 'name'> | undefined;
    if (id === user.id) person = user;
    else if (remote?.ok) person = remote.users.find(p => p.id === id);
    // Directory outages do not erase project membership/name snapshots.
    if (!person) {
      const cached = getKjxUser(db, id);
      if (!remote?.ok && cached && ['admin', 'manager', 'reviewer'].includes(cached.role)) person = cached;
      if (!person) {
        const team = db.prepare(`SELECT r.id,r.display_name AS name FROM reviewers r WHERE r.id=? AND (
          EXISTS(SELECT 1 FROM discipline_defaults x WHERE x.project_id=? AND x.reviewer_id=r.id) OR
          EXISTS(SELECT 1 FROM discipline_default_assignees x WHERE x.project_id=? AND x.reviewer_id=r.id) OR
          EXISTS(SELECT 1 FROM drawing_assignees x JOIN drawings d ON d.id=x.drawing_id WHERE d.project_id=? AND x.reviewer_id=r.id))`).get(id, project, project, project);
        if (team) person = { id: String(team.id), name: String(team.name) };
      }
    }
    if (!person) fail('Unknown initiator');
    resolved.set(id, { id: person.id, name: person.name });
  }
  return Object.fromEntries(resolved);
}
