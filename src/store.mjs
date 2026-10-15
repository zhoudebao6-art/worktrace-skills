import {initFileEvidence,importFileVersions,checkFileRelations} from './file-evidence.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash,canonical,validateEvent,validateAsset,assert,uuid } from './protocol.mjs';
import { checkWorkRelations } from './work.mjs';
import {checkLearningRelations} from './learning.mjs';
import {initWechatStore,checkWechatRelations,materializeWechatEvent} from './wechat-store.mjs';
export class Store{
 constructor(file){mkdirSync(dirname(file),{recursive:true});this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,employee_id TEXT NOT NULL,employee_name TEXT NOT NULL,label TEXT NOT NULL,token_hash TEXT,revoked INTEGER NOT NULL DEFAULT 0,last_seen TEXT,last_error TEXT,installation_id TEXT);
 CREATE TABLE IF NOT EXISTS policies(hash TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assets(sha256 TEXT PRIMARY KEY,mime TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,device_id TEXT NOT NULL,employee_id TEXT NOT NULL,stream_id TEXT NOT NULL,sequence INTEGER NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,event_type TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,FOREIGN KEY(device_id) REFERENCES devices(device_id),UNIQUE(org_id,device_id,stream_id,sequence));
 CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at,event_id);CREATE INDEX IF NOT EXISTS events_employee ON events(employee_id,occurred_at);
 CREATE INDEX IF NOT EXISTS events_task ON events(json_extract(json,'$.payload.task_id'));
 CREATE INDEX IF NOT EXISTS events_stream_sequence ON events(stream_id,sequence);
 CREATE INDEX IF NOT EXISTS events_type_time ON events(event_type,occurred_at);
 CREATE INDEX IF NOT EXISTS events_device_evidence ON events(device_id,event_type,org_id,employee_id,event_id);
 CREATE TABLE IF NOT EXISTS event_assets(event_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(event_id,sha256),FOREIGN KEY(event_id) REFERENCES events(event_id),FOREIGN KEY(sha256) REFERENCES assets(sha256));
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
 `);if(!this.get('stream_id'))this.set('stream_id',uuid());initFileEvidence(this);initWechatStore(this);}
 get(k){const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(k);return r?JSON.parse(r.value):null;}
 set(k,v){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,JSON.stringify(v));}
 audit(action,detail){this.db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)').run(new Date().toISOString(),action,String(detail).slice(0,500));}
 addDevice(d,token=null){this.db.prepare('INSERT INTO devices(device_id,org_id,employee_id,employee_name,label,token_hash) VALUES(?,?,?,?,?,?)').run(d.device_id,d.org_id,d.employee_id,d.employee_name,d.label,token?hash(token):null);this.audit('device.register',d.device_id);}
 device(id){return this.db.prepare('SELECT * FROM devices WHERE device_id=?').get(id);}
 devices(){return this.db.prepare('SELECT device_id,org_id,employee_id,employee_name,label,revoked,last_seen,last_error FROM devices ORDER BY employee_id').all();}
 policy(value){const json=canonical(value),digest=hash(json);this.db.prepare('INSERT OR IGNORE INTO policies VALUES(?,?)').run(digest,json);return digest;}
 ingest(events,assets,orgId,boundDevice=null,policies=[],files=[]){
  assert(Array.isArray(events)&&events.length<=10000&&Array.isArray(assets)&&assets.length<=10000,'批次无效');
  const assetMap=new Map();for(const a of assets){const data=validateAsset(a);assert(!assetMap.has(a.sha256),'重复附件');assetMap.set(a.sha256,{...a,bytes:data});}
  const referenced=new Set();const policyMap=new Map();assert(Array.isArray(policies)&&policies.length<=1000,'策略数量过多');for(const p of policies){assert(p&&typeof p.value==='object'&&canonical(p.value).length<12000&&hash(canonical(p.value))===p.hash,'策略摘要不匹配');policyMap.set(p.hash,p.value);}
  for(const e of events){validateEvent(e);assert(e.org_id===orgId,'公司编号不匹配');const d=this.device(e.device_id);assert(d&&d.org_id===e.org_id&&d.employee_id===e.employee_id&&!d.revoked,'设备未登记、已撤销或员工归属不匹配');assert(!boundDevice||e.device_id===boundDevice,'设备不能上传其他设备的数据');for(const a of e.attachments){referenced.add(a.sha256);const got=assetMap.get(a.sha256)||this.db.prepare('SELECT mime,size FROM assets WHERE sha256=?').get(a.sha256);assert(got&&(got.bytes?.length??got.size)===a.size&&got.mime===a.mime,'缺少附件或附件长度不符');}}
  for(const e of events)assert(policyMap.has(e.policy_hash)||this.db.prepare('SELECT hash FROM policies WHERE hash=?').get(e.policy_hash),'缺少采集策略证据');
  for(const key of assetMap.keys())assert(referenced.has(key),'禁止上传无关联附件');
  let added=0,duplicates=0;this.db.exec('SAVEPOINT ingest_batch');try{
   const referencedFiles=new Set(events.filter(e=>e.event_type==='document.version').map(e=>e.payload.file_sha256));assert(Array.isArray(files)&&files.every(f=>referencedFiles.has(f.sha256)),'禁止上传无关联文件版本');importFileVersions(this,files);
   for(const value of policyMap.values())this.policy(value);
   const putAsset=this.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?)');for(const a of assetMap.values())putAsset.run(a.sha256,a.mime,a.bytes.length,a.bytes);
   for(const e of events){const json=canonical(e),digest=hash(json),prev=this.db.prepare('SELECT hash FROM events WHERE event_id=?').get(e.event_id);
    if(prev){assert(prev.hash===digest,'同一事件编号内容冲突');duplicates++;continue;}
    const sameSeq=this.db.prepare('SELECT event_id FROM events WHERE org_id=? AND device_id=? AND stream_id=? AND sequence=?').get(e.org_id,e.device_id,e.stream_id,e.sequence);assert(!sameSeq,'设备序列号冲突，可能复制了运行中的数据目录');checkWorkRelations(this,e);
    checkLearningRelations(this,e);checkFileRelations(this,e);checkWechatRelations(this,e);
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(e.event_id,e.org_id,e.device_id,e.employee_id,e.stream_id,e.sequence,e.occurred_at,new Date().toISOString(),e.event_type,digest,json);
    materializeWechatEvent(this,e);
    for(const a of e.attachments)this.db.prepare('INSERT INTO event_assets VALUES(?,?)').run(e.event_id,a.sha256);added++;
   }
   this.db.exec('RELEASE SAVEPOINT ingest_batch');
  }catch(e){this.db.exec('ROLLBACK TO SAVEPOINT ingest_batch');this.db.exec('RELEASE SAVEPOINT ingest_batch');throw e;}
  return {added,duplicates};
 }
 append(base,assets=[]){const stream=this.get('stream_id');const n=this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE org_id=? AND device_id=? AND stream_id=?').get(base.org_id,base.device_id,stream).n;const e={...base,stream_id:stream,sequence:n+1};this.ingest([e],assets,e.org_id,e.device_id);return e;}
 batch(after=0,limit=20){const stream=this.get('stream_id');const rows=this.db.prepare('SELECT json FROM events WHERE stream_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(stream,after,limit);let events=rows.map(r=>JSON.parse(r.json)),batch=this.materialize(events);while(events.length>1&&Buffer.byteLength(JSON.stringify(batch))>12*1024*1024){events=events.slice(0,-1);batch=this.materialize(events);}assert(Buffer.byteLength(JSON.stringify(batch))<=12*1024*1024,'单条事件超过同步预算');return batch;}
 materialize(events){const refs=[...new Set(events.flatMap(e=>e.attachments.map(a=>a.sha256)))];return {...(events.some(e=>e.event_type==='document.version')?{files:[...new Set(events.filter(e=>e.event_type==='document.version').map(e=>e.payload.file_sha256))].map(h=>{const f=this.db.prepare('SELECT * FROM file_versions WHERE sha256=?').get(h);return {...f,data:Buffer.from(f.data).toString('base64')};})}:{}),events,policies:[...new Set(events.map(e=>e.policy_hash))].map(h=>({hash:h,value:JSON.parse(this.db.prepare('SELECT json FROM policies WHERE hash=?').get(h).json)})),assets:refs.map(sha=>{const a=this.db.prepare('SELECT * FROM assets WHERE sha256=?').get(sha);return {sha256:sha,mime:a.mime,data:Buffer.from(a.data).toString('base64')};})};}
 list({employee='',device='',from='',to='',search='',limit=100,offset=0}={}){const where=[],args=[];if(employee){where.push('employee_id=?');args.push(employee);}if(device){where.push('device_id=?');args.push(device);}if(from){where.push('occurred_at>=?');args.push(from);}if(to){where.push('occurred_at<=?');args.push(to);}if(search){where.push("json LIKE ? ESCAPE '\\'");args.push('%'+search.replace(/[\\%_]/g,'\\$&')+'%');}const w=where.length?' WHERE '+where.join(' AND '):'';const count=this.db.prepare('SELECT COUNT(*) n FROM events'+w).get(...args).n;const rows=this.db.prepare('SELECT json,received_at,hash FROM events'+w+' ORDER BY occurred_at DESC,event_id DESC LIMIT ? OFFSET ?').all(...args,Math.min(10001,limit),offset);return {count,items:rows.map(r=>({...JSON.parse(r.json),received_at:r.received_at,event_hash:r.hash}))};}
 exportBundle(orgId,filters={}){const result=this.list({...filters,limit:10001});assert(result.count<=10000,'一次最多导出 10000 条，请缩小日期范围');let events=result.items.map(({received_at,event_hash,...e})=>e);const refIds=new Set(events.filter(e=>e.event_type==='learning.summary').flatMap(e=>e.payload.evidence_event_ids));for(const eid of refIds){if(!events.some(e=>e.event_id===eid))events.push(JSON.parse(this.db.prepare('SELECT json FROM events WHERE event_id=?').get(eid).json));}const pendingDocs=events.filter(e=>['document.version','chat.message'].includes(e.event_type));const includedIds=new Set(events.map(e=>e.event_id));while(pendingDocs.length){const parentPayload=pendingDocs.pop().payload;const parent=parentPayload.previous_event_id||parentPayload.previous_revision_id;if(parent&&!includedIds.has(parent)){const doc=JSON.parse(this.db.prepare('SELECT json FROM events WHERE event_id=?').get(parent).json);events.push(doc);pendingDocs.push(doc);includedIds.add(parent);assert(events.length<=10000,'文件版本历史超过导出上限，请使用完整移交包');}}const taskIds=new Set(events.filter(e=>e.event_type.startsWith('task.')||e.event_type.startsWith('artifact.')).map(e=>e.payload.task_id));if(taskIds.size){const related=[];for(const tid of taskIds){const rows=this.db.prepare("SELECT json FROM events WHERE json_extract(json,'$.payload.task_id')=? ORDER BY rowid LIMIT 10001").all(tid);for(const row of rows)related.push(JSON.parse(row.json));assert(related.length<=10000,'相关任务历史超过导出上限');}events=[...new Map([...events,...related].map(e=>[e.event_id,e])).values()];}assert(events.length<=10000,'包含关联任务历史后超过 10000 条，请缩小范围');const selected=new Set(events.map(e=>e.event_id));events=this.db.prepare('SELECT json FROM events WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(JSON.stringify([...selected])).map(r=>JSON.parse(r.json));return {format:events.some(e=>e.event_type==='document.version')?'worktrace.bundle/1.1':'worktrace.bundle/1.0',exported_at:new Date().toISOString(),org_id:orgId,devices:this.devices().map(({last_seen,last_error,revoked,...d})=>d),...this.materialize(events)};}
 importBundle(b,orgId){assert(b.org_id===orgId,'只能导入本公司的数据包');const r=this.ingest(b.events,b.assets,orgId,null,b.policies,b.files||[]);this.audit('bundle.import',JSON.stringify(r));return r;}
 stats(){return {events:this.db.prepare('SELECT COUNT(*) n FROM events').get().n,assets:this.db.prepare('SELECT COUNT(*) n FROM assets').get().n,asset_bytes:this.db.prepare('SELECT COALESCE(SUM(size),0) n FROM assets').get().n,pending:this.db.prepare('SELECT COUNT(*) n FROM events WHERE stream_id=? AND sequence>?').get(this.get('stream_id'),this.get('sync_cursor')||0).n};}
 close(){this.db.close();}
}
