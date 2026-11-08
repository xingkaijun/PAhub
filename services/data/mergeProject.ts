import type { Project, ReviewTrackerData } from '../../types';

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
) {
  let changedDrawings = 0;
  const localById = new Map(local.drawings.map(d => [d.id, d]));
  const remoteIds = new Set(remote.drawings.map(d => d.id));
  const drawings = remote.drawings.filter(d => !deletedDrawingIds.has(d.id)).map(d => {
    const current = localById.get(d.id);
    if (dirtyDrawingIds.has(d.id) && current) return current;
    if (!current || JSON.stringify(current) !== JSON.stringify(d)) changedDrawings++;
    return current && JSON.stringify(current) === JSON.stringify(d) ? current : d;
  });
  for (const id of dirtyDrawingIds) {
    const current = localById.get(id);
    if (current && !remoteIds.has(id)) drawings.push(current);
  }
  const tracker: ReviewTrackerData = { ...(remoteTracker || {}) };
  for (const id of dirtyTrackerDrawingIds) tracker[id] = { ...(remoteTracker?.[id] || {}), ...(localTracker[id] || {}) };
  if (dirtyTracker && dirtyTrackerDrawingIds.size === 0) Object.assign(tracker, localTracker);
  return {
    project: { ...local, ...remote, id: local.id, conf: dirtyConf ? local.conf : remote.conf, drawings },
    reviewTracker: tracker,
    changedDrawings,
  };
}
