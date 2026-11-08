import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppData, Project, Drawing, AppSettings, ProjectConfig, ReviewTrackerData, DeltaPayload, AuditEntry } from './types';
import { appRepository } from './services/data/AppRepository';
import { mergeProjectPreservingDirty } from './lib/merge-project';
import { calculateDeadline, projectDateKey } from './lib/deadline';
import { changedDrawingFields, drawingFieldPatch, PCF_MANAGED_FIELDS, type DirtyDrawingFields } from './lib/drawing-fields';
import { ensureDrawingHasId, normalizeProjectDrawingIds, stripProjectPayload, recalculateReviewDeadline } from './lib/project';
import { editableDrawingUpdates, applyDrawingUpdates } from './lib/drawing-edit';
import { describeVerification } from './lib/project-save';
const generateId = () => Math.random().toString(36).substr(2, 9);

import { mergeReviewTracker, clearReviewTracker, verifySentState, type SentDrawingExpectation, type SendVerification } from './lib/review-tracker';
export type { SentDrawingExpectation, SendVerification } from './lib/review-tracker';

export interface AuditLogResult {
  entries: AuditEntry[];
  truncated: boolean;
  error?: string;
}

interface AppState {
  data: AppData;
  isLoading: boolean;
  error: string | null;
  activeProjectId: string | null;

  // Unsaved changes tracking
  hasUnsavedChanges: () => boolean;
  getUnsavedChangesCount: () => number;

  // Actions
  addProject: (name: string) => void;
  deleteProject: (projectId: string) => void;
  setActiveProject: (projectId: string) => void;
  updateSettings: (settings: Partial<AppSettings>) => void;
  addDrawing: (drawing: Drawing) => void;
  updateDrawing: (id: string, updates: Partial<Drawing>) => void;
  deleteDrawing: (id: string) => void;
  addRemark: (drawingId: string, content: string) => void;
  deleteRemark: (drawingId: string, content: string) => void;
  batchUpdateDrawings: (updates: { id: string; changes: Partial<Drawing> }[]) => void;
  resetAllAssignees: () => void;
  bulkImportDrawings: (drawings: Drawing[]) => void;
  saveActiveProject: (password: string) => Promise<boolean>;
  saveProject: (projectId: string) => Promise<boolean>;
  fetchGlobalSettings: () => Promise<void>;
  fetchProjectList: () => Promise<void>;
  loadProject: (projectId: string, passwordInput?: string) => Promise<void>;
  refreshProjectPreservingDirty: (projectId: string) => Promise<number>;
  testConnection: (url: string, user: string, pass: string, proxyUrl?: string) => Promise<{ success: boolean; message: string }>;

  // UI State
  viewMode: 'list' | 'board';
  setViewMode: (mode: 'list' | 'board') => void;
  filterQuery: string;
  setFilterQuery: (query: string) => void;
  isEditMode: boolean;
  toggleEditMode: (password?: string) => boolean;
  updateProjectConfig: (projectId: string, updates: Partial<ProjectConfig>) => void;
  clearError: () => void;
  restoreProject: (project: Project) => void;
  toggleRemarkStatus: (drawingId: string, remarkId: string) => void;

  // 审核追踪
  reviewTracker: ReviewTrackerData;
  loadReviewTracker: (projectId: string) => Promise<void>;
  toggleAssigneeDone: (drawingId: string, assignee: string) => void;
  clearTrackerForDrawings: (drawingIds: string[]) => void;
  verifySentDrawings: (projectId: string, expected: SentDrawingExpectation[]) => Promise<SendVerification>;

  // 服务端写入日志（audit_log）。报表查询，结果不进 state
  loadAuditLog: (projectId: string, fromISO: string, toISO: string) => Promise<AuditLogResult>;

  // 脏数据追踪（增量保存）
  _dirtyDrawingIds: Set<string>;
  _dirtyDrawingFields: DirtyDrawingFields;
  _deletedDrawingIds: Set<string>;
  _dirtyConf: boolean;
  _dirtyTracker: boolean;
  _dirtyTrackerDrawingIds: Set<string>; // tracker 变更涉及的 drawing ID

  // 管理员在线状态
  pcfPresence: Record<string, number>;
  refreshPcfPresence: (projectId: string) => Promise<void>;
  adminPresence: { isOnline: boolean; lastSeen?: string };
  _heartbeatTimer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_DATA: AppData = {
  lastUpdated: new Date().toISOString(),
  projects: [],
  settings: {
    reviewers: [
      { id: 'engineer_a', name: 'Engineer A' },
      { id: 'engineer_b', name: 'Engineer B' },
      { id: 'senior_eng_c', name: 'Senior Eng C' }
    ],
    disciplineDefaults: {}, // Map discipline -> reviewer ID
    holidays: [], // YYYY-MM-DD strings
    roundACycle: 10,
    otherRoundsCycle: 5,
  }
};

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      data: DEFAULT_DATA,
      isLoading: false,
      error: null,
      activeProjectId: null,
      viewMode: 'list',
      filterQuery: '',
      isEditMode: false,
      reviewTracker: {},
      _dirtyDrawingIds: new Set<string>(),
      _dirtyDrawingFields: {},
      _deletedDrawingIds: new Set<string>(),
      _dirtyConf: false,
      _dirtyTracker: false,
      _dirtyTrackerDrawingIds: new Set<string>(),
      pcfPresence: {},
      refreshPcfPresence: async (projectId: string) => {
        if (import.meta.env.MODE !== 'hub') return;
        try {
          const token = import.meta.env.VITE_DATA_API_TOKEN?.trim();
          const response = await fetch('/api/pcf/' + encodeURIComponent(projectId) + '/presence', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
          if (!response.ok) throw Error('Presence: ' + response.status);
          const result = await response.json();
          if (get().activeProjectId === projectId) set({
            pcfPresence: Object.fromEntries(Object.entries(result.drawings).map(([id, people]) => [id, (people as unknown[]).length])),
          });
        } catch { if (get().activeProjectId === projectId) set({ pcfPresence: {} }); }
      },
      refreshProjectPreservingDirty: async (projectId: string) => {
        const initial = get();
        const stub = initial.data.projects.find(p => p.id === projectId);
        if (!stub) return 0;
        const [rawProject, remoteTracker] = await Promise.all([
          appRepository.loadProject(initial.data.settings, stub, stub.conf?.password),
          appRepository.loadReviewTracker(initial.data.settings, stub).catch(() => ({})),
        ]);
        const remote = normalizeProjectDrawingIds(rawProject, generateId);
        let changed = 0;
        set(state => {
          if (state.activeProjectId !== projectId) return state;
          const local = state.data.projects.find(p => p.id === projectId);
          if (!local) return state;
          const merged = mergeProjectPreservingDirty(local, remote, state._dirtyDrawingIds, state._deletedDrawingIds, state._dirtyConf,
            state.reviewTracker, remoteTracker || {}, state._dirtyTrackerDrawingIds, state._dirtyTracker, state._dirtyDrawingFields);
          changed = merged.changedDrawings;
          return {
            data: { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? merged.project : p) },
            reviewTracker: merged.reviewTracker,
          };
        });
        return changed;
      },
      adminPresence: { isOnline: false },
      _heartbeatTimer: null,

      setViewMode: (mode) => set({ viewMode: mode }),
      setFilterQuery: (query) => set({ filterQuery: query }),

      hasUnsavedChanges: () => {
        const state = get();
        return state._dirtyDrawingIds.size > 0 || 
               state._deletedDrawingIds.size > 0 || 
               state._dirtyConf || 
               state._dirtyTracker;
      },

      getUnsavedChangesCount: () => {
        const state = get();
        return state._dirtyDrawingIds.size + state._deletedDrawingIds.size + 
               (state._dirtyConf ? 1 : 0) + (state._dirtyTracker ? 1 : 0);
      },

      toggleEditMode: (password) => {
        const envPass = import.meta.env.VITE_EDIT_PASSWORD; // 使用专用的编辑密码环境变量
        if (!get().isEditMode) {
          // Entering Edit Mode
          if (envPass && envPass.trim() !== '') {
            if (password === envPass) {
              set({ isEditMode: true, adminPresence: { isOnline: true, lastSeen: new Date().toISOString() } });
              // 启动心跳
              const pid = get().activeProjectId;
              if (pid) {
                appRepository.sendHeartbeat(pid).catch(() => { });
                const timer = setInterval(() => {
                  const currentPid = get().activeProjectId;
                  if (currentPid) appRepository.sendHeartbeat(currentPid).catch(() => { });
                }, 30000);
                set({ _heartbeatTimer: timer });
              }
              return true;
            }
            return false;
          } else {
            set({ isEditMode: true, adminPresence: { isOnline: true, lastSeen: new Date().toISOString() } });
            // 启动心跳
            const pid = get().activeProjectId;
            if (pid) {
              appRepository.sendHeartbeat(pid).catch(() => { });
              const timer = setInterval(() => {
                const currentPid = get().activeProjectId;
                if (currentPid) appRepository.sendHeartbeat(currentPid).catch(() => { });
              }, 30000);
              set({ _heartbeatTimer: timer });
            }
            return true;
          }
        } else {
          // Exiting Edit Mode — stop heartbeat
          const timer = get()._heartbeatTimer;
          if (timer) clearInterval(timer);
          set({ isEditMode: false, _heartbeatTimer: null, adminPresence: { isOnline: false } });
          return true;
        }
      },

      setActiveProject: (projectId) => set({ activeProjectId: projectId }),

      addProject: (name) => set((state) => ({
        data: {
          ...state.data,
          projects: [
            ...state.data.projects,
            {
              id: crypto.randomUUID(),
              name,
              drawings: [],
              conf: { // Default Project Config from Global Settings
                reviewers: state.data.settings.reviewers,
                disciplineDefaults: state.data.settings.disciplineDefaults,
                holidays: state.data.settings.holidays,
                roundACycle: state.data.settings.roundACycle,
                otherRoundsCycle: state.data.settings.otherRoundsCycle
              },

            },
          ],
        },
      })),

      deleteProject: (projectId) => set((state) => ({
        data: {
          ...state.data,
          projects: state.data.projects.filter((p) => p.id !== projectId),
        },
        activeProjectId: state.activeProjectId === projectId ? null : state.activeProjectId,
      })),

      updateSettings: (newSettings) => set((state) => ({
        data: { ...state.data, settings: { ...state.data.settings, ...newSettings } },
      })),

      addDrawing: (drawing) => set((state) => {
        const { activeProjectId, data } = state;
        if (!activeProjectId) return state;
        const drawingWithId = { ...ensureDrawingHasId(drawing, generateId), currentRound: drawing.currentRound || 'A' };

        const newDirty = new Set(state._dirtyDrawingIds);
        newDirty.add(drawingWithId.id);

        return {
          _dirtyDrawingIds: newDirty,
          data: {
            ...data,
            projects: data.projects.map((p) => {
              if (p.id !== activeProjectId) return p;

              const updatedDrawings = [...p.drawings, drawingWithId];

              // Auto-calculate deadline if new drawing has receivedDate
              if (drawingWithId.receivedDate && p.conf) {
                const disc = drawingWithId.discipline;
                const defaults = p.conf.disciplineDefaults[disc];
                if (defaults && drawingWithId.category) {
                  // Simple calculation
                  const startDate = new Date(drawingWithId.receivedDate);
                  const days = drawingWithId.category === 'A' ? p.conf.roundACycle : p.conf.otherRoundsCycle;
                  const deadline = calculateDeadline(startDate, days, p.conf.holidays);
                  drawingWithId.deadline = projectDateKey(deadline);
                }
              }

              return { ...p, drawings: updatedDrawings };
            }),
          },
        };
      }),

      updateDrawing: (id, updates) => set((state) => {
        const { activeProjectId } = state;
        if (!activeProjectId) return state;
        const current = state.data.projects.find(p => p.id === activeProjectId)?.drawings.find(d => d.id === id);
        updates = editableDrawingUpdates(current, updates);
        if (Object.keys(updates).length === 0) return state;

        const newDirty = new Set(state._dirtyDrawingIds);
        newDirty.add(id);

        // 如果 assignees 发生变化，标记 tracker 为脏数据（需要清理移除的 assignee 的 tracker 行）
        let newDirtyTracker = state._dirtyTracker;
        const newDirtyTrackerIds = new Set(state._dirtyTrackerDrawingIds);
        if (updates.assignees) {
          newDirtyTracker = true;
          newDirtyTrackerIds.add(id);
        }

        return {
          _dirtyDrawingIds: newDirty,
          _dirtyTracker: newDirtyTracker,
          _dirtyTrackerDrawingIds: newDirtyTrackerIds,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => {
              if (p.id !== activeProjectId) return p;
              return {
                ...p,
                drawings: p.drawings.map(d => {
                  if (d.id !== id) return d;

                  return applyDrawingUpdates(d, updates, p.conf || state.data.settings, new Date(), generateId());
                })
              };
            })
          }
        };
      }),

      deleteDrawing: (id) => set((state) => {
        const { activeProjectId } = state;
        if (!activeProjectId) return state;
        const newDeleted = new Set(state._deletedDrawingIds);
        newDeleted.add(id);
        const newDirty = new Set(state._dirtyDrawingIds);
        newDirty.delete(id);
        return {
          _deletedDrawingIds: newDeleted,
          _dirtyDrawingIds: newDirty,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => p.id === activeProjectId ? { ...p, drawings: p.drawings.filter(d => d.id !== id) } : p)
          }
        };
      }),

      addRemark: (drawingId, content) => set((state) => {
        const { activeProjectId } = state;
        if (!activeProjectId) return state;
        const newDirty = new Set(state._dirtyDrawingIds);
        newDirty.add(drawingId);
        return {
          _dirtyDrawingIds: newDirty,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => {
              if (p.id !== activeProjectId) return p;
              return {
                ...p,
                drawings: p.drawings.map(d => {
                  if (d.id !== drawingId) return d;
                  const newRemark = {
                    id: Math.random().toString(36).substr(2, 9),
                    content,
                    createdAt: new Date().toISOString()
                  };
                  return { ...d, remarks: [...(d.remarks || []), newRemark] };
                })
              };
            })
          }
        };
      }),

      deleteRemark: (drawingId, content) => set((state) => {
        const { activeProjectId } = state;
        if (!activeProjectId) return state;
        const newDirty = new Set(state._dirtyDrawingIds);
        newDirty.add(drawingId);
        return {
          _dirtyDrawingIds: newDirty,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => {
              if (p.id !== activeProjectId) return p;
              return {
                ...p,
                drawings: p.drawings.map(d => {
                  if (d.id !== drawingId) return d;
                  return { ...d, remarks: (d.remarks || []).filter(r => r.content !== content) };
                })
              };
            })
          }
        };
      }),

      batchUpdateDrawings: (updates) => {
        for (const update of updates) get().updateDrawing(update.id, update.changes);
      },

      resetAllAssignees: () => set((state) => {
        const { activeProjectId, data } = state;
        if (!activeProjectId) return state;
        const project = data.projects.find(p => p.id === activeProjectId);
        if (!project) return state;
        const defaultAssignees = project.conf?.defaultAssignees || {};
        const newDirty = new Set(state._dirtyDrawingIds);
        project.drawings.forEach(d => newDirty.add(d.id));
        return {
          _dirtyDrawingIds: newDirty,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => {
              if (p.id !== activeProjectId) return p;
              return {
                ...p,
                drawings: p.drawings.map(d => ({
                  ...d,
                  assignees: defaultAssignees[d.discipline] || []
                }))
              };
            })
          }
        };
      }),

      bulkImportDrawings: (drawings) => set((state) => {
        const { activeProjectId } = state;
        if (!activeProjectId) return state;
        const normalizedDrawings = drawings.map(d => ensureDrawingHasId(d, generateId));
        const newDirty = new Set(state._dirtyDrawingIds);
        normalizedDrawings.forEach(d => newDirty.add(d.id));
        return {
          _dirtyDrawingIds: newDirty,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => p.id === activeProjectId ? { ...p, drawings: [...p.drawings, ...normalizedDrawings] } : p)
          }
        };
      }),


      saveActiveProject: async (password: string) => {
        const { activeProjectId } = get();
        if (!activeProjectId) return false;
        return get().saveProject(activeProjectId);
      },

      saveProject: async (projectId: string) => {
        const { data, reviewTracker, _dirtyDrawingIds, _dirtyDrawingFields, _deletedDrawingIds, _dirtyConf, _dirtyTracker, _dirtyTrackerDrawingIds } = get();
        const project = data.projects.find(p => p.id === projectId);
        if (!project) return false;

        const dirtyDrawingSnapshot = new Set(_dirtyDrawingIds);
        const fieldSnapshot = Object.fromEntries(Object.entries(_dirtyDrawingFields).map(([id, fields]) => [id, new Set(fields)])) as DirtyDrawingFields;
        const deletedDrawingSnapshot = new Set(_deletedDrawingIds);
        const dirtyTrackerSnapshot = new Set(_dirtyTrackerDrawingIds);
        const dirtyConfSnapshot = _dirtyConf;
        const dirtyTrackerSnapshotFlag = _dirtyTracker;
        const dirtyCount = dirtyDrawingSnapshot.size + deletedDrawingSnapshot.size;
        const hasDirty = dirtyCount > 0 || dirtyConfSnapshot || dirtyTrackerSnapshotFlag;

        // 无任何变更时跳过
        if (!hasDirty) {
          console.log('[Save] No changes detected, skipping.');
          return true;
        }

        set({ isLoading: true, error: null });
        try {
          const updatedDrawings = project.drawings.filter(d => dirtyDrawingSnapshot.has(d.id)).map(d => drawingFieldPatch(d, fieldSnapshot[d.id] || new Set(Object.keys(d) as (keyof Drawing)[])));
          const payload: DeltaPayload = { projectName: project.name };
          if (deletedDrawingSnapshot.size) payload.deletedDrawingIds = [...deletedDrawingSnapshot];
          if (updatedDrawings.length > 0) payload.updatedDrawings = updatedDrawings;
          if (dirtyConfSnapshot) payload.conf = project.conf;
          if (dirtyTrackerSnapshotFlag) {
            const trackerSlice: ReviewTrackerData = {};
            for (const id of dirtyTrackerSnapshot) trackerSlice[id] = reviewTracker[id] || {};
            if (Object.keys(trackerSlice).length > 0) payload.reviewTracker = trackerSlice;
          }
          const saveResult = await appRepository.saveDelta(data.settings, projectId, payload);

          // 服务端回读校验：没落库的图纸不清脏标记，交给下次保存重试
          const verification = saveResult?.verification;
          const unverifiedIds = new Set(
            verification && !verification.ok && !verification.error
              ? verification.mismatched.map(m => m.id)
              : []
          );
          if (verification?.error) {
            console.warn(`[Save] Write verification unavailable: ${verification.error}`);
          }
          const verificationMessage = describeVerification(verification);
          if (verificationMessage) console.error(`[Save] ${verificationMessage}`);

          // 保存期间可能发生新修改：只清理本次 payload 中已发送且未再次改变的脏标记
          set(state => {
            const currentProject = state.data.projects.find(p => p.id === projectId);
            const nextDirtyDrawingIds = new Set(state._dirtyDrawingIds);
            const nextFields = { ...state._dirtyDrawingFields };
            const acknowledged = new Map((saveResult?.drawings || []).map(d => [d.id, d]));
            const mergedDrawings = currentProject?.drawings.map(d => {
              const remote = acknowledged.get(d.id);
              if (!remote || unverifiedIds.has(d.id)) return d;
              const sent = project.drawings.find(x => x.id === d.id);
              const merged = { ...d };
              for (const field of Object.keys(remote) as (keyof Drawing)[]) {
                if (field === 'hasPcf' || (remote.hasPcf && PCF_MANAGED_FIELDS.includes(field)) || JSON.stringify(d[field]) === JSON.stringify(sent?.[field])) (merged as any)[field] = remote[field];
              }
              return merged;
            });
            dirtyDrawingSnapshot.forEach(id => {
              if (unverifiedIds.has(id)) return;
              const previousDrawing = project.drawings.find(d => d.id === id);
              const currentDrawing = currentProject?.drawings.find(d => d.id === id);
              const remaining = new Set(nextFields[id] || []);
              for (const field of fieldSnapshot[id] || []) {
                if (JSON.stringify(currentDrawing?.[field]) === JSON.stringify(previousDrawing?.[field])) remaining.delete(field);
              }
              if (!remaining.size || currentDrawing === previousDrawing) { nextDirtyDrawingIds.delete(id); delete nextFields[id]; }
              else nextFields[id] = remaining;
            });

            const nextDeletedDrawingIds = new Set(state._deletedDrawingIds);
            deletedDrawingSnapshot.forEach(id => nextDeletedDrawingIds.delete(id));

            const nextDirtyTrackerDrawingIds = new Set(state._dirtyTrackerDrawingIds);
            dirtyTrackerSnapshot.forEach(id => {
              if (unverifiedIds.has(id)) return;
              if (state.reviewTracker[id] === reviewTracker[id]) nextDirtyTrackerDrawingIds.delete(id);
            });

            const nextDirtyConf = dirtyConfSnapshot && currentProject?.conf === project.conf ? false : state._dirtyConf;
            return {
              isLoading: false,
              error: verificationMessage ?? state.error,
              _dirtyDrawingIds: nextDirtyDrawingIds,
              _dirtyDrawingFields: nextFields,
              data: mergedDrawings ? { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? { ...p, drawings: mergedDrawings } : p) } : state.data,
              _deletedDrawingIds: nextDeletedDrawingIds,
              _dirtyConf: nextDirtyConf,
              _dirtyTracker: nextDirtyTrackerDrawingIds.size > 0,
              _dirtyTrackerDrawingIds: nextDirtyTrackerDrawingIds,
            };
          });
          return unverifiedIds.size === 0;
        } catch (err: any) {
          console.error("Push failed", err);
          set({ isLoading: false, error: err.message });
          return false;
        }
      },


      fetchGlobalSettings: async () => {
        const { data } = get();
        try {
          const settings = await appRepository.fetchGlobalSettings(data.settings);
          if (settings) {
            set(state => ({
              data: {
                ...state.data,
                settings: {
                  ...state.data.settings,
                  ...settings
                }
              }
            }));
          }
        } catch (e) { console.warn("Settings fetch failed", e); }
      },

      fetchProjectList: async () => {
        const { data } = get();
        set({ isLoading: true, error: null });
        try {
          const remoteProjects = await appRepository.fetchProjectList(data.settings);

          set(state => {
            const currentProjects = state.data.projects;
            const mergedProjects = [...currentProjects];

            remoteProjects.forEach(rp => {
              // 按 ID 合并，避免同名项目污染
              const existingIndex = mergedProjects.findIndex(p => p.id === rp.id);
              if (existingIndex > -1) {
                mergedProjects[existingIndex] = { ...mergedProjects[existingIndex], storagePath: rp.storagePath };
              } else {
                mergedProjects.push({
                  id: rp.id,
                  name: rp.name,
                  storagePath: rp.storagePath,
                  drawings: [],

                  conf: {
                    reviewers: state.data.settings.reviewers,
                    disciplineDefaults: state.data.settings.disciplineDefaults,
                    holidays: state.data.settings.holidays,
                    roundACycle: state.data.settings.roundACycle,
                    otherRoundsCycle: state.data.settings.otherRoundsCycle
                  }
                });
              }
            });

            return {
              data: { ...state.data, projects: mergedProjects },
              isLoading: false
            };
          });
        } catch (err: any) {
          console.error("List failed", err);
          set({ isLoading: false, error: err.message });
          throw err;
        }
      },

      loadProject: async (projectId: string, passwordInput?: string) => {
        const { data } = get();
        const projectStub = data.projects.find(p => p.id === projectId);
        if (!projectStub) return;

        set({ isLoading: true });
        try {
          const fullProject = normalizeProjectDrawingIds(await appRepository.loadProject(data.settings, projectStub, passwordInput), generateId);

          // Inject defaults
          const globalSettings = data.settings;
          if (!fullProject.conf) {
            fullProject.conf = {
              reviewers: globalSettings.reviewers,
              disciplineDefaults: globalSettings.disciplineDefaults,
              holidays: globalSettings.holidays,
              roundACycle: globalSettings.roundACycle,
              otherRoundsCycle: globalSettings.otherRoundsCycle
            };
          }

          set(state => ({
            data: {
              ...state.data,
              projects: state.data.projects.map(p =>
                p.id === projectId
                  ? { ...fullProject, id: projectId }
                  : stripProjectPayload(p, false)
              )
            },
            activeProjectId: projectId,
            isLoading: false,
            _dirtyDrawingIds: new Set<string>(),
            _dirtyDrawingFields: {},
            _deletedDrawingIds: new Set<string>(),
            _dirtyConf: false,
            _dirtyTracker: false,
            _dirtyTrackerDrawingIds: new Set<string>(),
          }));

          // 读取管理员在线状态（非阻塞）
          appRepository.getHeartbeat(projectId).then(lastSeen => {
            if (lastSeen) {
              const diff = Date.now() - new Date(lastSeen).getTime();
              set({ adminPresence: { isOnline: diff < 60000, lastSeen } });
            } else {
              set({ adminPresence: { isOnline: false } });
            }
          }).catch(() => { });
        } catch (err: any) {
          set({ isLoading: false, error: err.message });
          throw err;
        }
      },


      testConnection: async (url, user, pass, proxyUrl) => {
        const { data } = get();
        return appRepository.testConnection(data.settings, { url, user, pass, proxyUrl });
      },

      updateProjectConfig: (projectId, updates) => set((state) => {
        const shouldRecalculateDeadlines =
          updates.holidays !== undefined ||
          updates.roundACycle !== undefined ||
          updates.otherRoundsCycle !== undefined;
        const newDirty = new Set(state._dirtyDrawingIds);

        return {
          _dirtyConf: true,
          _dirtyDrawingIds: shouldRecalculateDeadlines ? newDirty : state._dirtyDrawingIds,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => {
              if (p.id !== projectId) return p;
              const nextConf = { ...(p.conf || state.data.settings), ...updates };
              const nextDrawings = shouldRecalculateDeadlines
                ? p.drawings.map(d => {
                    if (d.status !== 'Reviewing') return d;
                    newDirty.add(d.id);
                    return recalculateReviewDeadline(d, nextConf, new Date());
                  })
                : p.drawings;

              return {
                ...p,
                conf: nextConf,
                drawings: nextDrawings,
              };
            })
          }
        };
      }),

      clearError: () => set({ error: null }),

      restoreProject: (project) => set((state) => {
        const restoredProject = { ...project };
        // 恢复后标记所有 drawing 为脏，确保用户手动保存时同步到云端
        const newDirty = new Set(state._dirtyDrawingIds);
        const newDirtyTrackerIds = new Set(state._dirtyTrackerDrawingIds);
        (restoredProject.drawings || []).forEach(d => {
          if (d.id) {
            newDirty.add(d.id);
            newDirtyTrackerIds.add(d.id);
          }
        });
        return {
          _dirtyDrawingIds: newDirty,
          _dirtyConf: true,
          _dirtyTracker: true,
          _dirtyTrackerDrawingIds: newDirtyTrackerIds,
          data: {
            ...state.data,
            projects: [...state.data.projects.filter(p => p.name !== project.name), restoredProject]
          }
        };
      }),

      toggleRemarkStatus: (drawingId, remarkId) => set((state) => {
        const { activeProjectId } = state;
        if (!activeProjectId) return state;
        const newDirty = new Set(state._dirtyDrawingIds);
        newDirty.add(drawingId);
        return {
          _dirtyDrawingIds: newDirty,
          data: {
            ...state.data,
            projects: state.data.projects.map(p => {
              if (p.id !== activeProjectId) return p;
              return {
                ...p,
                drawings: p.drawings.map(d => {
                  if (d.id !== drawingId) return d;
                  return {
                    ...d,
                    remarks: d.remarks.map(r => r.id === remarkId ? { ...r, resolved: !r.resolved } : r)
                  };
                })
              };
            })
          }
        };
      }),

      // === 审核追踪 ===
      loadReviewTracker: async (projectId: string) => {
        const { data, reviewTracker: localTracker, _dirtyTrackerDrawingIds } = get();
        const project = data.projects.find(p => p.id === projectId);
        if (!project) return;
        try {
          const remote = await appRepository.loadReviewTracker(data.settings, project);
          const merged = mergeReviewTracker(localTracker, remote || {}, _dirtyTrackerDrawingIds);
          set({ reviewTracker: merged });
        } catch (e) { console.warn('loadReviewTracker failed', e); }
      },

      toggleAssigneeDone: (drawingId: string, assignee: string) => {
        const current = get().reviewTracker[drawingId]?.[assignee];
        const newDone = !current?.done;
        const doneAt = newDone ? new Date().toISOString() : undefined;

        // 1. 立即更新本地状态，并标记 tracker 为脏数据
        const newDirtyTrackerIds = new Set(get()._dirtyTrackerDrawingIds);
        newDirtyTrackerIds.add(drawingId);

        set(state => ({
          _dirtyTracker: true,
          _dirtyTrackerDrawingIds: newDirtyTrackerIds,
          reviewTracker: {
            ...state.reviewTracker,
            [drawingId]: {
              ...(state.reviewTracker[drawingId] || {}),
              [assignee]: { done: newDone, doneAt }
            }
          }
        }));

        // 2. 异步保存到服务端（fire-and-forget，但失败时脏标记已保留可供手动重试）
        const { data, activeProjectId } = get();
        if (activeProjectId) {
          const project = data.projects.find(p => p.id === activeProjectId);
          if (project) {
            const singleUpdate = { [drawingId]: { [assignee]: { done: newDone, doneAt } } };
            appRepository.saveReviewTracker(data.settings, project, singleUpdate)
              .then(result => {
                // 回读校验说没落库时保留脏标记，下次手动/自动保存兜底重试。
                // 校验查询自身失败（result.verification.error）只说明无法确认，按成功处理
                const verification = result?.verification;
                if (verification && !verification.ok && !verification.error) {
                  console.error(`[Tracker] Not persisted: ${drawingId}/${assignee}, staying dirty for retry`);
                  return;
                }
                if (verification?.error) {
                  console.warn(`[Tracker] Verification unavailable: ${verification.error}`);
                }
                console.log(`[Tracker] Saved: ${drawingId}/${assignee} = ${newDone}`);
              })
              .catch(err => {
                console.error('[Tracker] Save failed (will retry on next manual/auto save):', err);
                // 不恢复本地状态，脏标记已保留，下次手动/自动保存时会兜底
              });
          }
        }
      },

      // 批量清空指定图纸下所有 assignee 的完成状态（含 __approved__ 标记）
      // 只改本地并标脏，由调用方随 drawing 变更一起保存，避免出现
      // “check 已推送到服务端、status 仍留在本地”的半持久化状态
      clearTrackerForDrawings: (drawingIds: string[]) => {
        if (!drawingIds || drawingIds.length === 0) return;
        set(state => {
          const cleared = clearReviewTracker(state.reviewTracker, drawingIds);
          if (!cleared.changedIds.length) return state;
          const nextDirtyIds = new Set(state._dirtyTrackerDrawingIds);
          cleared.changedIds.forEach(id => nextDirtyIds.add(id));
          return {
            reviewTracker: cleared.tracker,
            _dirtyTracker: true,
            _dirtyTrackerDrawingIds: nextDirtyIds,
          };
        });
      },

      // 保存后回读服务器，端到端确认状态与 check 真的落库。
      // 不改动本地业务数据；发现未落库的图纸会重新标脏，交给下次保存/自动保存重试。
      verifySentDrawings: async (projectId: string, expected: SentDrawingExpectation[]) => {
        const empty: SendVerification = { ok: true, mismatchedDrawings: [], mismatchedTracker: [] };
        if (!expected || expected.length === 0) return empty;

        const { data } = get();
        const project = data.projects.find(p => p.id === projectId);
        if (!project) return { ...empty, ok: false, error: 'Project not found locally' };

        let remoteProject: Project;
        let remoteTracker: ReviewTrackerData;
        try {
          [remoteProject, remoteTracker] = await Promise.all([
            appRepository.loadProject(data.settings, project, project.conf?.password),
            appRepository.loadReviewTracker(data.settings, project),
          ]);
        } catch (err: any) {
          // 回读失败只说明"无法确认"，写入本身可能是成功的
          return { ...empty, ok: false, error: err?.message || 'Read-back request failed' };
        }

        // loadProject 在服务器 404 时会原样返回传入的本地项目，比对将失去意义
        if (remoteProject === project) {
          return { ...empty, ok: false, error: 'Project missing on server' };
        }

        const { failedIds, ...verification } = verifySentState(remoteProject, remoteTracker, expected);

        if (failedIds.length > 0) {
          set(state => {
            const nextDirty = new Set(state._dirtyDrawingIds);
            const nextDirtyTracker = new Set(state._dirtyTrackerDrawingIds);
            failedIds.forEach(id => { nextDirty.add(id); nextDirtyTracker.add(id); });
            return {
              _dirtyDrawingIds: nextDirty,
              _dirtyTracker: true,
              _dirtyTrackerDrawingIds: nextDirtyTracker,
            };
          });
        }

        return verification;
      },

      // 服务端写入日志。报表查询，结果直接返回不进 state——进了 state 会被
      // partialize 持久化到 localStorage，那不是它该待的地方
      loadAuditLog: async (projectId: string, fromISO: string, toISO: string): Promise<AuditLogResult> => {
        const { data } = get();
        const project = data.projects.find(p => p.id === projectId);
        if (!project) return { entries: [], truncated: false, error: 'Project not found locally' };

        try {
          const page = await appRepository.loadAuditLog(data.settings, project, fromISO, toISO);
          return { entries: page?.entries || [], truncated: Boolean(page?.truncated) };
        } catch (err: any) {
          return { entries: [], truncated: false, error: err?.message || 'Audit log request failed' };
        }
      },
    }),
    {
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
        _dirtyConf: state._dirtyConf,
        _dirtyTracker: state._dirtyTracker,
        _dirtyTrackerDrawingIds: Array.from(state._dirtyTrackerDrawingIds),
      }),
      version: 2,
      migrate: (persistedState: any) => {
        if (!persistedState?.data?.projects) return persistedState;
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
        _dirtyTrackerDrawingIds: persistedState?._dirtyTrackerDrawingIds instanceof Set
          ? persistedState._dirtyTrackerDrawingIds
          : new Set(Array.isArray(persistedState?._dirtyTrackerDrawingIds) ? persistedState._dirtyTrackerDrawingIds : []),
      }),
    }
  )
);

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
