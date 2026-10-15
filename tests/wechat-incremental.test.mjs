import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {canonical,hash} from '../src/protocol.mjs';
import {wechatSourceKey,validateWechatPayload} from '../src/wechat-schema.mjs';
import {pollWechatSource,validateWechatIncrementalState,wechatIncrementalCoverage} from '../src/wechat-incremental.mjs';

const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const source=(extra={})=>({account_id:'synthetic-self',db_generation:'synthetic-generation-1',shard_id:'message_0.db',table_id:'Msg_synthetic_table',...extra});
const row=(cursor,extra={})=>({cursor:String(cursor),source_message_id:`rowid:${cursor}:local:7`,local_message_id:'7',server_message_id:'9007199254740993',conversation_id:'synthetic-customer',conversation_kind:'private',sender_id:'synthetic-customer',sender_display_name:'合成客户',direction:'incoming',identity_status:'verified',message_kind:'text',message_status:'normal',sent_at:'2026-10-15T01:00:00.000Z',text:'合成消息，不是真实客户资料',raw_hash:hash(`synthetic raw row ${cursor}`),media:[],gaps:[],...extra});
const budget={max_rows:100,page_size:20,max_pages:3,max_ms:5000};
const msgKey=(s,r)=>hash(canonical([wechatSourceKey(s),r.source_message_id]));

class MemoryStorage{
 constructor(){this.states=new Map();this.messages=new Map();this.revisions=[];this.commits=0;this.lookups=0;}
 loadState(key){return clone(this.states.get(key)||null);}
 readMessage(key){this.lookups++;return clone(this.messages.get(key)||null);}
 commit(batch,{assertActive}){
  assert.equal((this.states.get(batch.source_key)?.version||0),batch.expected_version,'cursor conflict');
  const messages=new Map(this.messages),revisions=[...this.revisions];
  for(const change of batch.changes){
   assert.equal(messages.get(change.message_key)?.revision_id||null,change.previous_revision_id,'revision conflict');
   validateWechatPayload({format:'worktrace.wechat-message/1.0',source:change.source,message_key:change.message_key,revision_id:change.revision_id,revision:change.revision,previous_revision_id:change.previous_revision_id,observed_at:change.observed_at,message:change.message,text:change.message.text});
   messages.set(change.message_key,clone(change));revisions.push(clone(change));
  }
  this.beforeCommit?.(batch);assertActive();this.states.set(batch.source_key,clone(batch.next_state));this.messages=messages;this.revisions=revisions;this.commits++;
  if(this.afterCommitError)throw Error('synthetic acknowledgement lost after durable commit');
 }
}
function providerFor(rows=[],s=source()){
 return {rows:clone(rows),calls:[],headCalls:0,
  head(q){this.headCalls++;this.lastSignal=q.signal;assert.equal(q.priority,'background');return {source:clone(s),complete:true,high_watermark:this.rows.reduce((max,r)=>BigInt(r.cursor)>BigInt(max)?r.cursor:max,'0')};},
  readPage(q){
   this.calls.push({...q,signal:undefined});assert.equal(q.priority,'background');assert(q.signal instanceof AbortSignal);
   const selected=this.rows.filter(r=>BigInt(r.cursor)>BigInt(q.after)&&BigInt(r.cursor)<=BigInt(q.through)).sort((a,b)=>BigInt(a.cursor)<BigInt(b.cursor)?-1:1);
   return {source:clone(s),complete:true,rows:clone(selected.slice(0,q.limit)),has_more:selected.length>q.limit};
  }};
}
const poll=(provider,storage,extra={})=>pollWechatSource({provider,storage,source:source(),budget,...extra});

test('initial sweep is idempotent after restart and preserves numeric IDs without Number coercion',async()=>{
 const rows=[row('1'),row('2',{text:'相同内容仍是不同消息'}),row('3',{text:'相同内容仍是不同消息'})],storage=new MemoryStorage();
 const first=await poll(providerFor(rows),storage);assert.equal(first.stats.created,3);assert.equal(storage.revisions.length,3);assert.equal(first.state.tail,'3');
 assert.equal(first.changes[0].message.server_message_id,'9007199254740993');assert.equal(first.changes[0].message.local_message_id,'7');
 assert(first.changes.every(c=>c.revision===1&&c.previous_revision_id===null&&c.source.table_id===source().table_id));
 assert.equal(first.state.history_cycles,1);assert.equal(first.coverage.scope,'readable_rows_only');
 const reopened=new MemoryStorage();reopened.states=new Map(storage.states);reopened.messages=new Map(storage.messages);reopened.revisions=[...storage.revisions];
 const again=await poll(providerFor(rows),reopened);assert.equal(again.changes.length,0);assert.equal(reopened.revisions.length,3);assert.equal(again.state.version,2);
 assert.equal(again.stats.duplicates,6);assert.equal(reopened.lookups,3,'same message across overlap/history is a point lookup once per poll');
 assert.notEqual(first.changes[1].message_key,first.changes[2].message_key);
 assert.doesNotMatch(JSON.stringify(first.state),/合成消息|raw_hash|9007199254740993|secret|password|token/i);
});

test('account, generation, shard and table isolate identical local IDs and rowids',async()=>{
 const storage=new MemoryStorage(),sources=[source(),source({account_id:'synthetic-self-2'}),source({db_generation:'synthetic-generation-2'}),source({shard_id:'message_1.db'}),source({table_id:'Msg_other_table'})];
 for(const s of sources)await poll(providerFor([row('1')],s),storage,{source:s});
 assert.equal(storage.states.size,5);assert.equal(storage.messages.size,5);assert.equal(new Set(storage.revisions.map(c=>c.message_key)).size,5);
 assert(storage.revisions.every(c=>c.message.local_message_id==='7'));
});

test('actual rowid cursors above Number precision retain exact keyset bounds',async()=>{
 const storage=new MemoryStorage(),provider=providerFor([row('9007199254740992'),row('9007199254740993')]);
 for(let i=0;i<4;i++)await poll(provider,storage,{budget:{max_rows:1,page_size:1,max_pages:1,max_ms:5000,overlap_span:2}});
 assert.equal(storage.loadState(wechatSourceKey(source())).tail,'9007199254740993');assert.equal(storage.messages.size,2);
 assert.deepEqual(provider.calls.filter(q=>q.lane==='new').map(q=>[q.after,q.through]),[['9007199254740991','9007199254740993'],['9007199254740992','9007199254740993']]);
});

test('first deployment reads recent rows first while its independent history lane still reconciles old rows',async()=>{
 const storage=new MemoryStorage(),provider=providerFor([row('1'),row('2'),row('9999'),row('10000')]);
 const options={budget:{max_rows:1,page_size:1,max_pages:1,max_ms:5000,overlap_span:5}};
 const first=await poll(provider,storage,options);assert.equal(first.changes[0].message.cursor,'9999');assert.equal(first.state.history_verified_through,'0');assert.equal(first.coverage.new_rows_pending,true);
 for(let i=0;i<11;i++)await poll(provider,storage,options);
 assert.equal(storage.messages.size,4);assert.equal(storage.loadState(wechatSourceKey(source())).history_verified_through,'10000');
 assert.equal(provider.calls.find(q=>q.lane==='history').after,'0');
});

test('new, overlap and historical keyset pages rotate fairly under a one-page budget',async()=>{
 const storage=new MemoryStorage(),provider=providerFor(Array.from({length:12},(_,i)=>row(String(i+1))));
 for(let i=0;i<18;i++)await poll(provider,storage,{budget:{max_rows:2,page_size:2,max_pages:1,max_ms:5000,overlap_span:3}});
 assert.deepEqual(provider.calls.map(q=>q.lane),Array.from({length:18},(_,i)=>['new','overlap','history'][i%3]));
 assert(provider.calls.every(q=>q.limit===2));assert.equal(storage.messages.size,12);
 const state=storage.loadState(wechatSourceKey(source()));assert.equal(state.tail,'12');assert.equal(state.history_verified_through,'12');assert.equal(state.history_cycles,1);
});

test('late inserts and old revocations outside the overlap are repaired by bounded history sweeps',async()=>{
 const storage=new MemoryStorage(),provider=providerFor([row('10'),row('1000')]);
 await poll(provider,storage,{budget:{...budget,overlap_span:5}});
 provider.rows[0]=row('10',{message_status:'revoked',text:'',raw_hash:hash('synthetic revoked raw')});provider.rows.push(row('5',{text:'合成迟到旧行'}));
 const result=await poll(provider,storage,{budget:{...budget,overlap_span:5}});
 assert.equal(result.stats.created,1);assert.equal(result.stats.revised,1);assert.equal(storage.messages.size,3);
 const revoked=storage.messages.get(msgKey(source(),row('10')));assert.equal(revoked.revision,2);assert.equal(revoked.message.message_status,'revoked');assert.equal(revoked.message.text,'');
 assert.equal(revoked.previous_revision_id,storage.revisions.find(c=>c.message.cursor==='10'&&c.revision===1).revision_id);assert.equal(result.state.tail,'1000');
 assert(provider.calls.some(q=>q.lane==='history'&&q.after==='0'));
});

test('raw-only changes and A to B to A each append a new linked revision; missing rows are not revocations',async()=>{
 const original=row('1'),provider=providerFor([original,row('2')]),storage=new MemoryStorage();await poll(provider,storage);
 provider.rows[0]={...original,raw_hash:hash('changed encoding, same text')};await poll(provider,storage);
 provider.rows[0]=original;await poll(provider,storage);provider.rows=[row('2')];await poll(provider,storage);
 const history=storage.revisions.filter(c=>c.message_key===msgKey(source(),original));assert.deepEqual(history.map(c=>c.revision),[1,2,3]);
 assert.equal(history[0].content_hash,history[2].content_hash);assert.notEqual(history[0].revision_id,history[2].revision_id);assert.equal(history[2].previous_revision_id,history[1].revision_id);
 assert.equal(storage.messages.get(msgKey(source(),original)).message.message_status,'normal');
});

test('unknown group authors and unsupported media remain explicit gaps; no group-name attribution',async()=>{
 const unknown=row('1',{conversation_id:'synthetic-group@chatroom',conversation_kind:'group',sender_id:null,sender_display_name:null,direction:'unknown',identity_status:'unknown',message_kind:'image',text:'',media:[{kind:'image',state:'not_collected',reference:'synthetic-media-reference'}],gaps:['sender_id_unresolved','media_not_collected']}),storage=new MemoryStorage();
 const result=await poll(providerFor([unknown]),storage);assert.deepEqual(result.changes[0].message,unknown);assert.equal(result.changes[0].message.text,'');
 for(const extra of [{sender_id:'synthetic-group@chatroom',identity_status:'verified',direction:'incoming'},{sender_id:null,identity_status:'unknown',direction:'incoming'},{sender_id:'synthetic-self',identity_status:'verified',direction:'incoming'}]){
  const fresh=new MemoryStorage();await assert.rejects(poll(providerFor([{...unknown,...extra}]),fresh));assert.equal(fresh.commits,0);
 }
});

test('head failure, incomplete pages and a later failed page never commit earlier rows or cursor progress',async()=>{
 for(const mode of ['head','partial','later']){
  const storage=new MemoryStorage(),provider=providerFor([row('1'),row('2')]),original=provider.readPage;let calls=0;
  if(mode==='head')provider.head=()=>{throw Error('synthetic head failure');};
  provider.readPage=function(q){calls++;if(mode==='partial')return {...original.call(this,q),complete:false};if(mode==='later'&&calls===2)throw Error('synthetic page failure');return original.call(this,q);};
  await assert.rejects(poll(provider,storage));assert.equal(storage.commits,0);assert.equal(storage.messages.size,0);assert.equal(storage.states.size,0);
  if(mode==='head')assert.equal(calls,0);
 }
});

test('invalid ordering, limits, identity mismatch and apparent rowid regression fail without advancement',async()=>{
 const samples=[
  q=>({source:source(),complete:true,rows:[row('2'),row('1')],has_more:false}),
  q=>({source:source(),complete:true,rows:[row('3')],has_more:false}),
  q=>({source:source(),complete:true,rows:[],has_more:true}),
  q=>({source:source(),complete:true,rows:[row('1'),row('2'),row('3')],has_more:false}),
  q=>({source:source({account_id:'wrong-account'}),complete:true,rows:[row('1')],has_more:false}),
  q=>({source:source(),complete:true,rows:[row('1',{server_message_id:9007199254740993})],has_more:false}),
 ];
 for(const readPage of samples){const storage=new MemoryStorage(),provider=providerFor([row('2')]);provider.readPage=readPage;await assert.rejects(poll(provider,storage,{budget:{max_rows:2,page_size:2,max_pages:1}}));assert.equal(storage.commits,0);}
 const storage=new MemoryStorage();await poll(providerFor([row('2')]),storage);const before=clone([...storage.states]);
 await assert.rejects(poll(providerFor([row('1')]),storage),{code:'WECHAT_GENERATION_REGRESSED'});assert.deepEqual([...storage.states],before);
});

test('same row changing between lanes discards the mixed-snapshot round instead of reverting stored revisions',async()=>{
 const storage=new MemoryStorage(),provider=providerFor([row('1')]),original=provider.readPage;
 provider.readPage=function(q){const page=original.call(this,q);if(q.lane==='overlap')page.rows[0]=row('1',{text:'合成并发修改',raw_hash:hash('concurrent synthetic write')});return page;};
 await assert.rejects(poll(provider,storage),{code:'WECHAT_SOURCE_UNSTABLE'});assert.equal(storage.commits,0);
});

test('abort before read, during provider wait and immediately before atomic commit cannot write',async()=>{
 const pre=new AbortController();pre.abort();const first=providerFor([row('1')]),storage=new MemoryStorage();
 await assert.rejects(poll(first,storage,{signal:pre.signal}),{code:'WECHAT_ABORTED'});assert.equal(first.headCalls,0);
 const controller=new AbortController(),provider=providerFor([row('1')]);let finish;
 provider.readPage=q=>new Promise(resolve=>{finish=()=>resolve({source:source(),complete:true,rows:[row('1')],has_more:false});controller.abort();});
 await assert.rejects(poll(provider,storage,{signal:controller.signal}),{code:'WECHAT_ABORTED'});finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(storage.commits,0);
 const final=new AbortController();storage.beforeCommit=()=>final.abort();await assert.rejects(poll(providerFor([row('1')]),storage,{signal:final.signal}),{code:'WECHAT_ABORTED'});assert.equal(storage.commits,0);assert.equal(storage.states.size,0);
});

test('wall-time deadline rejects a late provider result and a deterministic clock expires before commit',async()=>{
 const storage=new MemoryStorage(),provider=providerFor([row('1')]);let finish;
 provider.head=q=>new Promise(resolve=>{finish=()=>resolve({source:source(),complete:true,high_watermark:'1'});});
 await assert.rejects(poll(provider,storage,{budget:{max_ms:20}}),{code:'WECHAT_DEADLINE'});finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(storage.commits,0);
 let time=Date.parse('2026-10-15T01:00:00.000Z');const other=providerFor([row('1')]),original=other.readPage;
 other.readPage=function(q){const response=original.call(this,q);time+=100;return response;};
 await assert.rejects(poll(other,storage,{clock:()=>time,budget:{max_ms:50}}),{code:'WECHAT_DEADLINE'});assert.equal(storage.commits,0);
});

test('row, page and byte limits are enforced without advancing on truncated oversized rounds',async()=>{
 const storage=new MemoryStorage(),provider=providerFor(Array.from({length:20},(_,i)=>row(String(i+1))));
 const result=await poll(provider,storage,{budget:{max_rows:3,page_size:2,max_pages:10,max_ms:5000}});assert.equal(result.stats.rows,3);assert.equal(result.stats.pages,2);assert.deepEqual(provider.calls.map(q=>q.limit),[2,1]);assert.equal(result.state.tail,'2');
 const fresh=new MemoryStorage();await assert.rejects(poll(providerFor([row('1')]),fresh,{budget:{max_bytes:50}}),{code:'WECHAT_BYTE_BUDGET'});assert.equal(fresh.commits,0);
 for(const bad of [{max_rows:0},{max_pages:21},{max_ms:30001},{max_bytes:8388609},{overlap_span:1000001},{unknown:1}])await assert.rejects(poll(provider,fresh,{budget:bad}));
});

test('trusted scope filtering advances cursors without storing or looking up out-of-scope messages',async()=>{
 const storage=new MemoryStorage(),provider=providerFor([row('1',{sent_at:null}),row('2'),row('3',{sent_at:'2026-10-14T01:00:00.000Z'})]);
 const filter=(m,s)=>{assert.deepEqual(s,source());return m.sent_at!==null&&m.sent_at>='2026-10-15T00:00:00.000Z';};
 const result=await poll(provider,storage,{includeMessage:filter});assert.equal(result.state.tail,'3');assert.equal(result.stats.created,1);assert.equal(result.stats.skipped_scope,6);assert.equal(result.state.totals.skipped_scope,6);assert.equal(storage.lookups,1);assert.equal(storage.revisions[0].message.cursor,'2');
 const allExcluded=await poll(providerFor([row('1')]),new MemoryStorage(),{includeMessage:()=>false});assert.equal(allExcluded.state.tail,'1');assert.equal(allExcluded.changes.length,0);
 for(const includeMessage of [()=>undefined,()=>Promise.resolve(true),()=>{throw Error('synthetic configuration failure');}]){
  const fresh=new MemoryStorage();await assert.rejects(poll(providerFor([row('1')]),fresh,{includeMessage}));assert.equal(fresh.commits,0);
 }
 // A trusted callback cannot accidentally mutate the canonical event being recorded.
 const isolated=await poll(providerFor([row('1')]),new MemoryStorage(),{includeMessage:m=>{m.text='mutated';return true;}});assert.equal(isolated.changes[0].message.text,row('1').text);
});

test('concurrent polls require cursor CAS; an acknowledgement lost after commit retries without duplicates',async()=>{
 const storage=new MemoryStorage(),provider=providerFor([row('1')]);
 const results=await Promise.allSettled([poll(provider,storage),poll(provider,storage)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(storage.revisions.length,1);
 const lost=new MemoryStorage();lost.afterCommitError=true;await assert.rejects(poll(providerFor([row('1')]),lost),/acknowledgement/);assert.equal(lost.revisions.length,1);
 lost.afterCommitError=false;const retry=await poll(providerFor([row('1')]),lost);assert.equal(retry.changes.length,0);assert.equal(lost.revisions.length,1);
});

test('malformed, foreign and overflowed checkpoints cannot silently reset collection history',async()=>{
 const storage=new MemoryStorage();const good=(await poll(providerFor([row('1')]),storage)).state;
 for(const change of [{source:source({table_id:'other'})},{tail:'-1'},{tail:'2'},{history:{after:'2',through:'1'}},{next_lane:3},{version:Number.MAX_SAFE_INTEGER},{history_verified_through:'2'},{totals:{...good.totals,rows:-1}}]){
  const bad={...clone(good),...change};assert.throws(()=>validateWechatIncrementalState(bad,source()));
 }
 assert.deepEqual(wechatIncrementalCoverage(good),{new_rows_pending:false,history_cycle_active:false,history_verified_through:'1',history_cycles:1,overlap_cycle_active:false,overlap_verified_through:'1',scope:'readable_rows_only',missing_rows:'not_inferred_as_revoked'});
});

test('SQLite caller transaction rolls back message and cursor together; a reopened store resumes exactly',async t=>{
 const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-wechat-incremental-tests');mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'case-')),path=join(directory,'synthetic.sqlite');let db;
 const open=()=>{db=new DatabaseSync(path);db.exec('CREATE TABLE IF NOT EXISTS states(k TEXT PRIMARY KEY,j TEXT);CREATE TABLE IF NOT EXISTS messages(k TEXT PRIMARY KEY,j TEXT);CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,j TEXT)');};open();
 t.after(()=>{db?.close();assert(resolve(directory).startsWith(base+sep));rmSync(directory,{recursive:true,force:true});});
 const storage={fail:true,loadState:k=>{const r=db.prepare('SELECT j FROM states WHERE k=?').get(k);return r?JSON.parse(r.j):null;},readMessage:k=>{const r=db.prepare('SELECT j FROM messages WHERE k=?').get(k);return r?JSON.parse(r.j):null;},
  commit(batch,{assertActive}){db.exec('BEGIN IMMEDIATE');try{
   assert.equal(this.loadState(batch.source_key)?.version||0,batch.expected_version);
   for(const c of batch.changes){assert.equal(this.readMessage(c.message_key)?.revision_id||null,c.previous_revision_id);db.prepare('INSERT INTO revisions VALUES(?,?)').run(c.revision_id,JSON.stringify(c));db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?)').run(c.message_key,JSON.stringify(c));}
   if(this.fail)throw Error('synthetic crash between message and cursor writes');
   db.prepare('INSERT OR REPLACE INTO states VALUES(?,?)').run(batch.source_key,JSON.stringify(batch.next_state));assertActive();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}}
 };
 await assert.rejects(poll(providerFor([row('1'),row('2')]),storage),/synthetic crash/);assert.equal(db.prepare('SELECT count(*) n FROM revisions').get().n,0);assert.equal(storage.loadState(wechatSourceKey(source())),null);
 storage.fail=false;await poll(providerFor([row('1'),row('2')]),storage);db.close();open();
 const resumed=await poll(providerFor([row('1'),row('2'),row('3')]),storage);assert.equal(resumed.stats.created,1);assert.equal(db.prepare('SELECT count(*) n FROM revisions').get().n,3);assert.equal(resumed.state.tail,'3');
});
