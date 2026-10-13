import { createHash, randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {validatePersonalPayload} from './learning-schema.mjs';
export const VERSION='1.0';
export const EXTERNAL_VERSION='1.1';
export const SOFTWARE_VERSION='0.4.0';
export const MAX_ASSET=2*1024*1024, MAX_BATCH=50, MAX_ARCHIVE=100*1024*1024;
export const uuid=()=>randomUUID();
export const hash=b=>createHash('sha256').update(b).digest('hex');
export function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
export function assert(ok,msg){if(!ok)throw new Error(msg);}
export function keys(obj,allowed,required=allowed){assert(obj&&typeof obj==='object'&&!Array.isArray(obj),'必须是对象');for(const k of Object.keys(obj))assert(allowed.includes(k),'未知字段: '+k);for(const k of required)assert(Object.hasOwn(obj,k),'缺少字段: '+k);}
export function str(v,max=200){return typeof v==='string'&&v.length<=max;}
export function id(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);}
export function utc(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));}
export function validateEvent(e){
 const fields=['schema_version','event_id','org_id','device_id','employee_id','stream_id','sequence','session_id','occurred_at','timezone','event_type','collector_version','policy_hash','app','context','payload','attachments'];
 keys(e,[...fields,'provenance'],fields);
 assert([VERSION,EXTERNAL_VERSION,'1.2'].includes(e.schema_version),'不支持的数据规范版本');for(const k of ['event_id','org_id','device_id','stream_id','session_id'])assert(id(e[k]),'无效编号: '+k);
 assert((e.schema_version==='1.2')===(e.event_type==='document.version'),'文件证据必须使用 1.2 规范');
 if(e.schema_version===EXTERNAL_VERSION){
  assert(e.event_type==='activity.snapshot'&&e.provenance,'1.1 事件仅用于带来源的外部活动记录');
  const p=e.provenance;
  keys(p,['format','source','source_instance','source_record_id','source_sha256','source_timestamp','evidence_kind','read_only','duration_seconds','source_type']);
  assert(p.format==='worktrace.external/1.0'&&['activitywatch','screenpipe'].includes(p.source),'外部来源无效');
  for(const [k,max] of [['source_instance',160],['source_record_id',300],['source_timestamp',80],['source_type',100]])assert(str(p[k],max)&&p[k].trim(),'外部来源字段无效: '+k);
  assert(/^[a-f0-9]{64}$/.test(p.source_sha256)&&p.read_only===true,'外部记录需要来源摘要及只读标记');
  assert(['activity_metadata','screen_text'].includes(p.evidence_kind)&&(p.duration_seconds===null||Number.isFinite(p.duration_seconds)&&p.duration_seconds>=0&&p.duration_seconds<1e9),'外部证据类型或时长无效');
  assert(e.attachments?.length===0,'本版外部导入不包含媒体附件');
  assert(p.evidence_kind==='activity_metadata'?e.payload?.text===''&&e.payload.capture_status==='activity_only':p.source==='screenpipe'&&e.payload?.capture_status==='external_text','外部活动和内容来源不可混淆');
 }else assert(!Object.hasOwn(e,'provenance')&&e.payload?.capture_status!=='external_text','外部来源必须使用 1.1 规范');
 assert(str(e.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(e.employee_id),'无效员工编号');
 assert(Number.isSafeInteger(e.sequence)&&e.sequence>0,'无效序列号');assert(utc(e.occurred_at),'时间必须为 UTC 毫秒格式');
 assert(str(e.timezone,100)&&e.timezone.length>0,'缺少时区');try{new Intl.DateTimeFormat('en',{timeZone:e.timezone});}catch{throw new Error('无效时区');}
 assert(['activity.snapshot','collector.started','collector.paused','collector.gap','task.created','task.transition','artifact.version','artifact.feedback','learning.summary','document.version'].includes(e.event_type),'未知事件类型');
 assert(str(e.collector_version,40)&&/^[a-f0-9]{64}$/.test(e.policy_hash),'版本或采集策略摘要无效');
 keys(e.app,['process_name','window_title']);assert(str(e.app.process_name,100)&&str(e.app.window_title,500),'应用字段过长');
 keys(e.context,['case_id','conversation_id','sender_id','identity_source']);for(const k of ['case_id','conversation_id','sender_id'])assert(e.context[k]===null||str(e.context[k],160),'上下文无效');
 assert(e.context.identity_source==='device_assignment','人员归属来源无效');
 if(e.event_type==='learning.summary'){validatePersonalPayload(e.payload);assert(e.attachments.length===0,'总结不得混入原始附件');}
 else if(e.event_type==='document.version'){
  const p=e.payload;keys(p,['file_sha256','path','extension','mime','size','modified_at','previous_event_id','text','parser','parser_version','capture_status','gaps']);
  assert(/^[a-f0-9]{64}$/.test(p.file_sha256)&&str(p.path,2000)&&p.path.length>0&&['.txt','.md','.csv','.pdf','.docx','.xlsx'].includes(p.extension)&&str(p.mime,160),'文件来源无效');
  assert(Number.isInteger(p.size)&&p.size>0&&p.size<=20*1024*1024&&utc(p.modified_at)&&(p.previous_event_id===null||id(p.previous_event_id)),'文件版本元数据无效');
  assert(str(p.text,60000)&&['builtin-text','ooxml','original-only'].includes(p.parser)&&p.parser_version==='1.0'&&['text_extracted','partial','unparsed'].includes(p.capture_status),'文件解析结果无效');
  assert(Array.isArray(p.gaps)&&p.gaps.length<=20&&p.gaps.every(x=>str(x,1000))&&Array.isArray(e.attachments)&&e.attachments.length===0,'文件证据缺口或附件无效');
  assert(p.capture_status!=='unparsed'||p.text==='','未解析文件不得伪造正文');
 }
 else if(e.event_type.startsWith('task.')||e.event_type.startsWith('artifact.'))validateWork(e);
 else {keys(e.payload,['text','capture_status','idle_seconds','truncated','reason']);assert(str(e.payload.text,12000)&&str(e.payload.reason,500),'内容超过限制');
 assert(['activity_only','uia','external_text','unavailable','excluded','idle','outside_schedule','status','locked'].includes(e.payload.capture_status),'无效采集状态');
 assert(Number.isFinite(e.payload.idle_seconds)&&e.payload.idle_seconds>=0&&e.payload.idle_seconds<1e9&&typeof e.payload.truncated==='boolean','无效采样信息');}
 assert(Array.isArray(e.attachments)&&e.attachments.length<=1,'每个事件最多一张截图');
 for(const a of e.attachments){keys(a,['sha256','size','mime','kind']);assert(/^[a-f0-9]{64}$/.test(a.sha256)&&Number.isInteger(a.size)&&a.size>0&&a.size<=MAX_ASSET&&a.mime==='image/jpeg'&&a.kind==='window_capture','附件信息无效');}
 return e;
}
export const TASK_TYPES=['customer.progress_followup','draft.initial_review'];
export const TRANSITIONS={queued:['in_progress'],in_progress:['waiting_external','needs_review'],waiting_external:['in_progress'],needs_review:['in_progress','completed'],completed:[]};
export function validateWork(e){const p=e.payload;assert(e.context.case_id&&e.attachments?.length===0,'业务事件需有案件编号且不能混入截图附件');
 if(e.event_type==='task.created'){keys(p,['task_id','task_type','title','customer_id','input_summary','acceptance_criteria','authority_profile']);assert(id(p.task_id)&&TASK_TYPES.includes(p.task_type)&&str(p.title,200)&&p.title.length>0&&str(p.customer_id,160)&&p.customer_id.length>0&&str(p.input_summary,20000),'任务字段无效');assert(Array.isArray(p.acceptance_criteria)&&p.acceptance_criteria.length>0&&p.acceptance_criteria.length<=20&&p.acceptance_criteria.every(x=>str(x,500)&&x.length>0),'请提供验收标准');assert(p.authority_profile==='draft_only','本版仅支持草稿和核验任务，不授予外发或系统修改权限');}
 if(e.event_type==='task.transition'){keys(p,['task_id','from','to','reason','evidence_event_ids']);assert(id(p.task_id)&&TRANSITIONS[p.from]?.includes(p.to)&&str(p.reason,2000)&&Array.isArray(p.evidence_event_ids)&&p.evidence_event_ids.length<=20&&p.evidence_event_ids.every(id),'任务状态转换无效');assert(p.to!=='completed'||p.evidence_event_ids.length>0,'完成必须关联验收证据');}
 if(e.event_type==='artifact.version'){keys(p,['task_id','artifact_id','version','kind','content_text','source_kind','parent_event_id']);assert(id(p.task_id)&&id(p.artifact_id)&&Number.isInteger(p.version)&&p.version>0&&['reply','draft','review','followup'].includes(p.kind)&&str(p.content_text,200000)&&p.content_text.length>0&&['ai','human'].includes(p.source_kind)&&(p.parent_event_id===null||id(p.parent_event_id)),'稿件版本字段无效');}
 if(e.event_type==='artifact.feedback'){keys(p,['task_id','artifact_event_id','decision','reason','reason_source']);assert(id(p.task_id)&&id(p.artifact_event_id)&&['adopted','edited','rejected'].includes(p.decision)&&str(p.reason,4000)&&['user_confirmed','agent_observation','unknown'].includes(p.reason_source),'反馈字段无效');}
}
export function validateAsset(a){keys(a,['sha256','mime','data']);assert(typeof a.data==='string'&&a.data.length<=Math.ceil(MAX_ASSET*4/3)+4,'附件过大');const b=Buffer.from(a.data,'base64');assert(b.length>0&&b.length<=MAX_ASSET&&b.toString('base64')===a.data,'附件编码无效');assert(hash(b)===a.sha256&&a.mime==='image/jpeg','附件校验失败');assert(b[0]===0xff&&b[1]===0xd8&&b[b.length-2]===0xff&&b[b.length-1]===0xd9,'不是 JPEG 文件');return b;}
export function sealBundle(bundle,password){assert(str(password,200)&&password.length>=12,'导出密码至少 12 个字符');const raw=Buffer.from(JSON.stringify(bundle));assert(raw.length<=MAX_ARCHIVE,'导出数据超过 100MB，请缩小日期范围');const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(password,salt,32),cipher=createCipheriv('aes-256-gcm',key,iv);const header=Buffer.concat([Buffer.from('WTRACE01'),salt,iv]);cipher.setAAD(header);const data=Buffer.concat([cipher.update(gzipSync(raw)),cipher.final()]);return Buffer.concat([header,cipher.getAuthTag(),data]);}
export function openBundle(bytes,password){assert(bytes.length<MAX_ARCHIVE&&bytes.length>52&&bytes.subarray(0,8).toString()==='WTRACE01','数据包格式或大小无效');assert(str(password,200)&&password.length>=12,'导入密码无效');const head=bytes.subarray(0,36),key=scryptSync(password,bytes.subarray(8,24),32),dec=createDecipheriv('aes-256-gcm',key,bytes.subarray(24,36));dec.setAAD(head);dec.setAuthTag(bytes.subarray(36,52));let raw;try{raw=gunzipSync(Buffer.concat([dec.update(bytes.subarray(52)),dec.final()]),{maxOutputLength:MAX_ARCHIVE});}catch{throw new Error('密码错误、数据包被修改或解压大小超限');}const b=JSON.parse(raw.toString('utf8'));keys(b,['format','exported_at','org_id','devices','events','assets','policies','files'],['format','exported_at','org_id','devices','events','assets','policies']);assert(['worktrace.bundle/1.0','worktrace.bundle/1.1'].includes(b.format)&&id(b.org_id)&&utc(b.exported_at),'不支持的导出格式');assert(Array.isArray(b.events)&&b.events.length<=10000&&Array.isArray(b.assets)&&b.assets.length<=10000&&Array.isArray(b.devices)&&b.devices.length<=10000,'数据包记录过多');assert(b.format!=='worktrace.bundle/1.1'||Array.isArray(b.files),'缺少文件版本');assert(!b.events.some(e=>e.event_type==='document.version')||b.format==='worktrace.bundle/1.1','文件证据需1.1数据包');return b;}
