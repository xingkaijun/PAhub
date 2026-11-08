import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { changedDrawingFields } from './lib/drawing-fields';
import { createProjectSlice } from './store/projectSlice';
import { createReviewTrackerSlice } from './store/reviewTrackerSlice';
import { createUiSlice } from './store/uiSlice';
import { createPresenceSlice } from './store/presenceSlice';
import { persistenceOptions } from './store/persistence';
import type { AppState } from './store/types';
export type { AppState, AuditLogResult } from './store/types';
export type { SentDrawingExpectation, SendVerification } from './lib/review-tracker';

export const useStore = create<AppState>()(persist((...args) => ({
  ...createProjectSlice(...args),
  ...createReviewTrackerSlice(...args),
  ...createUiSlice(...args),
  ...createPresenceSlice(...args),
}), persistenceOptions));

// Track fields centrally so every mutation path participates; non-dirty server refreshes do not create edits.
useStore.subscribe((state, previous) => {
  if (state.data === previous.data || state.activeProjectId !== previous.activeProjectId || state._dirtyDrawingIds === previous._dirtyDrawingIds || previous.isLoading && !state.isLoading) return;
  const project = state.data.projects.find(p => p.id === state.activeProjectId);
  const before = previous.data.projects.find(p => p.id === state.activeProjectId);
  if (!project) return;
  const next = { ...state._dirtyDrawingFields };
  let changed = false;
  for (const d of project.drawings) {
    if (!state._dirtyDrawingIds.has(d.id)) continue;
    const old = before?.drawings.find(x => x.id === d.id);
    if (old === d) continue;
    const fields = changedDrawingFields(old, d);
    if (!fields.size) continue;
    next[d.id] = new Set([...(next[d.id] || []), ...fields]); changed = true;
  }
  if (changed) useStore.setState({ _dirtyDrawingFields: next });
});
