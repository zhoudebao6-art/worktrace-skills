import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {Store} from '../src/store.mjs';
import {uuid} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {LearningWorker,defaultWorker} from '../src/worker.mjs';
import {nextPersonal,savePersonal} from '../src/learning.mjs';
import {nextAnalysis} from '../src/analysis.mjs';
import {enqueueJob,outgoingJobs,receiveJobs,job,pendingReceipts,acceptReceipts,ackReceipts,transitionJob} from '../src/jobs.mjs';

const temp=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-loop-resilience');mkdirSync(temp,{recursive:true});
const policy={...defaultWorker,enabled:true,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59',timezone:'UTC',max_calls_per_day:6};
const result={summary:'Synthetic source was reviewed; outcome remains unverified.',coverage:'content',limitations:['Synthetic test only.'],procedures:[],open_questions:['Verify outcome.']};
const hubResult={summary:'Synthetic analysis only.',findings:[],open_questions:['Verify business result.']};
function fixture(t){
 const dir=mkdtempSync(join(temp,'run-')),stores=new Set(),workers=[];let now=new Date('2026-10-14T18:30:00.000Z');
 const store=name=>{const s=new Store(join(dir,name+'.sqlite'));stores.add(s);return s;};
 const config=(org=uuid(),employee='SYNTHETIC',mode='hub')=>({role:'collector',connection_mode:mode,org_id:org,device_id:uuid(),employee_id:employee,employee_name:'SYNTHETIC',label:'SYNTHETIC'});
 const raw=(s,c)=>s.append({schema_version:'1.0',event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:uuid(),occurred_at:now.toISOString(),timezone:'UTC',event_type:'activity.snapshot',collector_version:'0.4.1',policy_hash:s.policy(defaultPolicy),app:{process_name:'synthetic-editor',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{capture_status:'uia',text:'SYNTHETIC content',idle_seconds:0,truncated:false,reason:''},attachments:[]});
 const summary=(s,c)=>{raw(s,c);const batch=nextPersonal(s,c).batch;return savePersonal(s,c,{batch_id:batch.batch_id,digest:batch.digest,result}).event_id;};
 const worker=(s,c,runner)=>{const w=new LearningWorker({store:s,config:c,dir:join(dir,uuid()),clock:()=>new Date(now),runner});workers.push(w);return w;};
 t.after(()=>{for(const w of workers)w.stop();for(const s of stores)s.close();const rel=relative(temp,dir);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});});
 return {dir,store,config,raw,summary,worker,setTime:value=>{now=new Date(value);},reopen(s,name){s.close();stores.delete(s);return store(name);}};
}
const queued=(s,c,key,kind='personal.summarize')=>enqueueJob(s,{device_id:c.device_id,kind,idempotency_key:key,max_batches:1,not_before:'2026-10-14T00:00:00.000Z',expires_at:'2026-10-16T00:00:00.000Z'});
const countSummaries=s=>s.db.prepare("SELECT COUNT(*) n FROM events WHERE event_type='learning.summary'").get().n;

test('transport cursor survives restart and lost pages; future tasks do not hide messages or cancellations',async t=>{
 const x=fixture(t);let hub=x.store('hub');const node=x.store('node'),c=x.config();hub.addDevice(c);node.addDevice(c);let calls=0;
 const worker=x.worker(node,c,async()=>{calls++;throw Error('unexpected model');}),future=[];
 for(let i=0;i<30;i++)future.push(enqueueJob(hub,{device_id:c.device_id,kind:'personal.summarize',idempotency_key:'future-'+i,not_before:'2026-10-15T00:00:00.000Z',expires_at:'2026-10-16T00:00:00.000Z'}));
 receiveJobs(node,c,outgoingJobs(hub,c.device_id));assert.equal(node.db.prepare('SELECT COUNT(*) n FROM node_jobs').get().n,30);
 const message=queued(hub,c,'later-message','message');hub=x.reopen(hub,'hub');
 const dropped=outgoingJobs(hub,c.device_id);assert(dropped.some(r=>r.spec.job_id===message.job_id));
 transitionJob(hub,future[0].job_id,'cancelled',{reason:'hub_cancelled'});
 for(let i=0;i<4;i++){receiveJobs(node,c,outgoingJobs(hub,c.device_id));await worker.tick();const ack=acceptReceipts(hub,c.device_id,pendingReceipts(node));if(i>0)ackReceipts(node,ack);}
 assert.equal(job(node,message.job_id).state,'succeeded');assert.equal(job(hub,message.job_id).state,'succeeded');assert.equal(job(node,future[0].job_id).state,'cancelled');
 assert.equal(pendingReceipts(node).length,0);assert(!outgoingJobs(hub,c.device_id).some(r=>r.spec.job_id===future[0].job_id));assert.equal(node.db.prepare('SELECT COUNT(*) n FROM node_jobs').get().n,31);assert.equal(calls,0);
 assert.equal(job(node,future[1].job_id).state,'queued');
});

test('one failed hub checkpoint does not block another employee and is not retried on the same day or restart',async t=>{
 const x=fixture(t),s=x.store('hub'),org=uuid(),ids=[];for(const employee of ['FIRST','SECOND']){const c=x.config(org,employee);s.addDevice(c);ids.push(x.summary(s,c));}
 const attempted=[],runner=async input=>{const employee=JSON.parse(input.prompt.split('\nDATA\n')[1]).batch.employee_id;attempted.push(employee);if(employee==='FIRST')throw Error('synthetic_timeout');return {result:hubResult};};
 const c={role:'hub',org_id:org};let w=x.worker(s,c,runner);w.configure(policy);await w.tick();await w.tick();await w.tick();assert.deepEqual(attempted,['FIRST','SECOND']);
 const second=s.db.prepare('SELECT b.status FROM analysis_batches b JOIN analysis_members m ON m.batch_id=b.batch_id WHERE m.event_id=?').get(ids[1]);assert.equal(second.status,'done');
 const checkpoint=w.status().hub_schedule.recent_open_attempts[0];assert.equal(checkpoint.employee_id,'FIRST');assert.equal(checkpoint.state,'blocked');assert.equal(checkpoint.next_retry_day,'2026-10-15');assert.match(checkpoint.reason,/synthetic_timeout/);
 w.stop();w=x.worker(s,c,runner);await w.tick();assert.equal(attempted.length,2);x.setTime('2026-10-15T18:30:00.000Z');await w.tick();await w.tick();assert.deepEqual(attempted,['FIRST','SECOND','FIRST']);assert.equal(s.get('worker_daily_usage').calls,1);
 assert.equal(nextAnalysis(s,{source:'personal'}).batch.employee_id,'FIRST','manual review keeps the original open checkpoint');
});

test('a one-call daily budget rotates to an unattempted employee before retrying yesterday failure',async t=>{
 const x=fixture(t),s=x.store('hub'),org=uuid();for(const employee of ['FIRST','SECOND']){const c=x.config(org,employee);s.addDevice(c);x.summary(s,c);}
 const attempted=[],w=x.worker(s,{role:'hub',org_id:org},async input=>{const employee=JSON.parse(input.prompt.split('\nDATA\n')[1]).batch.employee_id;attempted.push(employee);if(employee==='FIRST')throw Error('synthetic_bad_batch');return {result:hubResult};});w.configure({...policy,max_calls_per_day:1});
 await w.tick();await w.tick();assert.deepEqual(attempted,['FIRST']);assert(w.status().hub_schedule.recent_open_attempts.some(a=>a.employee_id==='SECOND'&&a.state==='budget_exhausted'));
 x.setTime('2026-10-15T18:30:00.000Z');await w.tick();await w.tick();assert.deepEqual(attempted,['FIRST','SECOND']);assert.equal(s.get('worker_daily_usage').calls,1);
 x.setTime('2026-10-16T18:30:00.000Z');await w.tick();assert.deepEqual(attempted,['FIRST','SECOND','FIRST']);
});

test('legacy hub attempt migration prevents an upgrade retry, and manual raw batches remain untouched',async t=>{
 const x=fixture(t),s=x.store('hub'),org=uuid(),first=x.config(org,'LEGACY');s.addDevice(first);x.summary(s,first);const legacy=nextAnalysis(s,{source:'personal',limit:1}).batch;
 s.set('worker_hub_attempt','2026-10-14:'+legacy.batch_id);s.set('worker_active_call',{batch_id:legacy.batch_id,run_id:uuid(),at:'2026-10-14T18:00:00.000Z'});s.db.exec('DROP TABLE worker_hub_attempts');
 const second=x.config(org,'NEW');s.addDevice(second);x.summary(s,second);let calls=0;const w=x.worker(s,{role:'hub',org_id:org},async()=>{calls++;return {result:hubResult};});w.configure(policy);await w.tick();await w.tick();assert.equal(calls,1);
 assert.equal(w.status().hub_schedule.recent_open_attempts[0].state,'interrupted');assert.equal(w.status().interrupted.batch_id,legacy.batch_id);assert.equal(nextAnalysis(s,{source:'personal'}).batch.batch_id,legacy.batch_id);
 const rawStore=x.store('manual-raw'),rc=x.config(org,'RAW');rawStore.addDevice(rc);x.raw(rawStore,rc);const manual=nextAnalysis(rawStore,{limit:1}).batch;const good=x.config(org,'GOOD');rawStore.addDevice(good);x.summary(rawStore,good);
 let rawCalls=0;const rw=x.worker(rawStore,{role:'hub',org_id:org},async()=>{rawCalls++;return {result:hubResult};});rw.configure(policy);await rw.tick();assert.equal(rawCalls,1);assert.equal(nextAnalysis(rawStore).batch.batch_id,manual.batch_id);assert.equal(rawStore.db.prepare('SELECT status FROM analysis_batches WHERE batch_id=?').get(manual.batch_id).status,'open');
});

for(const change of ['window','change-and-restore','same-policy'])test('late collector result honours configuration generation: '+change,async t=>{
 const x=fixture(t),s=x.store('node'),c=x.config();s.addDevice(c);x.raw(s,c);let finish,ready,signal;const started=new Promise(ok=>ready=ok);
 const w=x.worker(s,c,input=>{signal=input.signal;ready();return new Promise(ok=>finish=ok);});w.configure(policy);const j=queued(s,c,change);const running=w.tick();await started;
 if(change==='same-policy')w.configure({...w.policy});else {w.configure({...policy,start:'20:00',end:'21:00'});if(change==='change-and-restore')w.configure(policy);}
 finish({result});await running;assert.equal(s.get('worker_daily_usage').calls,1);assert.equal(countSummaries(s),change==='same-policy'?1:0);assert.equal(job(s,j.job_id).state,change==='same-policy'?'succeeded':'blocked');assert.equal(signal.aborted,change!=='same-policy');
});

for(const role of ['collector','hub'])test('window closing discards late '+role+' result while retaining its budget and checkpoint',async t=>{
 const x=fixture(t),s=x.store(role),c=x.config();s.addDevice(c);if(role==='hub')x.summary(s,c);else x.raw(s,c);let finish,ready;const started=new Promise(ok=>ready=ok);
 const w=x.worker(s,role==='hub'?{role:'hub',org_id:c.org_id}:c,()=>{ready();return new Promise(ok=>finish=ok);});w.configure({...policy,start:'18:00',end:'19:00'});const j=role==='collector'?queued(s,c,'window-end'):null;
 const running=w.tick();await started;x.setTime('2026-10-14T19:01:00.000Z');finish({result:role==='hub'?hubResult:result});await running;assert.equal(s.get('worker_daily_usage').calls,1);
 if(j){assert.equal(job(s,j.job_id).state,'blocked');assert.equal(countSummaries(s),0);}else {assert.equal(s.db.prepare("SELECT COUNT(*) n FROM analysis_batches WHERE status='done'").get().n,0);assert.equal(w.status().hub_schedule.recent_open_attempts[0].state,'blocked');}
});

test('cancelled job ignores a late successful model and converges through receipts without another call',async t=>{
 const x=fixture(t),hub=x.store('hub'),s=x.store('node'),c=x.config();hub.addDevice(c);s.addDevice(c);x.raw(s,c);let finish,ready,calls=0;const started=new Promise(ok=>ready=ok);
 const w=x.worker(s,c,()=>{calls++;ready();return new Promise(ok=>finish=ok);});w.configure(policy);const j=queued(hub,c,'cancel-late');receiveJobs(s,c,outgoingJobs(hub,c.device_id));const running=w.tick();await started;
 transitionJob(hub,j.job_id,'cancelled',{reason:'hub_cancelled'});receiveJobs(s,c,outgoingJobs(hub,c.device_id));w.controller.abort();finish({result});await running;
 ackReceipts(s,acceptReceipts(hub,c.device_id,pendingReceipts(s)));await w.tick();assert.equal(job(s,j.job_id).state,'cancelled');assert.equal(job(hub,j.job_id).state,'cancelled');assert.equal(countSummaries(s),0);assert.equal(calls,1);assert.equal(s.get('worker_daily_usage').calls,1);assert.equal(pendingReceipts(s).length,0);assert.equal(outgoingJobs(hub,c.device_id).length,0);
});

test('offline network failure consumes one reservation, survives restart, and cannot repeat next day',async t=>{
 const x=fixture(t),s=x.store('offline'),c=x.config(uuid(),'OFFLINE','offline');s.addDevice(c);x.raw(s,c);let calls=0;const runner=async()=>{calls++;throw Error('synthetic_ECONNRESET_result_uncertain');};let w=x.worker(s,c,runner);w.configure(policy);await w.tick();await w.tick();assert.equal(calls,1);w.stop();w=x.worker(s,c,runner);x.setTime('2026-10-15T18:30:00.000Z');await w.tick();assert.equal(calls,1);assert.equal(s.get('worker_daily_usage').calls,1);assert.equal(w.status().local_schedule.checkpoint_requires_explicit_retry,true);assert.equal(countSummaries(s),0);
});
