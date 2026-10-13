import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {defaultWorker} from '../src/worker.mjs';
import {enqueueJob,listJobs,job,transitionJob,outgoingJobs,receiveJobs,acceptReceipts,pendingReceipts,nextJob} from '../src/jobs.mjs';
import {codexArgs} from '../src/codex-runner.mjs';
const temp=resolve(process.env.TEMP||'../../work','worktrace-worker-tests');mkdirSync(temp,{recursive:true});
const free=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
async function api(a,path,data){const r=await fetch(new URL('/api/'+path,a.url),{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
const policy={...defaultWorker,enabled:true,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59',max_calls_per_day:1};
async function setup(t,runner){const dir=mkdtempSync(join(temp,'run-')),apps=[];t.after(async()=>{for(const a of apps.reverse())await a.close();if(resolve(dir).startsWith(temp+'\\'))rmSync(dir,{recursive:true,force:true});});const hub=await startApp({dir:join(dir,'hub'),port:0,workerRunner:runner});apps.push(hub);await api(hub,'setup',{role:'hub',org_name:'WORKER TEST ONLY',address:'127.0.0.1',hub_port:await free()});const enrollment=await api(hub,'devices',{employee_id:'TEST',employee_name:'TEST',label:'TEST'});const c=await startApp({dir:join(dir,'node'),port:0,workerRunner:runner});apps.push(c);await api(c,'setup',{role:'collector',enrollment});return {hub,c,apps,dir};}
const result={summary:'仅活动证据，无法确认操作方法',coverage:'content',limitations:['没有正文'],procedures:[],open_questions:['需真实业务结果']};
test('总控下发→分控模型执行→总结回传→总控分析，幂等消息、预算和暂停',async t=>{
 let calls=0;const runner=async input=>{calls++;assert.equal(input.reasoningEffort,'xhigh');assert.equal(input.model,input.schema.properties.procedures?'gpt-6.1-sol':'gpt-6-astra');assert(codexArgs({cwd:input.dir,schemaFile:'schema',outputFile:'result',model:input.model,reasoningEffort:input.reasoningEffort}).includes('model_reasoning_effort="xhigh"'));if(input.schema.properties.procedures)return {result,usage:{input_tokens:100,output_tokens:20}};const data=JSON.parse(input.prompt.split('\nDATA\n')[1]);return {result:{summary:'合成总控分析',findings:[{statement:'员工总结仍缺业务结果',basis:'observed',evidence_event_ids:[data.batch.events[0].event_id]}],open_questions:['补充结果证据']},usage:{input_tokens:100,output_tokens:20}};};
 const {hub,c}=await setup(t,runner);c.collector.record('activity.snapshot',{capture_status:'uia',text:'合成业务证据：员工核对任务进度。'});
 const query=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'node.status',idempotency_key:'status1'});await c.synchronize();await c.worker.tick();await c.synchronize();assert.equal(job(hub.store,query.job_id).state,'succeeded');assert.equal(calls,0);
 const j=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'night1'});assert.equal(enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'night1'}).job_id,j.job_id);await c.synchronize();await c.worker.tick();assert.equal(job(c.store,j.job_id).state,'queued');assert.equal(calls,0);
 c.worker.configure(policy);await c.worker.tick();await c.synchronize();assert.equal(calls,1);assert.equal(job(hub.store,j.job_id).state,'succeeded');assert.equal((await api(hub,'personal/history')).length,1);c.store.set('sync_cursor',0);await c.synchronize();await c.worker.tick();assert.equal(calls,1);
 hub.worker.configure(policy);await hub.worker.tick();assert.equal(calls,2);assert.equal((await api(hub,'analysis/history'))[0].status,'done');await hub.worker.tick();assert.equal(calls,2);
 c.collector.record('activity.snapshot',{capture_status:'uia',text:'合成业务证据：员工核对任务进度。'});const j2=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'night2'});await c.synchronize();await c.worker.tick();assert.equal(job(c.store,j2.job_id).state,'blocked');assert.equal(calls,2);
 const note=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'message',idempotency_key:'note1',message:'请保留缺口，不要操作微信。'});c.worker.configure({...policy,paused:true});await c.synchronize();await c.worker.tick();await c.synchronize();assert.equal(job(hub.store,note.job_id).result.employee_read,false);assert.equal(calls,2);
 const cancel=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'cancel1'});transitionJob(hub.store,cancel.job_id,'cancelled',{reason:'hub_cancelled'});await c.synchronize();await c.worker.tick();assert.equal(job(c.store,cancel.job_id).state,'cancelled');assert.equal(calls,2);assert.throws(()=>enqueueJob(hub.store,{device_id:c.config.device_id,kind:'shell.exec',idempotency_key:'bad'}),/类型/);
});
test('模型失败保留检查点，中断不盲目重跑',async t=>{
 let calls=0;const {hub,c,apps}=await setup(t,async()=>{calls++;throw Error('synthetic_model_timeout');});c.worker.configure(policy);c.collector.record('activity.snapshot',{capture_status:'uia',text:'合成业务证据：员工核对任务进度。'});const j=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'failure1'});await c.synchronize();await c.worker.tick();assert.equal(job(c.store,j.job_id).state,'blocked');assert.equal(c.store.db.prepare("SELECT COUNT(*) n FROM personal_batches WHERE status='open'").get().n,1);await c.worker.tick();assert.equal(calls,1);
 const j2=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'interrupted1'});await c.synchronize();transitionJob(c.store,j2.job_id,'running',{test:true});await c.close();const restarted=await startApp({dir:c.dir,port:0,workerRunner:async()=>{calls++;return {result};}});apps.push(restarted);assert.equal(job(restarted.store,j2.job_id).state,'interrupted');await restarted.worker.tick();assert.equal(calls,1);
});
test('Codex 执行参数隔离用户 MCP、命令行和桌面工具，不复制登录凭据',()=>{const args=codexArgs({cwd:'D:\\test',schemaFile:'D:\\test\\schema.json',outputFile:'D:\\test\\result.json',model:'',images:[]});assert(args.includes('--ignore-user-config'));assert(args.includes('--ignore-rules'));assert(args.includes('read-only'));for(const f of ['shell_tool','unified_exec','apps','plugins','hooks','computer_use']){const at=args.indexOf(f);assert(at>0&&args[at-1]==='--disable');}assert(!args.includes('--dangerously-bypass-approvals-and-sandbox'));assert.equal(args.at(-1),'-');});

test('取消确认收敛、节点消息双向传送、外设备任务拒绝与未来任务不阻塞',async t=>{
 const {hub,c}=await setup(t,async()=>{throw Error('no model expected');});
 const j=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'message',idempotency_key:'dialog',message:'核对资料覆盖范围'});
 const incoming=outgoingJobs(hub.store,c.config.device_id);assert.throws(()=>receiveJobs(c.store,{device_id:'00000000-0000-4000-8000-000000000000'},incoming),/不属于本机/);
 await c.synchronize();await c.worker.tick();await api(c,'replies/create',{job_id:j.job_id,text:'分控 AI：现有资料没有办结回执。'});await c.synchronize();await c.synchronize();const replies=await api(hub,'replies');assert.equal(replies.length,1);assert.equal(replies[0].author,'node_codex');await assert.rejects(()=>api(c,'replies/create',{job_id:j.job_id,text:'改写'}),/禁止覆盖/);
 assert.throws(()=>acceptReceipts(hub.store,'00000000-0000-4000-8000-000000000000',[{job_id:j.job_id,revision:3,state:'succeeded',result:{}}]),/不属于/);
 const cancel=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'cancel-converge'});transitionJob(hub.store,cancel.job_id,'cancelled',{reason:'hub_cancelled'});await c.synchronize();assert(pendingReceipts(c.store).some(r=>r.cancel_seen));await c.synchronize();assert(!outgoingJobs(hub.store,c.config.device_id).some(x=>x.spec.job_id===cancel.job_id));assert.equal(pendingReceipts(c.store).length,0);
 for(let i=0;i<105;i++)enqueueJob(c.store,{device_id:c.config.device_id,kind:'node.status',idempotency_key:'future'+i,not_before:new Date(Date.now()+3600000).toISOString()});const immediate=enqueueJob(c.store,{device_id:c.config.device_id,kind:'node.status',idempotency_key:'due-now'});assert.equal(nextJob(c.store).job_id,immediate.job_id);
});

test('纯活动记录不调用模型；自动模式排斥手动学习；模型按角色固定 xhigh',async t=>{
 let calls=0;const {hub,c}=await setup(t,async()=>{calls++;throw Error('unexpected model');});c.worker.configure(policy);hub.worker.configure(policy);
 assert.equal(c.worker.policy.model,'gpt-6.1-sol');assert.equal(hub.worker.policy.model,'gpt-6-astra');assert.equal(c.worker.policy.reasoning_effort,'xhigh');assert.throws(()=>c.worker.configure({...policy,model:'gpt-6-astra'}),/角色/);
 assert(codexArgs({cwd:'.',schemaFile:'schema',outputFile:'result',model:c.worker.policy.model}).includes('model_reasoning_effort="xhigh"'));
 for(const app of [c,hub]){app.store.set('worker_policy',{...policy,reasoning_effort:'high'});assert.equal(app.worker.policy.reasoning_effort,'xhigh');assert.throws(()=>app.worker.configure({...policy,reasoning_effort:'high'}),/xhigh/);app.worker.configure({...app.worker.policy});assert.equal(app.store.get('worker_policy').reasoning_effort,'xhigh');}
 await assert.rejects(()=>api(c,'personal/next',{}),/暂停/);await assert.rejects(()=>api(hub,'analysis/next',{}),/暂停/);
 c.collector.record('activity.snapshot',{capture_status:'activity_only'});enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'metadata'});await c.synchronize();await c.worker.tick();await c.synchronize();await hub.worker.tick();assert.equal(calls,0);assert.equal((await api(hub,'personal/history'))[0].coverage,'metadata_only');
});

test('执行中暂停后模型即使返回也不提交总结，保留批次以便恢复',async t=>{
 let started,finish;const ready=new Promise(ok=>started=ok);const {hub,c}=await setup(t,()=>{started();return new Promise(ok=>finish=ok);});c.worker.configure(policy);c.collector.record('activity.snapshot',{capture_status:'uia',text:'合成客户进度资料'});const j=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'personal.summarize',idempotency_key:'pause-active'});await c.synchronize();const running=c.worker.tick();await ready;c.worker.configure({...policy,paused:true});finish({result});await running;assert.equal(job(c.store,j.job_id).state,'blocked');assert.equal(c.store.db.prepare("SELECT COUNT(*) n FROM events WHERE event_type='learning.summary'").get().n,0);assert.equal(c.store.db.prepare("SELECT COUNT(*) n FROM personal_batches WHERE status='open'").get().n,1);
});
