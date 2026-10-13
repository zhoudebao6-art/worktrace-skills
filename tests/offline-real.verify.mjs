// Opt in: one real Sol/high call, only synthetic chemical text in an isolated DB.
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {startApp} from '../src/server.mjs';
import {FileEvidenceCollector,defaultFilePolicy} from '../src/file-evidence.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {defaultWorker} from '../src/worker.mjs';
import {listJobs,pendingReceipts} from '../src/jobs.mjs';
assert(process.env.WORKTRACE_TEST_CODEX,'Set WORKTRACE_TEST_CODEX to opt into one real model call');
const temp=resolve(process.env.TEMP,'worktrace-offline-real');mkdirSync(temp,{recursive:true});const dir=mkdtempSync(join(temp,'run-')),data=join(dir,'data'),docs=join(dir,'synthetic-docs');mkdirSync(docs);const app=await startApp({dir:data,port:0});
try{
 const response=await fetch(new URL('/api/setup',app.url),{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({role:'collector',offline:{format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC ONLY',employee_id:'CHEM_TEST',employee_name:'合成化工测试',label:'隔离文件验证'}})});assert(response.ok,await response.text());
 app.store.set('policy',{...defaultPolicy,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59'});
 const file=join(docs,'synthetic-chemical-notes.txt');writeFileSync(file,'仅为合成测试，不是真实员工工作或实验数据。\n原始材料：客户交底中组分 A:B=1:2，反应温度缺失。\n可观察操作记录：员工在合成文档中标注“温度待客户提供；暂不作出授权或实验结论”。没有消息发送回执、业务系统状态或真实检索结果。\n不得从此样本推断真实员工的能力。');
 const files=new FileEvidenceCollector({store:app.store,config:app.config,dir:data,root:resolve('.'),isActive:()=>true});files.configure({...defaultFilePolicy,enabled:true,roots:[docs],interval_seconds:30});await files.scan();const captured=await files.scan({now:new Date(Date.now()+31000)});assert.equal(captured.saved,1);
 app.worker.configure({...defaultWorker,enabled:true,codex_path:process.env.WORKTRACE_TEST_CODEX,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59',max_calls_per_day:1,timeout_seconds:240});await app.worker.tick();
 const jobs=listJobs(app.store);assert.equal(jobs.length,1);assert.equal(jobs[0].source,'local');assert.equal(jobs[0].state,'succeeded',JSON.stringify(jobs[0].result));assert.equal(pendingReceipts(app.store).length,0);
 const rows=app.store.db.prepare("SELECT json FROM events WHERE event_type='learning.summary'").all();assert.equal(rows.length,1);const summary=JSON.parse(rows[0].json);assert.equal(summary.payload.evidence_event_ids.length,1);assert.equal(app.worker.status().usage.calls,1);assert.equal(app.status().collection.enabled,false);assert.equal((await app.synchronize()).mode,'offline');
 const report={passed:true,synthetic_only:true,desktop_capture_started:false,no_hub:true,model:app.worker.policy.model,reasoning_effort:app.worker.policy.reasoning_effort,usage:app.worker.status().usage,source_event_ids:summary.payload.evidence_event_ids,summary:summary.payload.result,job_source:jobs[0].source,job_state:jobs[0].state,test_directory:dir};writeFileSync(join(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,model:report.model,reasoning_effort:report.reasoning_effort,usage:report.usage,report:join(dir,'verification.json')}));
}finally{await app.close();}
