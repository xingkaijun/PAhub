import type { PersistOptions } from 'zustand/middleware';
import type { Drawing, Project } from '../types';
import type { AppState } from './types';
import { normalizeProjectDrawingIds, stripProjectPayload } from '../lib/project';
const generateId = () => Math.random().toString(36).substr(2, 9);
// Keep version 2 and its serialized Sets compatible with already-open/local pages.
export const persistenceOptions: PersistOptions<AppState, any> = {
  name: 'pahub-storage',
  partialize: (state) => ({
    data: {
      ...state.data,
      projects: state.data.projects.map(project => stripProjectPayload(project, project.id === state.activeProjectId)),
    },
    activeProjectId: state.activeProjectId,
    reviewTracker: state.reviewTracker,
    _dirtyDrawingIds: [...state._dirtyDrawingIds],
    _deletedDrawingIds: [...state._deletedDrawingIds],
    _dirtyDrawingFields: Object.fromEntries(Object.entries(state._dirtyDrawingFields).map(([id, fields]) => [id, [...fields]])),
    _dirtyDrawingBase: state._dirtyDrawingBase,
    _dirtyConf: state._dirtyConf,
    _dirtyConfKeys: [...state._dirtyConfKeys],
    _dirtyConfBase: state._dirtyConfBase,
    _dirtyTracker: state._dirtyTracker,
    _dirtyTrackerDrawingIds: Array.from(state._dirtyTrackerDrawingIds),
  }),
  version: 2,
  migrate: (persistedState: any) => {
    if (!persistedState?.data?.projects)
      return persistedState;
    const dirtyTrackerDrawingIds = persistedState._dirtyTrackerDrawingIds;
    return {
      ...persistedState,
      data: {
        ...persistedState.data,
        projects: persistedState.data.projects.map((p: Project) => normalizeProjectDrawingIds(p, generateId)),
      },
      // 兼容历史持久化格式，确保运行态始终拿到 Set
      _dirtyTrackerDrawingIds: dirtyTrackerDrawingIds instanceof Set
        ? dirtyTrackerDrawingIds
        : new Set(Array.isArray(dirtyTrackerDrawingIds) ? dirtyTrackerDrawingIds : []),
    };
  },
  merge: (persistedState: any, currentState) => ({
    ...currentState,
    ...persistedState,
    data: persistedState?.data
      ? {
        ...currentState.data,
        ...persistedState.data,
        projects: Array.isArray(persistedState.data.projects)
          ? persistedState.data.projects.map((p: Project) => normalizeProjectDrawingIds(p, generateId))
          : currentState.data.projects,
      }
      : currentState.data,
    _dirtyDrawingIds: new Set(persistedState?._dirtyDrawingIds || []),
    _deletedDrawingIds: new Set(persistedState?._deletedDrawingIds || []),
    _dirtyDrawingFields: Object.fromEntries(Object.entries(persistedState?._dirtyDrawingFields || {}).map(([id, fields]) => [id, new Set(fields as (keyof Drawing)[])])),
    _dirtyConfKeys: new Set(Array.isArray(persistedState?._dirtyConfKeys) ? persistedState._dirtyConfKeys : []),
    _dirtyConfBase: persistedState?._dirtyConfBase && typeof persistedState._dirtyConfBase === 'object' ? persistedState._dirtyConfBase : {},
    _dirtyDrawingBase: persistedState?._dirtyDrawingBase && typeof persistedState._dirtyDrawingBase === 'object' ? persistedState._dirtyDrawingBase : {},
    _dirtyTrackerDrawingIds: persistedState?._dirtyTrackerDrawingIds instanceof Set
      ? persistedState._dirtyTrackerDrawingIds
      : new Set(Array.isArray(persistedState?._dirtyTrackerDrawingIds) ? persistedState._dirtyTrackerDrawingIds : []),
  }),
};
