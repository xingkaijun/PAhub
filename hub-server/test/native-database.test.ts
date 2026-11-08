import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,initializeSchema,migrationSql,schemaVersion} from '../src/database.ts';
import {DatabaseSync} from 'node:sqlite';
import {transaction} from '../src/project-write.ts';

test('native database exposes SQLite directly and replacements roll back atomically',async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'pahub-native-db-')),db=openDatabase(path.join(dir,'papc.db'));
 try{
  assert.ok(db instanceof DatabaseSync);
  db.exec('CREATE TABLE items(id TEXT PRIMARY KEY,name TEXT UNIQUE);INSERT INTO items VALUES(\'old\',\'original\')');
  assert.throws(()=>transaction(db,'replacement',()=>{db.exec('DELETE FROM items');db.prepare('INSERT INTO items VALUES(?,?)').run('a','duplicate');db.prepare('INSERT INTO items VALUES(?,?)').run('b','duplicate');}),/UNIQUE/);
  assert.equal(db.prepare('SELECT name FROM items').get()!.name,'original');
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
test('legacy views retire for HTML and JSON databases without advancing the offline conversion',()=>{
 for(const version of [1,2]){
  const db=new DatabaseSync(':memory:');try{
   db.exec(migrationSql('001_schema.sql'));db.exec('PRAGMA user_version='+version);
   assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='api_projects'").get());
   initializeSchema(db);initializeSchema(db);
   assert.equal(schemaVersion(db),version);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='view' AND name LIKE 'api_%'").get()!.n,0);
   assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='drawings'").get());
  }finally{db.close();}
 }
});
