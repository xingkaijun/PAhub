import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { readDrawing, DRAWING_COLUMNS } from './drawing-revision.ts';
import { getProjectConfiguration, getReviewTracker } from './project-read.ts';
import {projectRoster} from './project-membership.ts';

const trackerValue = (value: any) => Object.fromEntries(Object.entries(value || {}).map(([id, info]: [string, any]) => [id, { done: info?.done === true || info?.done === 1, doneAt: info?.doneAt ?? null }]));
// Only omit recognized values that are already stored. Unknown keys always
// reach fail-closed authorization. Run inside the PATCH locks/transaction and
// remove no-ops from the write body too, not merely from permission checks.
export function changedProjectPatch(db: DatabaseSync, project: string, body: Record<string, any>) {
  const changed = { ...body };
  if (body.conf && typeof body.conf === 'object' && !Array.isArray(body.conf)) {
    const current = {...getProjectConfiguration(db, project),reviewers:projectRoster(db,project)};
    const conf = Object.fromEntries(Object.entries(body.conf).filter(([key, value]) => !Object.hasOwn(current, key) || !isDeepStrictEqual(current[key as keyof typeof current], value)));
    if (Object.keys(conf).length) changed.conf = conf; else delete changed.conf;
    if (body.confBase && typeof body.confBase === 'object' && !Array.isArray(body.confBase)) {
      const base = Object.fromEntries(Object.entries(body.confBase).filter(([key]) => !Object.hasOwn(body.conf, key) || Object.hasOwn(conf, key)));
      if (Object.keys(base).length) changed.confBase = base; else delete changed.confBase;
    }
  }
  if (body.reviewTracker && typeof body.reviewTracker === 'object' && !Array.isArray(body.reviewTracker)) {
    const current = getReviewTracker(db, project);
    const tracker = Object.fromEntries(Object.entries(body.reviewTracker).filter(([id, value]) => {
      // Extra entry properties are not silently excused as a no-op.
      const valid = value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry: any) => entry && typeof entry === 'object' && Object.keys(entry).every(key => ['done','doneAt'].includes(key)) && (entry.done === undefined || typeof entry.done === 'boolean' || entry.done === 0 || entry.done === 1) && (entry.doneAt == null || typeof entry.doneAt === 'string'));
      return !valid || !isDeepStrictEqual(trackerValue(current[id]), trackerValue(value));
    }));
    if (Object.keys(tracker).length) changed.reviewTracker = tracker; else delete changed.reviewTracker;
  }
  if (Array.isArray(body.updatedDrawings)) changed.updatedDrawings = body.updatedDrawings.flatMap((drawing: any) => {
    const current = readDrawing(db, project, drawing.id);
    if (!current) return [drawing];
    const envelope = new Set(['id','rev','baseRev','base','changes','remarkOps']);
    const out = { ...drawing };
    const known = (key: string) => Object.hasOwn(DRAWING_COLUMNS, key) || ['assignees','remarks','statusHistory','logs'].includes(key);
    const same = (key: string, value: unknown) => known(key) && isDeepStrictEqual(current[key] ?? (key === 'logs' ? [] : null), value);
    for (const [key, value] of Object.entries(out)) if (!envelope.has(key) && same(key, value)) delete out[key];
    if (drawing.changes && typeof drawing.changes === 'object' && !Array.isArray(drawing.changes)) out.changes = Object.fromEntries(Object.entries(drawing.changes).filter(([key,value]) => !same(key,value)));
    const hasFields = Object.keys(out).some(key => !envelope.has(key)) || Object.keys(out.changes || {}).length || out.remarkOps && Object.values(out.remarkOps).some(value => !Array.isArray(value) || value.length);
    return hasFields ? [out] : [];
  });
  return changed;
}
