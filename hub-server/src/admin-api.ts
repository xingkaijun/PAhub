import { DatabaseSync, constants as sqlite, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ROOT_DIR } from './config.ts';
import path from 'node:path';
import { errorResponse } from './router.ts';
import { getProjectDetail, getProjectList, getReviewTracker } from './project-read.ts';
import { transaction, type ProjectWriter, type RecordValue } from './project-write.ts';
import { writeDrawing } from './drawing-write.ts';

const privateKey = (key: string) => /password|secret|hash/i.test(key);
function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    if (privateKey(String(value.setting_key || ''))) return { ...value, setting_value: '[redacted]' };
    return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey(key)).map(([key, entry]) => {
      if (key === 'detail' && typeof entry === 'string') { try { return [key, JSON.stringify(redact(JSON.parse(entry)))]; } catch { return [key, entry]; } }
      return [key, redact(entry)];
    }));
  }
  return value;
}

const allowedTables = ['projects','reviewers','drawings','drawing_assignees','drawing_status_history','review_tracker','discipline_defaults','discipline_default_assignees','project_settings','audit_log'];
const identifier = (name: string) => '"' + name.replaceAll('"','""') + '"';
const drawingColumns: Record<string,string> = {custom_id:'customId',drawing_no:'drawingNo',discipline:'discipline',title:'title',status:'status',version:'version',current_round:'currentRound',review_deadline:'reviewDeadline',manual_comments_count:'manualCommentsCount',manual_open_comments_count:'manualOpenCommentsCount',checked:'checked',checked_synced:'checkedSynced',received_date:'receivedDate',category:'category',deadline:'deadline'};

export class AdminApi {
  private password: string;
  constructor(readonly db: DatabaseSync, readonly dbPath: string, password: string | undefined, readonly writer: ProjectWriter) {this.password=password?.trim() || '';}
  private audit(table: string, action: string, detail?: unknown, id?: string) {
    this.db.prepare('INSERT INTO audit_log(table_name,row_id,action,detail) VALUES(?,?,?,?)').run(table,id || null,action,detail === undefined ? null : JSON.stringify(redact(detail)));
  }
  private notify(table: string, rows: RecordValue[]) {
    for (const row of rows) {
      const project = table==='projects' ? row.id : row.project_id || (row.drawing_id ? this.db.prepare('SELECT project_id FROM drawings WHERE id=?').get(row.drawing_id)?.project_id : undefined);
      if (!project) continue;
      if (table==='drawings' || row.drawing_id) this.writer.realtime.projectChanged(String(project),String(table==='drawings' ? row.id : row.drawing_id),table==='review_tracker' ? ['reviewTracker'] : ['project-data']);
      else for (const drawing of this.db.prepare('SELECT id FROM drawings WHERE project_id=?').all(String(project))) this.writer.realtime.projectChanged(String(project),String(drawing.id),['project-data']);
    }
  }
  private readOnlyQuery(sql: string) {
    // Never execute arbitrary SQL against credentials: aliases/hex()/json_group_array()
    // defeat output-key filtering. Query a private, sanitized in-memory snapshot instead.
    const reader=new DatabaseSync(':memory:');
    try {
      const tables=this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'project_passwords'").all();
      for (const {name,sql:schema} of tables) {
        const table=String(name);
        if (!schema) continue;
        reader.exec(String(schema));
        const columns=this.db.prepare('PRAGMA table_info(' + identifier(table) + ')').all().map(row=>String(row.name));
        const insert=reader.prepare('INSERT INTO '+identifier(table)+' ('+columns.map(identifier).join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')');
        for (const row of this.db.prepare('SELECT * FROM '+identifier(table)).all()) {
          if (table==='project_settings' && privateKey(String(row.setting_key))) continue;
          const sanitized=redact(row);
          insert.run(...columns.map(column=>(sanitized[column] ?? null) as SQLInputValue));
        }
      }
      reader.exec('PRAGMA query_only=ON');
      // query_only does not prohibit ATTACH (and a writable in-memory connection could
      // otherwise attach the real DB, undoing sanitization). SQLite's parser-level
      // authorizer prevents file attachment even with comments, aliases or PRAGMA tricks.
      // Keep the harmless historical :memory: attachment contract; all its writes still
      // fail query_only. No file-backed database can enter this connection.
      let denied = false;
      reader.setAuthorizer((action, first) => {
        if (action === sqlite.SQLITE_ATTACH && first !== ':memory:' || action === sqlite.SQLITE_PRAGMA) {
          denied = true; return sqlite.SQLITE_DENY;
        }
        return sqlite.SQLITE_OK;
      });
      try {
        return reader.prepare(sql).all().map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,value instanceof Uint8Array ? Array.from(value) : value])));
      } catch (error) {
        if (denied) throw new Error('Read-only SQL console: database attachments and PRAGMA statements are disabled');
        throw error;
      }
    } finally {reader.close();}
  }
  async handle(request: Request): Promise<Response> {
    const url=new URL(request.url),pathname=url.pathname.replace(/^\/api/,'');
    if (!this.password) return errorResponse(pathname==='/admin'?'Not found':'Admin console is disabled: ADMIN_PASSWORD is not set',pathname==='/admin'?404:403);
    if (pathname==='/admin' && request.method==='GET') return new Response(readFileSync(path.join(ROOT_DIR,'hub-server/src/admin.html'),'utf8'),{headers:{'Content-Type':'text/html; charset=utf-8'}});
    const token='admin_token_' + btoa(this.password).substring(0,10);
    const body=async ():Promise<RecordValue> => {
      const text=await request.text(),value=text?JSON.parse(text):{};
      if (!value || typeof value!=='object' || Array.isArray(value)) throw Object.assign(new Error('Expected JSON object'),{status:400});
      return value;
    };
    if (pathname==='/admin/auth' && request.method==='POST') return (await body()).password===this.password ? Response.json({token}) : errorResponse('Unauthorized',401);
    if (request.headers.get('Authorization')!=='Bearer ' + token) return errorResponse('Unauthorized',401);
    const segments=pathname.split('/').filter(Boolean);
    if (segments[1]==='api' && segments[2]==='tables') {
      if (segments.length===3 && request.method==='GET') {
        const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().filter(row => !String(row.name).startsWith('sqlite_') && !String(row.name).startsWith('d1_') && !String(row.name).startsWith('_cf_') && row.name !== 'project_passwords').map(row => ({name:row.name,count:this.db.prepare('SELECT COUNT(*) AS c FROM ' + identifier(String(row.name))).get()!.c}));
        return Response.json({tables});
      }
      const table=segments[3];if (!table) return errorResponse('Table required',400);
      if (!allowedTables.includes(table)) return errorResponse('Forbidden table',403);
      const schema=this.db.prepare('PRAGMA table_info(' + identifier(table) + ')').all();
      const columns=schema.map(row => String(row.name));
      if (segments.length===5 && segments[4]==='schema' && request.method==='GET') return Response.json({schema});
      if (segments.length===4 && request.method==='GET') {
        const page=Math.max(1,Number(url.searchParams.get('page')) || 1),search=url.searchParams.get('search') || '',projectId=url.searchParams.get('projectId');
        const predicates: string[]=[],params:SQLInputValue[]=[];
        if (table==='project_settings') predicates.push("lower(setting_key) NOT LIKE '%password%' AND lower(setting_key) NOT LIKE '%hash%' AND lower(setting_key) NOT LIKE '%secret%'");
        if (search) {
          const idMatch=search.match(/^(?:id|customid):(.*)$/i),idValue=idMatch?.[1].trim();
          if (idValue && columns.includes('custom_id')) {predicates.push('custom_id LIKE ?');params.push('%'+idValue+'%');}
          else if (idValue && columns.includes('drawing_id')) {predicates.push('drawing_id IN (SELECT id FROM drawings WHERE custom_id LIKE ?)');params.push('%'+idValue+'%');}
          else {predicates.push('(' + columns.map(c=>'CAST('+identifier(c)+' AS TEXT) LIKE ?').join(' OR ') + ')');columns.forEach(()=>params.push('%'+search+'%'));}
        }
        if (columns.includes('_deleted')) predicates.push('IFNULL(_deleted,0)!=1');
        if (projectId) {
          if (table==='projects') {predicates.push('id=?');params.push(projectId);}
          else if (columns.includes('project_id')) {predicates.push('project_id=?');params.push(projectId);}
          else if (['drawing_status_history','drawing_assignees'].includes(table)) {predicates.push('drawing_id IN (SELECT id FROM drawings WHERE project_id=?)');params.push(projectId);}
        }
        const where=predicates.length?'WHERE '+predicates.join(' AND '):'';
        let select='*';
        if (columns.includes('drawing_id')) select += ', (SELECT custom_id FROM drawings d WHERE d.id=' + (columns.includes('raw_drawing_ref')?'COALESCE('+table+'.drawing_id,'+table+'.raw_drawing_ref)':table+'.drawing_id') + ') AS _custom_id';
        const total=Number(this.db.prepare('SELECT COUNT(*) AS c FROM '+table+' '+where).get(...params)!.c);
        return Response.json({rows:redact(this.db.prepare('SELECT '+select+' FROM '+table+' '+where+' LIMIT ? OFFSET ?').all(...params,50,(page-1)*50)),total,page,pageSize:50});
      }
      const pk=columns.includes('id')?'id':columns.includes('project_id')?'project_id':'id';
      const id=segments[4]===undefined?undefined:decodeURIComponent(segments[4]);
      const validateColumns=(data:RecordValue) => { if (table==='project_settings' && privateKey(String(data.setting_key || ''))) throw Object.assign(new Error('Use project Config to change project passwords'),{status:400}); if (!Object.keys(data).length || Object.keys(data).some(c=>!columns.includes(c))) throw Object.assign(new Error('Invalid table columns'),{status:400}); };
      if (segments.length===4 && request.method==='POST') {
        const data=await body();validateColumns(data);
        if (table==='drawings') {
          if (data.id && this.db.prepare('SELECT 1 FROM drawings WHERE id=?').get(data.id)) return errorResponse('Drawing already exists',409);
          await writeDrawing(this.writer.storage,this.writer.realtime,String(data.project_id),{id:data.id,changes:Object.fromEntries(Object.entries(data).filter(([key])=>key in drawingColumns).map(([key,value])=>[drawingColumns[key],value]))},'admin');
        } else transaction(this.db,'admin_insert',()=> {const keys=Object.keys(data);this.db.prepare('INSERT INTO '+table+' ('+keys.map(identifier).join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(key=>data[key] as SQLInputValue));});
        this.audit(table,'INSERT',data);this.notify(table,[data]);return Response.json({success:true});
      }
      if (segments.length===5 && request.method==='PUT' && id!==undefined) {
        const data=await body();validateColumns(data);
        const before=this.db.prepare('SELECT * FROM '+table+' WHERE '+pk+'=?').all(id);
        const update=Object.keys(data).filter(c=>c!==pk);
        if (table==='drawings' && before.length) {
          if (update.includes('project_id') && data.project_id!==before[0].project_id) return errorResponse('Drawing belongs to another project',409);
          const metadata=Object.fromEntries(update.filter(c=>c in drawingColumns).map(c=>[drawingColumns[c],data[c]]));
          if (Object.keys(metadata).length) await writeDrawing(this.writer.storage,this.writer.realtime,String(before[0].project_id),{id,changes:metadata},'admin');
          const extra=update.filter(c=>!(c in drawingColumns));
          if (extra.length) this.db.prepare('UPDATE '+table+' SET '+extra.map(c=>identifier(c)+'=?').join(',')+' WHERE id=?').run(...extra.map(c=>data[c] as SQLInputValue),id);
        } else if (update.length) this.db.prepare('UPDATE '+table+' SET '+update.map(c=>identifier(c)+'=?').join(',')+' WHERE '+pk+'=?').run(...update.map(c=>data[c] as SQLInputValue),id);
        this.audit(table,'UPDATE',{id,updates:data},id);this.notify(table,before);return Response.json({success:true});
      }
      if (segments.length===5 && request.method==='DELETE' && id!==undefined) {
        const before=this.db.prepare('SELECT * FROM '+table+' WHERE '+pk+'=?').all(id);
        if (columns.includes('_deleted')) this.db.prepare('UPDATE '+table+' SET _deleted=1 WHERE '+pk+'=?').run(id);
        else this.db.prepare('DELETE FROM '+table+' WHERE '+pk+'=?').run(id);
        this.audit(table,'DELETE',undefined,id);this.notify(table,before);return Response.json({success:true});
      }
    }
    if (pathname==='/admin/api/sql' && request.method==='POST') {
      const sql=String((await body()).query || '').trim();if(!sql)return errorResponse('Query required',400);
      try{return Response.json({results:this.readOnlyQuery(sql)});}catch(error){return errorResponse(error instanceof Error?error.message:'Query failed',400);}
    }
    if (pathname==='/admin/api/export' && request.method==='GET') {
      const projects=getProjectList(this.db).map(p=>({project:getProjectDetail(this.db,String(p.id)),reviewTracker:getReviewTracker(this.db,String(p.id))}));
      return Response.json({exportedAt:new Date().toISOString(),projectCount:projects.length,projects},{headers:{'Content-Disposition':'attachment; filename="papc_db_export_'+new Date().toISOString().slice(0,10)+'.json"'}});
    }
    if (pathname==='/admin/api/import' && request.method==='POST') {
      const data=await body();if(!Array.isArray(data.projects))return errorResponse('Invalid import format; expected { projects: [...] }',400);
      let imported=0;
      for(const entry of data.projects){if(!entry.project?.id)continue;await this.writer.save(String(entry.project.id),entry.project,entry.reviewTracker || {},'import');imported++;}
      this.audit('FULL_DB','IMPORT',{imported});return Response.json({success:true,imported});
    }
    return errorResponse('Admin API not found',404);
  }
}
