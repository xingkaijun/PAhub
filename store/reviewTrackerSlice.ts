import type { Project, ReviewTrackerData } from '../types';
import { isProjectNotFound, projectsApi } from '../services/api/projectsApi';
import { mergeReviewTracker, clearReviewTracker, verifySentState, type SentDrawingExpectation, type SendVerification } from '../lib/review-tracker';
import type { ReviewTrackerSlice, SliceCreator } from './types';
// Project whose tracker this page has loaded once (see loadReviewTracker).
let trackerLoadedFor: string | null = null;

export const createReviewTrackerSlice: SliceCreator<ReviewTrackerSlice> = (set, get) => ({
  reviewTracker: {},
  loadReviewTracker: async (projectId: string, force = false) => {
    // In the hub build the project's live stream keeps the tracker current after the first load, so a tab
    // mounting (Inventory <-> Tracker) does not need to read it again; the Refresh button passes force.
    if (!force && import.meta.env.MODE === 'hub' && trackerLoadedFor === projectId)
      return;
    const project = get().data.projects.find(p => p.id === projectId);
    if (!project)
      return;
    try {
      const remote = await projectsApi.loadReviewTracker(project.id);
      const { reviewTracker: localTracker, _dirtyTrackerDrawingIds } = get();
      const merged = mergeReviewTracker(localTracker, remote || {}, _dirtyTrackerDrawingIds);
      set({ reviewTracker: merged });
      trackerLoadedFor = projectId;
    }
    catch (e) {
      console.warn('loadReviewTracker failed', e);
    }
  },
  toggleAssigneeDone: (drawingId: string, assignee: string) => {
    const session=get().session;
    if(session?.mode==='kjx') {
      const drawing=get().data.projects.find(p=>p.id===get().activeProjectId)?.drawings.find(d=>d.id===drawingId);
      const elevated=session.user?.role==='admin'||session.user?.role==='manager';
      if(!drawing || (assignee!=='__approved__' && !drawing.assignees.includes(assignee)) || (!elevated && (session.user?.role!=='reviewer'||session.user.id!==assignee))) return;
    }
    const current = get().reviewTracker[drawingId]?.[assignee];
    const newDone = !current?.done;
    const doneAt = newDone ? new Date().toISOString() : undefined;
    if(session?.mode==='kjx') {
      const projectId=get().activeProjectId;if(!projectId)return;
      void projectsApi.saveReviewTracker(projectId,{[drawingId]:{[assignee]:{done:newDone,doneAt}}}).then(()=>{
        set(state=>({reviewTracker:{...state.reviewTracker,[drawingId]:{...(state.reviewTracker[drawingId]||{}),[assignee]:{done:newDone,doneAt}}}}));
      }).catch(error=>set({error:'Tracker save failed: '+String(error)}));
      return;
    }
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
        projectsApi.saveReviewTracker(project.id, singleUpdate)
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
  clearTrackerForDrawings: (drawingIds: string[]) => {
    if (!drawingIds || drawingIds.length === 0)
      return;
    set(state => {
      const cleared = clearReviewTracker(state.reviewTracker, drawingIds);
      if (!cleared.changedIds.length)
        return state;
      const nextDirtyIds = new Set(state._dirtyTrackerDrawingIds);
      cleared.changedIds.forEach(id => nextDirtyIds.add(id));
      return {
        reviewTracker: cleared.tracker,
        _dirtyTracker: true,
        _dirtyTrackerDrawingIds: nextDirtyIds,
      };
    });
  },
  verifySentDrawings: async (projectId: string, expected: SentDrawingExpectation[]) => {
    const empty: SendVerification = { ok: true, mismatchedDrawings: [], mismatchedTracker: [] };
    if (!expected || expected.length === 0)
      return empty;
    const { data } = get();
    const project = data.projects.find(p => p.id === projectId);
    if (!project)
      return { ...empty, ok: false, error: 'Project not found locally' };
    let remoteProject: Project;
    let remoteTracker: ReviewTrackerData;
    try {
      [remoteProject, remoteTracker] = await Promise.all([
        projectsApi.loadProject(project),
        projectsApi.loadReviewTracker(project.id),
      ]);
    }
    catch (err: any) {
      // loadProject 在服务器 404 时抛 ProjectNotFoundError
      if (isProjectNotFound(err))
        return { ...empty, ok: false, error: 'Project missing on server' };
      // 回读失败只说明"无法确认"，写入本身可能是成功的
      return { ...empty, ok: false, error: err?.message || 'Read-back request failed' };
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
  _dirtyTracker: false,
  _dirtyTrackerDrawingIds: new Set<string>()
});
