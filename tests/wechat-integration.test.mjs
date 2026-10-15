import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {Store} from '../src/store.mjs';
import {uuid,hash,canonical} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {createOfflineIdentity} from '../src/offline-identity.mjs';
import {createWechatStorage,listWechatChats,readWechatChat} from '../src/wechat-store.mjs';
import {pollWechatSource} from '../src/wechat-incremental.mjs';
import {wechatSourceKey,validateWechatPayload} from '../src/wechat-schema.mjs';
import {WechatCollector,defaultWechatPolicy} from '../src/wechat-collector.mjs';
import {createOfflineHandoff,importOfflineHandoff,inspectOfflineHandoff} from '../src/offline-handoff.mjs';
import {nextPersonal} from '../src/learning.mjs';
import {startApp} from '../src/server.mjs';
import {callWechatReadTool,wechatDefinitions} from '../src/wechat-mcp.mjs';
import {definitions} from '../src/mcp.mjs';

const root=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-wechat-tests');mkdirSync(root,{recursive:true});
const at='2026-10-15T02:00:00.000Z';
const source={account_id:'fixture_self',db_generation:'synthetic-generation',shard_id:'message/message_0.db',table_id:'Msg_synthetic'};
const message=(cursor,text='SYNTHETIC ONLY',extra={})=>({cursor:String(cursor),source_message_id:String(cursor)+':1',local_message_id:'1',server_message_id:'9007199254740993',conversation_id:'fixture_group@chatroom',conversation_kind:'group',sender_id:'fixture_client',sender_display_name:'同名测试',direction:'incoming',identity_status:'verified',message_kind:'text',message_status:'normal',sent_at:at,text,raw_hash:hash(text),media:[],gaps:[],...extra});
function fixture(t){const dir=mkdtempSync(join(root,'integration-')),store=new Store(join(dir,'worktrace.sqlite')),config=createOfflineIdentity({format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC ONLY',employee_id:'CHEM_TEST',employee_name:'SYNTHETIC',label:'SYNTHETIC PC'});store.addDevice(config);store.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(config.installation_id,config.device_id);const stores=[store];t.after(()=>{for(const db of stores.reverse())db.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});return {dir,store,config,stores};}
function provider(rows){return {rows,closed:0,discover:async()=>({sources:[source],heads:[{source,high_watermark:String(Math.max(0,...rows.map(r=>Number(r.cursor))))}],errors:[],has_more:false}),head:async({source:s})=>({source:s,complete:true,high_watermark:rows.reduce((max,r)=>BigInt(r.cursor)>BigInt(max)?r.cursor:max,'0')}),readPage:async({source:s,after,through,limit})=>{const selected=rows.filter(r=>BigInt(r.cursor)>BigInt(after)&&BigInt(r.cursor)<=BigInt(through)).sort((a,b)=>Number(BigInt(a.cursor)-BigInt(b.cursor)));return {source:s,complete:true,rows:selected.slice(0,limit),has_more:selected.length>limit};},close(){this.closed++;}};}
const poll=(f,p,options={})=>pollWechatSource({source,provider:p,storage:createWechatStorage(f.store,f.config),clock:()=>Date.parse(at),...options});

test('WeChat messages, cursor and revision commit together; sender context survives learning and bundle import',async t=>{
 const f=fixture(t),rows=[message(1),message(2,'SYNTHETIC ONLY',{sender_id:null,sender_display_name:null,direction:'unknown',identity_status:'unknown',gaps:['sender_unknown']})],p=provider(rows);
 await poll(f,p);assert.equal(f.store.stats().events,2);await poll(f,p);assert.equal(f.store.stats().events,2);
 rows[0]={...rows[0],text:'CORRECTED',raw_hash:hash('CORRECTED')};await poll(f,p);assert.equal(f.store.stats().events,3);
 const chat=readWechatChat(f.store,f.config,{account_id:source.account_id,conversation_id:rows[0].conversation_id});assert.equal(chat.items.length,2);assert.equal(chat.items[0].revision,2);assert.equal(chat.items[1].direction,'unknown');assert.equal(chat.items[1].sender_id,null);assert.equal(chat.items[0].server_message_id,'9007199254740993');
 const learning=nextPersonal(f.store,f.config).batch;assert(learning.events.some(e=>e.wechat?.identity_status==='unknown'));assert(learning.events.some(e=>e.wechat?.previous_revision_id));
 const target=new Store(join(f.dir,'target.sqlite'));f.stores.push(target);target.addDevice(f.config);const bundle=f.store.exportBundle(f.config.org_id,{from:at,to:at});target.importBundle(bundle,f.config.org_id);assert.deepEqual(readWechatChat(target,f.config,{account_id:source.account_id,conversation_id:rows[0].conversation_id}),chat);
 assert.throws(()=>readWechatChat(target,f.config,{account_id:source.account_id,conversation_id:rows[0].conversation_id,device_id:uuid()}),/本设备/);
});

test('WeChat commit guard rollback retains both original cursor and message count',async t=>{
 const f=fixture(t),p=provider([message(1)]);let checks=0;const storage=createWechatStorage(f.store,f.config,{assertActive:()=>{if(++checks===2)throw Error('pause-during-commit');}});
 await assert.rejects(()=>poll(f,p,{storage}),/pause-during-commit/);assert.equal(f.store.stats().events,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM wechat_messages').get().n,0);assert.equal(storage.loadState(wechatSourceKey(source)),null);
 await poll(f,p);const old=JSON.parse(f.store.db.prepare('SELECT json FROM events LIMIT 1').get().json);const forged={...old,event_id:uuid(),sequence:old.sequence+1,payload:{...old.payload,revision_id:uuid(),message_key:hash('other')}};assert.throws(()=>f.store.ingest([forged],[],f.config.org_id),/标识不匹配|身份不一致/);assert.equal(f.store.stats().events,1);
});

test('Offline handoff carries chat identity and revisions into hub without source credentials',async t=>{
 const f=fixture(t),rows=[message(1)],p=provider(rows);await poll(f,p);rows[0]={...rows[0],text:'UPDATED',raw_hash:hash('UPDATED')};await poll(f,p);
 const output=join(f.dir,'test.wthandoff'),password='synthetic-only-password';const exported=await createOfflineHandoff(f.store,f.config,{output,password,tempDir:join(f.dir,'temp')});assert.equal(exported.manifest.counts.events,2);
 const inspected=await inspectOfflineHandoff({input:output,password,tempDir:join(f.dir,'inspect')});assert(!JSON.stringify(inspected).includes('key_hex'));
 const target=new Store(join(f.dir,'hub.sqlite'));f.stores.push(target);target.addDevice(f.config);target.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(f.config.installation_id,f.config.device_id);const hc={role:'hub',org_id:f.config.org_id};await importOfflineHandoff(target,hc,{input:output,password,tempDir:join(f.dir,'import')});const chat=readWechatChat(target,hc,{device_id:f.config.device_id,account_id:source.account_id,conversation_id:rows[0].conversation_id});assert.equal(chat.items[0].revision,2);assert.equal(chat.items[0].text,'UPDATED');assert.equal(target.db.prepare('SELECT COUNT(*) n FROM wechat_sources').get().n,0);
});

test('Passive collector requires probe, respects work time/capture start/pause, and rejects late reads',async t=>{
 const f=fixture(t);let now=Date.parse(at);const collector={enabled:true,policy:{...defaultPolicy,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59'}};
 const rows=[message(1),message(2,'BEFORE SCOPE',{sent_at:'2026-10-14T00:00:00.000Z'})],p=provider(rows);
 const wc=new WechatCollector({...f,getCollector:()=>collector,now:()=>now});wc.sourceConfig=()=>{wc.provider=p;wc.fingerprint='synthetic';return {};};
 const policy={...defaultWechatPolicy(),enabled:true,capture_since:at};assert.throws(()=>wc.configure(policy),/probe_required/);await wc.probe();wc.configure(policy);await wc.tick();assert.equal(f.store.stats().events,1);assert(wc.status().last_round.skipped_scope>=1);
 collector.enabled=false;wc.globalState(false);rows.push(message(3,'WHILE PAUSED',{sent_at:new Date(now+1000).toISOString()}));now+=3000;collector.enabled=true;wc.globalState(true);now+=60000;await wc.tick();assert.equal(f.store.stats().events,1);
 const outsidePolicy={...collector.policy,start:'12:00',end:'13:00'};collector.policy=outsidePolicy;now+=60000;assert.equal((await wc.tick()).reason,'paused_or_outside_schedule');collector.policy={...outsidePolicy,start:'00:00',end:'23:59'};
 now+=60000;let entered;const enteredPromise=new Promise(r=>entered=r);p.readPage=({source:s,signal})=>{entered();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({source:s,complete:true,rows:[message(4)],has_more:false}),{once:true}));};const pending=wc.tick();await enteredPromise;collector.enabled=false;wc.globalState(false);await pending;assert.equal(f.store.stats().events,1);assert(p.closed>0);
});

test('Existing WorkTrace MCP exposes reused read names; it never exposes sends or opens and reads only saved messages',async t=>{
 const dir=mkdtempSync(join(root,'mcp-')),app=await startApp({dir,port:0});t.after(async()=>{await app.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});
 const response=await fetch(new URL('/api/setup',app.url),{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({role:'collector',offline:{format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC',employee_id:'SYNTHETIC',employee_name:'SYNTHETIC',label:'SYNTHETIC'}})});assert(response.ok);
 assert(wechatDefinitions.every(d=>definitions.some(x=>x.name===d.name)));assert(!wechatDefinitions.some(x=>/send|open|draft|reception/.test(x.name)));
 const status=await callWechatReadTool(dir,'wechat_status');assert.equal(status.policy.enabled,false);
 await poll({store:app.store,config:app.config},provider([message(1)]));const chats=await callWechatReadTool(dir,'wechat_list_chats',{});assert.equal(chats.items[0].account_id,source.account_id);
 const data=await callWechatReadTool(dir,'wechat_read_chat',{account_id:source.account_id,conversation_id:'fixture_group@chatroom'});assert.equal(data.items[0].sender_id,'fixture_client');assert.equal(data.read_receipt_changed,false);
 await assert.rejects(()=>callWechatReadTool(dir,'wechat_send_text',{text:'NEVER SEND'}),/不提供微信控制/);await assert.rejects(()=>callWechatReadTool(dir,'wechat_read_chat',{chat:'同名群'}),/参数无效/);
 assert.equal(app.collector.enabled,false);assert.equal(app.wechatCollector.policy.enabled,false);
});
