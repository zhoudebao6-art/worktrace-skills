import {statSync,statfsSync} from 'node:fs';
import {join} from 'node:path';
import {assert,id,SOFTWARE_VERSION} from './protocol.mjs';
import {inSchedule} from './collector.mjs';

// Deliberately on demand: this report scans evidence indexes, never the tray's
// frequent status path, and never treats a generated summary as verified skill.
export function readiness(store,config,{dir,status,query={},now=new Date()}){
 const limit=Number(query.limit??20),offset=Number(query.offset??0),deviceId=query.device_id||'';
 assert(Object.keys(query).every(k=>['device_id','limit','offset'].includes(k)),'未知 readiness 参数');
 assert(Number.isInteger(limit)&&limit>=1&&limit<=100&&Number.isInteger(offset)&&offset>=0,'readiness 分页无效');
 assert(!deviceId||id(deviceId),'设备编号无效');
 if(config?.role==='collector')assert(!deviceId||deviceId===config.device_id,'分控只能检查本设备');
 const findings=[],add=(code,severity,message,next_action,device_id)=>findings.push({code,severity,...(device_id?{device_id}:{}),message,next_action});
 const storage={database_bytes:0,wal_bytes:0,free_bytes:null};
 for(const [field,file] of [['database_bytes','worktrace.sqlite'],['wal_bytes','worktrace.sqlite-wal']])try{storage[field]=statSync(join(dir,file)).size;}catch(error){if(error.code!=='ENOENT')storage.error=error.code||error.message;}
 try{const disk=statfsSync(dir);storage.free_bytes=Number(disk.bavail)*Number(disk.bsize);}catch(error){storage.free_space_error=error.code||error.message;}
 if(storage.free_bytes!==null&&storage.free_bytes<1024**3)add('storage_low','warning','数据盘可用空间低于 1GiB。','暂停高容量取证并备份；检查原件和截图保留策略，不自动删除证据。');
 let devices=[],total=0;
 if(!config)add('not_configured','warning','尚未配置本机角色。','先明确总控或分控与原部署位置；不要重复初始化既有身份。');
 else{
  const scope=config.role==='collector'?config.device_id:deviceId,where='org_id=?'+(scope?' AND device_id=?':''),args=[config.org_id,...(scope?[scope]:[])];
  total=store.db.prepare('SELECT COUNT(*) n FROM devices WHERE '+where).get(...args).n;
  devices=store.db.prepare('SELECT device_id,employee_id,employee_name,revoked,last_seen FROM devices WHERE '+where+' ORDER BY employee_id,device_id LIMIT ? OFFSET ?').all(...args,limit,offset).map(device=>{
   const counts=store.db.prepare("SELECT SUM(CASE WHEN event_type<>'learning.summary' AND event_type NOT LIKE 'collector.%' THEN 1 ELSE 0 END) evidence_count,SUM(CASE WHEN event_type='learning.summary' THEN 1 ELSE 0 END) personal_summary_count,MAX(CASE WHEN event_type<>'learning.summary' AND event_type NOT LIKE 'collector.%' THEN occurred_at END) latest_evidence_at,MAX(CASE WHEN event_type='learning.summary' THEN occurred_at END) latest_summary_at FROM events WHERE org_id=? AND device_id=? AND employee_id=?").get(config.org_id,device.device_id,device.employee_id);
   const value={...device,...counts,evidence_count:counts.evidence_count||0,personal_summary_count:counts.personal_summary_count||0};value.needs_personal_summary=value.evidence_count>0&&value.personal_summary_count===0;
   if(value.needs_personal_summary)add('personal_summary_missing','warning','已有原始证据，尚无个人方法总结。',config.role==='hub'?'优先让原分控补做个人总结后再次移交；原分控不可用时暂停总控自动学习，以 analysis_next(source=all) 手动复盘，注明不能据此自动提炼个人候选。':'检查正文范围和个人批次；暂停自动学习后用 worktrace-personal 核验证据并保存总结。',device.device_id);
   if(!value.evidence_count)add('no_work_evidence','info','尚无实际工作证据；服务启动记录不计入。','在已授权范围内核对实际应用采样或原件版本。',device.device_id);
   if(device.revoked)add('device_revoked','warning','设备已被撤销。','核实管理记录；不要通过重建身份绕过撤销。',device.device_id);
   return value;
  });
  if(deviceId&&!total)add('device_not_found','warning','本公司数据库没有此设备。','核对设备编号和导入/登记结果。',deviceId);
  if(config.role==='collector'){
   if(!status.collection.enabled)add('capture_paused','info','采集当前暂停。','若为原有暂停状态应保持；需要记录时按已告知范围启动。');
   else if(!inSchedule(status.collection.policy,now))add('capture_outside_window','info','当前不在采集时段。','检查工作日、时区和时间设置。');
   if(!status.collection.policy.content_processes.length&&!status.files?.policy?.enabled&&!status.wechat?.policy?.enabled)add('metadata_only_scope','warning','未开启应用正文或文件版本取证。','窗口元数据不能还原详细方法；按实际软件配置并验收所需正文或指定工作目录。');
   if(status.wechat?.policy?.enabled){
    if(status.wechat.last_error||status.wechat.discovery_errors?.length)add('wechat_source_degraded','warning','微信数据库来源读取不完整；已保留检查点。','检查只读适配、账号及密钥状态；不清空游标，不通过切换窗口补采。');
    if(!status.wechat.last_success)add('wechat_no_success','warning','微信数据库采集尚无本次运行的成功记录。','先验证来源与实际工作时段的增量记录，不能把配置成功当作完整采集。');
    add('wechat_coverage_limited','info','微信数据库仅覆盖已落库、可读且在授权范围的记录；媒体为状态元数据。','核对发送人未知、分片发现、历史复核进度与媒体缺口，不据此声称全量无遗漏。');
   }
   if(config.connection_mode==='offline')add('offline_handoff_required','info','当前为独立离线分控，不与总控通信。','定期导出加密完整移交包；先 Inspect，再交给总控导入。');
   else if(status.sync.error)add('sync_error','warning',status.sync.error,'检查总控地址、网络、证书与设备登记；保留未确认数据。');
  }
  const worker=status.worker;
  if(worker){
   if(!worker.policy.enabled||worker.policy.paused)add('learning_paused','info','自动学习未启用或已暂停。','需要自动学习时核对本机 Codex 与角色模型；手动复盘期间保持暂停。');
   else if(!inSchedule(worker.policy,now))add('learning_outside_window','info','当前不在自动学习窗口。','等待允许时段，不以反复点击运行突破窗口。');
   if(worker.last_error)add('learning_error','warning',worker.last_error,'查看批次、预算和检查点；结果不确定时先核查，不盲目重试。');
   if(worker.local_schedule?.checkpoint_requires_explicit_retry)add('personal_checkpoint_pending','warning','个人学习有已尝试检查点。','暂停自动学习后手动完成，或明确 worker-retry-local；重试可能消耗额度。');
  }
 }
 for(const [name,task] of Object.entries(status.runtime.tasks))if(task.last_error)add('runtime_task_error','warning',name+': '+task.last_error,'查看对应运行记录；保留检查点并修复原因后重试。');
 return {format:'worktrace.readiness/1.0',version:SOFTWARE_VERSION,role:config?.role||null,mode:config?.role==='collector'?(config.connection_mode||'hub'):config?.role||'unconfigured',runtime:status.runtime,storage,wechat:status.wechat||null,devices,findings,pagination:{limit,offset,total,has_more:offset+devices.length<total},limitations:['记录数与总结数不代表岗位已学会、客户已回复或业务已完成。','本报告不调用模型、不启动采集、不检查其他电脑的实时桌面。','latest_evidence_at 是已有事件时间，导入记录不证明本机采集当前健康。']};
}
