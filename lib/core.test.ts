import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFormatDate, toValidDate } from './date';
import { changedDrawingFields, drawingFieldPatch } from './drawing-fields';
import { lettersToRound, nextRoundLabel, roundToLetters } from './rounds';
import type { Drawing } from '../types';

test('date helpers reject missing/invalid values and clone dates before formatting', () => {
  for (const value of [undefined, null, '', 'not-a-date']) assert.equal(toValidDate(value), null);
  const input = new Date('2026-11-09T12:00:00Z');
  const result = toValidDate(input)!;
  assert.notStrictEqual(result, input);
  assert.equal(result.getTime(), input.getTime());
  assert.equal(safeFormatDate('invalid', 'yyyy-MM-dd'), '—');
  assert.equal(safeFormatDate(null, 'yyyy-MM-dd', 'missing'), 'missing');
  assert.equal(safeFormatDate(new Date(2026, 10, 9), 'yyyy-MM-dd'), '2026-11-09');
});

test('round conversions cover rollover, lowercase labels and invalid values', () => {
  assert.equal(nextRoundLabel('Z'), 'AA');
  assert.equal(nextRoundLabel('AA'), 'AB');
  assert.equal(nextRoundLabel('az'), 'BA');
  assert.equal(roundToLetters(703), 'AAA');
  assert.equal(lettersToRound('AAA'), 703);
  assert.equal(lettersToRound('invalid'), 1);
  assert.equal(roundToLetters('aa'), 'AA');
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.equal(roundToLetters(value), '');
});

test('dirty field patches exclude server identity/PCF metadata but encode explicit clears', () => {
  const before = { id: 'd', title: 'Old', reviewDeadline: '2026-11-09', version: '1', currentRound: 'A', manualCommentsCount: 2 } as Drawing;
  const after = { ...before, hasPcf: true, title: 'New', reviewDeadline: undefined, version: '2' };
  assert.deepEqual([...changedDrawingFields(before, after)], ['title', 'reviewDeadline', 'version']);
  const fields = new Set<keyof Drawing>(['id', 'hasPcf', 'title', 'reviewDeadline', 'version', 'currentRound', 'manualCommentsCount']);
  assert.deepEqual(drawingFieldPatch(after, fields), { id: 'd', changes: { title: 'New', reviewDeadline: null } });
  assert.deepEqual(drawingFieldPatch({ ...after, hasPcf: false }, fields), { id: 'd', changes: { title: 'New', reviewDeadline: null, version: '2', manualCommentsCount: 2 } });
});
