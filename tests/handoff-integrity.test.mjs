import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createCipheriv,createDecipheriv,scryptSync,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {uuid,hash,canonical} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {createOfflineIdentity,adoptOfflineDevice} from '../src/offline-identity.mjs';
import {createOfflineHandoff,inspectOfflineHandoff,restoreOfflineHandoff,importOfflineHandoff} from '../src/offline-handoff.mjs';
import {importFileVersions} from '../src/file-evidence.mjs';
import {startApp} from '../src/server.mjs';
import {nextPersonal,savePersonal} from '../src/learning.mjs';

const root=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-handoff-integrity');mkdirSync(root,{recursive:true});
const password='synthetic-integrity-test-password';
function fixture(t,{org_id=uuid(),employee_id='SYNTHETIC'}={}){
 const dir=mkdtempSync(join(root,'case-')),s=new Store(join(dir,'data','worktrace.sqlite'));
 t.after(()=>{s.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});
 const c=createOfflineIdentity({format:'worktrace.offline-identity/1.0',org_id,org_name:'SYNTHETIC ONLY',employee_id,employee_name:'SYNTHETIC SAME NAME',label:'SYNTHETIC PC'});s.addDevice(c);s.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(c.installation_id,c.device_id);
 const ph=s.policy(defaultPolicy),base=()=>({schema_version:'1.0',event_id:uuid(),org_id,device_id:c.device_id,employee_id,session_id:uuid(),occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',event_type:'activity.snapshot',collector_version:'synthetic-test',policy_hash:ph,app:{process_name:'synthetic.exe',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{text:'SYNTHETIC',capture_status:'uia',idle_seconds:0,truncated:false,reason:''},attachments:[]});
 const image=Buffer.from([255,216,1,2,3,255,217]),imageHash=hash(image),raw=s.append({...base(),attachments:[{sha256:imageHash,size:image.length,mime:'image/jpeg',kind:'window_capture'}]},[{sha256:imageHash,mime:'image/jpeg',data:image.toString('base64')}]);
 const bytes=Buffer.from('SYNTHETIC FILE CONTENT'),fileHash=hash(bytes);importFileVersions(s,[{sha256:fileHash,mime:'text/plain',size:bytes.length,data:bytes}]);
 const doc=s.append({...base(),schema_version:'1.2',event_type:'document.version',payload:{file_sha256:fileHash,path:'D:\\SYNTHETIC\\a.txt',extension:'.txt',mime:'text/plain',size:bytes.length,modified_at:new Date().toISOString(),previous_event_id:null,text:bytes.toString(),parser:'builtin-text',parser_version:'1.0',capture_status:'text_extracted',gaps:[]}});
 const output=join(dir,'handoff.wth'),tempDir=join(dir,'scratch');return {dir,s,c,ph,raw,doc,image,imageHash,fileHash,output,tempDir,options:{output,password,tempDir},input:{input:output,password,tempDir}};
}
// Make an authenticated old-format archive containing a logically damaged DB.
// Test-only whole-buffer encryption is bounded to this tiny synthetic fixture.
function mutateArchive(f,mutate){
 const packed=readFileSync(f.output),head=packed.subarray(0,36),key=scryptSync(password,head.subarray(8,24),32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),dec=createDecipheriv('aes-256-gcm',key,head.subarray(24));dec.setAAD(head);dec.setAuthTag(packed.subarray(-16));const raw=Buffer.concat([dec.update(packed.subarray(36,-16)),dec.final()]);key.fill(0);
 const length=raw.readUInt32BE(),manifest=JSON.parse(raw.subarray(4,4+length)),file=join(f.dir,'mutated.sqlite');writeFileSync(file,raw.subarray(4+length));const db=new DatabaseSync(file);try{mutate(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
 const bytes=readFileSync(file);manifest.files[0].size=bytes.length;manifest.files[0].sha256=hash(bytes);const meta=Buffer.from(JSON.stringify(manifest)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(meta.length);const salt=randomBytes(16),iv=randomBytes(12),header=Buffer.concat([Buffer.from('WTRHOF01'),salt,iv]),nextKey=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),cipher=createCipheriv('aes-256-gcm',nextKey,iv);cipher.setAAD(header);const sealed=Buffer.concat([header,cipher.update(Buffer.concat([prefix,meta,bytes])),cipher.final(),cipher.getAuthTag()]);nextKey.fill(0);const output=join(f.dir,'damaged-'+uuid()+'.wth');writeFileSync(output,sealed);return output;
}
function changeEvent(db,eventId,change,{updateHash=true}={}){const e=JSON.parse(db.prepare('SELECT json FROM events WHERE event_id=?').get(eventId).json);change(e);const json=canonical(e);if(updateHash)db.prepare('UPDATE events SET json=?,hash=? WHERE event_id=?').run(json,hash(json),eventId);else db.prepare('UPDATE events SET json=? WHERE event_id=?').run(json,eventId);}

test('移交创建拒绝源库已有逻辑损坏，源库不被修写且没有输出包',async t=>{
 const f=fixture(t);changeEvent(f.s.db,f.raw.event_id,e=>{e.payload.text='DAMAGED';},{updateHash:false});const before=f.s.db.prepare('SELECT json,hash FROM events WHERE event_id=?').get(f.raw.event_id);
 await assert.rejects(createOfflineHandoff(f.s,f.c,f.options),/事件摘要/);assert(!existsSync(f.output));assert.deepEqual(f.s.db.prepare('SELECT json,hash FROM events WHERE event_id=?').get(f.raw.event_id),before);assert.deepEqual(readdirSync(f.tempDir),[]);
});

test('旧格式加密包的索引、原件、策略和引用损坏，在检查及恢复前拒绝',async t=>{
 const f=fixture(t);await createOfflineHandoff(f.s,f.c,f.options);assert.equal((await inspectOfflineHandoff(f.input)).valid,true);
 const cases=[
  ['事件摘要',db=>changeEvent(db,f.raw.event_id,e=>{e.payload.text='DAMAGED';},{updateHash:false}),/事件摘要/],
  ['索引正文',db=>db.prepare("UPDATE events SET sequence=99 WHERE event_id=?").run(f.raw.event_id),/索引字段/],
  ['原件摘要',db=>db.prepare('UPDATE file_versions SET data=? WHERE sha256=?').run(Buffer.alloc(22,65),f.fileHash),/文件版本/],
  ['截图摘要',db=>db.prepare('UPDATE assets SET data=? WHERE sha256=?').run(Buffer.from([255,216,9,2,3,255,217]),f.imageHash),/附件校验/],
  ['策略摘要',db=>db.prepare('UPDATE policies SET json=? WHERE hash=?').run(canonical({...defaultPolicy,interval_seconds:99}),f.ph),/策略摘要/],
  ['附件引用',db=>db.prepare('DELETE FROM event_assets WHERE event_id=?').run(f.raw.event_id),/截图引用/],
  ['版本循环',db=>changeEvent(db,f.doc.event_id,e=>{e.payload.previous_event_id=e.event_id;}),/前一版本/]
  ,['安装身份',db=>db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(uuid(),f.c.device_id),/设备登记与移交身份/]
 ];
 for(const [name,mutate,pattern] of cases)await t.test(name,async()=>{
  const input=mutateArchive(f,mutate),options={...f.input,input},target=join(f.dir,'review-'+uuid());await assert.rejects(inspectOfflineHandoff(options),pattern);await assert.rejects(restoreOfflineHandoff({...options,directory:target}),pattern);assert(!existsSync(target));
  const recover=join(f.dir,'recover-'+uuid());await assert.rejects(restoreOfflineHandoff({...options,directory:recover,resumeConfig:true}),pattern);assert(!existsSync(recover));assert.deepEqual(readdirSync(f.tempDir),[]);
 });
});

test('同公司两个离线设备分别接纳并汇总，编号保持、共同原件去重、重复包幂等',async t=>{
 const org_id=uuid(),a=fixture(t,{org_id,employee_id:'SYNTHETIC_A'}),b=fixture(t,{org_id,employee_id:'SYNTHETIC_B'}),hub=new Store(join(a.dir,'hub.sqlite'));const config={role:'hub',org_id};try{
 const original=[];for(const f of [a,b]){const created=await createOfflineHandoff(f.s,f.c,f.options);adoptOfflineDevice(hub,config,created.manifest.identity);original.push(...f.s.db.prepare('SELECT event_id,hash,json FROM events').all());const first=await importOfflineHandoff(hub,config,f.input);assert.equal(first.added,2);assert.equal((await importOfflineHandoff(hub,config,f.input)).duplicates,2);}
 assert.equal(hub.stats().events,4);assert.equal(hub.stats().assets,1);assert.equal(hub.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n,1);assert.equal(hub.list({employee:'SYNTHETIC_A'}).count,2);assert.equal(hub.list({employee:'SYNTHETIC_B'}).count,2);
 for(const row of original)assert.deepEqual(hub.db.prepare('SELECT event_id,hash,json FROM events WHERE event_id=?').get(row.event_id),row);
 }finally{hub.close();}
});

test('原身份仍在运行时拒绝同机 Recover，退出原服务后可以暂停恢复',async t=>{
 const f=fixture(t);f.s.set('capture_enabled',false);writeFileSync(join(f.dir,'data','config.json'),JSON.stringify(f.c));await createOfflineHandoff(f.s,f.c,f.options);const app=await startApp({dir:join(f.dir,'data'),port:0}),target=join(f.dir,'recovered');
 try{await assert.rejects(restoreOfflineHandoff({...f.input,directory:target,resumeConfig:true}),/runtime_identity_active/);assert(!existsSync(target));}finally{await app.close();}
 const result=await restoreOfflineHandoff({...f.input,directory:target,resumeConfig:true});assert.equal(result.mode,'same_host_paused');assert(!existsSync(join(target,'REVIEW-ONLY.json')));const db=new DatabaseSync(result.database,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='capture_enabled'").get().value),false);}finally{db.close();}
});

test('恢复复制后进程中断，保护标记已存在并阻止误启动；原始包不变',async t=>{
 const f=fixture(t);await createOfflineHandoff(f.s,f.c,f.options);const target=join(f.dir,'interrupted'),original=hash(readFileSync(f.output)),module=pathToFileURL(resolve('src/offline-handoff.mjs')).href;
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const copy=fs.copyFileSync;fs.copyFileSync=(...args)=>{copy(...args);process.exit(79);};syncBuiltinESMExports();const {restoreOfflineHandoff}=await import(${JSON.stringify(module)});await restoreOfflineHandoff(${JSON.stringify({...f.input,directory:target})});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(child.status,79,child.stderr);assert(existsSync(join(target,'worktrace.sqlite')));assert(existsSync(join(target,'REVIEW-ONLY.json')));assert(!existsSync(join(target,'config.json')));await assert.rejects(startApp({dir:target,port:0}),/仅供审阅/);assert.equal(hash(readFileSync(f.output)),original);
});

test('目标父路径不可写入及截断移交包不覆盖既有文件，不产生可启动恢复目录',async t=>{
 const f=fixture(t),parentFile=join(f.dir,'parent-file');writeFileSync(parentFile,'KEEP');await assert.rejects(createOfflineHandoff(f.s,f.c,{...f.options,output:join(parentFile,'blocked.wth')}));assert.equal(readFileSync(parentFile,'utf8'),'KEEP');assert.deepEqual(readdirSync(f.tempDir),[]);
 await createOfflineHandoff(f.s,f.c,f.options);const truncated=join(f.dir,'interrupted.wth'),bytes=readFileSync(f.output);writeFileSync(truncated,bytes.subarray(0,Math.floor(bytes.length/2)));const target=join(f.dir,'must-not-appear');await assert.rejects(restoreOfflineHandoff({...f.input,input:truncated,directory:target}));assert(!existsSync(target));assert.deepEqual(readdirSync(f.tempDir),[]);
});

test('损坏个人检查点在创建、检查与恢复之前拒绝，不能隐藏被占用原始证据',async t=>{
 const f=fixture(t),batch=nextPersonal(f.s,f.c).batch;await createOfflineHandoff(f.s,f.c,f.options);
 const cases=[
  ['缺失证据',db=>db.prepare('UPDATE personal_batches SET refs_json=? WHERE batch_id=?').run(JSON.stringify([uuid()]),batch.batch_id),/检查点引用的原始证据/],
  ['孤立成员批次',db=>db.prepare('UPDATE personal_members SET batch_id=? WHERE event_id=?').run(uuid(),f.raw.event_id),/成员数量|成员引用的检查点/],
  ['孤立成员事件',db=>db.prepare('UPDATE personal_members SET event_id=? WHERE event_id=?').run(uuid(),f.raw.event_id),/成员引用的原始证据/],
  ['成员丢失',db=>db.prepare('DELETE FROM personal_members WHERE event_id=?').run(f.raw.event_id),/已消费成员数量/],
  ['错误完成结果',db=>db.prepare("UPDATE personal_batches SET status='done',result_event_id=? WHERE batch_id=?").run(f.raw.event_id,batch.batch_id),/完成结果缺失/],
  ['补证请求缺失',db=>db.prepare('UPDATE personal_batches SET request_id=? WHERE batch_id=?').run(uuid(),batch.batch_id),/补证请求缺失/]
 ];
 for(const [name,mutate,pattern] of cases)await t.test(name,async()=>{const input=mutateArchive(f,mutate),options={...f.input,input},target=join(f.dir,'bad-checkpoint-'+uuid());await assert.rejects(inspectOfflineHandoff(options),pattern);await assert.rejects(restoreOfflineHandoff({...options,directory:target,resumeConfig:true}),pattern);assert(!existsSync(target));});
 const original=f.s.db.prepare('SELECT refs_json,digest FROM personal_batches WHERE batch_id=?').get(batch.batch_id);f.s.db.prepare('UPDATE personal_batches SET refs_json=? WHERE batch_id=?').run(JSON.stringify([uuid()]),batch.batch_id);
 await assert.rejects(createOfflineHandoff(f.s,f.c,{...f.options,output:join(f.dir,'must-not-create.wth')}),/检查点引用的原始证据/);assert.equal(f.s.db.prepare('SELECT digest FROM personal_batches WHERE batch_id=?').get(batch.batch_id).digest,original.digest);assert(!existsSync(join(f.dir,'must-not-create.wth')));assert.deepEqual(readdirSync(f.tempDir),[]);
});

test('旧版无coverage列与原digest不改写，恢复后仍可继续原个人批次',async t=>{
 const f=fixture(t),batch=nextPersonal(f.s,f.c).batch,legacyDigest=hash('SYNTHETIC LEGACY DIGEST ALGORITHM');f.s.db.prepare('UPDATE personal_batches SET digest=? WHERE batch_id=?').run(legacyDigest,batch.batch_id);f.s.db.exec('ALTER TABLE personal_batches DROP COLUMN coverage_json');
 await createOfflineHandoff(f.s,f.c,f.options);assert.equal((await inspectOfflineHandoff(f.input)).valid,true);const restored=await restoreOfflineHandoff({...f.input,directory:join(f.dir,'legacy-review')}),s=new Store(restored.database);try{const next=nextPersonal(s,f.c).batch;assert.equal(next.batch_id,batch.batch_id);assert.equal(next.digest,legacyDigest);assert.equal(next.events.length,2);}finally{s.close();}
});

test('正常聚合成员和已提交总结但检查点尚未完成的中断状态可恢复',async t=>{
 const f=fixture(t);for(let i=0;i<3;i++)f.s.append({...f.raw,event_id:uuid(),attachments:[],occurred_at:'2026-10-14T02:00:0'+i+'.000Z',app:{process_name:'synthetic.exe',window_title:''},payload:{text:'',capture_status:'activity_only',idle_seconds:0,truncated:false,reason:''}});
 const batch=nextPersonal(f.s,f.c).batch;assert.equal(batch.source_coverage.new_events,5);assert(batch.events.length<5);const result={summary:'SYNTHETIC',coverage:'content',limitations:['SYNTHETIC ONLY'],procedures:[],open_questions:[]};const summary=savePersonal(f.s,f.c,{batch_id:batch.batch_id,digest:batch.digest,result});
 f.s.db.prepare("UPDATE personal_batches SET status='open',result_event_id=NULL WHERE batch_id=?").run(batch.batch_id);await createOfflineHandoff(f.s,f.c,f.options);const restored=await restoreOfflineHandoff({...f.input,directory:join(f.dir,'committed-review')}),s=new Store(restored.database);try{const next=nextPersonal(s,f.c).batch;assert.equal(next.batch_id,batch.batch_id);assert.equal(next.digest,batch.digest);const saved=savePersonal(s,f.c,{batch_id:next.batch_id,digest:next.digest,result});assert.equal(saved.duplicate,true);assert.equal(saved.event_id,summary.event_id);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE event_type='learning.summary'").get().n,1);}finally{s.close();}
});
