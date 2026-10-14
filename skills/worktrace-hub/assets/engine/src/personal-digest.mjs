import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {assert} from './protocol.mjs';
import {defaultPolicy} from './collector.mjs';
const localDay=(timezone,date)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const plain=value=>String(value||'').replace(/[\r\n]+/g,' ').replace(/[#<>]/g,'');
export function personalDigest(store,config,{directory,day}={}){
 assert(config.role==='collector'&&typeof directory==='string','日报仅生成到分控本地目录');const timezone=(store.get('policy')||defaultPolicy).timezone;day=day||localDay(timezone,new Date());assert(/^\d{4}-\d{2}-\d{2}$/.test(day),'日报日期无效');
 // Bound by a UTC envelope; local calendar date is selected explicitly below.
 const start=new Date(Date.parse(day+'T00:00:00.000Z')-86400000).toISOString(),end=new Date(Date.parse(day+'T00:00:00.000Z')+2*86400000).toISOString();
 const summaries=store.db.prepare("SELECT json FROM events WHERE device_id=? AND event_type='learning.summary' AND occurred_at>=? AND occurred_at<? ORDER BY rowid").all(config.device_id,start,end).map(r=>JSON.parse(r.json)).filter(e=>localDay(timezone,new Date(e.occurred_at))===day);
 const mode=config.connection_mode==='offline'?'离线待人工移交':'联网，由本机服务同步';
 const lines=[`# ${day} 个人学习日报`,`${plain(config.employee_name)} / ${plain(config.employee_id)} · 总结保存日（${timezone}）`,`个人分析 · ${mode}；总结可能处理此前积压证据，不表示当天全部工作或业务已完成。`];
 if(!summaries.length)lines.push('尚无已保存总结。不能据此推断员工当天没有工作。');
 for(const e of summaries){const r=e.payload.result;lines.push(`\n## ${plain(r.summary)}`,`总结证据：${e.event_id}；覆盖：${r.coverage}；原始证据 ${e.payload.evidence_event_ids.join(', ')}`);
  const range=store.db.prepare("SELECT MIN(occurred_at) first,MAX(occurred_at) last FROM events WHERE event_id IN (SELECT value FROM json_each(?)) AND org_id=? AND employee_id=? AND device_id=? AND event_type<>'learning.summary'").get(JSON.stringify(e.payload.evidence_event_ids),config.org_id,config.employee_id,config.device_id);
  lines.push('本批引用原始证据的 UTC 范围：'+(range.first||'未知')+' 至 '+(range.last||'未知')+'；不表示该范围已完整覆盖。');
  const selection=store.get('personal_selection:'+e.payload.batch_id),coverage=e.payload.source_coverage;
  if(coverage)lines.push('本批新增归组事件 '+coverage.new_events+'；代表证据 '+coverage.representative_events+'；补入上下文 '+coverage.context_events+'。活动计数不是工时或完成率。');
  if(selection)lines.push('选样窗口扫描 '+selection.scanned+'/'+selection.scan_limit+'；窗口内未选 '+selection.unselected_in_window+'；窗口外仍有记录：'+(selection.has_more_beyond_window?'是':'否')+'。此数为领取时快照，不是当前积压总量。');
  else lines.push('旧批次没有选样窗口快照；不能推断当时已处理全部记录。');
  for(const p of r.procedures){lines.push(`\n### 候选方法：${plain(p.name)}`);for(const [label,value] of [['触发',p.trigger],['输入',p.inputs],['结果',p.outcome]])lines.push(`${label} [${value.basis}]：${plain(value.text)}（${value.evidence_event_ids.join(', ')}）`);for(const step of p.steps)for(const [label,value] of [['操作',step.action],['判断',step.decision],['核验',step.check]])lines.push(`- ${label} [${value.basis}]：${plain(value.text)}（${value.evidence_event_ids.join(', ')}）`);for(const x of p.exceptions)lines.push(`- 异常 [${x.basis}]：${plain(x.text)}`);for(const x of p.gaps)lines.push(`- 缺口：${plain(x)}`);if(p.corrections.length)lines.push('人工改动（结构化记录）：'+JSON.stringify(p.corrections));}for(const x of r.limitations)lines.push(`- 局限：${plain(x)}`);for(const x of r.open_questions)lines.push(`- 待核验：${plain(x)}`);}
 lines.push('\n候选方法不自动安装为 Skill；需要总控结合原始证据和留出案例进一步验收。');mkdirSync(directory,{recursive:true});const file=join(directory,day+'.md');writeFileSync(file+'.tmp',lines.join('\n\n')+'\n',{mode:0o600});renameSync(file+'.tmp',file);return {path:file,day,summaries:summaries.length,derived_from_database:true};
}
