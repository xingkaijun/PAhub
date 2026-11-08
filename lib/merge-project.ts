import type { Project, ReviewTrackerData } from '../types';
import { mergeReviewTracker } from './review-tracker';
import { PCF_MANAGED_FIELDS, type DirtyDrawingFields } from './drawing-fields';

export function mergeProjectPreservingDirty(
  local: Project,
  remote: Project,
  dirtyDrawingIds: Set<string>,
  deletedDrawingIds: Set<string>,
  dirtyConf: boolean,
  localTracker: ReviewTrackerData,
  remoteTracker: ReviewTrackerData,
  dirtyTrackerDrawingIds: Set<string>,
  dirtyTracker: boolean,
  dirtyFields?: DirtyDrawingFields,
) {
  let changedDrawings = 0;
  const localById = new Map(local.drawings.map(d => [d.id, d]));
  const remoteIds = new Set(remote.drawings.map(d => d.id));
  const drawings = remote.drawings.filter(d => !deletedDrawingIds.has(d.id)).map(d => {
    const current = localById.get(d.id);
    if (dirtyDrawingIds.has(d.id) && current) {
      const merged = { ...d };
      const fields = dirtyFields?.[d.id] || new Set(Object.keys(current) as (keyof typeof current)[]);
      for (const field of fields) {
        if (field === 'hasPcf' || d.hasPcf && PCF_MANAGED_FIELDS.includes(field)) continue;
        (merged as any)[field] = current[field];
      }
      if (JSON.stringify(current) !== JSON.stringify(merged)) changedDrawings++;
      return JSON.stringify(current) === JSON.stringify(merged) ? current : merged;
    }
    if (!current || JSON.stringify(current) !== JSON.stringify(d)) changedDrawings++;
    return current && JSON.stringify(current) === JSON.stringify(d) ? current : d;
  });
  for (const id of dirtyDrawingIds) {
    const current = localById.get(id);
    if (current && !remoteIds.has(id)) drawings.push(current);
  }
  const tracker = mergeReviewTracker(localTracker, remoteTracker || {}, dirtyTrackerDrawingIds, dirtyTracker);
  return {
    project: { ...local, ...remote, id: local.id, conf: dirtyConf ? local.conf : remote.conf, drawings },
    reviewTracker: tracker,
    changedDrawings,
  };
}
