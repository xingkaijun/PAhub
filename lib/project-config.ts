import type { ConfigConflict, ProjectConfig } from '../types';

// Per dirty settings key: the value it had when local editing started. A dirty key without an entry
// (restore from backup) is sent without a base and written as is.
export type DirtyConfBase = Partial<Record<keyof ProjectConfig, unknown>>;
// Server merges these per discipline and returns the merged map, which the client then adopts.
export const MERGED_MAP_KEYS: (keyof ProjectConfig)[] = ['disciplineDefaults', 'defaultAssignees'];

const clone = (value: unknown) => value === undefined ? null : JSON.parse(JSON.stringify(value));
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Marks the keys an update really changes; the first recorded pre-edit value wins until it is saved.
export function recordConfigEdit(conf: Partial<ProjectConfig>, updates: Partial<ProjectConfig>, keys: Set<keyof ProjectConfig>, base: DirtyConfBase) {
  const nextKeys = new Set(keys);
  const nextBase: DirtyConfBase = { ...base };
  for (const key of Object.keys(updates) as (keyof ProjectConfig)[]) {
    if (sameValue(conf[key], updates[key])) continue;
    if (!nextKeys.has(key)) nextBase[key] = clone(conf[key]);
    nextKeys.add(key);
  }
  return { keys: nextKeys, base: nextBase };
}

// PATCH body part for settings: only the changed keys, plus their pre-edit values.
export function buildConfigPatch(conf: Partial<ProjectConfig>, keys: Set<keyof ProjectConfig>, base: DirtyConfBase) {
  const patch: Partial<ProjectConfig> = {};
  const values: DirtyConfBase = {};
  for (const key of keys) {
    (patch as any)[key] = conf[key] === undefined ? null : conf[key];
    if (key in base) values[key] = base[key];
  }
  return { conf: patch, confBase: Object.keys(values).length ? values : undefined };
}

// After a 409: every conflicting key (or discipline of a map key) takes the server value, and its base
// becomes the server value, so a remaining local change on other disciplines is re-sent cleanly.
export function applyConfigConflicts(conf: ProjectConfig, conflicts: ConfigConflict[], keys: Set<keyof ProjectConfig>, base: DirtyConfBase) {
  const nextConf: ProjectConfig = { ...conf };
  const nextKeys = new Set(keys);
  const nextBase: DirtyConfBase = { ...base };
  for (const conflict of conflicts) {
    const key = conflict.key as keyof ProjectConfig;
    if (conflict.entry !== undefined && MERGED_MAP_KEYS.includes(key)) {
      const map = { ...((nextConf[key] as Record<string, unknown>) || {}) };
      const server = (conflict.current as Record<string, unknown>) || {};
      if (server[conflict.entry] === undefined) delete map[conflict.entry]; else map[conflict.entry] = clone(server[conflict.entry]);
      (nextConf as any)[key] = map;
    } else (nextConf as any)[key] = clone(conflict.current);
    nextBase[key] = clone(conflict.current);
    if (sameValue(nextConf[key], conflict.current)) { nextKeys.delete(key); delete nextBase[key]; }
  }
  return { conf: nextConf, keys: nextKeys, base: nextBase };
}

const CONFIG_LABELS: Record<string, string> = {
  displayName: '显示名称', password: '项目密码', holidays: '节假日', roundACycle: 'A 轮周期', otherRoundsCycle: '其他轮周期',
  autoSyncInterval: '自动同步间隔', projectSummary: '项目概况', disciplineDefaults: '专业默认审图人', defaultAssignees: '专业默认分配',
};

export const describeConfigConflicts = (conflicts: ConfigConflict[]): string =>
  '项目设置（' + [...new Set(conflicts.map(c => (CONFIG_LABELS[c.key] || c.key) + (c.entry ? ' · ' + c.entry : '')))].join('、') + '）';
