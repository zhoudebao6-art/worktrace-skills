import {backup,DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {createReadStream,existsSync,mkdirSync,mkdtempSync,openSync,closeSync,readSync,writeSync,fsyncSync,statSync,lstatSync,writeFileSync,copyFileSync,rmSync,constants} from 'node:fs';
import {resolve,dirname,join,basename} from 'node:path';
import {hostname} from 'node:os';
import {assert,id,uuid,hash,canonical,SOFTWARE_VERSION,validateAsset,validateEvent} from './protocol.mjs';
import {importFileVersions} from './file-evidence.mjs';
import {validatePolicy} from './collector.mjs';
import {checkLearningRelations} from './learning.mjs';
import {coverageSchema,validateShape} from './learning-schema.mjs';
import {acquireIdentityLock} from './runtime-lifecycle.mjs';
import {wechatSourceKey} from './wechat-schema.mjs';
import {validateWechatIncrementalState} from './wechat-incremental.mjs';

const MAGIC=Buffer.from('WTRHOF01'),HEADER_SIZE=36,TAG_SIZE=16,MAX_MANIFEST=2*1024*1024,MAX_DATABASE=64*1024**3;
const deriveKey=promisify(scrypt);
const format='worktrace.offline-handoff/1.0';
const identityFields=['org_id','org_name','device_id','employee_id','employee_name','label','installation_id','stream_id'];
const configFields=['role','connection_mode','org_id','org_name','device_id','employee_id','employee_name','label','installation_id','host_binding'];
const pick=(value,fields)=>Object.fromEntries(fields.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
const hasTable=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
const getMeta=(db,key)=>{const row=db.prepare('SELECT value FROM meta WHERE key=?').get(key);return row?JSON.parse(row.value):null;};
function passwordCheck(password){assert((typeof password==='string'||Buffer.isBuffer(password))&&password.length>=12&&password.length<=200,'移交密码长度需为 12–200；密码不得写入包或配置');}
function workArea(tempDir,near){const root=resolve(tempDir||(existsSync('D:\\')?'D:\\codex+\\temp':join(dirname(resolve(near)),'runtime-temp')));mkdirSync(root,{recursive:true});return {root,dir:mkdtempSync(join(root,'worktrace-handoff-'))};}
function cleanArea(area){assert(dirname(resolve(area.dir))===area.root&&basename(area.dir).startsWith('worktrace-handoff-'),'临时目录边界无效');rmSync(area.dir,{recursive:true,force:true});}
function writeAll(fd,bytes){let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);assert(count>0,'写入移交文件失败');offset+=count;}}
function readAt(fd,length,position){const b=Buffer.alloc(length);let offset=0;while(offset<length){const n=readSync(fd,b,offset,length-offset,position+offset);assert(n>0,'移交包不完整');offset+=n;}return b;}
async function fileDigest(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
function identityCheck(identity){
 assert(identity&&id(identity.org_id)&&id(identity.device_id)&&id(identity.installation_id)&&id(identity.stream_id),'移交身份缺少稳定编号');
 assert(typeof identity.employee_id==='string'&&/^[\p{L}\p{N}_.-]{1,80}$/u.test(identity.employee_id),'移交员工编号无效');
 for(const field of ['org_name','employee_name','label'])assert(typeof identity[field]==='string'&&identity[field].trim()&&identity[field].length<=160,'移交身份缺少 '+field);
 assert(Object.keys(identity).every(k=>identityFields.includes(k)),'移交身份含未知字段');
}
const yieldTurn=()=>new Promise(done=>setImmediate(done));
// A valid SQLite file and an authenticated archive can still contain an already
// damaged record. Check evidence without modifying the snapshot or loading every
// original into memory. This runs only during explicit handoff operations.
async function validateEvidence(db){
 for(const row of db.prepare('SELECT hash,json FROM policies').iterate()){
  const value=JSON.parse(row.json);assert(canonical(value)===row.json&&hash(row.json)===row.hash,'来源策略摘要或规范化内容不一致');validatePolicy(value);
 }
 for(const row of db.prepare('SELECT sha256,mime,size,length(data) AS actual_size FROM assets').iterate()){
  assert(Number.isInteger(row.size)&&row.size>0&&row.size<=2*1024*1024&&row.actual_size===row.size,'来源截图长度不一致');
  const bytes=Buffer.from(db.prepare('SELECT data FROM assets WHERE sha256=?').get(row.sha256).data);validateAsset({sha256:row.sha256,mime:row.mime,data:bytes.toString('base64')});await yieldTurn();
 }
 if(hasTable(db,'file_versions'))for(const row of db.prepare('SELECT sha256,mime,size,length(data) AS actual_size FROM file_versions').iterate()){
  assert(Number.isInteger(row.size)&&row.size>0&&row.size<=20*1024*1024&&row.actual_size===row.size&&typeof row.mime==='string'&&row.mime.length<160,'来源文件版本长度或类型无效');
  const bytes=db.prepare('SELECT data FROM file_versions WHERE sha256=?').get(row.sha256).data;assert(hash(bytes)===row.sha256,'来源文件版本摘要不一致');await yieldTurn();
 }
 const getEvent=db.prepare('SELECT rowid,json FROM events WHERE event_id=?'),getPolicy=db.prepare('SELECT 1 FROM policies WHERE hash=?');
 let visited=0;
 for(const row of db.prepare('SELECT rowid,* FROM events ORDER BY rowid').iterate()){
  const e=JSON.parse(row.json);assert(canonical(e)===row.json&&hash(row.json)===row.hash,'来源事件摘要或规范化内容不一致');validateEvent(e);
  for(const field of ['event_id','org_id','device_id','employee_id','stream_id','sequence','occurred_at','event_type'])assert(row[field]===e[field],'来源事件索引字段与正文不一致：'+field);
  assert(getPolicy.get(e.policy_hash),'来源事件缺少采集策略');
  const refs=db.prepare('SELECT sha256 FROM event_assets WHERE event_id=? ORDER BY sha256').all(e.event_id).map(x=>x.sha256);
  assert(canonical(refs)===canonical(e.attachments.map(a=>a.sha256).sort()),'来源截图引用表与事件不一致');
  for(const a of e.attachments){const saved=db.prepare('SELECT mime,size FROM assets WHERE sha256=?').get(a.sha256);assert(saved&&saved.mime===a.mime&&saved.size===a.size,'来源事件截图元数据不一致');}
  const previous=(eid,message)=>{const r=getEvent.get(eid);assert(r&&r.rowid<row.rowid,message);return JSON.parse(r.json);};
  if(e.event_type==='document.version'){
   const p=e.payload,file=hasTable(db,'file_versions')&&db.prepare('SELECT size,mime FROM file_versions WHERE sha256=?').get(p.file_sha256);
   assert(file&&file.size===p.size&&(file.mime==='application/octet-stream'||file.mime===p.mime),'来源事件缺少匹配原件');
   if(p.previous_event_id){const prior=previous(p.previous_event_id,'来源文件前一版本缺失或顺序无效');assert(prior.event_type==='document.version'&&prior.org_id===e.org_id&&prior.device_id===e.device_id&&prior.employee_id===e.employee_id&&prior.payload.path===p.path,'来源文件前一版本归属不一致');}
  }
  if(e.event_type==='learning.summary'){for(const eid of e.payload.evidence_event_ids)previous(eid,'来源总结证据缺失或顺序无效');checkLearningRelations({db},e);}
  if(e.event_type==='chat.message'){
   const p=e.payload;
   if(p.previous_revision_id){const prior=previous(p.previous_revision_id,'来源微信修订缺失或顺序无效');assert(prior.event_type==='chat.message'&&prior.org_id===e.org_id&&prior.device_id===e.device_id&&prior.employee_id===e.employee_id&&prior.payload.message_key===p.message_key&&prior.payload.revision===p.revision-1,'来源微信修订归属不一致');}
  }
  if(e.event_type.startsWith('task.')||e.event_type.startsWith('artifact.')){
   const p=e.payload,originRow=db.prepare("SELECT rowid,json FROM events WHERE event_type='task.created' AND json_extract(json,'$.payload.task_id')=? ORDER BY rowid LIMIT 1").get(p.task_id);
   assert(originRow,'来源任务缺少起点');const origin=JSON.parse(originRow.json);
   assert(origin.device_id===e.device_id&&origin.employee_id===e.employee_id&&origin.org_id===e.org_id&&origin.context.case_id===e.context.case_id,'来源任务归属不一致');
   if(e.event_type==='task.created')assert(originRow.rowid===row.rowid,'来源任务编号重复');
   else assert(originRow.rowid<row.rowid,'来源任务起点顺序无效');
   const sameTask=(eid,message)=>{const prior=previous(eid,message);assert(prior.payload.task_id===p.task_id,message);return prior;};
   if(e.event_type==='task.transition'){
    const prior=db.prepare("SELECT json FROM events WHERE event_type='task.transition' AND json_extract(json,'$.payload.task_id')=? AND rowid<? ORDER BY rowid DESC LIMIT 1").get(p.task_id,row.rowid);
    assert((prior?JSON.parse(prior.json).payload.to:'queued')===p.from,'来源任务状态链不连续');
    for(const eid of p.evidence_event_ids)assert(['artifact.version','artifact.feedback'].includes(sameTask(eid,'来源验收证据不属于任务').event_type),'来源验收证据类型无效');
   }
   if(e.event_type==='artifact.version'){
    const priorRow=db.prepare("SELECT json FROM events WHERE event_type='artifact.version' AND json_extract(json,'$.payload.task_id')=? AND json_extract(json,'$.payload.artifact_id')=? AND rowid<? ORDER BY rowid DESC LIMIT 1").get(p.task_id,p.artifact_id,row.rowid),prior=priorRow?JSON.parse(priorRow.json):null;
    assert(p.version===(prior?.payload.version||0)+1&&p.parent_event_id===(prior?.event_id||null)&&(!prior||prior.payload.kind===p.kind),'来源稿件版本链不连续');
   }
   if(e.event_type==='artifact.feedback')assert(sameTask(p.artifact_event_id,'来源反馈稿件缺失').event_type==='artifact.version','来源反馈类型无效');
  }
  if(++visited%64===0)await yieldTurn();
 }
}
// These tables are optional in old packages. Validate existing references, but
// never migrate schemas, rebuild consumption state, or reinterpret old digests.
async function validateCheckpoints(db,identity){
 const eventRow=db.prepare('SELECT json FROM events WHERE event_id=?');
 const evidence=(eventId,type,message)=>{const row=id(eventId)&&eventRow.get(eventId),e=row?JSON.parse(row.json):null;assert(e&&e.org_id===identity.org_id&&e.device_id===identity.device_id&&e.employee_id===identity.employee_id&&(type==='raw'?e.event_type!=='learning.summary':!type||e.event_type===type),message);return e;};
 const personal=hasTable(db,'personal_batches'),members=hasTable(db,'personal_members'),requests=hasTable(db,'learning_requests'),analyses=hasTable(db,'analysis_batches'),analysisMembers=hasTable(db,'analysis_members'),jobs=hasTable(db,'node_jobs');
 const getBatch=personal?db.prepare('SELECT * FROM personal_batches WHERE batch_id=?'):null;
 const getJob=jobs?db.prepare('SELECT * FROM node_jobs WHERE job_id=?'):null;
 let visited=0;
 if(personal)for(const b of db.prepare('SELECT * FROM personal_batches').iterate()){
  assert(id(b.batch_id)&&/^[a-f0-9]{64}$/.test(b.digest)&&['open','done'].includes(b.status),'个人检查点编号、摘要或状态无效');
  const refs=JSON.parse(b.refs_json);assert(Array.isArray(refs)&&refs.length>0&&refs.length<=120&&new Set(refs).size===refs.length,'个人检查点证据列表无效');
  for(const eid of refs)evidence(eid,'raw','个人检查点引用的原始证据缺失或归属错误');
  if(b.coverage_json!==undefined&&b.coverage_json!==null){const coverage=JSON.parse(b.coverage_json);validateShape(coverage,coverageSchema,'个人检查点覆盖信息');assert(coverage.representative_events+coverage.context_events===refs.length,'个人检查点覆盖数量不一致');const count=members?db.prepare('SELECT COUNT(*) n FROM personal_members WHERE batch_id=?').get(b.batch_id).n:0;assert(count===coverage.new_events,'个人检查点已消费成员数量不一致');for(const group of coverage.metadata_groups)assert(refs.includes(group.evidence_event_id),'个人检查点聚合代表不在证据列表');}
  if(b.request_id!==null){const request=requests&&db.prepare('SELECT device_id FROM learning_requests WHERE request_id=?').get(b.request_id);assert(request&&request.device_id===identity.device_id,'个人检查点补证请求缺失或归属错误');}
  const committed=db.prepare("SELECT event_id,json FROM events WHERE event_type='learning.summary' AND json_extract(json,'$.payload.batch_id')=?").all(b.batch_id);assert(committed.length<=1,'个人检查点关联了多个总结');
  for(const row of committed){const e=evidence(row.event_id,'learning.summary','个人检查点总结归属错误'),p=e.payload;assert(p.digest===b.digest&&p.request_id===b.request_id&&canonical(p.evidence_event_ids)===canonical(refs),'个人检查点与已保存总结不一致');if(b.coverage_json!==undefined&&b.coverage_json!==null)assert(canonical(p.source_coverage)===canonical(JSON.parse(b.coverage_json)),'个人检查点覆盖信息与总结不一致');}
  if(b.result_event_id!==null||b.status==='done')assert(committed.length===1&&b.result_event_id===committed[0].event_id,'个人检查点完成结果缺失或指向其他批次');
  // A committed summary with an open checkpoint is a supported crash boundary.
  // The worker reuses that immutable result instead of making another paid call.
  if(++visited%64===0)await yieldTurn();
 }
 if(members)for(const m of db.prepare('SELECT event_id,batch_id FROM personal_members').iterate()){
  const batch=getBatch?.get(m.batch_id);assert(batch,'个人成员引用的检查点不存在');const e=evidence(m.event_id,'raw','个人成员引用的原始证据缺失或归属错误');
  // Grouped metadata members can legitimately be absent from representative refs.
  if(!JSON.parse(batch.refs_json).includes(m.event_id)){const coverage=batch.coverage_json?JSON.parse(batch.coverage_json):null;assert(e.event_type==='activity.snapshot'&&!e.payload.text&&!e.payload.content_text&&!e.payload.input_summary&&!e.attachments.length&&coverage?.metadata_groups.some(group=>{const representative=evidence(group.evidence_event_id,'raw','个人聚合代表缺失');return representative.event_type==='activity.snapshot'&&representative.app.process_name===e.app.process_name&&representative.payload.capture_status===e.payload.capture_status&&representative.occurred_at.slice(0,13)===e.occurred_at.slice(0,13);}),'个人成员不属于批次证据或元数据聚合范围');}
  if(++visited%64===0)await yieldTurn();
 }
 if(requests)for(const r of db.prepare('SELECT * FROM learning_requests').iterate()){
  assert(id(r.request_id)&&r.device_id===identity.device_id&&['open','answered','blocked'].includes(r.state),'补证检查点归属或状态无效');evidence(r.source_event_id,'learning.summary','补证检查点来源总结缺失');
  const questions=JSON.parse(r.questions_json);assert(Array.isArray(questions)&&questions.length<=8&&questions.every(q=>typeof q==='string'&&q.length<=1000),'补证检查点问题格式无效');
  if(r.result_event_id!==null||r.state!=='open'){const result=evidence(r.result_event_id,'learning.summary','补证检查点结果总结缺失');assert(result.payload.request_id===r.request_id&&result.payload.request_state===r.state,'补证检查点结果不匹配');}
 }
 if(analyses)for(const b of db.prepare('SELECT * FROM analysis_batches').iterate()){
  assert(id(b.batch_id)&&b.employee_id===identity.employee_id&&/^[a-f0-9]{64}$/.test(b.digest)&&['open','done'].includes(b.status),'分析检查点归属或状态无效');
  assert(analysisMembers&&db.prepare('SELECT 1 FROM analysis_members WHERE batch_id=? LIMIT 1').get(b.batch_id),'分析检查点缺少成员');
  if(b.result_json!==null){const result=JSON.parse(b.result_json);assert(result&&typeof result.summary==='string'&&Array.isArray(result.findings)&&Array.isArray(result.open_questions),'分析检查点结果格式无效');for(const f of result.findings)assert(Array.isArray(f.evidence_event_ids)&&f.evidence_event_ids.every(eid=>db.prepare('SELECT 1 FROM analysis_members WHERE batch_id=? AND event_id=?').get(b.batch_id,eid)),'分析检查点结果引用超出成员范围');}
  else assert(b.status!=='done','分析检查点缺少完成结果');
 }
 if(analysisMembers)for(const m of db.prepare('SELECT event_id,batch_id FROM analysis_members').iterate()){assert(analyses&&db.prepare('SELECT 1 FROM analysis_batches WHERE batch_id=?').get(m.batch_id),'分析成员引用的检查点不存在');evidence(m.event_id,null,'分析成员证据缺失或归属错误');}
 if(jobs)for(const j of db.prepare('SELECT * FROM node_jobs').iterate()){
  const spec=JSON.parse(j.spec_json);assert(id(j.job_id)&&j.device_id===identity.device_id&&spec.job_id===j.job_id&&spec.device_id===j.device_id&&spec.kind===j.kind&&spec.idempotency_key===j.idempotency_key,'本地队列任务索引或归属不一致');
  if(spec.retry_batch_id!==undefined&&spec.retry_batch_id!==null)assert(getBatch?.get(spec.retry_batch_id),'本地重试任务引用的检查点不存在');
  if(j.result_json!==null)JSON.parse(j.result_json);
 }
 if(hasTable(db,'worker_local_attempts'))for(const a of db.prepare('SELECT job_id,batch_id FROM worker_local_attempts').iterate())assert(getBatch?.get(a.batch_id)&&getJob?.get(a.job_id),'本地学习尝试引用的任务或检查点不存在');
 if(hasTable(db,'worker_hub_attempts'))for(const a of db.prepare('SELECT batch_id FROM worker_hub_attempts').iterate())assert(analyses&&db.prepare('SELECT 1 FROM analysis_batches WHERE batch_id=?').get(a.batch_id),'总控学习尝试引用的检查点不存在');
}
// The latest-message index and the incremental checkpoint survive a full Recover.
// Validate them against immutable evidence, rather than silently rebuilding or
// trusting a valid SQLite foreign key that may still point at an older revision.
// Stream one message chain at a time; imported evidence need not have a local
// source cursor, and a scope-filtered source may legitimately have no messages.
async function validateWechatCheckpoints(db){
 const indexed=hasTable(db,'wechat_messages'),hasChat=!!db.prepare("SELECT 1 FROM events WHERE event_type='chat.message' LIMIT 1").get();
 assert(!hasChat||indexed,'来源微信消息缺少最新索引');
 let previous=null,groups=0,visited=0;
 const getIndex=indexed?db.prepare('SELECT * FROM wechat_messages WHERE device_id=? AND message_key=?'):null;
 const checkLatest=()=>{
  if(!previous)return;
  const e=previous,p=e.payload,m=p.message,row=getIndex.get(e.device_id,p.message_key);
  const expected={device_id:e.device_id,message_key:p.message_key,source_key:wechatSourceKey(p.source),account_id:p.source.account_id,conversation_id:m.conversation_id,sender_id:m.sender_id,direction:m.direction,revision:p.revision,revision_id:p.revision_id,content_hash:hash(canonical(m)),observed_at:p.observed_at,sent_at:m.sent_at};
  assert(row&&Object.entries(expected).every(([key,value])=>row[key]===value),'来源微信最新索引与事件不一致');groups++;
 };
 for(const row of db.prepare("SELECT json FROM events WHERE event_type='chat.message' ORDER BY device_id,json_extract(json,'$.payload.message_key'),rowid").iterate()){
  const e=JSON.parse(row.json),p=e.payload,same=previous&&previous.device_id===e.device_id&&previous.payload.message_key===p.message_key;
  if(!same){checkLatest();assert(p.revision===1&&p.previous_revision_id===null,'来源微信修订起点缺失');}
  else assert(p.revision===previous.payload.revision+1&&p.previous_revision_id===previous.event_id,'来源微信修订缺失或分叉');
  previous=e;if(++visited%64===0)await yieldTurn();
 }
 checkLatest();
 if(indexed)assert(db.prepare('SELECT COUNT(*) n FROM wechat_messages').get().n===groups,'来源微信最新索引含无来源记录');
 if(hasTable(db,'wechat_sources'))for(const row of db.prepare('SELECT source_key,state_json FROM wechat_sources').iterate()){
  assert(typeof row.state_json==='string'&&Buffer.byteLength(row.state_json,'utf8')<=16384,'来源微信游标状态超出预算');
  const state=JSON.parse(row.state_json);validateWechatIncrementalState(state,state?.source);
  assert(row.source_key===state.source_key,'来源微信游标索引与状态不一致');
  if(++visited%64===0)await yieldTurn();
 }
}
async function databaseDetails(db,identity){
 db.exec('PRAGMA trusted_schema=OFF');
 assert(db.prepare('PRAGMA quick_check').all().every(r=>Object.values(r)[0]==='ok'),'快照 SQLite 完整性检查失败');assert(!db.prepare('PRAGMA foreign_key_check').all().length,'快照 SQLite 引用完整性检查失败');
 const tables={};for(const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.name),'快照表名不受支持');tables[row.name]=db.prepare('SELECT COUNT(*) n FROM "'+row.name+'"').get().n;}
 for(const table of ['events','devices','assets','policies','meta'])assert(Object.hasOwn(tables,table),'快照缺少必要表 '+table);
 assert(getMeta(db,'stream_id')===identity.stream_id,'快照同步流与来源身份不一致');
 assert(!db.prepare('SELECT 1 FROM events WHERE org_id<>? OR device_id<>? OR employee_id<>? LIMIT 1').get(identity.org_id,identity.device_id,identity.employee_id),'分控快照混入其他公司或员工设备');
 const devices=db.prepare('SELECT device_id,org_id,employee_id,employee_name,label,installation_id,revoked FROM devices ORDER BY device_id').all();
 assert(devices.every(d=>d.org_id===identity.org_id),'登记表混入其他公司');const own=devices.find(d=>d.device_id===identity.device_id);assert(own&&own.employee_id===identity.employee_id,'快照缺少原员工设备登记');
 assert((!own.installation_id||own.installation_id===identity.installation_id)&&own.employee_name===identity.employee_name&&own.label===identity.label,'快照设备登记与移交身份不一致');
 await validateEvidence(db);
 await validateCheckpoints(db,identity);
 await validateWechatCheckpoints(db);
 const range=db.prepare('SELECT MIN(occurred_at) from_time,MAX(occurred_at) to_time FROM events').get();
 return {tables,devices,counts:{events:tables.events,assets:tables.assets,file_versions:tables.file_versions||0,personal_summaries:db.prepare("SELECT COUNT(*) n FROM events WHERE event_type='learning.summary'").get().n},time_range:{from:range.from_time,to:range.to_time},local_state:{capture_enabled:getMeta(db,'capture_enabled'),worker_policy:getMeta(db,'worker_policy'),worker_active_call:getMeta(db,'worker_active_call'),sync_cursor:getMeta(db,'sync_cursor'),all_sqlite_tables_preserved:true,restore_mode:'review_only',external_runtime_logs_included:false}};
}
function validateManifest(m){
 assert(m&&m.format===format&&id(m.handoff_id)&&typeof m.created_at==='string','移交清单版本无效');identityCheck(m.identity);
 assert(Array.isArray(m.files)&&m.files.length===1&&m.files[0].path==='worktrace.sqlite','移交包仅允许固定数据库文件');const file=m.files[0];assert(Number.isSafeInteger(file.size)&&file.size>0&&file.size<=MAX_DATABASE&&/^[a-f0-9]{64}$/.test(file.sha256),'移交清单文件信息无效');
 assert(m.configuration&&Object.keys(m.configuration).every(k=>configFields.includes(k))&&m.configuration.role==='collector','移交配置必须是分控白名单');
 assert(m.configuration.org_id===m.identity.org_id&&m.configuration.device_id===m.identity.device_id&&m.configuration.employee_id===m.identity.employee_id&&m.configuration.installation_id===m.identity.installation_id,'移交配置与来源身份不一致');
 assert(m.local_state?.all_sqlite_tables_preserved===true&&m.local_state.restore_mode==='review_only','移交恢复模式无效');return m;
}

/** SQLite online backup preserves rowids, WAL commits, every table and checkpoint. */
export async function createOfflineHandoff(store,config,{output,password,tempDir,source={}}={}){
 passwordCheck(password);assert(config?.role==='collector','只有分控可生成个人完整移交包');assert(typeof output==='string'&&output.length,'需要新移交文件路径');
 const destination=resolve(output);assert(!existsSync(destination),'移交目标已存在，不覆盖');assert(Object.keys(source).every(k=>['base_version','derived_version','source_commit','source_sha256'].includes(k))&&Object.values(source).every(v=>typeof v==='string'&&v.length<=160),'源码来源字段无效');
 const area=workArea(tempDir,destination);let fd,key,created=false;
 try{
  const snapshot=join(area.dir,'worktrace.sqlite');await backup(store.db,snapshot,{rate:256});
  const db=new DatabaseSync(snapshot,{readOnly:true});let identity,details;try{identity=pick({...config,stream_id:getMeta(db,'stream_id')},identityFields);identityCheck(identity);details=await databaseDetails(db,identity);}finally{db.close();}
  const size=statSync(snapshot).size;assert(size>0&&size<=MAX_DATABASE,'完整数据库超过当前 64GiB 移交边界');
  const manifest=validateManifest({format,handoff_id:uuid(),created_at:new Date().toISOString(),software_version:SOFTWARE_VERSION,source:{derived_version:SOFTWARE_VERSION,...source},identity,configuration:pick(config,configFields),...details,files:[{path:'worktrace.sqlite',size,sha256:await fileDigest(snapshot)}],encryption:{algorithm:'aes-256-gcm',kdf:'scrypt-N32768-r8-p1',authentication:'header-and-entire-payload'},limitations:['摘要用于完整性核对，不是人员身份认证。','恢复目录为只读审阅用途，不含可直接启动的 config.json。','完整 SQLite 保存队列与检查点；外部模型运行日志、程序、登录凭据和证书私钥不在包中。']});
  const metadata=Buffer.from(JSON.stringify(manifest));assert(metadata.length<=MAX_MANIFEST,'移交清单过大');const prefix=Buffer.alloc(4);prefix.writeUInt32BE(metadata.length);
  const salt=randomBytes(16),iv=randomBytes(12),header=Buffer.concat([MAGIC,salt,iv]);key=await deriveKey(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(header);
  mkdirSync(dirname(destination),{recursive:true});fd=openSync(destination,'wx',0o600);created=true;writeAll(fd,header);writeAll(fd,cipher.update(prefix));writeAll(fd,cipher.update(metadata));
  for await(const chunk of createReadStream(snapshot,{highWaterMark:256*1024}))writeAll(fd,cipher.update(chunk));writeAll(fd,cipher.final());writeAll(fd,cipher.getAuthTag());fsyncSync(fd);closeSync(fd);fd=undefined;
  return {format,path:destination,sha256:await fileDigest(destination),bytes:statSync(destination).size,manifest};
 }catch(error){if(fd!==undefined)closeSync(fd);if(created)rmSync(destination,{force:true});throw error;}finally{key?.fill(0);cleanArea(area);}
}

async function unpack({input,password,tempDir},consume){
 passwordCheck(password);assert(typeof input==='string'&&input.length,'需要移交包路径');const source=resolve(input),stat=lstatSync(source);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>HEADER_SIZE+TAG_SIZE+4&&stat.size<=MAX_DATABASE+MAX_MANIFEST+HEADER_SIZE+TAG_SIZE+4,'移交包路径或大小无效');
 const area=workArea(tempDir,source),snapshot=join(area.dir,'worktrace.sqlite');let inputFd,outputFd,key;
 try{
  inputFd=openSync(source,'r');const header=readAt(inputFd,HEADER_SIZE,0);assert(header.subarray(0,8).equals(MAGIC),'不是完整离线移交包');const tag=readAt(inputFd,TAG_SIZE,stat.size-TAG_SIZE);
  key=await deriveKey(password,header.subarray(8,24),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(24));decipher.setAAD(header);decipher.setAuthTag(tag);
  let buffered=Buffer.alloc(0),metadataSize=null,manifest=null,written=0;const digest=createHash('sha256');outputFd=openSync(snapshot,'wx',0o600);
  function accept(bytes){
   if(!manifest){buffered=Buffer.concat([buffered,bytes]);if(metadataSize===null&&buffered.length>=4){metadataSize=buffered.readUInt32BE();assert(metadataSize>0&&metadataSize<=MAX_MANIFEST,'移交清单长度无效');}if(metadataSize===null||buffered.length<4+metadataSize)return;
    manifest=validateManifest(JSON.parse(buffered.subarray(4,4+metadataSize).toString('utf8')));bytes=buffered.subarray(4+metadataSize);buffered=Buffer.alloc(0);
   }
   written+=bytes.length;assert(written<=manifest.files[0].size,'移交数据库长度超过清单');digest.update(bytes);writeAll(outputFd,bytes);
  }
  // Own this descriptor end-to-end: an async ReadStream can destroy its fd on a
  // parser error before finally closes it, otherwise leaving plaintext behind.
  for(let position=HEADER_SIZE;position<stat.size-TAG_SIZE;){const chunk=readAt(inputFd,Math.min(256*1024,stat.size-TAG_SIZE-position),position);accept(decipher.update(chunk));position+=chunk.length;await new Promise(done=>setImmediate(done));}accept(decipher.final());
  assert(manifest&&written===manifest.files[0].size&&digest.digest('hex')===manifest.files[0].sha256,'移交数据库摘要或长度不一致');fsyncSync(outputFd);closeSync(outputFd);outputFd=undefined;closeSync(inputFd);inputFd=undefined;
  const db=new DatabaseSync(snapshot,{readOnly:true});try{const actual=await databaseDetails(db,manifest.identity);assert(canonical(actual.tables)===canonical(manifest.tables)&&canonical(actual.counts)===canonical(manifest.counts)&&canonical(actual.devices)===canonical(manifest.devices)&&canonical(actual.local_state)===canonical(manifest.local_state)&&canonical(actual.time_range)===canonical(manifest.time_range),'移交清单与数据库状态不一致');return await consume({manifest,snapshot,db});}finally{db.close();}
 }finally{if(inputFd!==undefined)closeSync(inputFd);if(outputFd!==undefined)closeSync(outputFd);key?.fill(0);cleanArea(area);}
}

/** Inspects authenticated metadata and SQLite integrity without publishing plaintext. */
export async function inspectOfflineHandoff(options){return unpack(options,async({manifest})=>({valid:true,format,manifest,restore_mode:'review_only'}));}

/** A new review directory only: no service configuration, startup or host rebinding. */
export async function restoreOfflineHandoff({directory,resumeConfig=false,...options}){
 assert(typeof directory==='string'&&directory.length&&typeof resumeConfig==='boolean','需要全新恢复目录及明确恢复模式');const target=resolve(directory);assert(!existsSync(target),'恢复目标已存在，不覆盖');
 return unpack(options,async({manifest,snapshot})=>{
  if(resumeConfig)assert(manifest.configuration.connection_mode==='offline'&&manifest.configuration.host_binding===hash(manifest.identity.org_id+':'+hostname()),'仅原主机可显式恢复离线运行配置；其他电脑只能审阅，联网凭据不在包中');
  let created=false,releaseIdentity;try{
   if(resumeConfig)releaseIdentity=await acquireIdentityLock(manifest.identity);
   mkdirSync(dirname(target),{recursive:true});mkdirSync(target);created=true;
   // Guard exists before any copied database or runtime configuration. A crash
   // midway through Restore/Recover can never leave an unguarded live directory.
   const guard=join(target,'REVIEW-ONLY.json');writeFileSync(guard,JSON.stringify({mode:'incomplete_restore',service_start_allowed:false}),{flag:'wx'});
   const database=join(target,'worktrace.sqlite');copyFileSync(snapshot,database,constants.COPYFILE_EXCL);writeFileSync(join(target,'handoff-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
   const mode=resumeConfig?'same_host_paused':'review_only';
   if(resumeConfig){const restored=new DatabaseSync(database);try{restored.exec('BEGIN IMMEDIATE');const put=restored.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),policy=getMeta(restored,'worker_policy');put.run('handoff_restore_previous_state',JSON.stringify({handoff_id:manifest.handoff_id,restored_at:new Date().toISOString(),capture_enabled:getMeta(restored,'capture_enabled'),worker_policy:policy}));put.run('capture_enabled','false');put.run('worker_policy',JSON.stringify({...policy,paused:true}));restored.exec('COMMIT');}catch(error){restored.exec('ROLLBACK');throw error;}finally{restored.close();}writeFileSync(join(target,'config.json'),JSON.stringify(manifest.configuration,null,2),{flag:'wx',mode:0o600});}
   writeFileSync(join(target,resumeConfig?'SAME-HOST-PAUSED.json':'REVIEW-ONLY.json'),JSON.stringify({mode,source_identity:manifest.identity,service_start_allowed:resumeConfig,service_started:false,notice:resumeConfig?'仅原主机的离线配置已恢复，采集与自动学习均暂停；检查原实例已退出后另行启动。':'完整状态仅供审阅，不得作为另一电脑的活跃分控启动。'},null,2),{flag:resumeConfig?'wx':'w'});
   if(resumeConfig)rmSync(guard);
   return {directory:target,database,mode,service_started:false,manifest};
  }catch(error){if(created){assert(dirname(target)!==target,'拒绝清理磁盘根目录');rmSync(target,{recursive:true,force:true});}throw error;}finally{await releaseIdentity?.();}
 });
}

/** Merge evidence only; employee-local jobs/checkpoints remain in the full backup. */
export async function importOfflineHandoff(store,config,options){
 assert(config?.role==='hub'&&id(config.org_id),'需要已初始化并接纳身份的总控');
 return unpack(options,async({manifest,db})=>{
  assert(manifest.identity.org_id===config.org_id,'总控属于另一公司，禁止改写历史身份或静默合并');
  for(const identity of manifest.devices){const existing=store.device(identity.device_id);assert(existing&&!existing.revoked&&existing.org_id===identity.org_id&&existing.employee_id===identity.employee_id,'总控尚未接纳原设备身份，或设备已撤销');const installation=identity.device_id===manifest.identity.device_id?manifest.identity.installation_id:identity.installation_id;assert(!existing.installation_id||existing.installation_id===installation,'设备编号已绑定其他安装实例，禁止静默合并');}
  const counts={added:0,duplicates:0,assets_added:0,file_versions_added:0};store.db.exec('BEGIN IMMEDIATE');try{
   for(const p of db.prepare('SELECT hash,json FROM policies').iterate()){const value=JSON.parse(p.json);assert(hash(canonical(value))===p.hash,'来源策略摘要不一致');const existing=store.db.prepare('SELECT json FROM policies WHERE hash=?').get(p.hash);assert(!existing||existing.json===p.json,'同摘要策略冲突');store.policy(value);}
   for(const a of db.prepare('SELECT sha256,mime,size,data FROM assets').iterate()){const bytes=Buffer.from(a.data);assert(bytes.length===a.size,'来源附件长度不一致');validateAsset({sha256:a.sha256,mime:a.mime,data:bytes.toString('base64')});const existing=store.db.prepare('SELECT mime,size,data FROM assets WHERE sha256=?').get(a.sha256);if(existing)assert(existing.mime===a.mime&&existing.size===a.size&&Buffer.from(existing.data).equals(bytes),'同摘要截图附件冲突');else{store.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(a.sha256,a.mime,a.size,bytes);counts.assets_added++;}}
   if(hasTable(db,'file_versions'))for(const file of db.prepare('SELECT sha256,mime,size,data FROM file_versions').iterate()){const existed=store.db.prepare('SELECT 1 FROM file_versions WHERE sha256=?').get(file.sha256);importFileVersions(store,[file]);if(!existed)counts.file_versions_added++;}
   let batch=[];const flush=()=>{if(!batch.length)return;const result=store.ingest(batch,[],config.org_id,null,[]);counts.added+=result.added;counts.duplicates+=result.duplicates;batch=[];};
   for(const row of db.prepare('SELECT json,hash FROM events ORDER BY rowid').iterate()){const event=JSON.parse(row.json);assert(canonical(event)===row.json&&hash(row.json)===row.hash,'来源事件摘要或规范化内容不一致');batch.push(event);if(batch.length>=50)flush();}flush();
   store.audit('handoff.import',canonical({handoff_id:manifest.handoff_id,device_id:manifest.identity.device_id,...counts}));store.db.exec('COMMIT');
   return {...counts,handoff_id:manifest.handoff_id,identity:manifest.identity,local_state_imported:false,note:'原始事件、附件、文件版本与总结已汇入；分控本地任务/消费检查点未覆盖总控状态，完整状态保留在移交备份。'};
  }catch(error){store.db.exec('ROLLBACK');throw error;}
 });
}
