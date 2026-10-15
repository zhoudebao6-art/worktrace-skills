import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {Store} from '../src/store.mjs';
import {hash} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {createOfflineIdentity} from '../src/offline-identity.mjs';
import {WechatCollector,defaultWechatPolicy} from '../src/wechat-collector.mjs';
import {createWechatStorage,readWechatChat,listWechatChats} from '../src/wechat-store.mjs';
import {pollWechatSource} from '../src/wechat-incremental.mjs';
import {wechatSourceKey} from '../src/wechat-schema.mjs';
import {LearningWorker} from '../src/worker.mjs';
import {createOfflineHandoff,restoreOfflineHandoff} from '../src/offline-handoff.mjs';
import {startApp} from '../src/server.mjs';

const root=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-wechat-review');mkdirSync(root,{recursive:true});
const at='2026-10-15T02:00:00.000Z',source={account_id:'fixture_self',db_generation:'synthetic-generation',shard_id:'message/message_0.db',table_id:'Msg_synthetic'};
const message=(n,text='SYNTHETIC ONLY',extra={})=>({cursor:String(n),source_message_id:String(n)+':1',local_message_id:String(n),server_message_id:String(1000+n),conversation_id:'fixture_group@chatroom',conversation_kind:'group',sender_id:'fixture_client',sender_display_name:'同名测试',direction:'incoming',identity_status:'verified',message_kind:'text',message_status:'normal',sent_at:at,text,raw_hash:hash(text),media:[],gaps:[],...extra});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function provider(rows=[]){return {discover:async()=>({sources:[source],heads:[{source,high_watermark:String(rows.length)}],errors:[],has_more:false}),head:async({source:s})=>({source:s,complete:true,high_watermark:String(rows.length)}),readPage:async({source:s,after,through,limit})=>{const selected=rows.filter(r=>BigInt(r.cursor)>BigInt(after)&&BigInt(r.cursor)<=BigInt(through));return {source:s,complete:true,rows:selected.slice(0,limit),has_more:selected.length>limit};},close(){}};}
function fixture(t,rows=[]){
 const base=mkdtempSync(join(root,'case-')),dir=join(base,'data');mkdirSync(dir);mkdirSync(join(base,'private'));mkdirSync(join(base,'account'));
 const config=createOfflineIdentity({format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC',employee_id:'SYNTHETIC',employee_name:'SYNTHETIC',label:'SYNTHETIC'}),store=new Store(join(dir,'worktrace.sqlite'));store.addDevice(config);store.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(config.installation_id,config.device_id);
 const cfg={format:'worktrace.wechat-source/1.0',reader_path:join(base,'reader.exe'),dll_path:join(base,'codec.dll'),profile_path:join(base,'private','profile.json'),account_root:join(base,'account'),account_id:source.account_id};
 writeFileSync(cfg.reader_path,'not executable');writeFileSync(cfg.dll_path,'not executable');
 const secret='SYNTHETIC_PRIVATE_SENTINEL_DO_NOT_TRANSFER',profile={format:'worktrace.wechat-native-profile/1.0',account_root:cfg.account_root,account_id:source.account_id,created_at:at,key_count:1,encrypted_keymap_base64:Buffer.from(secret).toString('base64')};
 const saveProfile=()=>writeFileSync(cfg.profile_path,JSON.stringify(profile)),saveConfig=()=>writeFileSync(join(dir,'wechat-source.json'),JSON.stringify(cfg));saveProfile();saveConfig();
 const p=provider(rows),collector={enabled:true,policy:{...defaultPolicy,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59'}},wc=new WechatCollector({store,config,dir,getCollector:()=>collector,now:()=>Date.parse(at),providerFactory:()=>p});
 t.after(()=>{wc.stop();store.close();assert.equal(dirname(base),root);rmSync(base,{recursive:true,force:true});});
 return {base,dir,config,store,cfg,profile,saveProfile,saveConfig,p,collector,wc,secret};
}
const enable=async f=>{await f.wc.probe();f.wc.configure({...defaultWechatPolicy(),enabled:true,capture_since:at});};
const poll=(f,rows,s=source)=>pollWechatSource({source:s,provider:provider(rows),storage:createWechatStorage(f.store,f.config),clock:()=>Date.parse(at),budget:{max_rows:Math.max(1,rows.length),max_pages:10,max_bytes:8388608,max_ms:30000}});

test('Profile binding rejects wrong account/root and malformed profile without decrypting or leaking material',t=>{
 const f=fixture(t);assert.deepEqual(f.wc.readSourceConfig(),f.cfg);
 f.profile.account_id='other';f.saveProfile();assert.throws(()=>f.wc.sourceConfig(),/wechat_profile_account_mismatch/);
 f.profile.account_id=source.account_id;f.profile.account_root=join(f.base,'other');f.saveProfile();assert.throws(()=>f.wc.sourceConfig(),/wechat_profile_root_mismatch/);
 f.profile.account_root=process.platform==='win32'?f.cfg.account_root.toUpperCase():f.cfg.account_root;f.saveProfile();assert.doesNotThrow(()=>f.wc.sourceConfig());
 f.profile.format='wrong';f.saveProfile();assert.throws(()=>f.wc.sourceConfig(),/wechat_profile_invalid/);
 writeFileSync(f.cfg.profile_path,'{"encrypted_keymap_base64":"'+f.secret);assert.throws(()=>f.wc.sourceConfig(),error=>error.message==='wechat_profile_invalid');
 assert(!JSON.stringify(f.wc.status()).includes(f.secret));
});

test('Paused/stopped probe cannot verify a late discovery and close rejection is contained',async t=>{
 for(const operation of ['pause','stop']){const f=fixture(t),entered=deferred(),released=deferred();f.p.discover=async()=>{entered.resolve();await released.promise;return {sources:[source],heads:[],errors:[]};};f.p.close=()=>Promise.reject(Error('synthetic-close-failure'));
  const pending=f.wc.probe();await entered.promise;if(operation==='pause')f.wc.globalState(false);else f.wc.stop();released.resolve();await assert.rejects(pending,/wechat_probe_cancelled/);assert.equal(f.store.get('wechat_verified_source'),null);assert.equal(f.wc.sources.length,0);
 }
});

test('Disabling an in-flight collector cancels late rows and cursor while same-ms pause remains idempotent',async t=>{
 const f=fixture(t,[message(1)]);await enable(f);const entered=deferred(),released=deferred();f.p.readPage=async({source:s})=>{entered.resolve();await released.promise;return {source:s,complete:true,rows:[message(1)],has_more:false};};
 const pending=f.wc.tick();await entered.promise;assert.doesNotThrow(()=>f.wc.configure({...f.wc.policy,enabled:false}));released.resolve();await pending;
 assert.equal(f.store.stats().events,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM wechat_sources').get().n,0);assert.equal(f.wc.policy.enabled,false);
 f.wc.policy.enabled=true;f.wc.globalState(false);f.wc.globalState(true);assert.doesNotThrow(()=>f.wc.globalState(false));assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM wechat_pauses WHERE end_at IS NULL').get().n,1);
});

test('Changing source account/profile while a page waits prevents attribution to the original employee source',async t=>{
 const f=fixture(t,[message(1)]);await enable(f);const entered=deferred(),released=deferred();f.p.readPage=async({source:s})=>{entered.resolve();await released.promise;return {source:s,complete:true,rows:[message(1)],has_more:false};};const pending=f.wc.tick();await entered.promise;
 f.cfg.account_id='other_account';f.profile.account_id='other_account';f.saveConfig();f.saveProfile();released.resolve();await pending;assert.equal(f.store.stats().events,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM wechat_sources').get().n,0);
});

test('Discovery is a current snapshot; removed generations and heads stop polling but evidence/cursors survive',async t=>{
 const f=fixture(t);await poll(f,[message(1)]);f.wc.accountId=source.account_id;const next={...source,db_generation:'next-generation'};
 f.wc.applyDiscovery({sources:[source],heads:[{source,high_watermark:'1'}]});f.wc.applyDiscovery({sources:[next],heads:[{source:next,high_watermark:'2'}],errors:[{shard_id:source.shard_id,code:'source_unavailable'}]});
 assert.deepEqual(f.wc.sources,[next]);assert.equal(f.wc.heads.has(wechatSourceKey(source)),false);assert.equal(f.wc.heads.get(wechatSourceKey(next)),'2');assert.equal(f.wc.discoveryErrors.length,1);assert.equal(f.store.stats().events,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM wechat_sources').get().n,1);
 assert.throws(()=>f.wc.applyDiscovery({sources:[{...source,account_id:'other'}]}),/wechat_discovery_account_mismatch/);assert.deepEqual(f.wc.sources,[next]);
});

test('Long chat queries and worker evidence are bounded, paginate every source record and retain original texts',async t=>{
 const f=fixture(t),full='化'.repeat(60000),rows=Array.from({length:30},(_,i)=>message(i+1,full));await poll(f,rows);let before,keys=[];do{const page=readWechatChat(f.store,f.config,{account_id:source.account_id,conversation_id:rows[0].conversation_id,limit:100,...(before?{before}:{})});
  assert(page.output_budget.characters<=100000);assert(page.items.length>0&&page.items.length<30);for(const item of page.items){assert.equal(item.text.length,6000);assert.equal(item.text_truncated,true);assert.equal(item.text_omitted_characters,54000);keys.push(item.message_key);}before=page.next_before;assert.equal(page.has_more,!!before);
 }while(before);assert.equal(keys.length,30);assert.equal(new Set(keys).size,30);assert.equal(JSON.parse(f.store.db.prepare('SELECT json FROM events LIMIT 1').get().json).payload.text,full);
 const worker=new LearningWorker({store:f.store,config:f.config,dir:f.dir,runner:()=>{throw Error('must not call a model');}}),events=f.store.db.prepare('SELECT event_id FROM events').all(),evidence=worker.evidence({events});assert(evidence.reduce((n,e)=>n+e.payload.text.length,0)<=60000);assert(evidence.every(e=>e.payload.message.text===e.payload.text));
 assert.throws(()=>readWechatChat(f.store,f.config,{account_id:source.account_id,conversation_id:rows[0].conversation_id,limit:0}),/分页/);assert.throws(()=>listWechatChats(f.store,f.config,{limit:0}),/分页/);
});

test('Logical IDs recognize stable server identity across generations without merging physical evidence or guessing unknown senders',async t=>{
 const f=fixture(t),row=message(1);await poll(f,[row]);await poll(f,[row],{...source,db_generation:'rebuilt-generation'});await poll(f,[{...row,server_message_id:null,sender_id:null,sender_display_name:null,identity_status:'unknown',direction:'unknown'}],{...source,db_generation:'unknown-generation'});
 const page=readWechatChat(f.store,f.config,{account_id:source.account_id,conversation_id:row.conversation_id});assert.equal(page.items.length,3);assert.equal(new Set(page.items.map(m=>m.source_message_key)).size,3);assert.equal(page.items[0].logical_message_id,page.items[1].logical_message_id);assert.equal(page.items[2].logical_message_id,null);assert.equal(page.items[2].sender_id,null);assert.equal(page.items[2].direction,'unknown');assert.equal(listWechatChats(f.store,f.config).items[0].saved_messages,3);assert.equal(page.count_semantics,'physical_source_records_latest_revision');
});

test('Full offline handoff carries database evidence but excludes private DPAPI profile and source paths',async t=>{
 const f=fixture(t);await f.wc.probe();await poll(f,[message(1)]);const output=join(f.base,'test.wthandoff'),password='synthetic-password-only';await createOfflineHandoff(f.store,f.config,{output,password,tempDir:join(f.base,'export')});
 const restored=await restoreOfflineHandoff({input:output,password,directory:join(f.base,'review'),tempDir:join(f.base,'restore')});const bytes=readFileSync(restored.database);for(const secret of [f.secret,f.profile.encrypted_keymap_base64,f.cfg.profile_path,f.cfg.account_root])assert(!bytes.includes(Buffer.from(secret)));
 assert(!readdirSync(restored.directory).includes('wechat-source.json'));assert.equal(restored.service_started,false);assert.equal(restored.mode,'review_only');
});

test('HTTP metadata probe rejects an occupied task instead of returning another probe/tick result',async t=>{
 const dir=mkdtempSync(join(root,'http-')),app=await startApp({dir,port:0});t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const post=(path,value={})=>fetch(new URL(path,app.url),{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert((await post('/api/setup',{role:'collector',offline:{format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC',employee_id:'SYNTHETIC',employee_name:'SYNTHETIC',label:'SYNTHETIC'}})).ok);
 const entered=deferred(),release=deferred();app.wechatCollector.probe=async()=>{entered.resolve();await release.promise;return {ok:true};};const first=post('/api/wechat/probe');await entered.promise;
 const second=await post('/api/wechat/probe');assert.equal(second.status,400);assert.equal((await second.json()).error,'wechat_reader_busy');release.resolve();assert((await first).ok);assert.equal(app.collector.enabled,false);
});
