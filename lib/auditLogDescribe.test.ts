import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAuditEntry } from './auditLogDescribe.ts';

const entry = (action: any, detail: any) => ({ id: '1', drawingId: 'd', action, createdAt: '2026-11-13T00:00:00.000Z', customId: 'H-1', drawingNo: 'D-1', source: 'Builder reply import (bulk)', detail });

test('Builder reply audit rows read as clear English for the Daily Log, CSV and Copy', () => {
  assert.equal(describeAuditEntry(entry('BUILDER_REPLY', { replies: 2, round: 'B', status: 'unchanged (Reviewing)' })), 'Builder replies imported: 2 replies (Round B) · status unchanged (Reviewing)');
  assert.equal(describeAuditEntry(entry('BUILDER_REPLY', { replies: 1, round: 'A', status: 'Waiting Reply -> Reviewing' })), 'Builder replies imported: 1 reply (Round A) · status Waiting Reply -> Reviewing');
  // A Builder reply row must not be caught by the "Sent Out → Review" STATUS filter.
  assert.doesNotMatch(describeAuditEntry(entry('BUILDER_REPLY', { replies: 1, round: 'A', status: 'Waiting Reply -> Reviewing' })), /Status:/);
  assert.equal(describeAuditEntry(entry('STATUS', { from: 'Waiting Reply', to: 'Reviewing' })), 'Status: Waiting Reply -> Reviewing');
});
