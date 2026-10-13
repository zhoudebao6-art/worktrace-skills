import {assert,canonical,hash,id,keys,str,validateEvent} from './protocol.mjs';
import {defaultPolicy,validatePolicy} from './collector.mjs';

export const EXTERNAL_LIMITS=Object.freeze({bytes:16*1024*1024,records:10000,buckets:500,days:31});
const DAY=86400000;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function text(v,max,label){assert(str(v,max)&&v.length>0,`${label} 无效或过长`);return v;}
function timestamp(value,label){
 text(value,80,label);
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 assert(m,`${label} 必须明确时区`);
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
 const maxDay=new Date(Date.UTC(year,month,0)).getUTCDate();
 assert(year>=1970&&month>=1&&month<=12&&day>=1&&day<=maxDay&&hour<24&&minute<60&&second<60,`${label} 日期无效`);
 if(m[8]!=='Z'){const [h,min]=m[8].slice(1).split(':').map(Number);assert(h<=14&&min<60&&(h!==14||min===0),`${label} 时区偏移无效`);}
 const time=Date.parse(value);assert(Number.isFinite(time),`${label} 日期无效`);
 return new Date(time).toISOString();
}
function checkTree(root){
 const todo=[[root,0]];let count=0;
 while(todo.length){const [v,depth]=todo.pop();assert(++count<=200000&&depth<=24,'JSON 结构过深或节点过多');
  if(v===null||typeof v==='boolean')continue;
  if(typeof v==='string'){assert(v.length<=1024*1024,'JSON 单字段过大');continue;}
  if(typeof v==='number'){assert(Number.isFinite(v),'JSON 数值无效');continue;}
  assert(Array.isArray(v)||object(v),'只接受普通 JSON 数据');
  for(const key of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,key);assert(d&&Object.hasOwn(d,'value'),'JSON 不允许访问器');todo.push([d.value,depth+1]);}
 }
}
function parseInput(input){
 if(Buffer.isBuffer(input)){assert(input.length<=EXTERNAL_LIMITS.bytes,'外部 JSON 超过 16MiB');input=new TextDecoder('utf-8',{fatal:true}).decode(input);}
 if(typeof input==='string'){assert(Buffer.byteLength(input)<=EXTERNAL_LIMITS.bytes,'外部 JSON 超过 16MiB');input=JSON.parse(input.replace(/^\uFEFF/,''));}
 checkTree(input);assert(Buffer.byteLength(JSON.stringify(input))<=EXTERNAL_LIMITS.bytes,'外部 JSON 超过 16MiB');
 assert(object(input),'导出必须是 JSON 对象');return input;
}
function optionsOf(options){
 keys(options,['source','source_instance','org_id','device_id','employee_id','timezone','from','to']);
 assert(['activitywatch','screenpipe'].includes(options.source),'不支持的外部来源');
 text(options.source_instance,160,'来源实例');assert(!/[\u0000-\u001f]/.test(options.source_instance),'来源实例含控制字符');
 for(const key of ['org_id','device_id'])assert(id(options[key]),`无效编号: ${key}`);
 assert(str(options.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(options.employee_id),'无效员工编号');
 text(options.timezone,100,'时区');try{new Intl.DateTimeFormat('en',{timeZone:options.timezone});}catch{throw Error('无效时区');}
 const from=timestamp(options.from,'from'),to=timestamp(options.to,'to');
 assert(to>from&&Date.parse(to)-Date.parse(from)<=EXTERNAL_LIMITS.days*DAY,'日期范围必须大于零且不超过 31 天');
 return {...options,from,to};
}
function stableId(value){const h=hash(canonical(value));return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;}
function bounded(v,max,label){assert(v===undefined||v===null||typeof v==='string',`${label} 必须是字符串`);const s=v??'';return {value:s.slice(0,max),truncated:s.length>max};}
function sourceNumber(value,label){assert(Number.isSafeInteger(value)&&value>=0,`${label} 必须是非负安全整数`);return String(value);}

function activityWatch(input,o){
 assert(object(input.buckets),'ActivityWatch 导出需包含 buckets 对象');
 const buckets=Object.entries(input.buckets);assert(buckets.length<=EXTERNAL_LIMITS.buckets,'ActivityWatch 桶过多');
 const records=[];let seen=0;
 for(const [bucketKey,b] of buckets){
  assert(object(b)&&b.id===bucketKey,'ActivityWatch 桶编号不一致');text(b.id,160,'桶编号');text(b.type,100,'桶类型');text(b.client,160,'采集客户端');
  assert(b.hostname===o.source_instance,'ActivityWatch hostname 与显式来源实例不一致，禁止混入其他电脑');
  assert(Array.isArray(b.events),'ActivityWatch 桶缺少完整 events 数组');seen+=b.events.length;assert(seen<=EXTERNAL_LIMITS.records,'外部记录超过 10000 条');
  for(const e of b.events){
   assert(object(e)&&object(e.data),'ActivityWatch 事件或 data 无效');
   const at=timestamp(e.timestamp,'来源时间');assert(Number.isFinite(e.duration)&&e.duration>=0&&e.duration<=EXTERNAL_LIMITS.days*86400,'ActivityWatch duration 无效');
   const app=bounded(e.data.app,100,'应用名'),title=bounded(e.data.title,500,'窗口标题');
   // Python exports scrub IDs; Rust exports may retain them. Identity must work for both.
   const sourceRecord=`bucket:${b.id}:at:${at}`;
   const digest=hash(canonical({bucket:{id:b.id,type:b.type,client:b.client,hostname:b.hostname},event:{timestamp:e.timestamp,duration:e.duration,data:e.data}}));
   records.push({at,sourceRecord,digest,sourceTimestamp:e.timestamp,sourceType:b.type,duration:e.duration,kind:'activity_metadata',app:app.value,title:title.value,text:'',truncated:app.truncated||title.truncated});
  }
 }
 return {records,pages:null,coverage:'exported_buckets_only'};
}

function screenpipe(input,o){
 const pages=Object.hasOwn(input,'pages')?input.pages:[input];
 assert(Array.isArray(pages)&&pages.length>0&&pages.length<=1000,'Screenpipe pages 数量无效');
 let offset=0,total=null;const records=[],seen=new Set();
 for(const page of pages){
  assert(object(page)&&Array.isArray(page.data)&&object(page.pagination),'Screenpipe 缺少 data 或 pagination');
  const p=page.pagination;
  assert(Number.isSafeInteger(p.offset)&&p.offset===offset&&Number.isSafeInteger(p.limit)&&p.limit>0&&p.limit<=EXTERNAL_LIMITS.records&&Number.isSafeInteger(p.total)&&p.total>=0&&p.total<=EXTERNAL_LIMITS.records,'Screenpipe 分页不连续或超限');
  if(total===null)total=p.total;assert(total===p.total,'Screenpipe 各页 total 不一致');
  assert(page.data.length<=p.limit&&offset+page.data.length<=total,'Screenpipe 分页数量不一致');
  assert(offset+page.data.length===total||page.data.length===p.limit,'Screenpipe 中间页不完整');
  for(const row of page.data){
   assert(object(row)&&['OCR','UI'].includes(row.type)&&object(row.content),'只支持 Screenpipe OCR/UI 原始观察，拒绝音频、输入和模型 Memory');
   const c=row.content,sourceRecord=`${row.type}:${sourceNumber(row.type==='OCR'?c.frame_id:c.id,'Screenpipe 来源编号')}`;
   assert(!seen.has(sourceRecord),'Screenpipe 分页含重复记录，无法确认结果完整');seen.add(sourceRecord);
   // device_name can identify a capture device, not the employee's computer.
   // Older search responses lack machine_id; their attribution stays operator-bound.
   if(c.machine_id!==undefined&&c.machine_id!==null&&c.machine_id!=='')assert(c.machine_id===o.source_instance,'Screenpipe machine_id 与显式来源实例不一致');
   assert(typeof c.text==='string','Screenpipe 原始观察缺少 text');
   const at=timestamp(c.timestamp,'来源时间'),app=bounded(c.app_name,100,'应用名'),title=bounded(c.window_name,500,'窗口标题'),body=bounded(c.text,12000,'屏幕文本');
   // No file_path/frame/URL is opened, fetched, or promoted to an attachment.
   records.push({at,sourceRecord,digest:hash(canonical(row)),sourceTimestamp:c.timestamp,sourceType:row.type,duration:null,kind:c.text.trim()?'screen_text':'activity_metadata',app:app.value,title:title.value,text:body.value,truncated:app.truncated||title.truncated||body.truncated});
  }
  offset+=page.data.length;
 }
 assert(offset===total,'Screenpipe 分页未收齐，请导出全部页面');
 return {records,pages:pages.length,coverage:'supplied_search_results_only'};
}

/** Pure, bounded normalization. Source data never grants execution authority. */
export function normalizeExternalRecords(input,options){
 const o=optionsOf(options),data=parseInput(input),parsed=o.source==='activitywatch'?activityWatch(data,o):screenpipe(data,o);
 // A compatible transport envelope, not a claim about upstream capture policy.
 // This is never installed as the collector policy or used to start capture.
 const policy=validatePolicy({...structuredClone(defaultPolicy),timezone:o.timezone,record_titles:true});
 const policyHash=hash(canonical(policy)),events=[],seen=new Map();let excluded=0,duplicates=0;
 for(const r of parsed.records){
  if(r.at<o.from||r.at>=o.to){excluded++;continue;}
  const eid=stableId(['worktrace.external/1.0',o.org_id,o.device_id,o.employee_id,o.source,o.source_instance,r.sourceRecord]);
  const event={schema_version:'1.1',event_id:eid,org_id:o.org_id,device_id:o.device_id,employee_id:o.employee_id,stream_id:stableId(['external-preview',eid]),sequence:1,session_id:stableId(['external-session',o.org_id,o.device_id,o.source,o.source_instance,r.at.slice(0,10)]),occurred_at:r.at,timezone:o.timezone,event_type:'activity.snapshot',collector_version:'external-import/1.0',policy_hash:policyHash,app:{process_name:r.app,window_title:r.title},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{text:r.kind==='screen_text'?r.text:'',capture_status:r.kind==='screen_text'?'external_text':'activity_only',idle_seconds:0,truncated:r.truncated,reason:r.kind==='screen_text'?'外部屏幕文本观察；不能单凭文本证明操作、发送、身份或业务结果。':'外部活动元数据；不是正文、操作序列或已核验工时。'},attachments:[],provenance:{format:'worktrace.external/1.0',source:o.source,source_instance:o.source_instance,source_record_id:r.sourceRecord,source_sha256:r.digest,source_timestamp:r.sourceTimestamp,evidence_kind:r.kind,read_only:true,duration_seconds:r.duration,source_type:r.sourceType}};
  validateEvent(event);const digest=hash(canonical(event));
  if(seen.has(eid)){assert(seen.get(eid)===digest,'同一外部记录编号内容冲突');duplicates++;continue;}
  seen.set(eid,digest);events.push(event);
 }
 events.sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)||a.event_id.localeCompare(b.event_id));
 return {events,policies:events.length?[{hash:policyHash,value:policy}]:[],report:{source:o.source,source_instance:o.source_instance,from:o.from,to:o.to,input_records:parsed.records.length,selected_records:events.length,excluded_records:excluded,duplicate_records:duplicates,pages:parsed.pages,coverage:parsed.coverage,read_only:true,limitations:['显式设备归属由导入者确认，导出文件不构成身份认证。','分页检查仅证明提供页面自洽，不能证明原始采集无缺口或导出未篡改。','来源时间保留；导入序列只用于同步，不表示员工操作顺序。','活动时长可能重叠，不能相加当作工作时长；屏幕文本不证明操作或结果。']}};
}

function semantic(event){const {stream_id,sequence,...rest}=event;return canonical(rest);}
/** Append to the local stream so existing synchronization and ACK continue to work. */
export function importExternalRecords(store,input,options){
 const normalized=normalizeExternalRecords(input,options),o=optionsOf(options),device=store.device(o.device_id);
 assert(device&&device.org_id===o.org_id&&device.employee_id===o.employee_id&&!device.revoked,'设备未登记、已撤销或员工归属不匹配');
 const stream=store.get('stream_id');assert(id(stream),'本地同步流无效');
 let next=store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE device_id=? AND stream_id=?').get(o.device_id,stream).n;
 const events=[];let duplicates=normalized.report.duplicate_records;
 for(const event of normalized.events){
  const row=store.db.prepare('SELECT json FROM events WHERE event_id=?').get(event.event_id);
  if(row){assert(semantic(JSON.parse(row.json))===semantic(event),'同一外部记录编号内容冲突；禁止静默覆盖');duplicates++;continue;}
  const appended={...event,stream_id:stream,sequence:++next};validateEvent(appended);events.push(appended);
 }
 // Store.ingest validates everything and commits the entire batch atomically.
 const result=store.ingest(events,[],o.org_id,o.device_id,events.length?normalized.policies:[]);
 return {added:result.added,duplicates:duplicates+result.duplicates,event_ids:normalized.events.map(e=>e.event_id),report:normalized.report};
}
