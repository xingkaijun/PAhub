import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PCF_HISTORY_COALESCE_MS, PCF_HISTORY_RECENT_LIMIT } from './config.ts';
import { projectDateKey } from '../../lib/deadline.ts';

export function historyEntries(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(filename => {
    const match = filename.match(/^(\d+)-(\d+)-[a-f0-9-]+\.json$/);
    return match ? [{ rev: Number(match[1]), savedAt: new Date(Number(match[2])).toISOString(), filename }] : [];
  }).sort((a, b) => b.rev - a.rev);
}

export function historyDay(savedAt: string) { return projectDateKey(savedAt); }
export function pruneHistory(directory: string) {
  const entries = historyEntries(directory).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || b.rev - a.rev);
  const keep = new Set(entries.slice(0, PCF_HISTORY_RECENT_LIMIT).map(entry => entry.filename));
  const days = new Set<string>();
  for (const entry of entries) {
    const day = historyDay(entry.savedAt);
    if (!days.has(day)) { days.add(day); keep.add(entry.filename); }
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
      pruneHistory(directory);
    },
  };
}
