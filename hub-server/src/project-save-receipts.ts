import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {fail} from './pcf-model.ts';
export function initializeSaveReceipts(db:DatabaseSync){
 db.exec('CREATE TABLE IF NOT EXISTS project_save_receipts(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(project_id,actor_id,request_id))');
}
export function saveReceiptKey(body:any){
 if(body.saveRequestId===undefined)return undefined;
 if(typeof body.saveRequestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.saveRequestId))fail('Invalid saveRequestId');
 return {id:body.saveRequestId,hash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}
export function replaySave(db:DatabaseSync,project:string,actor:string,key:{id:string;hash:string}){
 const row=db.prepare('SELECT request_hash,result_json FROM project_save_receipts WHERE project_id=? AND actor_id=? AND request_id=?').get(project,actor,key.id);
 if(!row)return undefined;
 if(row.request_hash!==key.hash)fail('saveRequestId reused with a different request',409);
 return JSON.parse(String(row.result_json));
}
export function recordSave(db:DatabaseSync,project:string,actor:string,key:{id:string;hash:string},result:any){
 db.prepare('INSERT INTO project_save_receipts VALUES(?,?,?,?,?,?)').run(project,actor,key.id,key.hash,JSON.stringify(result),Date.now());
 // Bound replay lifetime and storage; the client keeps a failed request and its
 // baselines, so an expired receipt still falls back to normal conflict checks.
 db.prepare('DELETE FROM project_save_receipts WHERE created_at<?').run(Date.now()-7*86400000);
 db.prepare('DELETE FROM project_save_receipts WHERE project_id=? AND actor_id=? AND request_id NOT IN (SELECT request_id FROM project_save_receipts WHERE project_id=? AND actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100)').run(project,actor,project,actor);
}
