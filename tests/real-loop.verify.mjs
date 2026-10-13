// Opt-in integration: exactly one Sol high and one Astra high call, synthetic data.
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {startApp} from '../src/server.mjs';
import {enqueueJob,job} from '../src/jobs.mjs';
import {defaultWorker} from '../src/worker.mjs';
assert(process.env.WORKTRACE_TEST_CODEX,'Set WORKTRACE_TEST_CODEX for explicit real model verification');
const temp=resolve(process.env.TEMP,'worktrace-real-loop');mkdirSync(temp,{recursive:true});const dir=mkdtempSync(join(temp,'run-')),apps=[];
const api=async(a,path,b)=>{const r=await fetch(new URL('/api/'+path,a.url),{method:b===undefined?'GET':'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const v=await r.json();assert(r.ok,JSON.stringify(v));return v;};
const free=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
try{
 const hub=await startApp({dir:join(dir,'hub'),port:0});apps.push(hub);await api(hub,'setup',{role:'hub',org_name:'SYNTHETIC REAL MODEL TEST',address:'127.0.0.1',hub_port:await free()});const enrollment=await api(hub,'devices',{employee_id:'TEST',employee_name:'TEST',label:'TEST'});
 const c=await startApp({dir:join(dir,'node'),port:0});apps.push(c);await api(c,'setup',{role:'collector',enrollment});
 c.collector.record('activity.snapshot',{capture_status:'uia',text:'合成测试记录：客户问“专利授权了吗”；客服打开案件详情，读取状态“待答复”，生成回复草稿“我先核对最新记录”。没有发送回执，也没有授权通知。此记录仅用于测试。'});
 const policy={...defaultWorker,enabled:true,codex_path:process.env.WORKTRACE_TEST_CODEX,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59',max_calls_per_day:1,timeout_seconds:240};
 c.worker.configure(policy);const j=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'real-loop-synthetic',max_batches:1});await c.synchronize();await c.worker.tick();assert.equal(job(c.store,j.job_id).state,'succeeded',JSON.stringify(job(c.store,j.job_id).result));await c.synchronize();const summaries=await api(hub,'personal/history?include_details=true');assert.equal(summaries.length,1);
 console.log(JSON.stringify({stage:'personal_saved',model:c.worker.policy.model,usage:c.worker.status().usage}));
 hub.worker.configure(policy);await hub.worker.tick();const analysis=await api(hub,'analysis/history');assert.equal(analysis[0].status,'done',hub.worker.lastError);const candidates=await api(hub,'candidates');
 assert.equal(c.worker.status().usage.calls,1);assert.equal(hub.worker.status().usage.calls,1);
 const report={passed:true,synthetic_only:true,physical_lan:false,real_models:true,tools_disabled:true,personal_usage:c.worker.status().usage,hub_usage:hub.worker.status().usage,summary:summaries[0].payload.result,analysis:analysis[0].result,candidate_count:candidates.length};writeFileSync('real-loop-verification.local.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{for(const a of apps.reverse())await a.close();}
