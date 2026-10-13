import {SOFTWARE_VERSION} from './protocol.mjs';
import {uuid,hash,canonical,assert,id,VERSION} from './protocol.mjs';
import {validatePersonalPayload} from './learning-schema.mjs';
import {defaultPolicy} from './collector.mjs';
function init(s){s.db.exec(`
 CREATE TABLE IF NOT EXISTS personal_batches(batch_id TEXT PRIMARY KEY,digest TEXT NOT NULL,refs_json TEXT NOT NULL,request_id TEXT,status TEXT NOT NULL,result_event_id TEXT);
 CREATE TABLE IF NOT EXISTS personal_members(event_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS learning_requests(request_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,source_event_id TEXT NOT NULL,questions_json TEXT NOT NULL,state TEXT NOT NULL,result_event_id TEXT);
 CREATE INDEX IF NOT EXISTS learning_requests_device ON learning_requests(device_id,state);
`);if(!s.db.prepare('PRAGMA table_info(personal_batches)').all().some(x=>x.name==='coverage_json'))s.db.exec('ALTER TABLE personal_batches ADD COLUMN coverage_json TEXT');}
const event=(s,eid)=>{const r=s.db.prepare('SELECT json FROM events WHERE event_id=?').get(eid);return r?JSON.parse(r.json):null;};
const raw=e=>e.event_type!=='learning.summary';
const preview=e=>({event_id:e.event_id,event_type:e.event_type,occurred_at:e.occurred_at,task_id:e.payload.task_id||null,case_id:e.context.case_id,app:e.app.process_name,preview:(e.payload.text||e.payload.content_text||e.payload.input_summary||'').slice(0,240),attachments:e.attachments,...(e.provenance?{provenance:e.provenance}:{})});
function selectEvidence(s,c,limit,initial){
 const refs=[...initial],members=[],groups=new Map();let selected=0;
 const rows=s.db.prepare("SELECT e.json FROM events e LEFT JOIN personal_members m ON m.event_id=e.event_id WHERE m.event_id IS NULL AND e.event_type<>'learning.summary' AND e.device_id=? ORDER BY e.rowid LIMIT 1000").all(c.device_id);
 for(const row of rows){const e=JSON.parse(row.json);
  const metadata=e.event_type==='activity.snapshot'&&!e.payload.text&&!e.app.window_title&&!e.attachments.length;
  const key=metadata?canonical([e.occurred_at.slice(0,13),e.app.process_name,e.payload.capture_status]):null;
  if(key&&groups.has(key)){const g=groups.get(key);g.count++;g.to=e.occurred_at;members.push(e.event_id);continue;}
  if(selected>=limit||refs.length>=100)break;
  if(!refs.includes(e.event_id))refs.push(e.event_id);members.push(e.event_id);selected++;
  if(key)groups.set(key,{app:e.app.process_name||'(none)',status:e.payload.capture_status,count:1,evidence_event_id:e.event_id,from:e.occurred_at,to:e.occurred_at});
 }
 const representative=refs.length;
 // Include prior saved file version for grounded change analysis, without consuming it again.
 for(const eid of [...refs]){const previous=event(s,eid)?.payload.previous_event_id;if(previous&&refs.length<120&&!refs.includes(previous))refs.push(previous);}
const taskIds=new Set(refs.map(x=>event(s,x)?.payload.task_id).filter(Boolean));
 // Task origin, parent versions and feedback may precede this batch. Add context,
 // without marking that context newly analysed or silently consuming later work.
 for(const tid of taskIds){const origin=s.db.prepare("SELECT event_id FROM events WHERE device_id=? AND json_extract(json,'$.payload.task_id')=? AND event_type='task.created' ORDER BY rowid LIMIT 1").all(c.device_id,tid);const parents=refs.map(x=>event(s,x)?.payload.parent_event_id).filter(Boolean).map(event_id=>({event_id}));const recent=s.db.prepare("SELECT event_id FROM events WHERE device_id=? AND json_extract(json,'$.payload.task_id')=? ORDER BY rowid DESC LIMIT 20").all(c.device_id,tid);for(const r of [...origin,...parents,...recent])if(refs.length<120&&!refs.includes(r.event_id))refs.push(r.event_id);}
 return {refs,members,coverage:{new_events:members.length,representative_events:representative,context_events:refs.length-representative,metadata_groups:[...groups.values()]}};
}
export function checkLearningRelations(s,e){
 if(e.event_type!=='learning.summary')return;
 validatePersonalPayload(e.payload);
 const refs=e.payload.evidence_event_ids.map(x=>event(s,x));
 assert(refs.every(x=>x&&raw(x)&&x.employee_id===e.employee_id&&x.device_id===e.device_id),'总结必须引用本员工本设备已保存的原始证据');
 for(const p of e.payload.result.procedures){
  if(p.task_id)assert(refs.some(x=>x.payload.task_id===p.task_id),'总结任务编号没有证据');
  if(p.case_id)assert(refs.some(x=>x.context.case_id===p.case_id),'总结案件编号没有证据');
 }
 const content=refs.some(x=>x.payload.text||x.payload.content_text||x.payload.input_summary||x.attachments.length);
 assert(e.payload.result.coverage==='metadata_only'||content,'只有应用元数据，不能声明已看到内容或结果');
 if(e.payload.result.coverage==='outcome_observed')assert(e.payload.result.procedures.some(p=>p.outcome.basis==='observed'),'结果覆盖需引用可观察结果；语义仍需核验');
}
export function nextPersonal(s,c,{limit=50}={}){
 assert(c.role==='collector','个人学习只能在分控运行');assert(Number.isInteger(limit)&&limit>=1&&limit<=100,'每批 1–100 条');init(s);
 let b=s.db.prepare("SELECT * FROM personal_batches WHERE status='open' ORDER BY rowid LIMIT 1").get();
 if(!b){
  const request=s.db.prepare("SELECT * FROM learning_requests WHERE state='open' ORDER BY rowid LIMIT 1").get();
  const {refs,members,coverage}=selectEvidence(s,c,limit,request?event(s,request.source_event_id)?.payload.evidence_event_ids||[]:[]);
  if(!refs.length)return {batch:null,stop_reason:'no_new_evidence'};
  b={batch_id:uuid(),digest:hash(canonical({coverage,events:refs.map(x=>({event_id:x,hash:s.db.prepare('SELECT hash FROM events WHERE event_id=?').get(x).hash}))})),refs_json:JSON.stringify(refs),request_id:request?.request_id||null,status:'open',result_event_id:null,coverage_json:JSON.stringify(coverage)};
  s.db.exec('BEGIN IMMEDIATE');try{s.db.prepare('INSERT INTO personal_batches VALUES(?,?,?,?,?,?,?)').run(...Object.values(b));for(const eid of members)s.db.prepare('INSERT OR IGNORE INTO personal_members VALUES(?,?)').run(eid,b.batch_id);s.db.exec('COMMIT');}catch(e){s.db.exec('ROLLBACK');throw e;}
 }
 const req=b.request_id?s.db.prepare('SELECT * FROM learning_requests WHERE request_id=?').get(b.request_id):null;
 return {batch:{batch_id:b.batch_id,digest:b.digest,employee_id:c.employee_id,source_coverage:b.coverage_json?JSON.parse(b.coverage_json):null,request:req?{request_id:req.request_id,source_event_id:req.source_event_id,questions:JSON.parse(req.questions_json)}:null,events:JSON.parse(b.refs_json).map(x=>preview(event(s,x)))},note:'重复无正文活动按小时/应用聚合，只代表采样数；正文/附件不合并。任务上下文有界补入；超出范围仍须标未知。最多三批，无新证据停止。'};
}
export function savePersonal(s,c,p){
 assert(c.role==='collector','个人学习只能在分控保存');init(s);
 const b=s.db.prepare('SELECT * FROM personal_batches WHERE batch_id=?').get(p.batch_id);assert(b&&p.digest===b.digest,'个人批次不存在或摘要不匹配');
 const refs=JSON.parse(b.refs_json);const payload={format:'worktrace.personal/1.0',batch_id:b.batch_id,digest:b.digest,source_coverage:b.coverage_json?JSON.parse(b.coverage_json):{new_events:refs.length,representative_events:refs.length,context_events:0,metadata_groups:[]},request_id:b.request_id,request_state:p.request_state||'none',evidence_event_ids:refs,result:p.result};validatePersonalPayload(payload);
 const existing=s.db.prepare("SELECT json FROM events WHERE event_type='learning.summary' AND json_extract(json,'$.payload.batch_id')=?").get(b.batch_id);
 let e;if(existing){e=JSON.parse(existing.json);assert(canonical(e.payload)===canonical(payload),'已保存不同总结，禁止静默覆盖');}
 else e=s.append({schema_version:VERSION,event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:uuid(),occurred_at:new Date().toISOString(),timezone:(s.get('policy')||defaultPolicy).timezone,event_type:'learning.summary',collector_version:SOFTWARE_VERSION,policy_hash:s.policy(s.get('policy')||defaultPolicy),app:{process_name:'codex',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload,attachments:[]});
 s.db.prepare("UPDATE personal_batches SET status='done',result_event_id=? WHERE batch_id=?").run(e.event_id,b.batch_id);
 if(b.request_id)s.db.prepare('UPDATE learning_requests SET state=?,result_event_id=? WHERE request_id=?').run(payload.request_state,e.event_id,b.request_id);
 return {saved:true,duplicate:!!existing,event_id:e.event_id,sync:c.connection_mode==='offline'?'awaiting_offline_handoff':'queued',semantic_validation:'not_proven'};
}
export function personalHistory(s,{employee='',limit=20,include_details=false}={}){assert(typeof employee==='string'&&employee.length<=80&&Number.isInteger(limit)&&limit>=1&&limit<=(include_details?5:100),'查询范围无效；完整总结每次最多五份');return s.db.prepare("SELECT json FROM events WHERE event_type='learning.summary'"+(employee?' AND employee_id=?':'')+' ORDER BY rowid DESC LIMIT ?').all(...(employee?[employee]:[]),limit).map(x=>{const e=JSON.parse(x.json);return include_details?e:{event_id:e.event_id,employee_id:e.employee_id,device_id:e.device_id,occurred_at:e.occurred_at,summary:e.payload.result.summary.slice(0,400),coverage:e.payload.result.coverage,procedure_count:e.payload.result.procedures.length,evidence_count:e.payload.evidence_event_ids.length,source_coverage:e.payload.source_coverage,open_questions:e.payload.result.open_questions.slice(0,6),details_omitted:true};});}
export function learningStatus(s,c){init(s);const summaries=s.db.prepare("SELECT COUNT(*) n,MAX(occurred_at) latest FROM events WHERE event_type='learning.summary'").get();if(c?.role!=='collector')return {summary_count:summaries.n,last_summary_at:summaries.latest};return {summary_count:summaries.n,last_summary_at:summaries.latest,raw_unassigned:s.db.prepare("SELECT COUNT(*) n FROM events e LEFT JOIN personal_members m ON m.event_id=e.event_id WHERE m.event_id IS NULL AND e.event_type<>'learning.summary' AND e.device_id=?").get(c.device_id).n,open_batches:s.db.prepare("SELECT COUNT(*) n FROM personal_batches WHERE status='open'").get().n,pending_questions:s.db.prepare("SELECT COUNT(*) n FROM learning_requests WHERE state='open'").get().n,scheduler:'optional_local_worker_or_manual_codex'};}
export function requestLearning(s,{source_event_id,questions}){
 init(s);const source=event(s,source_event_id);assert(source?.event_type==='learning.summary','只能针对个人总结提出补证');
 assert(Array.isArray(questions)&&questions.length>0&&questions.length<=8&&questions.every(x=>typeof x==='string'&&x.trim()&&x.length<=1000),'补证问题格式无效');
 const json=canonical(questions);const prior=s.db.prepare('SELECT * FROM learning_requests WHERE source_event_id=?').all(source_event_id);const same=prior.find(x=>x.questions_json===json);if(same)return {...same,questions:JSON.parse(same.questions_json),questions_json:undefined};
 assert(prior.length<2,'同一总结最多两次补证；仍不清楚则等待新证据或交人工');
 // A response cannot recursively generate more requests and form an unbounded loop.
 assert(!source.payload.request_id,'补证答复不能再自动生成补证链；请等待新的工作证据');
 const row={request_id:uuid(),device_id:source.device_id,source_event_id,questions_json:json,state:'open',result_event_id:null};s.db.prepare('INSERT INTO learning_requests VALUES(?,?,?,?,?,?)').run(...Object.values(row));s.audit('learning.request',row.request_id);return {...row,questions,questions_json:undefined};
}
export function requestsFor(s,deviceId){init(s);return s.db.prepare("SELECT * FROM learning_requests WHERE device_id=? AND state='open' ORDER BY rowid LIMIT 10").all(deviceId).map(x=>({...x,questions:JSON.parse(x.questions_json),questions_json:undefined}));}
export function receiveRequests(s,c,requests=[]){init(s);assert(Array.isArray(requests)&&requests.length<=10,'补证队列无效');for(const r of requests){const source=event(s,r.source_event_id);assert(id(r.request_id)&&r.device_id===c.device_id&&source?.device_id===c.device_id&&source.event_type==='learning.summary'&&Array.isArray(r.questions)&&r.questions.length<=8&&r.questions.every(x=>typeof x==='string'&&x.length<=1000),'补证任务归属或内容无效');const json=canonical(r.questions);const prev=s.db.prepare('SELECT * FROM learning_requests WHERE request_id=?').get(r.request_id);if(prev){assert(prev.source_event_id===r.source_event_id&&prev.questions_json===json,'补证任务内容冲突');continue;}s.db.prepare('INSERT INTO learning_requests VALUES(?,?,?,?,?,?)').run(r.request_id,c.device_id,r.source_event_id,json,'open',null);}}
export function settleRequests(s,events){init(s);for(const e of events){if(e.event_type!=='learning.summary'||!e.payload.request_id)continue;const r=s.db.prepare('SELECT * FROM learning_requests WHERE request_id=?').get(e.payload.request_id);if(!r)continue;assert(r.device_id===e.device_id,'补证答复归属不匹配');s.db.prepare('UPDATE learning_requests SET state=?,result_event_id=? WHERE request_id=?').run(e.payload.request_state,e.event_id,r.request_id);}}
