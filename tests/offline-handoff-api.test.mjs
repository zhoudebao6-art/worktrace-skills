import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {admin} from '../src/admin-cli.mjs';
import {handoffCommand} from '../src/handoff-cli.mjs';
import {localApi} from '../src/local-api.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {defaultWorker} from '../src/worker.mjs';
import {importFileVersions} from '../src/file-evidence.mjs';
import {uuid,hash,canonical} from '../src/protocol.mjs';
import {enqueueJob,job,listJobs,pendingReceipts} from '../src/jobs.mjs';

const temp=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-handoff-api-tests');mkdirSync(temp,{recursive:true});
const password='仅合成测试-strong-passphrase-2026';
const freePort=()=>new Promise(resolvePort=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolvePort(port));});});
const summary={summary:'合成化工记录：原稿配比需要确认修改理由。',coverage:'content',limitations:['仅为合成材料，不证明真实办结'],procedures:[],open_questions:['核对原件与修改理由']};
async function fixture(t){
 const dir=mkdtempSync(join(temp,'run-')),apps=[];let modelCalls=0;
 const open=async path=>{const app=await startApp({dir:path,port:0,workerRunner:async()=>{modelCalls++;throw Error('real model forbidden in handoff integration test');}});apps.push(app);return app;};
 t.after(async()=>{for(const app of apps.reverse())await app.close();assert.equal(dirname(dir),temp);rmSync(dir,{recursive:true,force:true});});
 const c=await open(join(dir,'collector'));
 const input=join(dir,'synthetic-identity-input.json');writeFileSync(input,JSON.stringify({format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC COMPANY',employee_id:'CHEM_TEST',employee_name:'SYNTHETIC ONLY',label:'SYNTHETIC PC'}));
 const initialized=await admin({command:'init',role:'collector',dir:c.dir,input});assert.equal(initialized.connection_mode,'offline');assert.equal(c.collector.enabled,false);assert.equal(c.collector.child,null);
 // Replace capture lifecycle on this isolated fixture. Even restoration of an
 // enabled flag cannot launch the Windows observer or read the real desktop.
 const capture={starts:0,stops:0};c.collector.start=()=>{capture.starts++;c.collector.enabled=true;c.collector.state='synthetic enabled';};c.collector.stop=()=>{capture.stops++;c.collector.enabled=false;c.collector.state='synthetic paused';};
 const inputJSON=(name,value)=>{const file=join(dir,name+'.json');writeFileSync(file,JSON.stringify(value));return file;};
 const doc=(text='合成 A:B=1:2；温度 25°C；不得作为实测结果。')=>{const bytes=Buffer.from(text),sha256=hash(bytes),s=c.store,config=c.config;importFileVersions(s,[{sha256,mime:'text/plain',size:bytes.length,data:bytes}]);const event=s.append({schema_version:'1.2',event_id:uuid(),org_id:config.org_id,device_id:config.device_id,employee_id:config.employee_id,session_id:uuid(),occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',event_type:'document.version',collector_version:'0.4.0',policy_hash:s.policy(defaultPolicy),app:{process_name:'synthetic-file-reader',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{file_sha256:sha256,path:'D:\\SYNTHETIC-ONLY\\case.txt',extension:'.txt',mime:'text/plain',size:bytes.length,modified_at:new Date().toISOString(),previous_event_id:null,text,parser:'builtin-text',parser_version:'1.0',capture_status:'text_extracted',gaps:[]},attachments:[]});return {event,bytes,sha256};};
 return {dir,c,open,inputJSON,doc,capture,get modelCalls(){return modelCalls;}};
}

test('offline API handoff carries file evidence, summaries and local checkpoint; hub adoption/import is idempotent and preserves hub state',async t=>{
 const f=await fixture(t),{c}=f,source=f.doc();
 const batch=(await localApi(c.dir,'personal/next',{})).batch;assert(batch.events.some(e=>e.event_id===source.event.event_id));
 const saved=await localApi(c.dir,'personal/save',{batch_id:batch.batch_id,digest:batch.digest,result:summary});assert.equal(saved.sync,'awaiting_offline_handoff');
 const digest=await admin({command:'personal-digest',role:'collector',dir:c.dir});assert(readFileSync(digest.path,'utf8').includes(source.event.event_id));
 c.collector.record('activity.snapshot',{capture_status:'uia',text:'合成待处理材料：还没有修改结果。'});const pending=(await localApi(c.dir,'personal/next',{})).batch;
 const retryInput=f.inputJSON('retry-input',{idempotency_key:'explicit-synthetic-retry',message:'保留待处理批次用于移交'});
 const retry=await admin({command:'worker-retry-local',role:'collector',dir:c.dir,input:retryInput});assert.equal(retry.retry_batch_id,pending.batch_id);assert.equal(retry.source,'local');assert.equal(pendingReceipts(c.store).length,0);
 c.store.set('worker_daily_usage',{day:'2026-10-13',calls:2,usage_records:[]});c.store.set('source_only_probe',{keep:'local checkpoint'});
 const initialPolicy={...c.worker.policy,paused:false};await localApi(c.dir,'worker/configure',initialPolicy);c.collector.start();c.store.set('capture_enabled',true);
 const normalOutput=join(f.dir,'normal.wthandoff');const normal=await handoffCommand({action:'Export',dir:c.dir,output:normalOutput},password);assert.equal(normal.mode,'previous_state_restored');assert.equal(normal.source_retained,true);assert.equal(normal.sha256,hash(readFileSync(normalOutput)));assert.equal(c.collector.enabled,true);assert.equal(c.store.get('capture_enabled'),true);assert.equal(c.worker.policy.paused,false);assert.equal(captureChild(c),null);
 const finalOutput=join(f.dir,'finished.wthandoff');const exported=await handoffCommand({action:'Export',dir:c.dir,output:finalOutput,finish_pilot:true},password);assert.equal(exported.mode,'pilot_finished_paused');assert.equal(c.collector.enabled,false);assert.equal(c.store.get('capture_enabled'),false);assert.equal(c.worker.policy.paused,true);assert(existsSync(join(c.dir,'worktrace.sqlite')));assert.equal(job(c.store,retry.job_id).state,'queued');
 const identityOutput=join(f.dir,'identity-for-hub.json'),inspected=await handoffCommand({action:'Inspect',input:finalOutput,output:identityOutput},password);assert.equal(inspected.valid,true);assert.equal(inspected.counts.file_versions,1);assert.equal(inspected.counts.personal_summaries,1);assert.deepEqual(JSON.parse(readFileSync(identityOutput)),inspected.identity);assert.equal(inspected.identity.stream_id,c.store.get('stream_id'));
 await assert.rejects(()=>handoffCommand({action:'Inspect',input:finalOutput,output:join(f.dir,'wrong-password-identity.json')},'incorrect-password-2026'));assert.equal(existsSync(join(f.dir,'wrong-password-identity.json')),false);
 const hub=await f.open(join(f.dir,'hub')),hubInput=f.inputJSON('hub-setup',{org_name:'SYNTHETIC COMPANY',address:'127.0.0.1',hub_port:await freePort(),offline_identity:inspected.identity});await admin({command:'init',role:'hub',dir:hub.dir,input:hubInput});assert.equal(hub.config.org_id,c.config.org_id);assert.equal(hub.store.device(c.config.device_id).installation_id,c.config.installation_id);
 const hubStream=hub.store.get('stream_id'),hubPolicy=canonical(hub.worker.policy),hubJob=enqueueJob(hub.store,{device_id:c.config.device_id,kind:'message',idempotency_key:'hub-owned-job',message:'合成总控独立任务'});hub.store.set('worker_daily_usage',{day:'2026-10-13',calls:7,usage_records:[]});hub.store.set('hub_only_probe',{preserve:true});
 const imported=await handoffCommand({action:'Import',dir:hub.dir,input:finalOutput},password);assert.equal(imported.added,exported.counts.events);assert.equal(imported.file_versions_added,1);assert.equal(imported.local_state_imported,false);
 const repeated=await handoffCommand({action:'Import',dir:hub.dir,input:finalOutput},password);assert.equal(repeated.added,0);assert.equal(repeated.duplicates,imported.added);assert.equal(repeated.file_versions_added,0);
 assert.equal(hub.store.get('stream_id'),hubStream);assert.equal(canonical(hub.worker.policy),hubPolicy);assert.equal(hub.store.get('worker_daily_usage').calls,7);assert.deepEqual(hub.store.get('hub_only_probe'),{preserve:true});assert.equal(hub.store.get('source_only_probe'),null);assert.deepEqual(listJobs(hub.store).map(j=>j.job_id),[hubJob.job_id]);assert.equal(hub.store.db.prepare("SELECT COUNT(*) n FROM personal_batches WHERE status='open'").get().n,0);
 const history=await localApi(hub.dir,'personal/history?include_details=true');assert.equal(history.length,1);assert.equal(history[0].event_id,saved.event_id);assert(history[0].payload.evidence_event_ids.includes(source.event.event_id));
 const extraction=await admin({command:'file-extract',role:'hub',dir:hub.dir,input:f.inputJSON('extract-input',{event_id:source.event.event_id}),output:join(f.dir,'extracted-original.txt')});assert.equal(hash(readFileSync(extraction.path)),source.sha256);
 await assert.rejects(()=>handoffCommand({action:'Import',dir:hub.dir,input:finalOutput},'incorrect-password-2026'));assert.equal(listJobs(hub.store).length,1);assert.equal(hub.store.stats().events,exported.counts.events);
 // The original is closed before explicit same-host recovery is started.
 const originalIdentity={...c.config},originalStream=c.store.get('stream_id');await c.close();const recoveredDir=join(f.dir,'recovered');const recovered=await handoffCommand({action:'Recover',input:finalOutput,destination:recoveredDir},password);assert.equal(recovered.mode,'same_host_paused');assert.equal(recovered.service_started,false);assert(existsSync(join(recoveredDir,'SAME-HOST-PAUSED.json')));
 const recoveredApp=await f.open(recoveredDir);assert.equal(recoveredApp.config.device_id,originalIdentity.device_id);assert.equal(recoveredApp.config.installation_id,originalIdentity.installation_id);assert.equal(recoveredApp.store.get('stream_id'),originalStream);assert.equal(recoveredApp.collector.enabled,false);assert.equal(recoveredApp.collector.child,null);assert.equal(recoveredApp.worker.policy.paused,true);assert.equal(recoveredApp.store.get('worker_daily_usage').calls,2);assert.equal(job(recoveredApp.store,retry.job_id).state,'queued');
 assert.equal((await localApi(recoveredApp.dir,'personal/next',{})).batch.batch_id,pending.batch_id);assert.equal((await admin({command:'worker-retry-local',role:'collector',dir:recoveredApp.dir,input:retryInput})).job_id,retry.job_id);assert.equal((await recoveredApp.synchronize()).mode,'offline');
 const reviewDir=join(f.dir,'review-only');const review=await handoffCommand({action:'Restore',input:finalOutput,destination:reviewDir},password);assert.equal(review.mode,'review_only');assert.equal(existsSync(join(reviewDir,'config.json')),false);assert(existsSync(join(reviewDir,'REVIEW-ONLY.json')));await assert.rejects(()=>startApp({dir:reviewDir,port:0}),/仅供审阅/);assert.equal(existsSync(join(reviewDir,'running.json')),false);assert.equal(f.modelCalls,0);
});

function captureChild(app){return app.collector.child;}

test('failed exports report errors and restore flags, including FinishPilot; busy worker and invalid retry do not mutate state',async t=>{
 const f=await fixture(t),{c}=f;f.doc();const beforePolicy={...defaultWorker,model:'gpt-6.1-sol',enabled:false,paused:false};await localApi(c.dir,'worker/configure',beforePolicy);c.collector.start();c.store.set('capture_enabled',true);
 const protectedFile=join(f.dir,'must-not-overwrite.wthandoff');writeFileSync(protectedFile,'synthetic existing bytes');
 for(const finish_pilot of [false,true]){
  await assert.rejects(()=>handoffCommand({action:'Export',dir:c.dir,output:protectedFile,finish_pilot},password),/已存在/);assert.equal(readFileSync(protectedFile,'utf8'),'synthetic existing bytes');assert.equal(c.collector.enabled,true);assert.equal(c.store.get('capture_enabled'),true);assert.equal(canonical(c.worker.policy),canonical(beforePolicy));
  const output=join(f.dir,'short-password-'+finish_pilot+'.wthandoff');await assert.rejects(()=>handoffCommand({action:'Export',dir:c.dir,output,finish_pilot},'short'),/密码长度/);assert.equal(existsSync(output),false);assert.equal(c.collector.enabled,true);assert.equal(c.worker.policy.paused,false);
 }
 const marker=canonical(c.store.get('handoff_previous_state'));c.worker.busy=true;try{await assert.rejects(()=>handoffCommand({action:'Export',dir:c.dir,output:join(f.dir,'busy.wthandoff')},password),/正在完成/);}finally{c.worker.busy=false;}assert.equal(canonical(c.store.get('handoff_previous_state')),marker);assert.equal(c.collector.enabled,true);
 await assert.rejects(()=>localApi(c.dir,'worker/retry-local',{idempotency_key:'without-batch'}),/没有待恢复/);const pending=(await localApi(c.dir,'personal/next',{})).batch;assert(pending);
 await localApi(c.dir,'worker/configure',{...beforePolicy,enabled:true});try{await assert.rejects(()=>localApi(c.dir,'worker/retry-local',{idempotency_key:'must-pause'}),/暂停/);}finally{await localApi(c.dir,'worker/configure',{...beforePolicy,paused:true});}
 const retry=await localApi(c.dir,'worker/retry-local',{idempotency_key:'paused-explicit'});assert.equal(retry.retry_batch_id,pending.batch_id);assert.equal((await localApi(c.dir,'worker/retry-local',{idempotency_key:'paused-explicit'})).job_id,retry.job_id);assert.equal(f.modelCalls,0);
});
