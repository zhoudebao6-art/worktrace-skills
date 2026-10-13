import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hostname} from 'node:os';
import {Store} from '../src/store.mjs';
import {uuid,hash,canonical} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {nextPersonal,savePersonal} from '../src/learning.mjs';
import {nextAnalysis,saveAnalysis} from '../src/analysis.mjs';
import {enqueueLocalJob,enqueueJob,job} from '../src/jobs.mjs';
import {importFileVersions} from '../src/file-evidence.mjs';
import {createOfflineHandoff,inspectOfflineHandoff,restoreOfflineHandoff,importOfflineHandoff} from '../src/offline-handoff.mjs';

const root=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-handoff-tests');mkdirSync(root,{recursive:true});const password='synthetic-password-only-2026';
function fixture(t){
 const dir=mkdtempSync(join(root,'case-')),data=join(dir,'data');let store=new Store(join(data,'worktrace.sqlite'));const stores=[];t.after(()=>{store.close();for(const s of stores)s.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});
 const config={role:'collector',connection_mode:'offline',org_id:uuid(),org_name:'SYNTHETIC COMPANY',device_id:uuid(),employee_id:'CHEM001',employee_name:'SYNTHETIC EMPLOYEE',label:'SYNTHETIC PC',installation_id:uuid(),host_binding:hash('synthetic-host'),device_token:'DO-NOT-COPY-TOKEN',cert_password:'DO-NOT-COPY-CERT',ca_pem:'DO-NOT-COPY-CERTIFICATE'};
 store.addDevice(config);store.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(config.installation_id,config.device_id);store.db.exec('PRAGMA wal_autocheckpoint=0');
 const policyHash=store.policy(defaultPolicy);
 const base=()=>({schema_version:'1.0',event_id:uuid(),org_id:config.org_id,device_id:config.device_id,employee_id:config.employee_id,session_id:uuid(),occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',event_type:'activity.snapshot',collector_version:'synthetic-test',policy_hash:policyHash,app:{process_name:'synthetic.exe',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{text:'合成化工工作材料，不是真实客户资料',capture_status:'uia',idle_seconds:0,truncated:false,reason:''},attachments:[]});
 const raw=()=>store.append(base());
 const image=Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]),imageHash=hash(image);const e=base();e.attachments=[{sha256:imageHash,size:image.length,mime:'image/jpeg',kind:'window_capture'}];store.append(e,[{sha256:imageHash,mime:'image/jpeg',data:image.toString('base64')}]);
 const bytes=Buffer.from('合成配方：组分 A 10%，仅供测试。'),fileHash=hash(bytes);importFileVersions(store,[{sha256:fileHash,mime:'text/plain',size:bytes.length,data:bytes}]);
 const doc={...base(),schema_version:'1.2',event_type:'document.version',payload:{file_sha256:fileHash,path:'D:\\SYNTHETIC-ALLOWED\\case.txt',extension:'.txt',mime:'text/plain',size:bytes.length,modified_at:new Date().toISOString(),previous_event_id:null,text:bytes.toString(),parser:'builtin-text',parser_version:'1.0',capture_status:'text_extracted',gaps:[]}};store.append(doc);
 const batch=nextPersonal(store,config,{limit:50}).batch;const claim={text:'观察合成材料中的配比文字',basis:'observed',evidence_event_ids:[doc.event_id]};const summary=savePersonal(store,config,{batch_id:batch.batch_id,digest:batch.digest,result:{summary:'合成化工方法总结，尚未业务验收',coverage:'content',limitations:['仅合成材料'],procedures:[{name:'合成材料核对',task_id:null,case_id:null,trigger:claim,inputs:claim,steps:[{action:claim,decision:{text:'真实判断理由未知',basis:'unknown',evidence_event_ids:[]},check:claim}],outcome:claim,exceptions:[],corrections:[],gaps:['缺实际业务结果']}],open_questions:[]}});
 const analysis=nextAnalysis(store,{source:'personal'}).batch;saveAnalysis(store,{batch_id:analysis.batch_id,digest:analysis.digest,result:{summary:'合成试验的分析记录',findings:[{statement:'保留候选和来源',basis:'observed',evidence_event_ids:[summary.event_id]}],open_questions:[]}});
 raw();const openBatch=nextPersonal(store,config,{limit:50}).batch;const queued=enqueueLocalJob(store,{device_id:config.device_id,idempotency_key:'local:synthetic:2026-10-13',schedule_day:'2026-10-13'});
 store.set('capture_enabled',true);store.set('worker_policy',{enabled:true,paused:true,model:'gpt-6.1-sol',reasoning_effort:'high'});store.set('worker_daily_usage',{day:'2026-10-13',calls:2,usage_records:[]});store.set('worker_active_call',{run_id:uuid(),batch_id:openBatch.batch_id,at:new Date().toISOString()});store.set('sync_cursor',2);
 store.db.exec("CREATE TABLE checkpoint_probe(key TEXT PRIMARY KEY,value TEXT); INSERT INTO checkpoint_probe VALUES('delete-me','first'); INSERT INTO checkpoint_probe VALUES('keep','second'); DELETE FROM checkpoint_probe WHERE key='delete-me'");
 writeFileSync(join(data,'config.json'),JSON.stringify(config));writeFileSync(join(data,'hub.pfx'),'PRIVATE-KEY-DO-NOT-COPY');writeFileSync(join(data,'codex-auth.json'),'LOGIN-DO-NOT-COPY');
 const tempDir=join(dir,'scratch'),output=join(dir,'handoff.wth');const options={output,password,tempDir};
 function hub({adopt=true,org=config.org_id}={}){const s=new Store(join(dir,'hub-'+uuid()+'.sqlite'));stores.push(s);if(adopt)s.addDevice({...config,org_id:org});return {store:s,config:{role:'hub',org_id:org}};}
 return {dir,data,store,config,raw,image,imageHash,bytes,fileHash,doc,summary,openBatch,queued,output,tempDir,options,hub};
}

test('完整移交：运行中的 WAL 备份保留全部表、rowid、文件/截图和未完成状态，恢复默认为审阅',async t=>{
 const f=fixture(t);assert(statSync(join(f.data,'worktrace.sqlite-wal')).size>0);
 const originalTables=f.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
 const result=await createOfflineHandoff(f.store,f.config,{...f.options,source:{base_version:'0.3.0',derived_version:'0.4.0',source_commit:'synthetic'}});assert.equal(result.sha256,hash(readFileSync(f.output)));assert.equal(result.manifest.identity.installation_id,f.config.installation_id);assert.deepEqual(Object.keys(result.manifest.tables),originalTables);assert.equal(result.manifest.counts.file_versions,1);assert.equal(result.manifest.counts.assets,1);
 assert(!JSON.stringify(result.manifest).includes('DO-NOT-COPY'));assert(!readFileSync(f.output).includes(Buffer.from('合成配方')));
 const inspected=await inspectOfflineHandoff({input:f.output,password,tempDir:f.tempDir});assert.equal(inspected.valid,true);assert.equal(inspected.manifest.local_state.capture_enabled,true);
 const restored=await restoreOfflineHandoff({input:f.output,password,tempDir:f.tempDir,directory:join(f.dir,'review')});assert.equal(restored.mode,'review_only');assert.deepEqual(readdirSync(restored.directory).sort(),['REVIEW-ONLY.json','handoff-manifest.json','worktrace.sqlite']);assert(!existsSync(join(restored.directory,'config.json')));
 const db=new DatabaseSync(restored.database,{readOnly:true});try{
  assert.deepEqual(db.prepare('SELECT rowid,key,value FROM checkpoint_probe').all(),f.store.db.prepare('SELECT rowid,key,value FROM checkpoint_probe').all());
  assert.deepEqual(db.prepare('SELECT * FROM personal_batches WHERE batch_id=?').get(f.openBatch.batch_id),f.store.db.prepare('SELECT * FROM personal_batches WHERE batch_id=?').get(f.openBatch.batch_id));
  assert.equal(db.prepare('SELECT state FROM node_jobs WHERE job_id=?').get(f.queued.job_id).state,'queued');assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='worker_daily_usage'").get().value),f.store.get('worker_daily_usage'));
  assert(Buffer.from(db.prepare('SELECT data FROM file_versions WHERE sha256=?').get(f.fileHash).data).equals(f.bytes));assert(Buffer.from(db.prepare('SELECT data FROM assets WHERE sha256=?').get(f.imageHash).data).equals(f.image));
  assert.deepEqual(db.prepare('SELECT event_id,json,hash FROM events ORDER BY rowid').all(),f.store.db.prepare('SELECT event_id,json,hash FROM events ORDER BY rowid').all());
 }finally{db.close();}assert.deepEqual(readdirSync(f.tempDir),[]);assert.equal(f.store.get('capture_enabled'),true);assert.equal(job(f.store,f.queued.job_id).state,'queued');
});

test('完整移交：总控接纳原身份后增量汇入引用链，重复导入幂等且不覆盖本地任务和检查点',async t=>{
 const f=fixture(t);await createOfflineHandoff(f.store,f.config,f.options);const h=f.hub(),hubStream=h.store.get('stream_id');h.store.set('sync_cursor',77);const hubJob=enqueueJob(h.store,{device_id:f.config.device_id,kind:'message',idempotency_key:'hub-owned-job'});
 const opts={input:f.output,password,tempDir:f.tempDir};const first=await importOfflineHandoff(h.store,h.config,opts);assert.equal(first.added,f.store.stats().events);assert.equal(first.assets_added,1);assert.equal(first.file_versions_added,1);assert.equal(first.local_state_imported,false);
 assert.deepEqual(h.store.db.prepare('SELECT event_id,json,hash FROM events ORDER BY rowid').all(),f.store.db.prepare('SELECT event_id,json,hash FROM events ORDER BY rowid').all());assert.equal(h.store.get('stream_id'),hubStream);assert.equal(h.store.get('sync_cursor'),77);assert.equal(job(h.store,hubJob.job_id).state,'queued');assert.equal(job(h.store,f.queued.job_id),null);
 const second=await importOfflineHandoff(h.store,h.config,opts);assert.equal(second.added,0);assert.equal(second.duplicates,f.store.stats().events);assert.equal(second.assets_added,0);assert.equal(second.file_versions_added,0);
 f.raw();const later=join(f.dir,'later.wth');await createOfflineHandoff(f.store,f.config,{...f.options,output:later});assert.equal((await importOfflineHandoff(h.store,h.config,{...opts,input:later})).added,1);
});

test('完整移交：异组织、未接纳设备、员工或安装身份冲突均拒绝',async t=>{
 const f=fixture(t);await createOfflineHandoff(f.store,f.config,f.options);const opts={input:f.output,password,tempDir:f.tempDir};
 const foreign=f.hub({org:uuid()});await assert.rejects(importOfflineHandoff(foreign.store,foreign.config,opts),/另一公司/);assert.equal(foreign.store.stats().events,0);
 const missing=f.hub({adopt:false});await assert.rejects(importOfflineHandoff(missing.store,missing.config,opts),/接纳原设备/);
 const wrong=f.hub();wrong.store.db.prepare('UPDATE devices SET employee_id=? WHERE device_id=?').run('ANOTHER',f.config.device_id);await assert.rejects(importOfflineHandoff(wrong.store,wrong.config,opts),/接纳原设备/);
 const installation=f.hub();installation.store.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(uuid(),f.config.device_id);await assert.rejects(importOfflineHandoff(installation.store,installation.config,opts),/其他安装实例/);
});

test('完整移交：后续批次事件冲突时整个导入回滚，包括先写入的原件和截图',async t=>{
 const f=fixture(t);for(let i=0;i<60;i++)f.raw();await createOfflineHandoff(f.store,f.config,f.options);const h=f.hub();
 const original=JSON.parse(f.store.db.prepare('SELECT json FROM events ORDER BY rowid DESC LIMIT 1').get().json),conflict=structuredClone(original);conflict.payload.text='总控已有不同内容';const policy=f.store.db.prepare('SELECT json FROM policies WHERE hash=?').get(original.policy_hash);h.store.ingest([conflict],[],h.config.org_id,f.config.device_id,[{hash:original.policy_hash,value:JSON.parse(policy.json)}]);
 await assert.rejects(importOfflineHandoff(h.store,h.config,{input:f.output,password,tempDir:f.tempDir}),/同一事件编号内容冲突/);assert.equal(h.store.stats().events,1);assert.equal(h.store.stats().assets,0);assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n,0);assert.equal(JSON.parse(h.store.db.prepare('SELECT json FROM events').get().json).payload.text,'总控已有不同内容');assert.equal(h.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='handoff.import'").get().n,0);
});

test('完整移交：错误密码、篡改与已存在路径不产生可用恢复目录，也不覆盖原件',async t=>{
 const f=fixture(t);await createOfflineHandoff(f.store,f.config,f.options);const initial=hash(readFileSync(f.output));await assert.rejects(createOfflineHandoff(f.store,f.config,f.options),/已存在/);assert.equal(hash(readFileSync(f.output)),initial);
 await assert.rejects(inspectOfflineHandoff({input:f.output,password:'wrong-password-2026',tempDir:f.tempDir}));
 const corrupted=Buffer.from(readFileSync(f.output));corrupted[corrupted.length-1]^=1;const bad=join(f.dir,'bad.wth');writeFileSync(bad,corrupted);const target=join(f.dir,'must-not-appear');await assert.rejects(restoreOfflineHandoff({input:bad,password,tempDir:f.tempDir,directory:target}));assert(!existsSync(target));assert.deepEqual(readdirSync(f.tempDir),[]);
 const occupied=join(f.dir,'occupied');mkdirSync(occupied);writeFileSync(join(occupied,'keep.txt'),'KEEP');await assert.rejects(restoreOfflineHandoff({input:f.output,password,tempDir:f.tempDir,directory:occupied}),/已存在/);assert.equal(readFileSync(join(occupied,'keep.txt'),'utf8'),'KEEP');
});

test('完整移交：超过旧 wpack 100MiB 的数据库仍可流式加密和校验',async t=>{
 const f=fixture(t);f.store.db.exec('CREATE TABLE large_saved_state(payload BLOB NOT NULL); INSERT INTO large_saved_state VALUES(zeroblob(106954752))');
 const result=await createOfflineHandoff(f.store,f.config,f.options);assert(result.bytes>100*1024*1024);const inspected=await inspectOfflineHandoff({input:f.output,password,tempDir:f.tempDir});assert.equal(inspected.manifest.tables.large_saved_state,1);assert(inspected.manifest.files[0].size>100*1024*1024);
});

test('完整移交：显式同机恢复运行配置仍暂停，保留原状态，跨主机恢复配置拒绝',async t=>{
 const f=fixture(t);await createOfflineHandoff(f.store,f.config,f.options);const denied=join(f.dir,'foreign-active');await assert.rejects(restoreOfflineHandoff({input:f.output,password,tempDir:f.tempDir,directory:denied,resumeConfig:true}),/仅原主机/);assert(!existsSync(denied));
 f.config.host_binding=hash(f.config.org_id+':'+hostname());f.store.set('worker_policy',{...f.store.get('worker_policy'),paused:false});const sameHost=join(f.dir,'same-host.wth');await createOfflineHandoff(f.store,f.config,{...f.options,output:sameHost});
 const result=await restoreOfflineHandoff({input:sameHost,password,tempDir:f.tempDir,directory:join(f.dir,'same-host-recovery'),resumeConfig:true});assert.equal(result.mode,'same_host_paused');assert.equal(result.service_started,false);const config=JSON.parse(readFileSync(join(result.directory,'config.json')));assert.equal(config.device_id,f.config.device_id);assert.equal(config.connection_mode,'offline');assert(!Object.hasOwn(config,'device_token'));
 const db=new DatabaseSync(result.database,{readOnly:true});try{const get=key=>JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(key).value);assert.equal(get('capture_enabled'),false);assert.equal(get('worker_policy').paused,true);assert.equal(get('handoff_restore_previous_state').capture_enabled,true);assert.equal(get('handoff_restore_previous_state').worker_policy.paused,false);assert.equal(db.prepare('SELECT status FROM personal_batches WHERE batch_id=?').get(f.openBatch.batch_id).status,'open');assert.equal(db.prepare('SELECT state FROM node_jobs WHERE job_id=?').get(f.queued.job_id).state,'queued');}finally{db.close();}
});
