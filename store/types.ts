import type { StateCreator } from 'zustand';
import type { SessionStatus } from '../services/api/sessionApi';
import type { AppData, Project, Drawing, AppSettings, ProjectConfig, ReviewTrackerData, AuditEntry } from '../types';
import type { DirtyDrawingBase, DirtyDrawingFields } from '../lib/drawing-fields';
import type { DirtyConfBase } from '../lib/project-config';
import type { SentDrawingExpectation, SendVerification } from '../lib/review-tracker';
export interface AuditLogResult {
  entries: AuditEntry[];
  truncated: boolean;
  error?: string;
}
export interface ProjectSlice {
  data: AppData;
  isLoading: boolean;
  error: string | null;
  activeProjectId: string | null;
  hasUnsavedChanges: () => boolean;
  getUnsavedChangesCount: () => number;
  addProject: (name: string) => void;
  deleteProject: (projectId: string) => void;
  setActiveProject: (projectId: string) => void;
  updateSettings: (settings: Partial<AppSettings>) => void;
  addDrawing: (drawing: Drawing) => void;
  updateDrawing: (id: string, updates: Partial<Drawing>) => void;
  deleteDrawing: (id: string) => void;
  addRemark: (drawingId: string, content: string) => void;
  deleteRemark: (drawingId: string, remarkId: string) => void;
  batchUpdateDrawings: (updates: {
    id: string;
    changes: Partial<Drawing>;
  }[]) => void;
  resetAllAssignees: () => void;
  bulkImportDrawings: (drawings: Drawing[]) => void;
  saveActiveProject: (password: string) => Promise<boolean>;
  saveProject: (projectId: string) => Promise<boolean>;
  fetchGlobalSettings: () => Promise<void>;
  fetchProjectList: () => Promise<void>;
  loadProject: (projectId: string, _legacyPassword?: string, signal?: AbortSignal) => Promise<void>;
  refreshProjectPreservingDirty: (projectId: string) => Promise<number>;
  /** Refetch only these drawings (drawing-changed) and merge them like a full refresh would, keeping unsaved edits. */
  refreshDrawingsPreservingDirty: (projectId: string, drawingIds: string[]) => Promise<number>;
  testConnection: (url: string, user: string, pass: string, proxyUrl?: string) => Promise<{
    success: boolean;
    message: string;
  }>;
  updateProjectConfig: (projectId: string, updates: Partial<ProjectConfig>) => void;
  restoreProject: (project: Project) => void;
  toggleRemarkStatus: (drawingId: string, remarkId: string) => void;
  loadAuditLog: (projectId: string, fromISO: string, toISO: string) => Promise<AuditLogResult>;
  _dirtyDrawingIds: Set<string>;
  _dirtyDrawingFields: DirtyDrawingFields;
  _dirtyDrawingBase: DirtyDrawingBase;
  saveConflict: { message: string; drawingIds: string[]; at: number } | null;
  clearSaveConflict: () => void;
  /** Shown when the server answers 404 for a project (deleted, or never saved). */
  projectNotice: { message: string; projectId: string; at: number; requiresReload?: boolean } | null;
  clearProjectNotice: () => void;
  _deletedDrawingIds: Set<string>;
  _dirtyConf: boolean;
  _dirtyConfKeys: Set<keyof ProjectConfig>;
  _dirtyConfBase: DirtyConfBase;
}
export interface ReviewTrackerSlice {
  reviewTracker: ReviewTrackerData;
  /** force: read even if this page already loaded the tracker for this project (manual refresh). */
  loadReviewTracker: (projectId: string, force?: boolean) => Promise<void>;
  toggleAssigneeDone: (drawingId: string, assignee: string) => void;
  clearTrackerForDrawings: (drawingIds: string[]) => void;
  verifySentDrawings: (projectId: string, expected: SentDrawingExpectation[]) => Promise<SendVerification>;
  _dirtyTracker: boolean;
  _dirtyTrackerDrawingIds: Set<string>;
}
export interface UiSlice {
  session: SessionStatus | null;
  can: (capability: string) => boolean;
  viewMode: 'list' | 'board';
  setViewMode: (mode: 'list' | 'board') => void;
  filterQuery: string;
  setFilterQuery: (query: string) => void;
  isEditMode: boolean;
  /** Ask the server whether this browser holds an administrator session; mirrors it into isEditMode. */
  refreshSession: () => Promise<void>;
  /** Exchange the administrator password for a server session. */
  loginAdmin: (password: string) => Promise<boolean>;
  /** Clear the server session, then the local mirror. */
  logoutAdmin: () => Promise<void>;
  /** Mirror a server session answer without changing the server. */
  applySession: (admin: boolean) => void;
  clearError: () => void;
}
export interface PresenceSlice {
  pcfPresence: Record<string, number>;
  refreshPcfPresence: (projectId: string) => Promise<void>;
  adminPresence: {
    isOnline: boolean;
    lastSeen?: string;
  };
  _heartbeatTimer: ReturnType<typeof setInterval> | null;
  startEditingPresence: () => void;
  stopEditingPresence: () => void;
  refreshAdminPresence: (projectId: string) => Promise<void>;
}
export type AppState = ProjectSlice & ReviewTrackerSlice & UiSlice & PresenceSlice;
export type SliceCreator<T> = StateCreator<AppState, [
], [
], T>;
