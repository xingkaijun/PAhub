import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { D1Adapter } from '../src/d1.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, blob BLOB)');
  return new D1Adapter(sqlite);
}

test('D1 prepare/bind/first/all/run/raw and metadata', async () => {
  const db = fixture();
  try {
    const statement = db.prepare('INSERT INTO items(name, blob) VALUES (?, ?)');
    const result = await statement.bind('one', new Uint8Array([1, 2, 255])).run();
    assert.deepEqual(result.results, []);
    assert.equal(result.success, true);
    assert.equal(result.meta.changes, 1);
    assert.equal(result.meta.last_row_id, 1);
    assert.equal(result.meta.changed_db, true);
    await statement.bind('two', null).run();
    const read = await db.prepare('SELECT * FROM items ORDER BY id').all();
    assert.equal(read.results.length, 2);
    assert.equal(read.meta.changes, 0);
    assert.equal(read.meta.rows_written, 0);
    assert.equal(read.meta.changed_db, false);
    assert.deepEqual(read.results[0].blob, [1, 2, 255]);
    assert.equal(await db.prepare('SELECT name FROM items WHERE id = ?').bind(1).first('name'), 'one');
    assert.equal(await db.prepare('SELECT * FROM items WHERE id = ?').bind(99).first(), null);
    await assert.rejects(db.prepare('SELECT id FROM items').first('missing'), /D1_COLUMN_NOTFOUND/);
    assert.deepEqual(await db.prepare('SELECT id, name FROM items ORDER BY id').raw({ columnNames: true }), [['id', 'name'], [1, 'one'], [2, 'two']]);
    assert.deepEqual(await db.prepare('SELECT id FROM items WHERE 0').raw({ columnNames: true }), [['id']]);
    const returned = await db.prepare('INSERT INTO items(name) VALUES (?) RETURNING id').bind('three').run();
    assert.equal(returned.results[0].id, 3);
    assert.equal(returned.meta.last_row_id, 3);
    assert.equal((await db.prepare('UPDATE items SET name = ? WHERE id = ?').bind('updated', 2).run()).meta.changes, 1);
    assert.equal((await db.prepare('DELETE FROM items WHERE id = 99').run()).meta.changes, 0);
    assert.throws(() => statement.bind(undefined), /D1_TYPE_ERROR/);
    assert.throws(() => statement.bind({}), /D1_TYPE_ERROR/);
    assert.throws(() => statement.bind(true), /D1_TYPE_ERROR/);
  } finally { db.sqlite.close(); }
});

test('D1 batch is ordered and rolls back every statement on failure', async () => {
  const db = fixture();
  try {
    const results = await db.batch([
      db.prepare('INSERT INTO items(name) VALUES (?)').bind('original'),
      db.prepare('SELECT name FROM items'),
    ]);
    assert.equal(results[0].meta.changes, 1);
    assert.equal((results[1].results[0] as { name: string }).name, 'original');
    await assert.rejects(db.batch([
      db.prepare('DELETE FROM items'),
      db.prepare('INSERT INTO items(name) VALUES (?)').bind('duplicate'),
      db.prepare('INSERT INTO items(name) VALUES (?)').bind('duplicate'),
    ]), /UNIQUE/);
    assert.equal(await db.prepare('SELECT name FROM items').first('name'), 'original');
    assert.deepEqual(await db.batch([]), []);
  } finally { db.sqlite.close(); }
});

test('D1 exec supports multiple SQL statements and accurate counts', async () => {
  const db = fixture();
  try {
    const result = await db.exec("-- comment ;\nINSERT INTO items(name) VALUES ('semi;colon'); /* ; */ UPDATE items SET name = 'ok';");
    assert.equal(result.count, 2);
    assert.ok(result.duration >= 0);
    assert.equal(await db.prepare('SELECT name FROM items').first('name'), 'ok');
    assert.equal((await db.exec('-- only comment')).count, 0);
    const trigger = await db.exec("CREATE TABLE logged(value TEXT); CREATE TRIGGER item_log AFTER UPDATE ON items BEGIN INSERT INTO logged VALUES (CASE WHEN new.id > 0 THEN 'yes;ok' ELSE 'no' END); INSERT INTO logged VALUES ('second'); END;");
    assert.equal(trigger.count, 2);
    assert.equal((await db.prepare('CREATE TABLE extra(id INTEGER)').run()).meta.changed_db, true);
  } finally { db.sqlite.close(); }
});
