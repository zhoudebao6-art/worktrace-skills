import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createCipheriv,createDecipheriv,scryptSync,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {uuid,hash,canonical} from '../src/protocol.mjs';
import {createOfflineIdentity} from '../src/offline-identity.mjs';
import {createWechatStorage,readWechatChat} from '../src/wechat-store.mjs';
import {pollWechatSource} from '../src/wechat-incremental.mjs';
import {createOfflineHandoff,inspectOfflineHandoff,restoreOfflineHandoff} from '../src/offline-handoff.mjs';

const root=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-wechat-handoff-review');mkdirSync(root,{recursive:true});
const password='synthetic-only-handoff-password';
const source={account_id:'synthetic-self',db_generation:'synthetic-generation',shard_id:'message_0.db',table_id:'Msg_synthetic'};
async function fixture(t,{filtered=false,empty=false}={}){
 const dir=mkdtempSync(join(root,'case-')),store=new Store(join(dir,'worktrace.sqlite'));
 const config=createOfflineIdentity({format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC',employee_id:'SYNTHETIC',employee_name:'SYNTHETIC',label:'SYNTHETIC'});store.addDevice(config);store.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(config.installation_id,config.device_id);
 t.after(()=>{store.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});
 const row={cursor:'1',source_message_id:'rowid:1:local:7',local_message_id:'7',server_message_id:'9007199254740993',conversation_id:'synthetic-group@chatroom',conversation_kind:'group',sender_id:null,sender_display_name:null,direction:'unknown',identity_status:'unknown',message_kind:'text',message_status:'normal',sent_at:'2026-10-15T01:00:00.000Z',text:'SYNTHETIC ORIGINAL',raw_hash:hash('SYNTHETIC ORIGINAL'),media:[],gaps:['sender_unknown']};
 const provider={head:()=>({source,complete:true,high_watermark:'1'}),readPage:q=>({source,complete:true,rows:BigInt(q.after)<1n?[structuredClone(row)]:[],has_more:false})};
 const poll=()=>pollWechatSource({source,provider,storage:createWechatStorage(store,config),includeMessage:()=>!filtered,budget:{max_ms:5000}});
 if(!empty){await poll();row.text='SYNTHETIC REVISED';row.raw_hash=hash(row.text);await poll();}
 const output=join(dir,'handoff.wth'),tempDir=join(dir,'scratch'),options={output,password,tempDir},input={input:output,password,tempDir};
 return {dir,store,config,output,tempDir,options,input};
}
// Tiny synthetic archive only: recompute authentication and the database hash so
// failures prove semantic checks, rather than merely detecting damaged encryption.
function mutateArchive(f,mutate){
 const bytes=readFileSync(f.output),header=bytes.subarray(0,36),key=scryptSync(password,header.subarray(8,24),32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),dec=createDecipheriv('aes-256-gcm',key,header.subarray(24));dec.setAAD(header);dec.setAuthTag(bytes.subarray(-16));const plain=Buffer.concat([dec.update(bytes.subarray(36,-16)),dec.final()]);key.fill(0);
 const length=plain.readUInt32BE(),manifest=JSON.parse(plain.subarray(4,4+length)),file=join(f.dir,'mutated-'+uuid()+'.sqlite');writeFileSync(file,plain.subarray(4+length));
 const db=new DatabaseSync(file);try{mutate(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
 const database=readFileSync(file);manifest.files[0].size=database.length;manifest.files[0].sha256=hash(database);const metadata=Buffer.from(JSON.stringify(manifest)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(metadata.length);
 const salt=randomBytes(16),iv=randomBytes(12),nextHeader=Buffer.concat([Buffer.from('WTRHOF01'),salt,iv]),nextKey=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),enc=createCipheriv('aes-256-gcm',nextKey,iv);enc.setAAD(nextHeader);const sealed=Buffer.concat([nextHeader,enc.update(Buffer.concat([prefix,metadata,database])),enc.final(),enc.getAuthTag()]);nextKey.fill(0);
 const input=join(f.dir,'mutated-'+uuid()+'.wth');writeFileSync(input,sealed);return input;
}
function staleIndex(db){const e=JSON.parse(db.prepare("SELECT json FROM events WHERE event_type='chat.message' ORDER BY rowid LIMIT 1").get().json);db.prepare('UPDATE wechat_messages SET revision=1,revision_id=?,content_hash=?').run(e.event_id,hash(canonical(e.payload.message)));}
function invalidCursor(db){const row=db.prepare('SELECT * FROM wechat_sources').get(),state=JSON.parse(row.state_json);state.tail='2';db.prepare('UPDATE wechat_sources SET state_json=?').run(JSON.stringify(state));}
function fork(db){
 const original=db.prepare("SELECT * FROM events WHERE event_type='chat.message' ORDER BY rowid DESC LIMIT 1").get(),e=JSON.parse(original.json);e.event_id=uuid();e.sequence=999;e.payload.revision_id=e.event_id;const json=canonical(e);
 db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(e.event_id,e.org_id,e.device_id,e.employee_id,e.stream_id,e.sequence,e.occurred_at,original.received_at,e.event_type,hash(json),json);
}

test('微信完整移交保留未知身份、最新修订与来源游标，Recover 不重写证据',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT event_id,hash,json FROM events ORDER BY rowid').all(),cursor=f.store.db.prepare('SELECT * FROM wechat_sources').all();
 await createOfflineHandoff(f.store,f.config,f.options);assert.equal((await inspectOfflineHandoff(f.input)).valid,true);
 const result=await restoreOfflineHandoff({...f.input,directory:join(f.dir,'recovered'),resumeConfig:true}),restored=new Store(result.database);
 try{assert.deepEqual(restored.db.prepare('SELECT event_id,hash,json FROM events ORDER BY rowid').all(),before);assert.deepEqual(restored.db.prepare('SELECT * FROM wechat_sources').all(),cursor);const chat=readWechatChat(restored,f.config,{account_id:source.account_id,conversation_id:'synthetic-group@chatroom'});assert.equal(chat.items[0].revision,2);assert.equal(chat.items[0].text,'SYNTHETIC REVISED');assert.equal(chat.items[0].sender_id,null);assert.equal(chat.items[0].identity_status,'unknown');assert.equal(restored.get('capture_enabled'),false);}finally{restored.close();}
 assert.deepEqual(f.store.db.prepare('SELECT event_id,hash,json FROM events ORDER BY rowid').all(),before);assert.deepEqual(readdirSync(f.tempDir),[]);
});

test('微信最新索引所有字段、缺行和多余行损坏均在导出前拒绝，源数据不被修写',async t=>{
 const f=await fixture(t),old=JSON.parse(f.store.db.prepare('SELECT json FROM events ORDER BY rowid LIMIT 1').get().json);
 const fields={device_id:uuid(),message_key:hash('wrong-key'),source_key:hash('wrong-source'),account_id:'another-account',conversation_id:'another-conversation',sender_id:'guessed-author',direction:'incoming',revision:1,revision_id:old.event_id,content_hash:hash('wrong-content'),observed_at:'2026-10-14T00:00:00.000Z',sent_at:null};
 const mutations=[...Object.entries(fields).map(([field,value])=>[field,db=>db.prepare('UPDATE wechat_messages SET '+field+'=?').run(value)]),['stale-valid-reference',staleIndex],['missing',db=>db.exec('DELETE FROM wechat_messages')],['extra',db=>{const r=db.prepare('SELECT * FROM wechat_messages').get();db.prepare('INSERT INTO wechat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.device_id,hash('extra'),r.source_key,r.account_id,r.conversation_id,r.sender_id,r.direction,r.revision,r.revision_id,r.content_hash,r.observed_at,r.sent_at);}]];
 const original=f.store.db.prepare('SELECT * FROM wechat_messages').all();
 for(const [name,mutate] of mutations)await t.test(name,async()=>{try{mutate(f.store.db);const damaged=f.store.db.prepare('SELECT * FROM wechat_messages ORDER BY message_key').all();await assert.rejects(createOfflineHandoff(f.store,f.config,f.options),/微信最新索引/);assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_messages ORDER BY message_key').all(),damaged);assert(!existsSync(f.output));}finally{f.store.db.exec('DELETE FROM wechat_messages');for(const row of original)f.store.db.prepare('INSERT INTO wechat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));}});
});

test('微信游标来源、十进制边界和禁止秘密字段均在导出前拒绝',async t=>{
 const f=await fixture(t);
 const mutations=[['source-key',db=>db.prepare('UPDATE wechat_sources SET source_key=?').run(hash('wrong-key'))],['tail-beyond-head',invalidCursor],['source-mismatch',db=>{const s=JSON.parse(db.prepare('SELECT state_json FROM wechat_sources').get().state_json);s.source.account_id='other';db.prepare('UPDATE wechat_sources SET state_json=?').run(JSON.stringify(s));}],['forbidden-field',db=>{const s=JSON.parse(db.prepare('SELECT state_json FROM wechat_sources').get().state_json);s.key_hex='SYNTHETIC-FORBIDDEN';db.prepare('UPDATE wechat_sources SET state_json=?').run(JSON.stringify(s));}],['state-byte-budget',db=>{const s=db.prepare('SELECT state_json FROM wechat_sources').get().state_json;db.prepare('UPDATE wechat_sources SET state_json=?').run(s+' '.repeat(16384));}]];
 const original=f.store.db.prepare('SELECT * FROM wechat_sources').all();
 for(const [name,mutate] of mutations)await t.test(name,async()=>{try{mutate(f.store.db);const before=f.store.db.prepare('SELECT * FROM wechat_sources').all();await assert.rejects(createOfflineHandoff(f.store,f.config,f.options));assert.deepEqual(f.store.db.prepare('SELECT * FROM wechat_sources').all(),before);assert(!existsSync(f.output));}finally{f.store.db.exec('DELETE FROM wechat_sources');for(const row of original)f.store.db.prepare('INSERT INTO wechat_sources VALUES(?,?)').run(row.source_key,row.state_json);}});
});

test('认证完整但微信索引、游标或修订分叉损坏的包在 Inspect 和 Recover 前拒绝',async t=>{
 const f=await fixture(t);await createOfflineHandoff(f.store,f.config,f.options);
 for(const [name,mutate,pattern] of [['stale-index',staleIndex,/最新索引/],['cursor',invalidCursor,/游标超出/],['fork',fork,/修订缺失或分叉/]])await t.test(name,async()=>{
  const input=mutateArchive(f,mutate),options={...f.input,input},target=join(f.dir,'blocked-'+uuid());await assert.rejects(inspectOfflineHandoff(options),pattern);await assert.rejects(restoreOfflineHandoff({...options,directory:target,resumeConfig:true}),pattern);assert(!existsSync(target));assert.deepEqual(readdirSync(f.tempDir),[]);
 });
});

test('旧包无微信表、无消息的范围过滤游标和仅导入消息无本机游标均可移交',async t=>{
 const legacy=await fixture(t,{empty:true});legacy.store.db.exec('DROP TABLE wechat_sources; DROP TABLE wechat_messages');await createOfflineHandoff(legacy.store,legacy.config,legacy.options);assert.equal((await inspectOfflineHandoff(legacy.input)).valid,true);
 const filtered=await fixture(t,{filtered:true});assert.equal(filtered.store.stats().events,0);await createOfflineHandoff(filtered.store,filtered.config,filtered.options);assert.equal((await inspectOfflineHandoff(filtered.input)).valid,true);
 const imported=await fixture(t);imported.store.db.exec('DELETE FROM wechat_sources');await createOfflineHandoff(imported.store,imported.config,imported.options);assert.equal((await inspectOfflineHandoff(imported.input)).valid,true);
 const missing=await fixture(t);missing.store.db.exec('DROP TABLE wechat_messages');await assert.rejects(createOfflineHandoff(missing.store,missing.config,missing.options),/缺少最新索引/);
});
