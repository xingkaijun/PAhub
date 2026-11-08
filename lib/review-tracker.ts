import type { DrawingStatus, Project, ReviewTrackerData } from '../types';

export interface SentDrawingExpectation {
  id: string;
  customId?: string;
  status: DrawingStatus;
}

export interface SendVerification {
  ok: boolean;
  mismatchedDrawings: string[];
  mismatchedTracker: string[];
  error?: string;
}

export function mergeReviewTracker(local: ReviewTrackerData, remote: ReviewTrackerData, dirtyIds: Set<string>, dirty = false): ReviewTrackerData {
  const merged: ReviewTrackerData = { ...remote };
  for (const id of dirtyIds) merged[id] = { ...(remote[id] || {}), ...(local[id] || {}) };
  if (dirty && dirtyIds.size === 0) Object.assign(merged, local);
  return merged;
}

// Preserve reference identity for untouched entries so in-flight saves can detect newer edits.
export function clearReviewTracker(tracker: ReviewTrackerData, drawingIds: string[]) {
  const next = { ...tracker };
  const changedIds: string[] = [];
  for (const id of new Set(drawingIds)) {
    const entry = tracker[id];
    if (!entry || !Object.values(entry).some(value => value?.done)) continue;
    next[id] = Object.fromEntries(Object.keys(entry).map(key => [key, { done: false }]));
    changedIds.push(id);
  }
  return { tracker: changedIds.length ? next : tracker, changedIds };
}

export function verifySentState(project: Project, tracker: ReviewTrackerData, expected: SentDrawingExpectation[]) {
  const remoteById = new Map((project.drawings || []).map(d => [String(d.id), d]));
  const mismatchedDrawings: string[] = [];
  const mismatchedTracker: string[] = [];
  const failedIds: string[] = [];
  for (const { id, customId, status } of expected) {
    const label = customId || id;
    const remote = remoteById.get(String(id));
    const drawingFailed = !remote || remote.status !== status;
    const trackerFailed = Object.values(tracker[id] || {}).some(value => value?.done);
    if (drawingFailed) mismatchedDrawings.push(label);
    if (trackerFailed) mismatchedTracker.push(label);
    if (drawingFailed || trackerFailed) failedIds.push(id);
  }
  return { ok: failedIds.length === 0, mismatchedDrawings, mismatchedTracker, failedIds };
}
