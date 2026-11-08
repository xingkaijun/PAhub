import type { Drawing } from '../types';

export type DirtyDrawingFields = Record<string, Set<keyof Drawing>>;
export const PCF_MANAGED_FIELDS: (keyof Drawing)[] = ['manualCommentsCount', 'manualOpenCommentsCount', 'currentRound', 'version'];

export function changedDrawingFields(before: Drawing | undefined, after: Drawing): Set<keyof Drawing> {
  return new Set((Object.keys(after) as (keyof Drawing)[]).filter(field => field !== 'id' && field !== 'hasPcf' &&
    JSON.stringify(before?.[field]) !== JSON.stringify(after[field])));
}

export function drawingFieldPatch(drawing: Drawing, fields: Set<keyof Drawing>) {
  const changes: Partial<Drawing> = {};
  for (const field of fields) {
    if (field === 'id' || field === 'hasPcf' || field === 'currentRound' || (drawing.hasPcf && PCF_MANAGED_FIELDS.includes(field))) continue;
    (changes as any)[field] = drawing[field] === undefined ? null : drawing[field];
  }
  return { id: drawing.id, changes };
}
