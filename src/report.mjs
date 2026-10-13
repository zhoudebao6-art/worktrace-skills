import {assert} from './protocol.mjs';
// Aggregate inside SQLite: do not send every screenshot/text body to the model.
export function report(store,{from='',to='',employee=''}={}){
 const valid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&!Number.isNaN(Date.parse(s));
 assert(valid(from)&&valid(to)&&from<=to&&Date.parse(to)-Date.parse(from)<=31*86400000,'请提供不超过 31 天的有效 UTC 毫秒时间范围');
 assert(typeof employee==='string'&&employee.length<=80,'员工编号无效');
 const where='occurred_at>=? AND occurred_at<=?'+(employee?' AND employee_id=?':'');const args=[from,to,...(employee?[employee]:[])];
 const q=sql=>store.db.prepare(sql.replaceAll('$WHERE',where)).all(...args);
 const count=q('SELECT COUNT(*) n FROM events WHERE $WHERE')[0].n;
 const devices=q('SELECT device_id,employee_id,COUNT(*) event_count,MIN(occurred_at) first_event,MAX(occurred_at) last_event FROM events WHERE $WHERE GROUP BY device_id,employee_id');
 const types=q('SELECT event_type,COUNT(*) count FROM events WHERE $WHERE GROUP BY event_type');
 const applications=q("SELECT employee_id,json_extract(json,'$.app.process_name') process_name,COUNT(*) samples FROM events WHERE $WHERE AND event_type='activity.snapshot' GROUP BY employee_id,process_name ORDER BY samples DESC LIMIT 100");
 const capture_status=q("SELECT json_extract(json,'$.payload.capture_status') capture_status,COUNT(*) count FROM events WHERE $WHERE AND event_type='activity.snapshot' GROUP BY capture_status");
 const versions=q("SELECT json_extract(json,'$.payload.source_kind') source_kind,COUNT(*) count FROM events WHERE $WHERE AND event_type='artifact.version' GROUP BY source_kind");
 const feedback=q("SELECT json_extract(json,'$.payload.decision') decision,json_extract(json,'$.payload.reason_source') reason_source,COUNT(*) count FROM events WHERE $WHERE AND event_type='artifact.feedback' GROUP BY decision,reason_source");
 const refs=q('SELECT event_id,employee_id,event_type,occurred_at FROM events WHERE $WHERE ORDER BY occurred_at DESC,event_id DESC LIMIT 20');
 return {format:'worktrace.report/1.0',from,to,employee:employee||null,event_count:count,devices,event_types:types,applications,capture_status,versions,feedback,evidence_refs:refs,limitations:['采样数量不代表工作时长、劳动效率或完整操作次数。','报告覆盖已到达本数据库的事件；离线未同步、空闲及采集缺口不能认定为未工作。','人工改稿表示实际版本差异；采用理由只以明确记录为依据。'],applications_truncated:applications.length===100};
}
