import type { Project, ReviewTrackerData } from '../types';
import { appRepository } from '../services/data/AppRepository';
import { mergeReviewTracker, clearReviewTracker, verifySentState, type SentDrawingExpectation, type SendVerification } from '../lib/review-tracker';
import type { ReviewTrackerSlice, SliceCreator } from './types';
export const createReviewTrackerSlice: SliceCreator<ReviewTrackerSlice> = (set, get) => ({
  reviewTracker: {},
  loadReviewTracker: async (projectId: string) => {
    const { data, reviewTracker: localTracker, _dirtyTrackerDrawingIds } = get();
    const project = data.projects.find(p => p.id === projectId);
    if (!project)
      return;
    try {
      const remote = await appRepository.loadReviewTracker(data.settings, project);
      const merged = mergeReviewTracker(localTracker, remote || {}, _dirtyTrackerDrawingIds);
      set({ reviewTracker: merged });
    }
    catch (e) {
      console.warn('loadReviewTracker failed', e);
    }
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
        appRepository.loadProject(data.settings, project, project.conf?.password),
        appRepository.loadReviewTracker(data.settings, project),
      ]);
    }
    catch (err: any) {
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
  _dirtyTracker: false,
  _dirtyTrackerDrawingIds: new Set<string>()
});
