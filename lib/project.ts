import type { Drawing, Project, Remark, ProjectConfig } from '../types';
import { calculateDeadline, reviewCycleDays } from './deadline';

export const ensureDrawingHasId = (drawing: Drawing, createId: () => string): Drawing => {
  if (drawing.id && String(drawing.id).trim() !== '') return drawing;
  return { ...drawing, id: createId() };
};

// statusHistory 必须按时间升序排列（旧→新）：全站多处逻辑（Wait days、Last Change 等）
// 依赖 statusHistory[length - 1] 为最新记录，而后端视图返回顺序不保证有序
export const sortHistoryAsc = (history: Remark[] | undefined): Remark[] =>
  [...(history || [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

// Legacy caches/imports may contain plaintext credentials. Public status/version flags are safe,
// but password drafts and hash/salt fields must never survive hydration, backup or persistence.
export function withoutProjectSecrets<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const children = value.map(withoutProjectSecrets);
    return children.every((child, index) => child === value[index]) ? value : children as T;
  }
  let changed = false;
  const entries = Object.entries(value).flatMap(([key, child]) => {
    if (/password/i.test(key) && !['passwordSet', 'passwordVersion', 'passwordProtected'].includes(key)) {
      changed = true; return [];
    }
    const safe = withoutProjectSecrets(child);
    if (safe !== child) changed = true;
    return [[key, safe]];
  });
  return changed ? Object.fromEntries(entries) as T : value;
}

export const normalizeProjectDrawingIds = (project: Project, createId: () => string): Project => ({
  ...withoutProjectSecrets(project),
  drawings: (project.drawings || []).map(d => ({
    ...ensureDrawingHasId(d, createId),
    currentRound: d.currentRound || 'A',
    statusHistory: sortHistoryAsc(d.statusHistory)
  })),
});

export const stripProjectPayload = (project: Project, keepPayload: boolean): Project => {
  const safe = withoutProjectSecrets(project);
  if (keepPayload) return safe;
  return { ...safe, drawings: [] };
};

export const getReviewStartDate = (drawing: Drawing, at: Date) => {
  const statusHistory = drawing.statusHistory || [];
  const latestReviewingLog = [...statusHistory]
    .reverse()
    .find(log => log.content.includes('Status:') && log.content.includes('-> Reviewing'));
  const parsed = latestReviewingLog?.createdAt ? new Date(latestReviewingLog.createdAt) : new Date(at.getTime());
  return isNaN(parsed.getTime()) ? new Date(at.getTime()) : parsed;
};

export const recalculateReviewDeadline = (drawing: Drawing, conf: ProjectConfig, at: Date, startDate?: Date): Drawing => {
  if (drawing.status !== 'Reviewing') return drawing;
  const round = drawing.currentRound || 'A';
  const cycleDays = reviewCycleDays(round, conf);
  
  // 如果提供了明确的起始日期，使用它；否则从 statusHistory 中查找
  const effectiveStartDate = startDate || getReviewStartDate(drawing, at);
  
  return {
    ...drawing,
    reviewDeadline: calculateDeadline(effectiveStartDate, cycleDays, conf.holidays || []).toISOString(),
  };
};

