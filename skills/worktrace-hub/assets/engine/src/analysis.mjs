import {deriveCandidates} from './candidates.mjs';
import {assert,uuid,canonical,hash,id} from './protocol.mjs';
export function initAnalysis(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS analysis_batches(batch_id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL,digest TEXT NOT NULL,result_json TEXT,finished_at TEXT);
 CREATE TABLE IF NOT EXISTS analysis_members(event_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,FOREIGN KEY(event_id) REFERENCES events(event_id),FOREIGN KEY(batch_id) REFERENCES analysis_batches(batch_id));
 CREATE INDEX IF NOT EXISTS analysis_members_batch ON analysis_members(batch_id);
 CREATE TABLE IF NOT EXISTS worker_hub_attempts(batch_id TEXT NOT NULL,day TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,reason TEXT,next_retry_day TEXT NOT NULL,PRIMARY KEY(batch_id,day),FOREIGN KEY(batch_id) REFERENCES analysis_batches(batch_id));
 CREATE INDEX IF NOT EXISTS worker_hub_attempts_day ON worker_hub_attempts(day,state);
`);}
function batchView(store,b){if(!b)return null;const rows=store.db.prepare('SELECT e.json FROM events e JOIN analysis_members m ON m.event_id=e.event_id WHERE m.batch_id=? ORDER BY e.rowid').all(b.batch_id);return {...b,result:b.result_json?JSON.parse(b.result_json):null,result_json:undefined,events:rows.map(r=>{const e=JSON.parse(r.json);return {event_id:e.event_id,employee_id:e.employee_id,device_id:e.device_id,occurred_at:e.occurred_at,event_type:e.event_type,case_id:e.context.case_id,task_id:e.payload.task_id||null,application:e.app.process_name,preview:(e.payload.text||e.payload.content_text||e.payload.input_summary||e.payload.reason||e.payload.result?.summary||'').slice(0,200),attachments:e.attachments};})};}
export function nextAnalysis(store,{employee='',limit=50,source='all'}={},{automaticDay=null}={}){
 initAnalysis(store);assert(['all','personal'].includes(source),'分析来源无效');assert(typeof employee==='string'&&employee.length<=80,'员工编号无效');assert(Number.isInteger(limit)&&limit>=1&&limit<=100,'批次最多 100 条');
 // Only the in-process worker supplies this third argument. Manual review
 // still receives the original open checkpoint, including raw/manual batches.
 assert(automaticDay===null||source==='personal'&&typeof automaticDay==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(automaticDay)&&new Date(automaticDay+'T00:00:00.000Z').toISOString().slice(0,10)===automaticDay,'自动分析日期无效');
 const automaticFilter=automaticDay?" AND NOT EXISTS(SELECT 1 FROM worker_hub_attempts a WHERE a.batch_id=analysis_batches.batch_id AND a.day=?) AND NOT EXISTS(SELECT 1 FROM analysis_members m JOIN events e ON e.event_id=m.event_id WHERE m.batch_id=analysis_batches.batch_id AND e.event_type<>'learning.summary')":'';
 const batchOrder=automaticDay?" ORDER BY (SELECT MAX(a.started_at) FROM worker_hub_attempts a WHERE a.batch_id=analysis_batches.batch_id AND a.state<>'budget_exhausted'),rowid":" ORDER BY rowid";
 const filter=source==='personal'?" AND e.event_type='learning.summary'":'';const db=store.db;db.exec('BEGIN IMMEDIATE');try{
  let b=db.prepare("SELECT * FROM analysis_batches WHERE status='open'"+(employee?' AND employee_id=?':'')+automaticFilter+batchOrder+' LIMIT 1').get(...(employee?[employee]:[]),...(automaticDay?[automaticDay]:[]));
  // Fresh/unattempted evidence gets a turn before a previously failed model
  // call. This also prevents one bad employee from taking a one-call budget
  // every new day while the other employees remain unprocessed.
  if(!b||automaticDay&&db.prepare("SELECT 1 FROM worker_hub_attempts WHERE batch_id=? AND state<>'budget_exhausted' LIMIT 1").get(b.batch_id)){
   const first=db.prepare('SELECT e.employee_id FROM events e LEFT JOIN analysis_members m ON m.event_id=e.event_id WHERE m.event_id IS NULL'+filter+(employee?' AND e.employee_id=?':'')+' ORDER BY e.rowid LIMIT 1').get(...(employee?[employee]:[]));
   if(first){
    const rows=db.prepare('SELECT e.event_id,e.hash FROM events e LEFT JOIN analysis_members m ON m.event_id=e.event_id WHERE m.event_id IS NULL AND e.employee_id=?'+filter+' ORDER BY e.rowid LIMIT ?').all(first.employee_id,limit);
    b={batch_id:uuid(),employee_id:first.employee_id,created_at:new Date().toISOString(),status:'open',digest:hash(canonical(rows)),result_json:null,finished_at:null};
    db.prepare('INSERT INTO analysis_batches VALUES(?,?,?,?,?,?,?)').run(...Object.values(b));
    const add=db.prepare('INSERT INTO analysis_members VALUES(?,?)');for(const r of rows)add.run(r.event_id,b.batch_id);
   }
  }
  const view=batchView(store,b);db.exec('COMMIT');return {batch:view,unassigned_events:db.prepare('SELECT COUNT(*) n FROM events e LEFT JOIN analysis_members m ON m.event_id=e.event_id WHERE m.event_id IS NULL').get().n,note:'单总控分析队列；已完成不重复投递，离线晚到事件仍会进入新批次。'};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function saveAnalysis(store,p){
 initAnalysis(store);assert(p&&id(p.batch_id)&&/^[a-f0-9]{64}$/.test(p.digest),'分析批次无效');
 const b=store.db.prepare('SELECT * FROM analysis_batches WHERE batch_id=?').get(p.batch_id);assert(b&&b.digest===p.digest,'批次不存在或摘要不匹配');
 const r=p.result;assert(r&&Object.keys(r).every(k=>['summary','findings','open_questions'].includes(k))&&typeof r.summary==='string'&&r.summary.length<=4000,'分析摘要无效');
 assert(Array.isArray(r.findings)&&r.findings.length<=40&&Array.isArray(r.open_questions)&&r.open_questions.length<=30&&r.open_questions.every(x=>typeof x==='string'&&x.length<=1000),'分析结果格式无效');
 const refs=new Set(store.db.prepare('SELECT event_id FROM analysis_members WHERE batch_id=?').all(p.batch_id).map(x=>x.event_id));
 for(const f of r.findings){assert(f&&Object.keys(f).every(k=>['statement','basis','evidence_event_ids'].includes(k))&&typeof f.statement==='string'&&f.statement.length>0&&f.statement.length<=2000&&['observed','hypothesis','unknown'].includes(f.basis),'结论必须区分观察、推断和未知');assert(Array.isArray(f.evidence_event_ids)&&f.evidence_event_ids.length<=100&&f.evidence_event_ids.every(x=>refs.has(x)),'结论引用了批次外或不存在的证据');assert(f.basis!=='observed'||f.evidence_event_ids.length>0,'观察事实必须引用证据');}
 const json=canonical(r);assert(json.length<=50000,'分析结果过大');if(b.status==='done'){assert(b.result_json===json,'已保存不同结果，禁止静默覆盖');return {saved:true,duplicate:true,batch_id:b.batch_id,candidates:deriveCandidates(store,b.batch_id)};}
 store.db.prepare("UPDATE analysis_batches SET status='done',result_json=?,finished_at=? WHERE batch_id=?").run(json,new Date().toISOString(),b.batch_id);store.audit('analysis.saved',b.batch_id);return {saved:true,duplicate:false,batch_id:b.batch_id,candidates:deriveCandidates(store,b.batch_id)};
}
export function analysisHistory(store,{employee='',limit=20}={}){initAnalysis(store);assert(typeof employee==='string'&&employee.length<=80&&Number.isInteger(limit)&&limit>0&&limit<=100,'历史查询无效');return store.db.prepare('SELECT * FROM analysis_batches'+(employee?' WHERE employee_id=?':'')+' ORDER BY rowid DESC LIMIT ?').all(...(employee?[employee]:[]),limit).map(b=>({...b,result:b.result_json?JSON.parse(b.result_json):null,result_json:undefined}));}
