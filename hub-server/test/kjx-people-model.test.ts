import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, initializeSchema } from '../src/database.ts';
import { upsertKjxUser, getKjxUser } from '../src/kjx-users.ts';
import { applyOps, initData, type Op } from '../src/pcf-model.ts';
import { externalData, standaloneHTML } from '../src/pcf-exchange.ts';
import { parseHTML } from '../src/pcf-html.ts';
import { currentTemplate, renderTemplate, upgradeFile } from '../src/pcf-template.ts';
import { validateJSON } from '../src/pcf-v26.ts';

const client = { clientId: 'client', clientName: 'Client', ip: '' };
const user = { sub: 'user-1', name: 'User One' };
function fixture() {
  const data = parseHTML(currentTemplate());
  data.comments = []; data.deleted = []; data.roundRegister = []; data.circulation = []; data.approvalHistory = [];
  data.hub = { rev: 1, entities: {} }; data.nextCommentNumber = 1;
  return initData(data);
}
function apply(data: any, ops: Op[], actor = user, rev = 2) { return applyOps(data, ops, client, rev, actor); }

test('new rounds use the request identity and ignore submitted ids', () => {
  const data = fixture();
  apply(data, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1', initiator: 'Impostor', initiatorId: 'other', responderId: 'other' }]);
  assert.equal(data.comments[0].rounds[0].initiator, user.name);
  assert.equal(data.comments[0].rounds[0].initiatorId, user.sub);
  assert.equal(data.comments[0].rounds[0].responderId, undefined);
  apply(data, [{ type: 'round.add', commentId: 'c1', id: 'r2', initiatorId: 'other', responderId: 'other' }], user, 3);
  const r2 = data.comments[0].rounds[1];
  assert.equal(r2.initiatorId, user.sub); assert.equal(r2.initiator, user.name); assert.equal(r2.responderId, undefined);
  const recordRev = data.hub.entities['comment:c1:record'].rev;
  const currentRev = data.hub.entities['project:currentRound'].rev;
  apply(data, [{ type: 'rounds.addAll', number: 3, baseRev: currentRev, rounds: [{ commentId: 'c1', id: 'r3', recordRev, initiatorId: 'other', responderId: 'other' }] }], user, 4);
  const r3 = data.comments[0].rounds[2];
  assert.equal(r3.initiatorId, user.sub); assert.equal(r3.initiator, user.name); assert.equal(r3.responderId, undefined);
});

test('legacy creation keeps previous names and does not create identity fields', () => {
  const data = fixture();
  applyOps(data, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }], client, 2);
  data.comments[0].rounds[0].initiator = 'Previous'; data.comments[0].rounds[0].responder = 'Builder';
  applyOps(data, [{ type: 'round.add', commentId: 'c1', id: 'r2' }], client, 3);
  const round = data.comments[0].rounds[1];
  assert.equal(round.initiator, 'Previous'); assert.equal(round.responder, 'Builder');
  assert.equal(Object.hasOwn(round, 'initiatorId'), false); assert.equal(Object.hasOwn(round, 'responderId'), false);
});

test('round meta silently ignores identity fields without modifying other operations', () => {
  const data = fixture(); apply(data, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }]);
  const result = apply(data, [
    { type: 'round.meta', commentId: 'c1', roundId: 'r1', field: 'initiatorId', value: 'other' },
    { type: 'round.meta', commentId: 'c1', roundId: 'r1', field: 'responderId', value: 'other' },
    { type: 'round.meta', commentId: 'c1', roundId: 'r1', field: 'minHeight', value: 42, baseRev: 0 },
  ], user, 3);
  assert.equal(result.applied.length, 1); assert.equal(data.comments[0].rounds[0].initiatorId, user.sub);
  assert.equal(data.comments[0].rounds[0].responderId, undefined); assert.equal(data.comments[0].rounds[0].minHeight, 42);
});

test('offline export and import preserve ids; legacy projection remains byte identical', () => {
  const data = fixture(); apply(data, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }]);
  const round = data.comments[0].rounds[0]; round.responderId = 'builder-1';
  const exported = externalData(data);
  const imported = parseHTML(standaloneHTML(exported));
  validateJSON(imported);
  assert.equal(imported.comments[0].rounds[0].initiatorId, user.sub);
  assert.equal(imported.comments[0].rounds[0].responderId, 'builder-1');
  const legacy = structuredClone(data); delete legacy.comments[0].rounds[0].initiatorId; delete legacy.comments[0].rounds[0].responderId;
  const actual = externalData(legacy);
  const expected = structuredClone(exported); delete expected.comments[0].rounds[0].initiatorId; delete expected.comments[0].rounds[0].responderId;
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(standaloneHTML(actual), standaloneHTML(expected));
});

test('current template validator accepts identity fields and upgrades are a no-op', () => {
  const data = fixture(); apply(data, [{ type: 'comment.add', id: 'c1', roundIdNew: 'r1' }]);
  data.comments[0].rounds[0].responderId = 'builder-1';
  const html = renderTemplate(data), parsed = parseHTML(html);
  validateJSON(parsed);
  assert.equal(parsed.comments[0].rounds[0].initiatorId, user.sub);
  assert.equal(parsed.comments[0].rounds[0].responderId, 'builder-1');
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-people-')), file = path.join(dir, 'pcf.html');
  const legacy = fixture(), original = renderTemplate(legacy); writeFileSync(file, original);
  assert.equal(upgradeFile(file).status, 'current'); assert.equal(readFileSync(file, 'utf8'), original);
});

test('user cache migration is idempotent and upsert preserves first seen', () => {
  const db = openDatabase(':memory:');
  try {
    initializeSchema(db); initializeSchema(db);
    assert.equal(getKjxUser(db, 'missing'), undefined);
    const person = { id: 'u1', username: 'user', name: 'User', title: null, disciplines: ['HULL'], role: 'reviewer' };
    upsertKjxUser(db, person, 'first');
    upsertKjxUser(db, { ...person, name: 'Changed', title: 'Engineer', disciplines: ['ELEC'], role: 'manager' }, 'last');
    assert.deepEqual(getKjxUser(db, 'u1'), { ...person, name: 'Changed', title: 'Engineer', disciplines: ['ELEC'], role: 'manager', first_seen: 'first', last_seen: 'last' });
  } finally { db.close(); }
});
