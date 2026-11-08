import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_TIME_ZONE,
  calculateDeadline,
  normalizeHolidays,
  projectDateKey,
  projectMidnight,
  reviewCycleDays,
} from '../../lib/deadline.ts';
import { nextRoundLabel, roundToLetters } from '../../lib/rounds.ts';
import { historyDay } from '../src/pcf-history.ts';

const originalTZ = process.env.TZ;
function withTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
}

function isoAt(dayKey: string, time: string) {
  return new Date(`${dayKey}T${time}+08:00`).toISOString();
}

test('project time zone is Asia/Shanghai and independent of the host zone', () => {
  assert.equal(PROJECT_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(projectDateKey('2026-11-09T00:30:00+08:00'), '2026-11-09');
  assert.equal(projectDateKey('2026-11-08T16:30:00Z'), '2026-11-09');
  assert.equal(projectDateKey('2026-11-09T15:59:59Z'), '2026-11-09');
  assert.equal(projectDateKey('2026-11-09T16:00:00Z'), '2026-11-10');
});

test('deadline is project midnight so toISOString stays stable on every host zone', () => {
  const expected = '2026-11-09T16:00:00.000Z';
  assert.equal(projectMidnight('2026-11-10').toISOString(), expected);
  for (const timeZone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Shanghai']) {
    withTimeZone(timeZone, () => {
      assert.equal(projectMidnight('2026-11-10').toISOString(), expected, timeZone);
      assert.equal(calculateDeadline('2026-11-09T00:30:00+08:00', 1).toISOString(), expected, timeZone);
    });
  }
});

test('weekend skipping starts after the project calendar day containing the start instant', () => {
  // Friday 2026-11-06 -> Monday 2026-11-09
  assert.equal(calculateDeadline(isoAt('2026-11-06', '10:00:00'), 1).toISOString(), '2026-11-08T16:00:00.000Z');
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-06', '10:00:00'), 1)), '2026-11-09');
  // A full Friday week: Mon 2026-11-02 + 5 working days -> Mon 2026-11-09.
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-02', '09:00:00'), 5)), '2026-11-09');
  // Starting on Saturday: Sunday is skipped, so 1 working day lands on Monday.
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-07', '12:00:00'), 1)), '2026-11-09');
  // Starting on Sunday: Monday is the first working day.
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-08', '12:00:00'), 1)), '2026-11-09');
  // The start day itself is never counted.
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-09', '08:00:00'), 1)), '2026-11-10');
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-09', '08:00:00'), 0)), '2026-11-09');
});

test('Beijing 00:00-08:00 uses the new project day regardless of server time zone', () => {
  const start = '2026-11-09T00:30:00+08:00';
  const expectedDate = '2026-11-09T16:00:00.000Z';
  for (const timeZone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    withTimeZone(timeZone, () => {
      const startDate = new Date(start);
      const previous = projectDateKey(new Date(startDate.getTime() - 24 * 60 * 60 * 1000));
      // In UTC/LA-like host zones the naive implementation sees Sunday and would pick 11-10.
      if (['UTC', 'America/Los_Angeles'].includes(timeZone)) assert.equal(startDate.getDay(), 0, timeZone);
      assert.equal(previous, '2026-11-08', timeZone);
      assert.equal(projectDateKey(startDate), '2026-11-09', timeZone);
      assert.equal(calculateDeadline(startDate, 1).toISOString(), expectedDate, timeZone);
      assert.equal(historyDay(start), '2026-11-09', timeZone);
    });
  }
  assert.equal(projectDateKey(start), '2026-11-09');
});

test('holidays accept date-only and ISO values including the UTC offset crossing the project day', () => {
  // Date-only holiday (input[type=date]).
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-09', '00:30:00'), 1, ['2026-11-10'])), '2026-11-11');
  // Z timestamp at 2026-11-09T16:00Z is 2026-11-10 in Shanghai.
  assert.deepEqual([...normalizeHolidays(['2026-11-09T16:00:00.000Z'])], ['2026-11-10']);
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-09', '00:30:00'), 1, ['2026-11-09T16:00:00.000Z'])), '2026-11-11');
  // Z timestamp before Shanghai midnight stays on the same project day.
  assert.deepEqual([...normalizeHolidays(['2026-11-10T15:59:59.000Z'])], ['2026-11-10']);
  // Explicit +08:00 offset.
  assert.deepEqual([...normalizeHolidays(['2026-11-10T00:00:00+08:00'])], ['2026-11-10']);
  // Zoneless local timestamp and date-only values keep their literal date.
  assert.deepEqual([...normalizeHolidays(['2026-11-10T00:00:00', '2026-11-11', '', null as any])], ['2026-11-10', '2026-11-11']);
  // Two holidays in a row stretch the deadline further.
  assert.equal(projectDateKey(calculateDeadline(isoAt('2026-11-09', '00:30:00'), 2, ['2026-11-10', '2026-11-11T00:00:00.000Z'])), '2026-11-13');
});

test('review cycle days follow round A vs later rounds', () => {
  assert.equal(reviewCycleDays('A', {}), 14);
  assert.equal(reviewCycleDays('B', {}), 7);
  assert.equal(reviewCycleDays('A', { roundACycle: 10, otherRoundsCycle: 5 }), 10);
  assert.equal(reviewCycleDays('AB', { roundACycle: 10, otherRoundsCycle: 5 }), 5);
  assert.equal(reviewCycleDays(undefined, { roundACycle: 0, otherRoundsCycle: -1 }), 14);
});

test('lib rounds turn Z into AA and AA into AB', () => {
  assert.deepEqual([1, 2, 26, 27, 28].map(roundToLetters), ['A', 'B', 'Z', 'AA', 'AB']);
  assert.equal(nextRoundLabel('Z'), 'AA');
  assert.equal(nextRoundLabel('AA'), 'AB');
  assert.equal(nextRoundLabel('AZ'), 'BA');
});
