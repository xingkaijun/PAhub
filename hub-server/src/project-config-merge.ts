import type { DatabaseSync } from 'node:sqlite';
import { getProjectConfiguration } from './project-read.ts';

export type RecordValue = Record<string, any>;
// One configuration key (or one entry of a map key) that someone else changed meanwhile.
export type ConfigConflict = { key: string; entry?: string; current: unknown };

// Settings stored as their own row (project_settings); the conflict check covers exactly these.
const SCALAR_KEYS = ['displayName', 'password', 'holidays', 'roundACycle', 'otherRoundsCycle', 'autoSyncInterval', 'projectSummary'];
// Maps stored one row per discipline: merged entry by entry, so two people editing different disciplines both keep their change.
const MAP_KEYS = ['disciplineDefaults', 'defaultAssignees'];
const NUMBER_DEFAULTS: Record<string, number | null> = { roundACycle: 10, otherRoundsCycle: 5, autoSyncInterval: null };

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable((value as RecordValue)[k])).join(',') + '}';
  return JSON.stringify(value ?? null);
}

// Same shape the read API returns, so a value the client loaded compares equal to what is stored.
export function normalizeConfigValue(key: string, value: unknown): unknown {
  if (key in NUMBER_DEFAULTS) {
    if (value === undefined || value === null || value === '') return NUMBER_DEFAULTS[key];
    const parsed = parseInt(String(value), 10); return Number.isFinite(parsed) ? parsed : 0;
  }
  if (key === 'holidays') return Array.isArray(value) ? value : [];
  if (key === 'displayName' || key === 'password') return value === undefined || value === null || value === '' ? null : String(value);
  if (key === 'projectSummary') return value || null;
  if (key === 'disciplineDefaults') return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([, reviewer]) => reviewer).map(([d, reviewer]) => [d, String(reviewer)]));
  if (key === 'defaultAssignees') return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([, list]) => Array.isArray(list) && list.length).map(([d, list]) => [d, (list as unknown[]).map(String).sort()])); // stored rows have no order
  return value ?? null;
}

const same = (key: string, a: unknown, b: unknown) => stable(normalizeConfigValue(key, a)) === stable(normalizeConfigValue(key, b));

// Three-way check of a key-level configuration patch.
// conf holds only the keys the client changed; base holds the values those keys had when the client started editing.
// A key without a base value (legacy client, restore, never-loaded project) is written as sent.
// A key is accepted when the stored value still equals the base, or already equals the new value.
// Map keys are checked per discipline and merged onto the stored map.
// Returns the configuration to write, or the conflicts (nothing is written then).
export function mergeConfiguration(db: DatabaseSync, projectId: string, conf: RecordValue, base: RecordValue | undefined): { conf: RecordValue; conflicts: ConfigConflict[] } {
  if (!base || typeof base !== 'object') return { conf, conflicts: [] };
  const current = getProjectConfiguration(db, projectId) as RecordValue;
  const conflicts: ConfigConflict[] = [];
  const result: RecordValue = { ...conf };
  for (const key of SCALAR_KEYS) {
    if (!(key in conf) || !(key in base)) continue;
    if (!same(key, current[key], base[key]) && !same(key, current[key], conf[key])) conflicts.push({ key, current: current[key] });
  }
  for (const key of MAP_KEYS) {
    if (!(key in conf) || !(key in base) || !conf[key] || typeof conf[key] !== 'object') continue;
    const before = normalizeConfigValue(key, base[key]) as RecordValue;
    const after = normalizeConfigValue(key, conf[key]) as RecordValue;
    const stored = normalizeConfigValue(key, current[key]) as RecordValue;
    const merged: RecordValue = { ...stored };
    for (const entry of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (stable(before[entry]) === stable(after[entry])) continue; // this client did not touch the entry
      if (stable(stored[entry]) !== stable(before[entry]) && stable(stored[entry]) !== stable(after[entry])) { conflicts.push({ key, entry, current: current[key] }); continue; }
      if (after[entry] === undefined) delete merged[entry]; else merged[entry] = after[entry];
    }
    result[key] = merged;
  }
  return { conf: result, conflicts };
}
