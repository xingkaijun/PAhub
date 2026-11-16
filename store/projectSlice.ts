import type { AppData, ConfigConflict, Drawing, DrawingConflict, Project, ProjectConfig, ReviewTrackerData, DeltaPayload } from '../types';
import { applyConfigConflicts, buildConfigPatch, describeConfigConflicts, recordConfigEdit, sameValue, type DirtyConfBase } from '../lib/project-config';
import { isProjectNotFound, projectsApi } from '../services/api/projectsApi';
import { mergeProjectPreservingDirty } from '../lib/merge-project';
import { calculateDeadline, projectDateKey } from '../lib/deadline';
import { buildDrawingPatch, PCF_MANAGED_FIELDS, type DirtyDrawingBase, type DirtyDrawingFields } from '../lib/drawing-fields';
import { describeDrawingConflicts } from '../lib/project-save';
import { ApiError } from '../services/api/apiClient';
import { ensureDrawingHasId, normalizeProjectDrawingIds, stripProjectPayload, recalculateReviewDeadline, withoutProjectSecrets } from '../lib/project';
import { editableDrawingUpdates, applyDrawingUpdates } from '../lib/drawing-edit';
import { describeVerification } from '../lib/project-save';
import type { AuditLogResult, ProjectSlice, SliceCreator } from './types';
import {SaveLock,withSaveTimeout,saveFailure,retryable,retryDelay,failureText} from '../lib/save-control';
const editSnapshots = new WeakMap<Function, Map<string, Project>>();
function rememberProject(get: Function, state: any, id: string | null) {
  if(state.session?.mode!=='kjx'||!id)return;
  const project=state.data.projects.find((p:Project)=>p.id===id);if(!project)return;
  let snapshots=editSnapshots.get(get);if(!snapshots){snapshots=new Map();editSnapshots.set(get,snapshots);}
  if(!snapshots.has(id))snapshots.set(id,structuredClone(project));
}
const allowedEdit=(state:any,capability:string)=>state.session?.mode!=='kjx'||state.session.permissions?.includes(capability);
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
/** Made with "New project" and not confirmed on the server yet (see Project.localOnly). */
const isLocalOnlyProject = (project: Project) => project.localOnly === true;
const projectNotFoundMessage = (name: string, whileOpen: boolean) => whileOpen
  ? `Project "${name}" no longer exists on the server. It may have been deleted; changes you make here cannot be saved.`
  : `Project "${name}" does not exist on the server. It may have been deleted. The local copy was not opened.`;

export const createProjectSlice: SliceCreator<ProjectSlice> = (set, get) => {
 const lock=new SaveLock();
 return ({
  saveStatuses:{},pendingSaves:{},
  saveProject:(id,options={})=>lock.run(id,async()=>{
    const intents=Object.entries(get().trackerWrites).filter(([,intent])=>intent.projectId===id);
    for(const [key] of intents) if(!await get().retryTrackerWrite(key))return false;
    const status=get().saveStatuses[id];
    if(!get().hasUnsavedChanges()&&!get().pendingSaves[id]&&!get().data.projects.find(p=>p.id===id)?.localOnly){
      if(status?.phase==='failed'||status?.phase==='unconfirmed')set(current=>({saveStatuses:{...current.saveStatuses,[id]:{phase:'saved',attempts:0,lastSuccess:status.lastSuccess}}}));
      return true;
    }
    if(status?.failure==='forbidden' && get().hasUnsavedChanges() && !get().pendingSaves[id]){set(current=>({saveStatuses:{...current.saveStatuses,[id]:{phase:'saved',attempts:0,lastSuccess:status.lastSuccess}}}));return get().saveProjectAttempt(id);}
    if(get().session?.mode!=='kjx' && status?.phase!=='unconfirmed' && (!status?.failure || !retryable(status.failure)))return get().saveProjectAttempt(id);
    if(!options.manual && (status?.phase==='failed'||status?.phase==='unconfirmed') && (!status.retryAt || status.retryAt>Date.now()))return false;
    if(status?.failure==='login'||status?.failure==='oversize')return false;
    if(status?.failure==='forbidden' && !get().hasUnsavedChanges())return false;
    return get().saveProjectAttempt(id);
  }),
  membershipRecovery: {},
  data: { ...DEFAULT_DATA, projects: [], settings: { ...DEFAULT_DATA.settings } },
  nextAutosaveAt: 0,
  isLoading: false,
  error: null,
  activeProjectId: null,
  _dirtyDrawingIds: new Set<string>(),
  _dirtyDrawingFields: {},
  _dirtyDrawingBase: {},
  _deletedDrawingIds: new Set<string>(),
  _dirtyConf: false,
  _dirtyConfKeys: new Set<keyof ProjectConfig>(),
  _dirtyConfBase: {},
  saveConflict: null,
  clearSaveConflict: () => set({ saveConflict: null }),
  projectNotice: null,
  clearProjectNotice: () => set({ projectNotice: null }),
  refreshProjectPreservingDirty: async (projectId: string) => {
    const initial = get();
    const stub = initial.data.projects.find(p => p.id === projectId);
    if (!stub)
      return 0;
    // Conditional reads: null means 304, the server still has exactly what this client last read.
    let rawProject: Project | null, remoteTracker: ReviewTrackerData | null;
    try {
      [rawProject, remoteTracker] = await Promise.all([
        projectsApi.loadProjectIfChanged(stub),
        projectsApi.loadReviewTrackerIfChanged(stub.id).catch(() => null),
      ]);
    }
    catch (err) {
      if (isProjectNotFound(err) && isLocalOnlyProject(stub)) return 0; // not on the server yet: nothing to refresh
      if (isProjectNotFound(err) && get().activeProjectId === projectId)
        set({ projectNotice: { message: projectNotFoundMessage(stub.name, true), projectId, at: Date.now() } });
      throw err;
    }
    if (!rawProject && !remoteTracker)
      return 0;
    let changed = 0;
    set(state => {
      if (state.activeProjectId !== projectId)
        return state;
      const local = state.data.projects.find(p => p.id === projectId);
      if (!local)
        return state;
      const remote = rawProject ? normalizeProjectDrawingIds(rawProject, generateId) : local;
      const merged = mergeProjectPreservingDirty(local, remote, state._dirtyDrawingIds, state._deletedDrawingIds, state._dirtyConfKeys.size ? state._dirtyConfKeys : state._dirtyConf, state.reviewTracker, remoteTracker || state.reviewTracker, state._dirtyTrackerDrawingIds, state._dirtyTracker, state._dirtyDrawingFields);
      changed = merged.changedDrawings;
      return {
        data: { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? merged.project : p) },
        reviewTracker: merged.reviewTracker,
      };
    });
    return changed;
  },
  refreshDrawingsPreservingDirty: async (projectId: string, drawingIds: string[]) => {
    const stub = get().data.projects.find(p => p.id === projectId);
    if (!stub || !drawingIds.length)
      return 0;
    const result = await projectsApi.loadDrawings(projectId, drawingIds);
    const fetched = new Map(normalizeProjectDrawingIds({ ...stub, drawings: result.drawings || [] }, generateId).drawings.map(d => [d.id, d]));
    const gone = new Set(result.missing || []);
    let changed = 0;
    set(state => {
      if (state.activeProjectId !== projectId)
        return state;
      const local = state.data.projects.find(p => p.id === projectId);
      if (!local)
        return state;
      // A remote copy that differs from local only in the fetched drawings; the shared merge then keeps
      // unsaved fields, rev/base for conflict checks, and dirty tracker rows exactly as a full refresh does.
      const seen = new Set<string>();
      const drawings = local.drawings.flatMap(d => {
        seen.add(d.id);
        if (gone.has(d.id)) return [];
        return [fetched.get(d.id) || d];
      });
      for (const [id, d] of fetched) if (!seen.has(id)) drawings.push(d);
      const remoteTracker = { ...state.reviewTracker };
      for (const id of drawingIds) {
        if (result.reviewTracker?.[id]) remoteTracker[id] = result.reviewTracker[id];
        else delete remoteTracker[id];
      }
      const merged = mergeProjectPreservingDirty(local, { ...local, drawings, ...(result.assigneeNames ? {assigneeNames:result.assigneeNames} : {}) }, state._dirtyDrawingIds, state._deletedDrawingIds, state._dirtyConfKeys.size ? state._dirtyConfKeys : state._dirtyConf, state.reviewTracker, remoteTracker, state._dirtyTrackerDrawingIds, state._dirtyTracker, state._dirtyDrawingFields);
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
    return Object.values(state.trackerWrites).some(intent=>intent.projectId===state.activeProjectId) || state._dirtyDrawingIds.size > 0 ||
      state._deletedDrawingIds.size > 0 ||
      state._dirtyConf ||
      state._dirtyTracker;
  },
  getUnsavedChangesCount: () => {
    const state = get();
    return Object.values(state.trackerWrites).filter(intent=>intent.projectId===state.activeProjectId).length + state._dirtyDrawingIds.size + state._deletedDrawingIds.size +
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
          localOnly: true,
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
  updateSettings: (newSettings) => set((state) => !allowedEdit(state,'settings.write') ? state : ({
    data: { ...state.data, settings: { ...state.data.settings, ...newSettings } },
  })),
  addDrawing: (drawing) => set((state) => {
    if(!allowedEdit(state,'bulk.import'))return state;
    rememberProject(get,state,state.activeProjectId);
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
    if(!allowedEdit(state,'drawing.update'))return state;
    rememberProject(get,state,state.activeProjectId);
    const { activeProjectId } = state;
    if (!activeProjectId)
      return state;
    const current = state.data.projects.find(p => p.id === activeProjectId)?.drawings.find(d => d.id === id);
    updates = editableDrawingUpdates(current, updates);
    if (state.session?.mode === 'kjx') updates = Object.fromEntries(Object.entries(updates).filter(([key,value]) => !sameValue(current?.[key as keyof Drawing], value))) as Partial<Drawing>;
    if (Object.keys(updates).length === 0)
      return state;
    const newDirty = new Set(state._dirtyDrawingIds);
    newDirty.add(id);
    // 如果 assignees 发生变化，标记 tracker 为脏数据（需要清理移除的 assignee 的 tracker 行）
    let newDirtyTracker = state._dirtyTracker;
    const newDirtyTrackerIds = new Set(state._dirtyTrackerDrawingIds);
    if (updates.assignees && state.session?.mode !== 'kjx') {
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
    if(!allowedEdit(state,'drawing.void'))return state;
    rememberProject(get,state,state.activeProjectId);
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
    if(!allowedEdit(state,'drawing.update'))return state;
    rememberProject(get,state,state.activeProjectId);
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
  deleteRemark: (drawingId, remarkId) => set((state) => {
    if(!allowedEdit(state,'drawing.update'))return state;
    rememberProject(get,state,state.activeProjectId);
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
              return { ...d, remarks: (d.remarks || []).filter(r => r.id !== remarkId) };
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
    if(!allowedEdit(state,'team.setup'))return state;
    rememberProject(get,state,state.activeProjectId);
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
    if(!allowedEdit(state,'bulk.import'))return state;
    rememberProject(get,state,state.activeProjectId);
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
  saveProjectAttempt: async (projectId: string) => {
    let state = get();
    const pending=state.session?.mode==='kjx'?state.pendingSaves[projectId]:undefined;
    if(pending?.actorId && pending.actorId!==state.session?.user?.id){set(current=>({saveStatuses:{...current.saveStatuses,[projectId]:{phase:'failed',attempts:0,failure:'login',reason:'Pending changes belong to another account; sign in with the original account'}}}));return false;}
    if(pending)state={...state,...pending.source,data:{...state.data,projects:state.data.projects.map(p=>p.id===projectId?pending.project:p)},reviewTracker:pending.tracker,_dirtyDrawingIds:new Set(pending.source._dirtyDrawingIds),_dirtyDrawingFields:Object.fromEntries(Object.entries(pending.source._dirtyDrawingFields).map(([id,fields])=>[id,new Set(fields as any)])),_deletedDrawingIds:new Set(pending.source._deletedDrawingIds),_dirtyConfKeys:new Set(pending.source._dirtyConfKeys),_dirtyTrackerDrawingIds:new Set(pending.source._dirtyTrackerDrawingIds)};
    if (state.session?.mode === 'kjx' && state.projectNotice?.projectId === projectId && state.projectNotice.requiresReload) return false;
    // A new workspace must persist its own configuration even when the active
    // workspace is clean; never borrow another project's global dirty flags.
    const source = state.activeProjectId === projectId || !state.data.projects.find(project => project.id === projectId)?.localOnly ? state : { ...state, _dirtyDrawingIds: new Set<string>(), _dirtyDrawingFields: {}, _dirtyDrawingBase: {}, _deletedDrawingIds: new Set<string>(), _dirtyConf: false, _dirtyConfKeys: new Set<keyof ProjectConfig>(), _dirtyConfBase: {}, _dirtyTracker: false, _dirtyTrackerDrawingIds: new Set<string>() };
    const { data, reviewTracker, _dirtyDrawingIds, _dirtyDrawingFields, _dirtyDrawingBase, _deletedDrawingIds, _dirtyConf, _dirtyConfKeys, _dirtyConfBase, _dirtyTracker, _dirtyTrackerDrawingIds } = source;
    const project = data.projects.find(p => p.id === projectId);
    if (!project)
      return false;
    const dirtyDrawingSnapshot = new Set(_dirtyDrawingIds);
    const fieldSnapshot = Object.fromEntries(Object.entries(_dirtyDrawingFields).map(([id, fields]) => [id, new Set(fields)])) as DirtyDrawingFields;
    const deletedDrawingSnapshot = new Set(_deletedDrawingIds);
    const dirtyTrackerSnapshot = new Set(_dirtyTrackerDrawingIds);
    const dirtyConfSnapshot = _dirtyConf;
    const confKeySnapshot = new Set(_dirtyConfKeys);
    const dirtyTrackerSnapshotFlag = _dirtyTracker;
    const dirtyCount = dirtyDrawingSnapshot.size + deletedDrawingSnapshot.size;
    const hasDirty = project.localOnly || dirtyCount > 0 || dirtyConfSnapshot || dirtyTrackerSnapshotFlag;
    // 无任何变更时跳过
    if (!hasDirty) {
      console.log('[Save] No changes detected, skipping.');
      return true;
    }
    const previousStatus=get().saveStatuses[projectId];
    const status=(value:any)=>set(current=>({saveStatuses:{...current.saveStatuses,[projectId]:value}}));
    status({...previousStatus,phase:'saving',attempts:previousStatus?.attempts || 0,retryAt:undefined});
    set({ error: null });
    try {
      // 只发改过的字段，并带上开始修改时的版本和旧值，服务端据此判断是否被别人先改了
      const updatedDrawings = project.drawings.filter(d => dirtyDrawingSnapshot.has(d.id)).map(d => {
        const fields = fieldSnapshot[d.id] || new Set(Object.keys(d) as (keyof Drawing)[]);
        const base = _dirtyDrawingBase[d.id] || (d.rev ? { rev: d.rev, values: {} } : undefined);
        const actual = state.session?.mode === 'kjx' && base ? new Set([...fields].filter(field => !Object.hasOwn(base.values,field) || !sameValue(d[field],base.values[field]))) : fields;
        return buildDrawingPatch(d,actual,base);
      }).filter(patch => state.session?.mode !== 'kjx' || Object.keys(patch.changes).length || Object.values(patch.remarkOps || {}).some(items => items.length));
      const payload: DeltaPayload = { projectName: project.name, ...(state.session?.mode==='kjx'?{saveRequestId:crypto.randomUUID()}:{}) };
      if (deletedDrawingSnapshot.size)
        payload.deletedDrawingIds = [...deletedDrawingSnapshot];
      if (updatedDrawings.length > 0)
        payload.updatedDrawings = updatedDrawings;
      if (project.localOnly) payload.conf = project.conf;
      else if (dirtyConfSnapshot) {
        if (confKeySnapshot.size) {
          // 只发改过的设置项，并带上开始修改时的值
          const actualKeys = state.session?.mode === 'kjx' ? new Set([...confKeySnapshot].filter(key => !Object.hasOwn(_dirtyConfBase,key) || !sameValue(project.conf[key],_dirtyConfBase[key]))) : confKeySnapshot;
          const { conf, confBase } = buildConfigPatch(project.conf, actualKeys, _dirtyConfBase);
          payload.conf = conf;
          if (confBase) payload.confBase = confBase;
        }
        else payload.conf = project.conf; // 旧版本地缓存里只有 _dirtyConf 标记：按原样整份发送
      }
      if (!pending && dirtyTrackerSnapshotFlag) {
        const trackerSlice: ReviewTrackerData = {};
        for (const id of dirtyTrackerSnapshot)
          trackerSlice[id] = reviewTracker[id] || {};
        if (Object.keys(trackerSlice).length > 0) {
          if (state.session?.mode === 'kjx') {
            const stored = await withSaveTimeout(signal=>projectsApi.loadReviewTracker(projectId,signal));
            for (const id of Object.keys(trackerSlice)) if (sameValue(trackerSlice[id], stored[id] || {})) delete trackerSlice[id];
          }
          if (Object.keys(trackerSlice).length) payload.reviewTracker = trackerSlice;
        }
      }
      const request=pending?.payload || payload;
      if(!pending && state.session?.mode==='kjx')set(current=>({pendingSaves:{...current.pendingSaves,[projectId]:{actorId:state.session?.user?.id,payload:request,project:structuredClone(project),tracker:structuredClone(reviewTracker),source:{_dirtyDrawingIds:[...dirtyDrawingSnapshot],_dirtyDrawingFields:Object.fromEntries(Object.entries(fieldSnapshot).map(([id,fields])=>[id,[...fields]])),_dirtyDrawingBase,_deletedDrawingIds:[...deletedDrawingSnapshot],_dirtyConf:dirtyConfSnapshot,_dirtyConfKeys:[...confKeySnapshot],_dirtyConfBase,_dirtyTracker:dirtyTrackerSnapshotFlag,_dirtyTrackerDrawingIds:[...dirtyTrackerSnapshot]}}}}));
      const saveResult = state.session?.mode==='kjx' ? await withSaveTimeout(signal=>projectsApi.saveDelta(projectId,request,signal)) : await projectsApi.saveDelta(projectId,request);
      // 服务端回读校验：没落库的图纸不清脏标记，交给下次保存重试
      const verification = saveResult?.verification;
      if (verification?.error) {
        const attempts = (previousStatus?.attempts || 0) + 1;
        status({phase:'unconfirmed',failure:'network',reason:verification.error,attempts,lastSuccess:previousStatus?.lastSuccess,retryAt:Date.now()+retryDelay(attempts)});
        return false;
      }
      const unverifiedIds = new Set(verification && !verification.ok && !verification.error
        ? verification.mismatched.map(m => m.id)
        : []);
      const verificationMessage = describeVerification(verification);
      if (verificationMessage)
        console.error(`[Save] ${verificationMessage}`);
      // 保存期间可能发生新修改：只清理本次 payload 中已发送且未再次改变的脏标记
      set(state => {
        if (project.localOnly && state.activeProjectId !== projectId) return {};
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
          const remaining = new Set(nextFields[id] || (currentDrawing && !sameValue(currentDrawing,previousDrawing) ? Object.keys(currentDrawing).filter(field=>!sameValue((currentDrawing as any)[field],(previousDrawing as any)?.[field])) as (keyof Drawing)[] : []));
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
          if (sameValue(state.reviewTracker[id],reviewTracker[id]))
            nextDirtyTrackerDrawingIds.delete(id);
        });
        // 设置项：发出后没再改的项清掉；服务端回传合并后的设置（按专业合并的 map 以服务端为准）
        const nextConfKeys = new Set(state._dirtyConfKeys);
        const nextConfBase: DirtyConfBase = { ...state._dirtyConfBase };
        let nextConf = currentProject?.conf;
        const serverConf = saveResult?.conf;
        if (dirtyConfSnapshot && currentProject) {
          const sentKeys = confKeySnapshot.size ? [...confKeySnapshot] : [];
          for (const key of sentKeys) {
            const unchanged = sameValue(currentProject.conf?.[key], project.conf?.[key]);
            if (unchanged) {
              nextConfKeys.delete(key); delete nextConfBase[key];
              if (serverConf && key in serverConf && key !== 'reviewers') nextConf = { ...nextConf!, [key]: serverConf[key] };
            }
            else if (serverConf && key in serverConf) nextConfBase[key] = JSON.parse(JSON.stringify(serverConf[key] ?? null));
          }
        }
        const nextDirtyConf = nextConfKeys.size > 0 || (dirtyConfSnapshot
          ? !confKeySnapshot.size && !sameValue(currentProject?.conf,project.conf) && state._dirtyConf
          : state._dirtyConf);
        return {
          error: verificationMessage ?? state.error,
          _dirtyDrawingIds: nextDirtyDrawingIds,
          _dirtyDrawingFields: nextFields,
          _dirtyDrawingBase: nextBase,
          data: mergedDrawings || nextConf !== currentProject?.conf ? { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? { ...p, drawings: mergedDrawings || p.drawings, conf: nextConf || p.conf } : p) } : state.data,
          _deletedDrawingIds: nextDeletedDrawingIds,
          _dirtyConf: nextDirtyConf,
          _dirtyConfKeys: nextConfKeys,
          _dirtyConfBase: nextConfBase,
          _dirtyTracker: nextDirtyTrackerDrawingIds.size > 0,
          _dirtyTrackerDrawingIds: nextDirtyTrackerDrawingIds,
        };
      });
      // The PATCH created the project row on the server: from now on a 404 means it was deleted.
      if (get().data.projects.find(p => p.id === projectId)?.localOnly)
        set(state => ({ data: { ...state.data, projects: state.data.projects.map(p => {
          if (p.id !== projectId) return p;
          const { localOnly: _localOnly, ...rest } = p;
          return rest;
        }) } }));
      if(!get().hasUnsavedChanges())editSnapshots.get(get)?.delete(projectId);
      set(current=>{const pendingSaves={...current.pendingSaves};delete pendingSaves[projectId];return{pendingSaves};});
      status(unverifiedIds.size ? {phase:'unconfirmed',failure:'network',reason:'Read-back mismatch; pending sync retained',attempts:1,lastSuccess:previousStatus?.lastSuccess,retryAt:Date.now()+retryDelay(1)} : {phase:'saved',lastSuccess:Date.now(),attempts:0});
      return unverifiedIds.size === 0;
    }
    catch (err: any) {
      const failure=saveFailure(err),attempts=(previousStatus?.attempts || 0)+1;
      status({phase:'failed',lastSuccess:previousStatus?.lastSuccess,attempts,failure,reason:failureText(failure)+(err instanceof ApiError?' (HTTP '+err.status+')':''),...(retryable(failure)?{retryAt:Date.now()+retryDelay(attempts)}:{})});
      if(!retryable(failure) && failure!=='login' && failure!=='oversize')set(current=>{const pendingSaves={...current.pendingSaves};delete pendingSaves[projectId];return{pendingSaves};});
      if (err instanceof ApiError && err.status === 409 && (err.data?.code === 'DRAWING_CONFLICT' || err.data?.code === 'CONFIG_CONFLICT') && Array.isArray(err.data.conflicts)) {
        // 整批没有写入。冲突字段换成服务端最新值并放弃本地修改，其余未冲突的修改保留，下次自动保存再发
        const conflicts = err.data.conflicts as DrawingConflict[];
        const confConflicts = (Array.isArray(err.data.confConflicts) ? err.data.confConflicts : []) as ConfigConflict[];
        const message = conflicts.length && confConflicts.length
          ? describeDrawingConflicts(conflicts) + ' Also, ' + describeConfigConflicts(confConflicts) + ' changed by someone else first and now show the latest values.'
          : conflicts.length ? describeDrawingConflicts(conflicts)
          : 'Save conflict: ' + describeConfigConflicts(confConflicts) + ' changed by someone else first and now show the latest values. Your other edits will be sent with the next auto-save.';
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
          const currentConf = state.data.projects.find(p => p.id === projectId)?.conf;
          const conf = confConflicts.length && currentConf ? applyConfigConflicts(currentConf, confConflicts, state._dirtyConfKeys, state._dirtyConfBase) : null;
          return {
            error: message,
            saveConflict: { message, drawingIds: conflicts.map(c => c.id), at: Date.now() },
            _dirtyDrawingIds: nextDirtyDrawingIds,
            _dirtyDrawingFields: nextFields,
            _dirtyDrawingBase: nextBase,
            ...(conf ? { _dirtyConfKeys: conf.keys, _dirtyConfBase: conf.base, _dirtyConf: conf.keys.size > 0 } : {}),
            data: { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? { ...p, drawings, ...(conf ? { conf: conf.conf } : {}) } : p) },
          };
        });
        // 载入别人的其他改动（不覆盖仍在编辑的字段）
        void get().refreshProjectPreservingDirty(projectId).catch(e => console.warn('[Save] Refresh after conflict failed', e));
        if(get().hasUnsavedChanges())status({phase:'failed',failure:'conflict',reason:failureText('conflict'),attempts:0,lastSuccess:previousStatus?.lastSuccess,retryAt:Date.now()+3000});
        return false;
      }
      if (get().session?.mode === 'kjx' && err instanceof ApiError && err.status === 403) {
        const message = 'You do not have permission. Unsaved changes were rolled back.';
        let restored=editSnapshots.get(get)?.get(projectId);
        let tracker=reviewTracker;
        try { restored=await withSaveTimeout(signal=>projectsApi.loadProject(project,undefined,signal)); tracker=await withSaveTimeout(signal=>projectsApi.loadReviewTracker(projectId,signal)); } catch { /* The pre-edit copy also works offline or after access revocation. */ }
        if(!restored){
          restored=structuredClone(project);
          for(const drawing of restored.drawings)for(const [field,value]of Object.entries(_dirtyDrawingBase[drawing.id]?.values || {}))(drawing as any)[field]=value;
          for(const [key,value]of Object.entries(_dirtyConfBase))(restored.conf as any)[key]=value;
          restored.drawings=restored.drawings.filter(d=>!!d.rev);
        }
        const rollback=restored;
        set(current=>({data:{...current.data,projects:current.data.projects.map(p=>p.id===projectId?rollback:p)},
          ...(current.activeProjectId===projectId ? {reviewTracker:tracker,_dirtyDrawingIds:new Set<string>(),_dirtyDrawingFields:{},_dirtyDrawingBase:{},_deletedDrawingIds:new Set<string>(),_dirtyConf:false,_dirtyConfKeys:new Set<keyof ProjectConfig>(),_dirtyConfBase:{},_dirtyTracker:false,_dirtyTrackerDrawingIds:new Set<string>()} : {}),
          error:message,projectNotice:{message,projectId,at:Date.now()}}));
        editSnapshots.get(get)?.delete(projectId);
        return false;
      }
      console.error("Push failed", err);
      set({ error: err.message });
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
        const visibleIds = new Set(remoteProjects.map(project=>project.id));
        const currentProjects = state.session?.mode === 'kjx' ? state.data.projects.filter(project=>visibleIds.has(project.id)) : state.data.projects;
        const mergedProjects = [...currentProjects];
        remoteProjects.forEach(rp => {
          // 按 ID 合并，避免同名项目污染
          const existingIndex = mergedProjects.findIndex(p => p.id === rp.id);
          if (existingIndex > -1) {
            mergedProjects[existingIndex] = { ...mergedProjects[existingIndex], name: rp.name, storagePath: rp.storagePath, passwordProtected: rp.passwordProtected, conf: { ...mergedProjects[existingIndex].conf, passwordSet: rp.passwordProtected } };
          }
          else {
            mergedProjects.push({
              id: rp.id,
              name: rp.name,
              storagePath: rp.storagePath,
              passwordProtected: rp.passwordProtected,
              drawings: [],
              conf: {
                passwordSet: rp.passwordProtected,
                reviewers: state.data.settings.reviewers,
                disciplineDefaults: state.data.settings.disciplineDefaults,
                holidays: state.data.settings.holidays,
                roundACycle: state.data.settings.roundACycle,
                otherRoundsCycle: state.data.settings.otherRoundsCycle
              }
            });
          }
        });
        const revoked=state.session?.mode==='kjx' ? state.data.projects.filter(project=>!visibleIds.has(project.id)) : [];
        const membershipRecovery={...state.membershipRecovery};
        for(const project of revoked)membershipRecovery[project.id]={project,tracker:state.reviewTracker};
        return {
          membershipRecovery,
          ...(state.session?.mode==='kjx' && state.activeProjectId && !visibleIds.has(state.activeProjectId) ? {activeProjectId:null} : {}),
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
  loadProject: async (projectId: string, _legacyPassword?: string, signal?: AbortSignal) => {
    const state=get();
    if(state.session?.mode==='kjx' && state.activeProjectId && state.activeProjectId!==projectId && state.hasUnsavedChanges()){const saved=await state.saveProject(state.activeProjectId,{manual:true});if(!saved || get().hasUnsavedChanges())throw new Error('Switch blocked: current workspace has unsaved changes. Retry saving before switching.');}
    const { data } = get();
    const projectStub = data.projects.find(p => p.id === projectId);
    if (!projectStub)
      return;
    set({ isLoading: true });
    try {
      // 404 means the project was deleted on the server -> ProjectNotFoundError and a notice. The exception is a project
      // just made with "New project" whose first save has not reached the server yet (localOnly): open the local
      // copy, as before, so creating a project keeps working.
      const remote = await projectsApi.loadProject(projectStub, undefined, signal)
        .catch(err => { if (isProjectNotFound(err) && isLocalOnlyProject(projectStub)) return projectStub; throw err; });
      signal?.throwIfAborted();
      const fullProject = normalizeProjectDrawingIds(remote, generateId);
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
      // Re-unlocking the current project is a refresh, not a project switch. Session expiry
      // must not discard edits made before the hall's password challenge appeared.
      const current = get();
      if (current.activeProjectId === projectId && current.hasUnsavedChanges()) {
        set(state => {
          const local = state.data.projects.find(p => p.id === projectId);
          if (!local || state.activeProjectId !== projectId) return state;
          const merged = mergeProjectPreservingDirty(local, fullProject, state._dirtyDrawingIds,
            state._deletedDrawingIds, state._dirtyConfKeys.size ? state._dirtyConfKeys : state._dirtyConf,
            state.reviewTracker, state.reviewTracker, state._dirtyTrackerDrawingIds, state._dirtyTracker,
            state._dirtyDrawingFields);
          return { data: { ...state.data, projects: state.data.projects.map(p => p.id === projectId ? merged.project : p) },
            reviewTracker: merged.reviewTracker, isLoading: false };
        });
        void get().refreshAdminPresence(projectId);
        return;
      }
      set(state => ({
        data: {
          ...state.data,
          projects: state.data.projects.map(p => p.id === projectId
            ? { ...fullProject, id: projectId }
            : stripProjectPayload(p, false))
        },
        activeProjectId: projectId,
        trackerWrites: state.session?.mode==='kjx'?state.trackerWrites:Object.fromEntries(Object.entries(state.trackerWrites).filter(([,intent])=>intent.projectId===projectId)),
        isLoading: false,
        _dirtyDrawingIds: new Set<string>(),
        _dirtyDrawingFields: {},
        _dirtyDrawingBase: {},
        _deletedDrawingIds: new Set<string>(),
        _dirtyConf: false,
        _dirtyConfKeys: new Set<keyof ProjectConfig>(),
        _dirtyConfBase: {},
        _dirtyTracker: false,
        _dirtyTrackerDrawingIds: new Set<string>(),
      }));
      // Presence is non-blocking and owned by its slice.
      void get().refreshAdminPresence(projectId);
    }
    catch (err: any) {
      set({ isLoading: false, error: signal?.aborted ? null : err.message,
        ...(isProjectNotFound(err) ? { projectNotice: { message: projectNotFoundMessage(projectStub.name, false), projectId, at: Date.now() } } : {}) });
      throw err;
    }
  },
  testConnection: async () => projectsApi.testConnection(),
  updateProjectConfig: (projectId, updates) => set((state) => {
    if(!allowedEdit(state,'project.settings'))return state;
    rememberProject(get,state,projectId);
    // Passwords have a separate write-only settings flow; never put a draft in the persisted store.
    updates = withoutProjectSecrets(updates);
    const shouldRecalculateDeadlines = updates.holidays !== undefined ||
      updates.roundACycle !== undefined ||
      updates.otherRoundsCycle !== undefined;
    const newDirty = new Set(state._dirtyDrawingIds);
    // 记下真正改动的设置项和它们开始修改时的值，保存时只发这些项
    const currentConf = state.data.projects.find(p => p.id === projectId)?.conf || state.data.settings;
    const edit = recordConfigEdit(currentConf, updates, state._dirtyConfKeys, state._dirtyConfBase);
    return {
      _dirtyConf: state._dirtyConf || edit.keys.size > 0,
      _dirtyConfKeys: edit.keys,
      _dirtyConfBase: edit.base,
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
    if(state.session?.mode==='kjx')return state;
    const restoredProject = withoutProjectSecrets(project);
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
      // 从备份恢复：所有设置项都发，不带旧值，按备份内容直接写入
      _dirtyConfKeys: new Set(Object.keys(restoredProject.conf || {}).filter(k => k !== 'lastUpdated') as (keyof ProjectConfig)[]),
      _dirtyConfBase: {},
      _dirtyTracker: true,
      _dirtyTrackerDrawingIds: newDirtyTrackerIds,
      data: {
        ...state.data,
        projects: [...state.data.projects.filter(p => p.name !== project.name), restoredProject]
      }
    };
  }),
  toggleRemarkStatus: (drawingId, remarkId) => set((state) => {
    if(!allowedEdit(state,'drawing.update'))return state;
    rememberProject(get,state,state.activeProjectId);
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
  loadAuditLog: async (projectId: string, fromISO: string, toISO: string, cursor?: string): Promise<AuditLogResult> => {
    const { data } = get();
    const project = data.projects.find(p => p.id === projectId);
    if (!project)
      return { entries: [], truncated: false, error: 'Project not found locally' };
    try {
      const page = await projectsApi.loadAuditLog(project.id, fromISO, toISO, undefined, cursor);
      return { entries: page?.entries || [], truncated: Boolean(page?.truncated), nextCursor: page?.nextCursor };
    }
    catch (err: any) {
      return { entries: [], truncated: false, error: err?.message || 'Audit log request failed' };
    }
  }
});
};
