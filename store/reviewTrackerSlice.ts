import {withSaveTimeout} from '../lib/save-control';
import type { Project, ReviewTrackerData } from '../types';
import { isProjectNotFound, projectsApi } from '../services/api/projectsApi';
import { mergeReviewTracker, clearReviewTracker, verifySentState, type SentDrawingExpectation, type SendVerification } from '../lib/review-tracker';
import type { ReviewTrackerSlice, SliceCreator } from './types';
// Project whose tracker this page has loaded once (see loadReviewTracker).
let trackerLoadedFor: string | null = null;

export const createReviewTrackerSlice: SliceCreator<ReviewTrackerSlice> = (set, get) => ({
  trackerWrites: {},
  retryTrackerWrite: async (key: string) => {
    const intent = get().trackerWrites[key];
    if (!intent || intent.phase === 'saving') return false;
    const session = get().session;
    if (intent.actorId && intent.actorId !== session?.user?.id) return false;
    const update = (phase: 'saving' | 'failed', reason?: string) => set(state => ({trackerWrites:{...state.trackerWrites,[key]:{...intent,phase,reason}}}));
    update('saving');
    let writeError: unknown;
    try { await withSaveTimeout(signal => projectsApi.saveReviewTracker(intent.projectId, {[intent.drawingId]:{[intent.assignee]:{done:intent.done,doneAt:intent.doneAt}}}, signal)); }
    catch (error) { writeError = error; }
    // The PUT may have committed even when its response was lost. A fresh read is authoritative.
    try {
      const remote = await withSaveTimeout(signal => projectsApi.loadReviewTracker(intent.projectId, signal));
      const mark = remote[intent.drawingId]?.[intent.assignee];
      if (!!mark?.done !== intent.done) throw Error('Read-back does not confirm the requested mark');
      set(state => {
        const trackerWrites = {...state.trackerWrites}; delete trackerWrites[key];
        return {trackerWrites, ...(state.activeProjectId === intent.projectId ? {reviewTracker:{...state.reviewTracker,[intent.drawingId]:{...state.reviewTracker[intent.drawingId],[intent.assignee]:mark || {done:false}}}} : {})};
      });
      return true;
    } catch (error) { update('failed', 'Awaiting confirmation: '+String(writeError || error)); return false; }
  },
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
    const projectId=get().activeProjectId;if(!projectId)return;
    const key=JSON.stringify([projectId,drawingId,assignee]);
    if(get().trackerWrites[key])return;
    set(state=>({trackerWrites:{...state.trackerWrites,[key]:{projectId,drawingId,assignee,done:newDone,doneAt,actorId:session?.user?.id,phase:'failed'}}}));
    void get().retryTrackerWrite(key);
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
      set(state=>({_dirtyDrawingIds:new Set([...state._dirtyDrawingIds,...expected.map(item=>item.id)]),_dirtyTracker:true,_dirtyTrackerDrawingIds:new Set([...state._dirtyTrackerDrawingIds,...expected.map(item=>item.id)])}));
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
