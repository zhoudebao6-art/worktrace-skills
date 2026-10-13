import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {Store} from '../src/store.mjs';
import {uuid,hash} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {LearningWorker,defaultWorker} from '../src/worker.mjs';
import {nextPersonal,savePersonal} from '../src/learning.mjs';
import {importFileVersions} from '../src/file-evidence.mjs';
import {initJobs,job,listJobs,enqueueJob,enqueueLocalJob,transitionJob,outgoingJobs,receiveJobs,pendingReceipts,acceptReceipts,ackReceipts,nextJob} from '../src/jobs.mjs';

const temp=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-offline-worker-tests');mkdirSync(temp,{recursive:true});
const result={summary:'合成材料记录了核对内容，判断理由待补。',coverage:'content',limitations:['没有交付或办结凭据'],procedures:[],open_questions:['确认修改理由']};
const policy={...defaultWorker,enabled:true,start:'18:00',end:'23:59',timezone:'Asia/Shanghai'};
function fixture(t,runner=async()=>({result})){
 const dir=mkdtempSync(join(temp,'run-')),s=new Store(join(dir,'worktrace.sqlite'));
 const c={role:'collector',connection_mode:'offline',org_id:uuid(),device_id:uuid(),employee_id:'OFFLINE_TEST',employee_name:'SYNTHETIC',label:'SYNTHETIC'};s.addDevice(c);s.set('policy',defaultPolicy);
 let now=new Date('2026-10-12T11:00:00.000Z'),calls=0,implementation=runner,w;
 const makeWorker=()=>new LearningWorker({store:s,config:c,dir,clock:()=>new Date(now),runner:async input=>{calls++;return implementation(input);}});
 w=makeWorker();t.after(()=>{w.stop();s.close();const rel=relative(temp,dir);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});});
 const append=(event_type,payload,extra={})=>s.append({schema_version:event_type==='document.version'?'1.2':'1.0',event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:uuid(),occurred_at:now.toISOString(),timezone:'Asia/Shanghai',event_type,collector_version:'0.4.0',policy_hash:s.policy(defaultPolicy),app:{process_name:'synthetic-editor',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload,attachments:[],...extra});
 return {s,c,dir,get w(){return w;},get calls(){return calls;},get now(){return now;},setTime(at){now=new Date(at);},setRunner(fn){implementation=fn;},restart(){w.stop();w=makeWorker();return w;},record(text='合成化工材料：浓度和温度须核对原件。',type='activity.snapshot'){return append(type,{text,capture_status:text?'uia':'activity_only',idle_seconds:0,truncated:false,reason:''});},document(text='',previous=null){const bytes=Buffer.from(text||'%PDF synthetic original'),sha256=hash(bytes),mime=text?'text/plain':'application/pdf';importFileVersions(s,[{sha256,mime,size:bytes.length,data:bytes}]);return append('document.version',{file_sha256:sha256,path:'D:\\synthetic-only\\chemical'+(text?'.txt':'.pdf'),extension:text?'.txt':'.pdf',mime,size:bytes.length,modified_at:now.toISOString(),previous_event_id:previous,text,parser:text?'builtin-text':'original-only',parser_version:'1.0',capture_status:text?'text_extracted':'unparsed',gaps:text?[]:['未解析结构式，需要原件核对。']});},summaries(){return s.list({limit:1000}).items.filter(e=>e.event_type==='learning.summary');}};
}

test('offline schedule requires new work, enabled/unpaused settings and local workday/window',async t=>{
 const x=fixture(t);x.w.configure(policy);await x.w.tick();assert.equal(listJobs(x.s).length,0);x.record('','collector.started');await x.w.tick();assert.equal(listJobs(x.s).length,0);
 x.record();x.w.configure({...policy,enabled:false});await x.w.tick();x.w.configure({...policy,paused:true});await x.w.tick();assert.equal(listJobs(x.s).length,0);
 x.w.configure(policy);x.setTime('2026-10-12T08:00:00.000Z');await x.w.tick();x.setTime('2026-10-11T11:00:00.000Z');await x.w.tick();assert.equal(listJobs(x.s).length,0);
 x.setTime('2026-10-12T11:00:00.000Z');await x.w.tick();assert.equal(x.calls,1);const [j]=listJobs(x.s);assert.equal(j.source,'local');assert.equal(j.schedule_day,'2026-10-12');assert.equal(j.state,'succeeded');assert.equal(j.payload.max_batches,3);assert.equal(j.payload.limit,50);
 await x.w.tick();x.restart();await x.w.tick();assert.equal(x.calls,1);assert.equal(listJobs(x.s).length,1);assert.equal(x.w.status().local_schedule.has_new_work,false);
 x.setTime('2026-10-13T11:00:00.000Z');await x.w.tick();assert.equal(listJobs(x.s).length,1);
});

test('three bounded batches preserve excess raw evidence for the following local calendar day',async t=>{
 const seen=[];const x=fixture(t,async input=>{seen.push(JSON.parse(input.prompt.split('\nDATA\n')[1]));assert.equal(input.model,'gpt-6.1-sol');assert.equal(input.reasoningEffort,'high');return {result};});x.w.configure(policy);
 for(let i=0;i<160;i++)x.record('合成文本 #'+i);await x.w.tick();assert.equal(x.calls,3);assert.equal(x.summaries().length,3);assert.equal(x.w.status().local_schedule.pending_raw_events,10);assert(seen.every(d=>d.batch.source_coverage.new_events===50));
 await x.w.tick();assert.equal(x.calls,3);x.setTime('2026-10-13T11:00:00.000Z');await x.w.tick();assert.equal(x.calls,4);assert.equal(x.w.status().local_schedule.pending_raw_events,0);assert.equal(listJobs(x.s).length,2);assert.equal(x.w.status().usage.day,'2026-10-13');
 assert.match(x.w.status().local_schedule.remainder,/次日/);
});

test('daily usage budget leaves an unattempted batch eligible next day and excludes other task sources/devices',async t=>{
 const x=fixture(t);x.w.configure({...policy,max_calls_per_day:1});for(let i=0;i<55;i++)x.record('合成正文 #'+i);
 const hubJob=enqueueJob(x.s,{device_id:x.c.device_id,kind:'personal.summarize',idempotency_key:'retained-hub-job'});
 const other={...x.c,device_id:uuid(),employee_id:'OTHER'};x.s.addDevice(other);const otherJob=enqueueLocalJob(x.s,{device_id:other.device_id,idempotency_key:'other-local',schedule_day:'2026-10-12'},x.now);
 await x.w.tick();assert.equal(x.calls,1);assert.equal(x.summaries().length,1);assert.equal(x.w.status().local_schedule.checkpoint_requires_explicit_retry,false);assert.equal(job(x.s,hubJob.job_id).state,'queued');assert.equal(job(x.s,otherJob.job_id).state,'queued');
 assert.equal(x.s.db.prepare('SELECT COUNT(*) n FROM worker_local_attempts').get().n,1);await x.w.tick();assert.equal(x.calls,1);
 x.setTime('2026-10-13T11:00:00.000Z');await x.w.tick();assert.equal(x.calls,2);assert.equal(x.summaries().length,2);assert.equal(x.w.status().local_schedule.open_batch_id,null);
});

test('failed model is never retried by repeated ticks, restart or a later day; explicit retry is bound and idempotent',async t=>{
 const x=fixture(t,async()=>{throw Error('synthetic_result_uncertain');});x.w.configure(policy);const first=x.record();await x.w.tick();const state=x.w.status().local_schedule,batchId=state.open_batch_id;
 assert.equal(x.calls,1);assert.equal(state.checkpoint_requires_explicit_retry,true);assert.equal(state.checkpoint_attempt.state,'failed');await x.w.tick();x.restart();await x.w.tick();x.setTime('2026-10-13T11:00:00.000Z');await x.w.tick();assert.equal(x.calls,1);assert.equal(listJobs(x.s).length,1);
 assert.throws(()=>x.w.retryLocal({idempotency_key:'approved-one'}),/暂停/);x.w.configure({...policy,paused:true});const retry=x.w.retryLocal({idempotency_key:'approved-one',message:'明确重试此合成批次'});assert.equal(retry.retry_batch_id,batchId);assert.equal(retry.payload.max_batches,1);assert.equal(retry.source,'local');
 assert.equal(x.w.retryLocal({idempotency_key:'approved-one',message:'明确重试此合成批次'}).job_id,retry.job_id);assert.throws(()=>x.w.retryLocal({idempotency_key:'approved-one',message:'different'}),/幂等键/);await x.w.tick();assert.equal(x.calls,1);
 x.setRunner(async()=>({result}));x.w.configure(policy);await x.w.tick();assert.equal(x.calls,2);assert.equal(job(x.s,retry.job_id).state,'succeeded');assert(x.summaries()[0].payload.evidence_event_ids.includes(first.event_id));
 x.w.configure({...policy,paused:true});assert.equal(x.w.retryLocal({idempotency_key:'approved-one',message:'明确重试此合成批次'}).state,'succeeded');assert.throws(()=>x.w.retryLocal({idempotency_key:'new-after-done'}),/没有待恢复/);
 const reports=readdirSync(join(x.dir,'daily-reports')).filter(f=>f.endsWith('.md'));assert(reports.length>0);assert(reports.map(f=>readFileSync(join(x.dir,'daily-reports',f),'utf8')).join('\n').includes(first.event_id));
});

test('restart converts running local job and reserved call to interrupted without repeating the model',async t=>{
 const x=fixture(t);x.w.configure(policy);x.record();const j=x.w.scheduleLocal(),batch=nextPersonal(x.s,x.c).batch;transitionJob(x.s,j.job_id,'running',{test:true});x.w.takeBudget();
 x.s.db.prepare("INSERT INTO worker_local_attempts(job_id,batch_id,state,started_at) VALUES(?,?,'started',?)").run(j.job_id,batch.batch_id,x.now.toISOString());x.s.set('worker_active_call',{job_id:j.job_id,batch_id:batch.batch_id,source:'local'});
 x.restart();assert.equal(job(x.s,j.job_id).state,'interrupted');assert.equal(x.w.status().local_schedule.checkpoint_attempt.state,'interrupted');assert.equal(x.w.status().interrupted.job_id,j.job_id);await x.w.tick();x.setTime('2026-10-13T11:00:00.000Z');await x.w.tick();assert.equal(x.calls,0);assert.equal(x.w.status().usage.calls,1);
});

test('a paused result cannot be saved or automatically repeated',async t=>{
 let started,finish;const ready=new Promise(ok=>started=ok),x=fixture(t,()=>{started();return new Promise(ok=>finish=ok);});x.record();x.w.configure(policy);const running=x.w.tick();await ready;x.w.configure({...policy,paused:true});finish({result});await running;
 assert.equal(x.summaries().length,0);assert.equal(listJobs(x.s)[0].state,'blocked');assert.equal(x.w.status().local_schedule.checkpoint_attempt.state,'failed');x.w.configure(policy);await x.w.tick();assert.equal(x.calls,1);
});

test('unparsed original files consume no calls; parsed versions preserve original provenance in prompt',async t=>{
 let prompt;const x=fixture(t,async input=>{prompt=input.prompt;return {result};});const unparsed=x.document();x.w.configure(policy);await x.w.tick();assert.equal(x.calls,0);assert.equal(x.summaries()[0].payload.result.coverage,'metadata_only');assert(x.summaries()[0].payload.evidence_event_ids.includes(unparsed.event_id));
 x.setTime('2026-10-13T11:00:00.000Z');const first=x.document('合成原稿 H₂SO₄ 浓度 98%');const second=x.document('合成修改稿 H₂SO₄ 浓度 96%',first.event_id);await x.w.tick();assert.equal(x.calls,1);const data=JSON.parse(prompt.split('\nDATA\n')[1]);const version=data.evidence.find(e=>e.event_id===second.event_id);assert.equal(version.payload.previous_event_id,first.event_id);assert.equal(version.payload.file_sha256,second.payload.file_sha256);assert.deepEqual(version.payload.gaps,[]);assert.match(prompt,/化学式、结构式、数值/);assert.match(prompt,/文件保存不代表/);
});

test('stale explicit retry never reserves unrelated next evidence, and committed checkpoint recovery does not pay twice',async t=>{
 const x=fixture(t,async()=>{throw Error('synthetic_failure');});x.record();x.w.configure(policy);await x.w.tick();const batch=nextPersonal(x.s,x.c).batch;x.w.configure({...policy,paused:true});const retry=x.w.retryLocal({idempotency_key:'reconcile'});
 const saved=savePersonal(x.s,x.c,{batch_id:batch.batch_id,digest:batch.digest,result});x.s.db.prepare("UPDATE personal_batches SET status='open',result_event_id=NULL WHERE batch_id=?").run(batch.batch_id);
 x.w.configure(policy);await x.w.tick();assert.equal(x.calls,1);assert.equal(job(x.s,retry.job_id).state,'succeeded');assert.equal(x.summaries().length,1);assert.equal(x.summaries()[0].event_id,saved.event_id);
 x.w.configure({...policy,paused:true});const another=x.record('新批次合成证据');const newBatch=nextPersonal(x.s,x.c).batch;const stale=x.w.retryLocal({idempotency_key:'completed-manually'});savePersonal(x.s,x.c,{batch_id:newBatch.batch_id,digest:newBatch.digest,result});const untouched=x.record('不得由旧重试消费的证据');x.w.configure(policy);await x.w.tick();assert.equal(job(x.s,stale.job_id).state,'blocked');assert.equal(x.calls,1);assert(x.s.db.prepare('SELECT 1 FROM personal_members WHERE event_id=?').get(another.event_id));assert.equal(x.s.db.prepare('SELECT 1 FROM personal_members WHERE event_id=?').get(untouched.event_id),undefined);
});

test('previous-day queued daily jobs are superseded, and report failure preserves saved summary/job success',async t=>{
 const x=fixture(t);x.w.configure(policy);x.record();const queued=x.w.scheduleLocal();x.setTime('2026-10-13T11:00:00.000Z');writeFileSync(join(x.dir,'daily-reports'),'synthetic path collision');await x.w.tick();assert.equal(job(x.s,queued.job_id).state,'blocked');assert.equal(x.calls,1);assert.equal(x.summaries().length,1);assert.equal(listJobs(x.s)[0].state,'succeeded');assert.match(x.w.status().last_error,/daily_report/);
});

test('local jobs and receipts never enter hub transport; legacy rows migrate as hub and local spoofing is rejected',t=>{
 const x=fixture(t),hub=enqueueJob(x.s,{device_id:x.c.device_id,kind:'message',idempotency_key:'legacy'});x.s.db.exec('ALTER TABLE node_jobs DROP COLUMN source');initJobs(x.s);assert.equal(job(x.s,hub.job_id).source,'hub');
 const local=enqueueLocalJob(x.s,{device_id:x.c.device_id,idempotency_key:'local-only',schedule_day:'2026-10-12'},x.now);transitionJob(x.s,local.job_id,'succeeded',{summary_event_ids:[]});x.s.db.prepare('UPDATE node_jobs SET cancel_seen=1 WHERE job_id=?').run(local.job_id);assert.deepEqual(outgoingJobs(x.s,x.c.device_id).map(r=>r.spec.job_id),[hub.job_id]);assert.equal(outgoingJobs(x.s,x.c.device_id)[0].spec.source,undefined);assert.deepEqual(pendingReceipts(x.s),[]);
 assert.throws(()=>acceptReceipts(x.s,x.c.device_id,[{job_id:local.job_id,revision:1,state:'succeeded',result:{}}]),/不是 hub/);assert.throws(()=>ackReceipts(x.s,[{job_id:local.job_id,revision:1}]),/local/);
 const spec=JSON.parse(x.s.db.prepare('SELECT spec_json FROM node_jobs WHERE job_id=?').get(local.job_id).spec_json);assert.throws(()=>receiveJobs(x.s,x.c,[{spec}]),/伪装/);const hubSpec=outgoingJobs(x.s,x.c.device_id)[0].spec;assert.throws(()=>receiveJobs(x.s,x.c,[{spec:{...hubSpec,source:'hub',local_trigger:'daily'}}]),/伪装/);
 receiveJobs(x.s,x.c,[{spec:hubSpec}]);transitionJob(x.s,hub.job_id,'succeeded',{receipt:'synthetic'});assert.equal(pendingReceipts(x.s).length,1);ackReceipts(x.s,[{job_id:hub.job_id,revision:1}]);assert.equal(pendingReceipts(x.s).length,0);assert.equal(nextJob(x.s,x.now,null,{source:'local',device_id:x.c.device_id}),null);
 assert.throws(()=>enqueueLocalJob(x.s,{device_id:x.c.device_id,kind:'message',idempotency_key:'bad-kind',schedule_day:'2026-10-12'},x.now),/仅支持/);
});
