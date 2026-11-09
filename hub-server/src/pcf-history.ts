import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PCF_HISTORY_COALESCE_MS, PCF_HISTORY_RECENT_LIMIT, PCF_HISTORY_DAILY_DAYS, PCF_HISTORY_WEEKLY_DAYS } from './config.ts';
import { projectDateKey } from '../../lib/deadline.ts';

export function historyEntries(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(filename => {
    const match = filename.match(/^(\d+)-(\d+)-[a-f0-9-]+\.json$/);
    return match ? [{ rev: Number(match[1]), savedAt: new Date(Number(match[2])).toISOString(), filename }] : [];
  }).sort((a, b) => b.rev - a.rev);
}

export function historyDay(savedAt: string) { return projectDateKey(savedAt); }
// Retention, newest first (savedAt in the project time zone):
//  - the latest PCF_HISTORY_RECENT_LIMIT (50) snapshots are always kept;
//  - younger than PCF_HISTORY_DAILY_DAYS (30 days): the last snapshot of each calendar day;
//  - 30 to PCF_HISTORY_WEEKLY_DAYS (180 days) old: the last snapshot of each ISO week (Monday start);
//  - older than 180 days: the last snapshot of each calendar month.
// Age is measured from `now` (the save that triggers pruning). Buckets are evaluated per age
// band, so a week or month that straddles a band boundary may keep one snapshot on each side.
export function historyWeek(savedAt: string) {
  const [y, m, d] = projectDateKey(savedAt).split('-').map(Number), date = new Date(Date.UTC(y, m - 1, d));
  const weekday = (date.getUTCDay() + 6) % 7; date.setUTCDate(date.getUTCDate() - weekday + 3); // Thursday of this ISO week
  const isoYear = date.getUTCFullYear(), week = 1 + Math.floor((date.getTime() - Date.UTC(isoYear, 0, 1)) / (7 * 86400000));
  return isoYear + '-W' + String(week).padStart(2, '0');
}
export function historyMonth(savedAt: string) { return projectDateKey(savedAt).slice(0, 7); }
export function historyBucket(savedAt: string, now: number) {
  const age = now - Date.parse(savedAt);
  if (age < PCF_HISTORY_DAILY_DAYS * 86400000) return 'day:' + historyDay(savedAt);
  if (age < PCF_HISTORY_WEEKLY_DAYS * 86400000) return 'week:' + historyWeek(savedAt);
  return 'month:' + historyMonth(savedAt);
}
export function pruneHistory(directory: string, now = Date.now()) {
  const entries = historyEntries(directory).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || b.rev - a.rev);
  const keep = new Set(entries.slice(0, PCF_HISTORY_RECENT_LIMIT).map(entry => entry.filename));
  const buckets = new Set<string>();
  for (const entry of entries) {
    const bucket = historyBucket(entry.savedAt, now);
    if (!buckets.has(bucket)) { buckets.add(bucket); keep.add(entry.filename); }
  }
  for (const entry of entries) if (!keep.has(entry.filename)) {
    try { unlinkSync(path.join(directory, entry.filename)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Persist only editing-segment metadata, never bodies or receipts in SQLite.
type Segment = { filename: string; clientId: string; lastSavedAt: number; headRev: number };
export function prepareHistory(directory: string, oldRev: number, oldJSON: string, clientId: string, at: number, write: (file: string, content: string) => void) {
  const manifest = path.join(directory, '.retention.json');
  let previous: Segment | undefined;
  try { previous = JSON.parse(readFileSync(manifest, 'utf8')); } catch (error: any) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const validFilename = previous && /^(\d+)-(\d+)-[a-f0-9-]+\.json$/.test(previous.filename);
  const coalesce = !!clientId && previous?.clientId === clientId && previous.headRev === oldRev &&
    at >= previous.lastSavedAt && at - previous.lastSavedAt < PCF_HISTORY_COALESCE_MS &&
    validFilename && existsSync(path.join(directory, previous.filename));
  const filename = coalesce ? previous!.filename : oldRev + '-' + at + '-' + randomUUID() + '.json';
  // Keep the earliest pre-edit image throughout a continuous client segment,
  // so restore can always return to the state BEFORE that segment started.
  if (!coalesce) write(path.join(directory, filename), oldJSON);
  return {
    rollback() { if (!coalesce && existsSync(path.join(directory, filename))) unlinkSync(path.join(directory, filename)); },
    commit(headRev: number) {
      write(manifest, JSON.stringify({ filename, clientId, lastSavedAt: at, headRev } satisfies Segment));
      pruneHistory(directory, at);
    },
  };
}
