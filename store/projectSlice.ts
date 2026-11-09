import type { AppData, Drawing, DrawingConflict, Project, ReviewTrackerData, DeltaPayload } from '../types';
import { projectsApi } from '../services/api/projectsApi';
import { mergeProjectPreservingDirty } from '../lib/merge-project';
import { calculateDeadline, projectDateKey } from '../lib/deadline';
import { buildDrawingPatch, PCF_MANAGED_FIELDS, type DirtyDrawingBase, type DirtyDrawingFields } from '../lib/drawing-fields';
import { describeDrawingConflicts } from '../lib/project-save';
import { ApiError } from '../services/api/apiClient';
import { ensureDrawingHasId, normalizeProjectDrawingIds, stripProjectPayload, recalculateReviewDeadline } from '../lib/project';
import { editableDrawingUpdates, applyDrawingUpdates } from '../lib/drawing-edit';
import { describeVerification } from '../lib/project-save';
import type { AuditLogResult, ProjectSlice, SliceCreator } from './types';
const generateId = () => Math.random().toString(36).substr(2, 9);
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
export const createProjectSlice: SliceCreator<ProjectSlice> = (set, get) => ({
  data: { ...DEFAULT_DATA, projects: [], settings: { ...DEFAULT_DATA.settings } },
  isLoading: false,
  error: null,
  activeProjectId: null,
  _dirtyDrawingIds: new Set<string>(),
  _dirtyDrawingFields: {},
  _dirtyDrawingBase: {},
  _deletedDrawingIds: new Set<string>(),
  _dirtyConf: false,
  saveConflict: null,
  clearSaveConflict: () => set({ saveConflict: null }),
  refreshProjectPreservingDirty: async (projectId: string) => {
    const initial = get();
    const stub = initial.data.projects.find(p => p.id === projectId);
    if (!stub)
      return 0;
    const [rawProject, remoteTracker] = await Promise.all([
      projectsApi.loadProject(stub, stub.conf?.password),
      projectsApi.loadReviewTracker(stub.id).catch(() => ({})),
    ]);
    const remote = normalizeProjectDrawingIds(rawProject, generateId);
    let changed = 0;
    set(state => {
      if (state.activeProjectId !== projectId)
        return state;
      const local = state.data.projects.find(p => p.id === projectId);
      if (!local)
        return state;
      const merged = mergeProjectPreservingDirty(local, remote, state._dirtyDrawingIds, state._deletedDrawingIds, state._dirtyConf, state.reviewTracker, remoteTracker || {}, state._dirtyTrackerDrawingIds, state._dirtyTracker, state._dirtyDrawingFields);
      changed = merged.changedDrawings;
      return {
        data: { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? merged.project : p) },
        reviewTracker: merged.reviewTracker,
      };
    });
    return changed;
  },
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
          conf: {
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
    if (!activeProjectId)
      return state;
    const drawingWithId = { ...ensureDrawingHasId(drawing, generateId), currentRound: drawing.currentRound || 'A' };
    const newDirty = new Set(state._dirtyDrawingIds);
    newDirty.add(drawingWithId.id);
    return {
      _dirtyDrawingIds: newDirty,
      data: {
        ...data,
        projects: data.projects.map((p) => {
          if (p.id !== activeProjectId)
            return p;
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
    if (!activeProjectId)
      return state;
    const current = state.data.projects.find(p => p.id === activeProjectId)?.drawings.find(d => d.id === id);
    updates = editableDrawingUpdates(current, updates);
    if (Object.keys(updates).length === 0)
      return state;
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
          if (p.id !== activeProjectId)
            return p;
          return {
            ...p,
            drawings: p.drawings.map(d => {
              if (d.id !== id)
                return d;
              return applyDrawingUpdates(d, updates, p.conf || state.data.settings, new Date(), generateId());
            })
          };
        })
      }
    };
  }),
  deleteDrawing: (id) => set((state) => {
    const { activeProjectId } = state;
    if (!activeProjectId)
      return state;
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
    if (!activeProjectId)
      return state;
    const newDirty = new Set(state._dirtyDrawingIds);
    newDirty.add(drawingId);
    return {
      _dirtyDrawingIds: newDirty,
      data: {
        ...state.data,
        projects: state.data.projects.map(p => {
          if (p.id !== activeProjectId)
            return p;
          return {
            ...p,
            drawings: p.drawings.map(d => {
              if (d.id !== drawingId)
                return d;
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
    if (!activeProjectId)
      return state;
    const newDirty = new Set(state._dirtyDrawingIds);
    newDirty.add(drawingId);
    return {
      _dirtyDrawingIds: newDirty,
      data: {
        ...state.data,
        projects: state.data.projects.map(p => {
          if (p.id !== activeProjectId)
            return p;
          return {
            ...p,
            drawings: p.drawings.map(d => {
              if (d.id !== drawingId)
                return d;
              return { ...d, remarks: (d.remarks || []).filter(r => r.content !== content) };
            })
          };
        })
      }
    };
  }),
  batchUpdateDrawings: (updates) => {
    for (const update of updates)
      get().updateDrawing(update.id, update.changes);
  },
  resetAllAssignees: () => set((state) => {
    const { activeProjectId, data } = state;
    if (!activeProjectId)
      return state;
    const project = data.projects.find(p => p.id === activeProjectId);
    if (!project)
      return state;
    const defaultAssignees = project.conf?.defaultAssignees || {};
    const newDirty = new Set(state._dirtyDrawingIds);
    project.drawings.forEach(d => newDirty.add(d.id));
    return {
      _dirtyDrawingIds: newDirty,
      data: {
        ...state.data,
        projects: state.data.projects.map(p => {
          if (p.id !== activeProjectId)
            return p;
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
    if (!activeProjectId)
      return state;
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
    if (!activeProjectId)
      return false;
    return get().saveProject(activeProjectId);
  },
  saveProject: async (projectId: string) => {
    const { data, reviewTracker, _dirtyDrawingIds, _dirtyDrawingFields, _dirtyDrawingBase, _deletedDrawingIds, _dirtyConf, _dirtyTracker, _dirtyTrackerDrawingIds } = get();
    const project = data.projects.find(p => p.id === projectId);
    if (!project)
      return false;
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
      // 只发改过的字段，并带上开始修改时的版本和旧值，服务端据此判断是否被别人先改了
      const updatedDrawings = project.drawings.filter(d => dirtyDrawingSnapshot.has(d.id)).map(d => buildDrawingPatch(d,
        fieldSnapshot[d.id] || new Set(Object.keys(d) as (keyof Drawing)[]),
        _dirtyDrawingBase[d.id] || (d.rev ? { rev: d.rev, values: {} } : undefined)));
      const payload: DeltaPayload = { projectName: project.name };
      if (deletedDrawingSnapshot.size)
        payload.deletedDrawingIds = [...deletedDrawingSnapshot];
      if (updatedDrawings.length > 0)
        payload.updatedDrawings = updatedDrawings;
      if (dirtyConfSnapshot)
        payload.conf = project.conf;
      if (dirtyTrackerSnapshotFlag) {
        const trackerSlice: ReviewTrackerData = {};
        for (const id of dirtyTrackerSnapshot)
          trackerSlice[id] = reviewTracker[id] || {};
        if (Object.keys(trackerSlice).length > 0)
          payload.reviewTracker = trackerSlice;
      }
      const saveResult = await projectsApi.saveDelta(projectId, payload);
      // 服务端回读校验：没落库的图纸不清脏标记，交给下次保存重试
      const verification = saveResult?.verification;
      const unverifiedIds = new Set(verification && !verification.ok && !verification.error
        ? verification.mismatched.map(m => m.id)
        : []);
      if (verification?.error) {
        console.warn(`[Save] Write verification unavailable: ${verification.error}`);
      }
      const verificationMessage = describeVerification(verification);
      if (verificationMessage)
        console.error(`[Save] ${verificationMessage}`);
      // 保存期间可能发生新修改：只清理本次 payload 中已发送且未再次改变的脏标记
      set(state => {
        const currentProject = state.data.projects.find(p => p.id === projectId);
        const nextDirtyDrawingIds = new Set(state._dirtyDrawingIds);
        const nextFields = { ...state._dirtyDrawingFields };
        const nextBase: DirtyDrawingBase = { ...state._dirtyDrawingBase };
        const acknowledged = new Map((saveResult?.drawings || []).map(d => [d.id, d]));
        const mergedDrawings = currentProject?.drawings.map(d => {
          const remote = acknowledged.get(d.id);
          if (!remote || unverifiedIds.has(d.id))
            return d;
          const sent = project.drawings.find(x => x.id === d.id);
          const merged = { ...d };
          for (const field of Object.keys(remote) as (keyof Drawing)[]) {
            if (field === 'hasPcf' || (remote.hasPcf && PCF_MANAGED_FIELDS.includes(field)) || JSON.stringify(d[field]) === JSON.stringify(sent?.[field]))
              (merged as any)[field] = remote[field];
          }
          return merged;
        });
        dirtyDrawingSnapshot.forEach(id => {
          if (unverifiedIds.has(id))
            return;
          const previousDrawing = project.drawings.find(d => d.id === id);
          const currentDrawing = currentProject?.drawings.find(d => d.id === id);
          const remaining = new Set(nextFields[id] || []);
          for (const field of fieldSnapshot[id] || []) {
            if (JSON.stringify(currentDrawing?.[field]) === JSON.stringify(previousDrawing?.[field]))
              remaining.delete(field);
          }
          if (!remaining.size || currentDrawing === previousDrawing) {
            nextDirtyDrawingIds.delete(id);
            delete nextFields[id];
            delete nextBase[id];
          }
          else {
            nextFields[id] = remaining;
            const entry = nextBase[id];
            if (entry) {
              // 已确认的字段不再参与比对；同一字段保存期间又改了，新的旧值就是这次服务端确认的值
              const values = { ...entry.values };
              const remote = acknowledged.get(id);
              for (const field of Object.keys(values) as (keyof Drawing)[]) {
                if (!remaining.has(field)) delete values[field];
                else if (fieldSnapshot[id]?.has(field) && remote && field in remote) values[field] = JSON.parse(JSON.stringify(remote[field] ?? null));
              }
              nextBase[id] = { rev: entry.rev, values };
            }
          }
        });
        const nextDeletedDrawingIds = new Set(state._deletedDrawingIds);
        deletedDrawingSnapshot.forEach(id => nextDeletedDrawingIds.delete(id));
        const nextDirtyTrackerDrawingIds = new Set(state._dirtyTrackerDrawingIds);
        dirtyTrackerSnapshot.forEach(id => {
          if (unverifiedIds.has(id))
            return;
          if (state.reviewTracker[id] === reviewTracker[id])
            nextDirtyTrackerDrawingIds.delete(id);
        });
        const nextDirtyConf = dirtyConfSnapshot && currentProject?.conf === project.conf ? false : state._dirtyConf;
        return {
          isLoading: false,
          error: verificationMessage ?? state.error,
          _dirtyDrawingIds: nextDirtyDrawingIds,
          _dirtyDrawingFields: nextFields,
          _dirtyDrawingBase: nextBase,
          data: mergedDrawings ? { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? { ...p, drawings: mergedDrawings } : p) } : state.data,
          _deletedDrawingIds: nextDeletedDrawingIds,
          _dirtyConf: nextDirtyConf,
          _dirtyTracker: nextDirtyTrackerDrawingIds.size > 0,
          _dirtyTrackerDrawingIds: nextDirtyTrackerDrawingIds,
        };
      });
      return unverifiedIds.size === 0;
    }
    catch (err: any) {
      if (err instanceof ApiError && err.status === 409 && err.data?.code === 'DRAWING_CONFLICT' && Array.isArray(err.data.conflicts)) {
        // 整批没有写入。冲突字段换成服务端最新值并放弃本地修改，其余未冲突的修改保留，下次自动保存再发
        const conflicts = err.data.conflicts as DrawingConflict[];
        const message = describeDrawingConflicts(conflicts);
        console.warn(`[Save] ${message}`);
        set(state => {
          const byId = new Map(conflicts.map(c => [c.id, c]));
          const nextDirtyDrawingIds = new Set(state._dirtyDrawingIds);
          const nextFields = { ...state._dirtyDrawingFields };
          const nextBase: DirtyDrawingBase = { ...state._dirtyDrawingBase };
          const drawings: Drawing[] = [];
          for (const d of state.data.projects.find(p => p.id === projectId)?.drawings || []) {
            const conflict = byId.get(d.id);
            if (!conflict) { drawings.push(d); continue; }
            if (!conflict.current) { // 别人已删除
              nextDirtyDrawingIds.delete(d.id); delete nextFields[d.id]; delete nextBase[d.id];
              continue;
            }
            const merged = { ...d } as Drawing;
            const discard = new Set(conflict.fields as (keyof Drawing)[]);
            for (const field of discard) (merged as any)[field] = (conflict.current as any)[field];
            const remaining = new Set([...(nextFields[d.id] || [])].filter(f => !discard.has(f)));
            if (remaining.size) {
              nextFields[d.id] = remaining;
              const entry = nextBase[d.id];
              if (entry) nextBase[d.id] = { rev: entry.rev, values: Object.fromEntries(Object.entries(entry.values).filter(([f]) => !discard.has(f as keyof Drawing))) };
            }
            else { nextDirtyDrawingIds.delete(d.id); delete nextFields[d.id]; delete nextBase[d.id]; Object.assign(merged, conflict.current); }
            drawings.push(merged);
          }
          return {
            isLoading: false,
            error: message,
            saveConflict: { message, drawingIds: conflicts.map(c => c.id), at: Date.now() },
            _dirtyDrawingIds: nextDirtyDrawingIds,
            _dirtyDrawingFields: nextFields,
            _dirtyDrawingBase: nextBase,
            data: { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? { ...p, drawings } : p) },
          };
        });
        // 载入别人的其他改动（不覆盖仍在编辑的字段）
        void get().refreshProjectPreservingDirty(projectId).catch(e => console.warn('[Save] Refresh after conflict failed', e));
        return false;
      }
      console.error("Push failed", err);
      set({ isLoading: false, error: err.message });
      return false;
    }
  },
  fetchGlobalSettings: async () => {
    try {
      const settings = await projectsApi.fetchGlobalSettings();
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
    }
    catch (e) {
      console.warn("Settings fetch failed", e);
    }
  },
  fetchProjectList: async () => {
    set({ isLoading: true, error: null });
    try {
      const remoteProjects = await projectsApi.fetchProjectList();
      set(state => {
        const currentProjects = state.data.projects;
        const mergedProjects = [...currentProjects];
        remoteProjects.forEach(rp => {
          // 按 ID 合并，避免同名项目污染
          const existingIndex = mergedProjects.findIndex(p => p.id === rp.id);
          if (existingIndex > -1) {
            mergedProjects[existingIndex] = { ...mergedProjects[existingIndex], storagePath: rp.storagePath };
          }
          else {
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
    }
    catch (err: any) {
      console.error("List failed", err);
      set({ isLoading: false, error: err.message });
      throw err;
    }
  },
  loadProject: async (projectId: string, passwordInput?: string) => {
    const { data } = get();
    const projectStub = data.projects.find(p => p.id === projectId);
    if (!projectStub)
      return;
    set({ isLoading: true });
    try {
      const fullProject = normalizeProjectDrawingIds(await projectsApi.loadProject(projectStub, passwordInput), generateId);
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
          projects: state.data.projects.map(p => p.id === projectId
            ? { ...fullProject, id: projectId }
            : stripProjectPayload(p, false))
        },
        activeProjectId: projectId,
        isLoading: false,
        _dirtyDrawingIds: new Set<string>(),
        _dirtyDrawingFields: {},
        _dirtyDrawingBase: {},
        _deletedDrawingIds: new Set<string>(),
        _dirtyConf: false,
        _dirtyTracker: false,
        _dirtyTrackerDrawingIds: new Set<string>(),
      }));
      // Presence is non-blocking and owned by its slice.
      void get().refreshAdminPresence(projectId);
    }
    catch (err: any) {
      set({ isLoading: false, error: err.message });
      throw err;
    }
  },
  testConnection: async () => projectsApi.testConnection(),
  updateProjectConfig: (projectId, updates) => set((state) => {
    const shouldRecalculateDeadlines = updates.holidays !== undefined ||
      updates.roundACycle !== undefined ||
      updates.otherRoundsCycle !== undefined;
    const newDirty = new Set(state._dirtyDrawingIds);
    return {
      _dirtyConf: true,
      _dirtyDrawingIds: shouldRecalculateDeadlines ? newDirty : state._dirtyDrawingIds,
      data: {
        ...state.data,
        projects: state.data.projects.map(p => {
          if (p.id !== projectId)
            return p;
          const nextConf = { ...(p.conf || state.data.settings), ...updates };
          const nextDrawings = shouldRecalculateDeadlines
            ? p.drawings.map(d => {
              if (d.status !== 'Reviewing')
                return d;
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
    if (!activeProjectId)
      return state;
    const newDirty = new Set(state._dirtyDrawingIds);
    newDirty.add(drawingId);
    return {
      _dirtyDrawingIds: newDirty,
      data: {
        ...state.data,
        projects: state.data.projects.map(p => {
          if (p.id !== activeProjectId)
            return p;
          return {
            ...p,
            drawings: p.drawings.map(d => {
              if (d.id !== drawingId)
                return d;
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
  loadAuditLog: async (projectId: string, fromISO: string, toISO: string): Promise<AuditLogResult> => {
    const { data } = get();
    const project = data.projects.find(p => p.id === projectId);
    if (!project)
      return { entries: [], truncated: false, error: 'Project not found locally' };
    try {
      const page = await projectsApi.loadAuditLog(project.id, fromISO, toISO);
      return { entries: page?.entries || [], truncated: Boolean(page?.truncated) };
    }
    catch (err: any) {
      return { entries: [], truncated: false, error: err?.message || 'Audit log request failed' };
    }
  }
});
