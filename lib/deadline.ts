// Shared by the browser and the hub server. This module must not import Node-only APIs.
export const PROJECT_TIME_ZONE = 'Asia/Shanghai';

type DateInput = Date | string | number;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  return date;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function dayKeyFromUtcDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDayKey(dayKey: string) {
  const match = DAY_KEY.exec(dayKey);
  if (!match) throw new RangeError('Invalid calendar day: ' + dayKey);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function shiftDayKey(dayKey: string, days: number): string {
  const { year, month, day } = parseDayKey(dayKey);
  return dayKeyFromUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

function isWeekendDayKey(dayKey: string): boolean {
  const { year, month, day } = parseDayKey(dayKey);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Calendar date (YYYY-MM-DD) of an instant in the project time zone. */
export function projectDateKey(value: DateInput, timeZone = PROJECT_TIME_ZONE): string {
  const parts = zonedParts(toDate(value), timeZone);
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Project-zone midnight of a YYYY-MM-DD calendar day, independent of the host time zone. */
export function projectMidnight(dayKey: string, timeZone = PROJECT_TIME_ZONE): Date {
  const { year, month, day } = parseDayKey(dayKey);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  // Resolve the zone offset for this wall-clock time; two passes are normally enough.
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(guess), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = target - (represented - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/**
 * Holiday values may be date-only strings (YYYY-MM-DD, as used by input[type=date])
 * or ISO timestamps. Timestamps with an explicit offset are converted to a project
 * calendar date; date-only values and zoneless timestamps use their literal date.
 */
export function normalizeHolidays(holidays: readonly (string | null | undefined)[] = [], timeZone = PROJECT_TIME_ZONE): Set<string> {
  const result = new Set<string>();
  for (const raw of holidays) {
    if (!raw) continue;
    const value = String(raw).trim();
    const dateOnly = value.slice(0, 10);
    if (!DAY_KEY.test(dateOnly)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) result.add(projectDateKey(parsed, timeZone));
      continue;
    }
    if (value.length === 10) {
      result.add(value);
    } else if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) result.add(projectDateKey(parsed, timeZone));
    } else {
      result.add(dateOnly);
    }
  }
  return result;
}

/**
 * Add working days to the project calendar day containing `start`, skipping weekends
 * and holidays. The result is midnight of the deadline day in the project time zone.
 */
export function calculateDeadline(
  start: DateInput,
  workingDays: number,
  holidays: readonly (string | null | undefined)[] = [],
  timeZone = PROJECT_TIME_ZONE,
): Date {
  const startKey = projectDateKey(start, timeZone);
  const requested = Number(workingDays);
  const days = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0;
  if (days === 0) return projectMidnight(startKey, timeZone);

  const holidaySet = normalizeHolidays(holidays, timeZone);
  let dayKey = startKey;
  let counted = 0;
  let guard = 0;
  while (counted < days && guard++ < 3660) {
    dayKey = shiftDayKey(dayKey, 1);
    if (!isWeekendDayKey(dayKey) && !holidaySet.has(dayKey)) counted++;
  }
  return projectMidnight(dayKey, timeZone);
}

export type ReviewCycleConfig = { roundACycle?: number | null; otherRoundsCycle?: number | null };

/** Round A uses roundACycle (default 14); later rounds use otherRoundsCycle (default 7). */
export function reviewCycleDays(round: unknown, config: ReviewCycleConfig = {}): number {
  const firstRound = String(round || 'A').trim().toUpperCase() === 'A';
  const configured = Number(firstRound ? config.roundACycle : config.otherRoundsCycle);
  if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);
  return firstRound ? 14 : 7;
}
