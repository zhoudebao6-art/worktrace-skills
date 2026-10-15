import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {zstdCompressSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {getPriority} from 'node:os';
import {WechatProvider,WechatJsonReader,normalizeWechatRow} from '../src/wechat-provider.mjs';
import {pollWechatSource} from '../src/wechat-incremental.mjs';
import {canonical,hash} from '../src/protocol.mjs';
import {Store} from '../src/store.mjs';
import {createOfflineIdentity} from '../src/offline-identity.mjs';
import {createWechatStorage,readWechatChat} from '../src/wechat-store.mjs';

const md5=s=>createHash('md5').update(s).digest('hex');
const table=name=>'Msg_'+md5(name);
const source=(conversation='synthetic-customer')=>({account_id:'synthetic-self',db_generation:'synthetic-fileid-salt-generation',shard_id:'message_0.db',table_id:table(conversation)});
const raw=(cursor='1',extra={})=>({cursor,local_id:'7',server_id:'9007199254740993',sort_seq:'1',create_time:'1792026000',local_type:'1',real_sender_id:'2',sender_username:'synthetic-customer',message_content:'合成消息：请核对资料。',source:null,WCDB_CT_message_content:'0',...extra});
const blob=bytes=>({encoding:'base64',data:Buffer.from(bytes).toString('base64')});
const clone=v=>JSON.parse(JSON.stringify(v));

function nativeFixture(shards){
 const calls=[];
 const read=async request=>{
  calls.push(clone(request));const shard=shards[request.shard_id];
  if(shard.error)return {ok:false,complete:false,error:shard.error};
  if(request.expected_generation&&request.expected_generation!==shard.generation)return {ok:false,complete:false,error:'database_generation_changed'};
  const result={id:request.id,ok:true,complete:true,readonly:true,query:request.query,shard_id:request.shard_id,table_id:request.table_id??null,db_generation:shard.generation,rows:[],has_more:false};
  if(request.query==='head'){result.high_watermark=(shard.messages[request.table_id]||[]).reduce((max,row)=>BigInt(row.cursor)>BigInt(max)?row.cursor:max,'0');return result;}
  let rows;
  if(request.query==='schema')rows=[{cursor:'1',name:'Name2Id'},...Object.keys(shard.messages).map((name,i)=>({cursor:String(i+2),name}))];
  else if(request.query==='name2id')rows=shard.names.map((user_name,i)=>({cursor:String(i+1),user_name}));
  else if(request.query==='messages')rows=shard.messages[request.table_id]||[];
  else throw Error('test fixture disallows arbitrary SQL');
  rows=rows.filter(row=>BigInt(row.cursor)>BigInt(request.after||'0')&&(request.through===undefined||BigInt(row.cursor)<=BigInt(request.through))).sort((a,b)=>BigInt(a.cursor)<BigInt(b.cursor)?-1:1);
  result.rows=clone(rows.slice(0,request.limit));result.has_more=rows.length>request.limit;return result;
 };
 return {read,calls,shards};
}
function standardShard(extra={}){return {generation:source().db_generation,names:['synthetic-self','synthetic-customer'],messages:{[table('synthetic-customer')]:[raw()]},...extra};}
function setup(t,shards={'message_0.db':standardShard()},options={}){
 const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-wechat-provider-tests');mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'case-')),messages=join(directory,'db_storage','message');mkdirSync(messages,{recursive:true});
 for(const name of Object.keys(shards))writeFileSync(join(messages,name),'synthetic file placeholder; never opened as a database');
 const native=nativeFixture(shards),provider=new WechatProvider({account_root:directory,account_id:'synthetic-self',read:native.read,...options});
 t.after(async()=>{await provider.close();assert(resolve(directory).startsWith(base+sep));rmSync(directory,{recursive:true,force:true});});return {provider,native,directory,messages};
}

test('discovery maps hashed conversation tables using paged Name2Id and preserves sender IDs',async t=>{
 const group='synthetic-group@chatroom',shard=standardShard({names:['synthetic-self','synthetic-customer',group,'synthetic-member'],messages:{[table('synthetic-customer')]:[raw('1')],[table(group)]:[raw('2',{sender_username:'synthetic-member',message_content:'synthetic-member:\n群内合成正文'})]}});
 const {provider,native}=setup(t,{'message_0.db':shard}),discovery=await provider.discover();
 assert.equal(discovery.sources.length,2);assert.equal(discovery.errors.length,0);assert.equal(discovery.heads.length,2);assert.equal(discovery.has_more,false);
 assert.equal(native.calls.filter(r=>r.query==='head').length,2,'one head per table per discovery, not repeated polling within a round');
 const groupSource=discovery.sources.find(s=>s.table_id===table(group)),head=await provider.head({source:groupSource}),page=await provider.readPage({source:groupSource,after:'0',through:head.high_watermark,limit:5});
 assert.equal(page.rows[0].conversation_id,group);assert.equal(page.rows[0].conversation_kind,'group');assert.equal(page.rows[0].sender_id,'synthetic-member');assert.equal(page.rows[0].direction,'incoming');assert.equal(page.rows[0].text,'群内合成正文');
 assert.equal(page.rows[0].server_message_id,'9007199254740993');assert.equal(page.rows[0].source_message_id,'rowid:2:local:7');
 const before=native.calls.length;await provider.discover();assert(native.calls.slice(before).every(r=>r.query==='head'),'cached discovery does not rescan schema/name pages every interval');
 assert(native.calls.every(r=>r.timeout_ms>=50&&r.timeout_ms<=10000&&!Object.hasOwn(r,'key')&&!Object.hasOwn(r,'sql')));
});

test('bounded discovery rotates shards and tables; an unreadable shard does not hide readable peers',async t=>{
 const shards={};for(let i=0;i<12;i++)shards[`message_${i}.db`]=standardShard({generation:'synthetic-generation-'+i});shards['message_0.db'].error='key_not_prepared';
 const {provider,native}=setup(t,shards);let latest;
 for(let i=0;i<8;i++){const before=native.calls.length;latest=await provider.discover();assert(native.calls.length-before<=8);assert(!latest.sources.some(s=>s.shard_id==='message_0.db'));}
 assert.equal(new Set(latest.sources.map(s=>s.shard_id)).size,11);assert(native.calls.some(r=>r.shard_id==='message_11.db'&&r.query==='head'));
 let sawError=false;for(let i=0;i<3;i++)if((await provider.discover()).errors.some(e=>e.code==='key_not_prepared'))sawError=true;assert(sawError);assert.equal(latest.coverage.media_collected,false);
});

test('catalog pagination continues across calls and removes dropped tables after its bounded refresh',async t=>{
 let now=Date.now();const conversations=Array.from({length:90},(_,i)=>'synthetic-contact-'+i),shard=standardShard({names:conversations,messages:Object.fromEntries(conversations.map(name=>[table(name),[raw()]]))});
 const {provider,native}=setup(t,{'message_0.db':shard},{clock:()=>now});let discovery;
 for(let i=0;i<30;i++)discovery=await provider.discover();
 assert.equal(discovery.sources.length,90);assert(native.calls.filter(q=>q.query==='schema').some(q=>q.after!=='0'));assert.equal(new Set(native.calls.filter(q=>q.query==='head').map(q=>q.table_id)).size,90);
 const removed=table(conversations[0]);delete shard.messages[removed];now+=300001;
 for(let i=0;i<3;i++)discovery=await provider.discover();assert(!discovery.sources.some(s=>s.table_id===removed));
});

test('generation replacement invalidates old sources and rejects a mixed-source page',async t=>{
 const {provider,native}=setup(t);const first=await provider.discover(),old=first.sources[0];native.shards['message_0.db'].generation='replacement-fileid-and-salt';
 await assert.rejects(provider.head({source:old}),{code:'database_generation_changed'});
 const invalid=await provider.discover();assert.equal(invalid.sources.length,0);assert(invalid.errors.some(e=>e.code==='database_generation_changed'));
 const refreshed=await provider.discover();assert.equal(refreshed.sources[0].db_generation,'replacement-fileid-and-salt');await assert.rejects(provider.head({source:old}),{code:'wechat_source_not_discovered'});
});

test('unknown Name2Id/group authors stay unknown; self direction depends on stable sender username only',()=>{
 const unknown=normalizeWechatRow(raw('1',{sender_username:null,message_content:'谁的昵称:\n不得猜作者'}),source('synthetic-group@chatroom'),{conversation_id:'synthetic-group@chatroom'});
 assert.equal(unknown.sender_id,null);assert.equal(unknown.direction,'unknown');assert.equal(unknown.identity_status,'unknown');assert.equal(unknown.text,'谁的昵称:\n不得猜作者');
 const missing=normalizeWechatRow(raw(),source());assert.equal(missing.conversation_kind,'unknown');assert(missing.gaps.includes('conversation_id_unresolved'));
 const self=normalizeWechatRow(raw('1',{sender_username:'synthetic-self'}),source(),{conversation_id:'synthetic-customer'});assert.equal(self.direction,'outgoing');
 const groupAsAuthor=normalizeWechatRow(raw('1',{sender_username:'synthetic-group@chatroom'}),source('synthetic-group@chatroom'),{conversation_id:'synthetic-group@chatroom'});assert.equal(groupAsAuthor.sender_id,null);
});

test('bounded zstd/UTF-8 decoding preserves text and records truncation or unsupported encoding gaps',()=>{
 const text='合成压缩消息😀',compressed=blob(zstdCompressSync(Buffer.from(text))),decoded=normalizeWechatRow(raw('1',{message_content:compressed,WCDB_CT_message_content:'4'}),source(),{conversation_id:'synthetic-customer'});
 assert.equal(decoded.text,text);assert.equal(decoded.gaps.length,0);
 const large=normalizeWechatRow(raw('1',{message_content:'合'.repeat(100000)}),source());assert.equal(large.text.length,60000);assert(large.gaps.includes('body_byte_limit'));assert(large.gaps.includes('body_text_limit'));assert(!large.gaps.includes('body_utf8_unreadable'));
 const bomb=normalizeWechatRow(raw('1',{message_content:blob(zstdCompressSync(Buffer.alloc(400000,65)))}),source());assert.equal(bomb.text,'');assert(bomb.gaps.includes('body_zstd_unreadable_or_oversized'));
 const invalid=normalizeWechatRow(raw('1',{message_content:blob([0xff,0xfe])}),source());assert.equal(invalid.text,'');assert(invalid.gaps.includes('body_utf8_unreadable'));
 const frame=zstdCompressSync(Buffer.from('完整合成帧'));
 for(const bytes of [Buffer.from('KLUv/Q==','base64'),frame.subarray(0,frame.length-1),Buffer.concat([frame,Buffer.from([1])])]){
  const truncated=normalizeWechatRow(raw('1',{message_content:blob(bytes)}),source());assert.equal(truncated.text,'');assert(truncated.gaps.includes('body_zstd_unreadable_or_oversized'));
 }
 const concatenated=normalizeWechatRow(raw('1',{message_content:blob(Buffer.concat([frame,frame]))}),source());assert.equal(concatenated.text,'完整合成帧完整合成帧');
 assert.throws(()=>normalizeWechatRow(raw('1',{message_content:{encoding:'base64',data:'***'}}),source()),{code:'wechat_blob_invalid'});
 assert.throws(()=>normalizeWechatRow(raw('1',{server_id:9007199254740993}),source()),{code:'wechat_integer_invalid'});
});

test('media, app XML and system notices preserve bounded raw text without pretending to parse attachments or revoke targets',()=>{
 for(const [local_type,kind] of [['3','image'],['34','voice'],['43','video'],['49','file']]){
  const item=normalizeWechatRow(raw('1',{local_type,message_content:'<msg><appmsg><type>6</type><path>C:\\never-read\\customer-file</path></appmsg></msg>'}),source());
  assert.equal(item.message_kind,kind);assert(item.text.includes('C:\\never-read\\customer-file'));assert(item.gaps.includes('non_text_raw_payload'));assert.equal(item.media[0].state,'not_collected');assert.match(item.media[0].reference,/^sha256:[a-f0-9]{64}$/);
 }
 const notice=normalizeWechatRow(raw('1',{local_type:'10002',message_content:'<sysmsg type="revokemsg"><revokemsg><newmsgid>9007199254740993</newmsgid></revokemsg></sysmsg>'}),source());
 assert.equal(notice.message_kind,'system');assert.equal(notice.message_status,'normal');assert(notice.text.includes('revokemsg'));assert(notice.gaps.includes('revoke_notice_target_unresolved'));
 const disguised=normalizeWechatRow(raw('1',{local_type:'1',message_content:'<sysmsg type="not-plain-text" />'}),source());assert.equal(disguised.message_kind,'other');assert.equal(disguised.text,'<sysmsg type="not-plain-text" />');
 const system=normalizeWechatRow(raw('1',{local_type:'10000',message_content:'合成系统通知：群成员发生变化'}),source());assert.equal(system.text,'合成系统通知：群成员发生变化');assert(system.gaps.includes('non_text_raw_payload'));
 const shared=normalizeWechatRow(raw('1',{local_type:'49',message_content:'<msg><appmsg><type>5</type><title>合成链接</title><url>https://example.invalid/never-fetch</url></appmsg></msg>'}),source());assert.equal(shared.message_kind,'other');assert(shared.text.includes('https://example.invalid/never-fetch'));assert(shared.gaps.includes('non_text_raw_payload'));
 const a=normalizeWechatRow(raw('1',{source:blob([1,2,3])}),source()),b=normalizeWechatRow(raw('1',{source:blob([1,2,4])}),source());assert.notEqual(a.raw_hash,b.raw_hash);assert.equal(a.text,b.text);
});

test('only the configured account message directory is scanned and symlink/junction entries are rejected',async t=>{
 const {provider,messages,directory}=setup(t);writeFileSync(join(messages,'unrelated.sqlite'),'synthetic');writeFileSync(join(messages,'contact.db'),'synthetic');mkdirSync(join(messages,'message_2.db'));
 const outside=join(directory,'synthetic-outside');mkdirSync(outside);symlinkSync(outside,join(messages,'message_3.db'),'junction');
 const result=await provider.discover();assert.equal(result.sources.length,1);assert(result.errors.some(e=>e.shard_id==='message_2.db'));assert(result.errors.some(e=>e.shard_id==='message_3.db'));
 await assert.rejects(provider.head({source:{...result.sources[0],account_id:'other'}}),{code:'wechat_account_mismatch'});
 await assert.rejects(provider.readPage({source:result.sources[0],after:'0',through:'1',limit:501}),{code:'wechat_page_request_invalid'});
});

test('injected requests are single-flight, partial/read-write responses fail, and native diagnostics never escape',async t=>{
 let active=0,maximum=0;const fixture=setup(t);const base=fixture.native.read;
 const provider=new WechatProvider({account_root:fixture.directory,account_id:'synthetic-self',read:async(req,options)=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setImmediate(resolve));try{return await base(req,options);}finally{active--;}}});t.after(()=>provider.close());
 const result=await provider.discover(),s=result.sources[0];await Promise.all([provider.head({source:s}),provider.head({source:s}),provider.head({source:s})]);assert.equal(maximum,1);
 for(const response of [{ok:false,error:'SYNTHETIC-SECRET-with-private-path'},{ok:true,complete:false,readonly:true},{ok:true,complete:true,readonly:false}]){
  const bad=new WechatProvider({account_root:fixture.directory,account_id:'synthetic-self',read:async()=>response});t.after(()=>bad.close());const report=await bad.discover();assert.equal(report.sources.length,0);assert.equal(report.errors.length,1);assert(!JSON.stringify(report).includes('SECRET'));
 }
});

test('close cancels an in-flight discovery without spawning more reads and allows an explicit subsequent restart',async t=>{
 const fixture=setup(t);let release,calls=0,hold=true;
 const provider=new WechatProvider({account_root:fixture.directory,account_id:'synthetic-self',read:async(req)=>{calls++;if(hold)await new Promise(resolve=>{release=resolve;});return fixture.native.read(req);}});t.after(()=>provider.close());
 const pending=provider.discover();while(!release)await new Promise(resolve=>setImmediate(resolve));await provider.close();await assert.rejects(pending,{code:'wechat_reader_cancelled'});const stopped=calls;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,stopped);
 hold=false;assert.equal((await provider.discover()).sources.length,1);
});

function childFactory(handler){
 const children=[],priorities=[];
 const spawnImpl=(path,args,options)=>{
  const child=new EventEmitter();child.pid=12345+children.length;child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=0;child.invocation={path,args,options};
  child.stdin=new Writable({write(buffer,encoding,callback){const request=JSON.parse(buffer.toString());callback();handler(child,request);}});
  child.kill=()=>{child.killed++;queueMicrotask(()=>child.emit('close',1));return true;};children.push(child);queueMicrotask(()=>child.emit('spawn'));return child;
 };
 const reader=new WechatJsonReader({reader_path:resolve('synthetic-reader.exe'),dll_path:resolve('synthetic-codec.dll'),profile_path:resolve('synthetic-profile.json'),spawnImpl,setPriorityImpl:(pid,priority)=>priorities.push([pid,priority])});
 return {reader,children,priorities};
}

test('persistent native transport hides its window, lowers only its own PID and closes/restarts cleanly',async t=>{
 const fixture=childFactory((child,req)=>{child.stderr.write('synthetic secret never retained');queueMicrotask(()=>child.stdout.write(JSON.stringify({id:req.id,ok:true})+'\n'));});t.after(()=>fixture.reader.close());
 const first=await fixture.reader.read({query:'head'});await fixture.reader.read({query:'head'});assert.equal(first.ok,true);assert.equal(fixture.children.length,1);assert.equal(fixture.children[0].invocation.options.windowsHide,true);assert.deepEqual(fixture.children[0].invocation.args.slice(0,1),['--dll']);assert.deepEqual(fixture.priorities.map(x=>x[0]),[fixture.children[0].pid]);
 fixture.reader.close();assert.equal(fixture.children[0].killed,1);await fixture.reader.read({query:'head'});assert.equal(fixture.children.length,2);
});

test('native deadline/abort/oversized output/mismatched replies kill only the owned child and reject late results',async t=>{
 for(const mode of ['timeout','abort','bytes','mismatch','error']){
  let request;const fixture=childFactory((child,req)=>{request=req;if(mode==='bytes')queueMicrotask(()=>child.stdout.write(Buffer.alloc(8*1024*1024+1,65)));if(mode==='mismatch')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:'wrong',ok:true})+'\n'));if(mode==='error')queueMicrotask(()=>child.emit('error',Error('synthetic secret must not escape')));});t.after(()=>fixture.reader.close());
  const abort=new AbortController(),pending=fixture.reader.read({query:'head'},{deadline:Date.now()+30,signal:abort.signal});if(mode==='abort'){while(!request)await new Promise(resolve=>setImmediate(resolve));abort.abort();}
  await assert.rejects(pending,error=>{assert(!error.message.includes('secret'));return /^wechat_reader_/.test(error.code);});assert.equal(fixture.children.length,1);assert.equal(fixture.children[0].killed,1);
  if(request)fixture.children[0].stdout.write(JSON.stringify({id:request.id,ok:true})+'\n');
 }
});

test('provider plus incremental engine stores synthetic revisions and cursor atomically through the adapter contract',async t=>{
 const {provider,native}=setup(t);const s=(await provider.discover()).sources[0],states=new Map(),messages=new Map(),events=[];
 const storage={loadState:key=>states.get(key)||null,readMessage:key=>messages.get(key)||null,commit(batch,{assertActive}){assert.equal(states.get(batch.source_key)?.version||0,batch.expected_version);assertActive();for(const c of batch.changes){assert.equal(c.content_hash,hash(canonical(c.message)));messages.set(c.message_key,c);events.push(c);}states.set(batch.source_key,batch.next_state);}};
 const first=await pollWechatSource({provider,source:s,storage,budget:{max_ms:5000}});assert.equal(first.stats.created,1);
 native.shards['message_0.db'].messages[s.table_id][0].message_content='合成修改后的正文';const second=await pollWechatSource({provider,source:s,storage,budget:{max_ms:5000}});assert.equal(second.stats.revised,1);assert.equal(events[1].previous_revision_id,events[0].revision_id);
 const third=await pollWechatSource({provider,source:s,storage,budget:{max_ms:5000}});assert.equal(third.changes.length,0);assert.equal(events.length,2);
});

test('Windows native encrypted WAL flows through provider, incremental engine and actual WorkTrace store', {skip:process.platform!=='win32'||!process.env.WORKTRACE_WECHAT_NATIVE_DIR,timeout:45000},async t=>{
 const binaries=process.env.WORKTRACE_WECHAT_NATIVE_DIR,base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-wechat-provider-tests');mkdirSync(base,{recursive:true});
 const directory=mkdtempSync(join(base,'native-')),account=join(directory,'account'),profile=join(directory,'profile.json');
 const fixture=spawn(join(binaries,'worktrace-native-fixture.exe'),[account,profile],{windowsHide:true,stdio:['pipe','pipe','pipe']});fixture.stderr.resume();
 const queued=[],waiting=[];let closed=false;
 const lines=createInterface({input:fixture.stdout});lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{value={ok:false,error:'synthetic_fixture_invalid_json'};}if(waiting.length)waiting.shift().resolve(value);else queued.push(value);});
 fixture.once('error',()=>{closed=true;for(const w of waiting.splice(0))w.reject(Error('synthetic_fixture_start_failed'));});fixture.once('close',()=>{closed=true;for(const w of waiting.splice(0))w.reject(Error('synthetic_fixture_closed'));});
 const next=()=>queued.length?Promise.resolve(queued.shift()):closed?Promise.reject(Error('synthetic_fixture_closed')):new Promise((resolveResult,reject)=>{const w={resolve:value=>{clearTimeout(timer);resolveResult(value);},reject:error=>{clearTimeout(timer);reject(error);}};const timer=setTimeout(()=>{const index=waiting.indexOf(w);if(index>=0)waiting.splice(index,1);reject(Error('synthetic_fixture_timeout'));},10000);waiting.push(w);});
 const command=async text=>{fixture.stdin.write(text+'\n');assert.equal((await next()).ok,true);};
 const waitClosed=child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise((resolveClosed,rejectClosed)=>{const timer=setTimeout(()=>child.kill(),3000),guard=setTimeout(()=>rejectClosed(Error('synthetic_child_did_not_exit')),6000);child.once('close',()=>{clearTimeout(timer);clearTimeout(guard);resolveClosed();});});
 let provider,store;
 try{
  const ready=await next();assert.equal(ready.ok,true);assert.equal(ready.table_id,table('fixture-other'));
  provider=new WechatProvider({reader_path:join(binaries,'worktrace-wechat-reader.exe'),dll_path:join(binaries,'worktrace-wcdb.dll'),profile_path:profile,account_root:account,account_id:'fixture-self'});
  const original=[ready.database_path,ready.database_path+'-wal'].map(path=>hash(readFileSync(path)));
  const discovery=await provider.discover({deadline:Date.now()+10000});assert.equal(discovery.errors.length,0);assert.equal(discovery.sources.length,1);const source=discovery.sources[0];assert.equal(source.table_id,ready.table_id);
  const nativeChild=provider.reader.child;assert(nativeChild?.pid);assert(getPriority(nativeChild.pid)>=10,'only owned reader is running at BelowNormal or lower priority');
  const firstPage=await provider.readPage({source,after:'0',through:'2',limit:2,deadline:Date.now()+5000});assert.equal(firstPage.rows.length,2);assert.equal(firstPage.rows[0].conversation_id,'fixture-other');assert.equal(firstPage.rows[0].sender_id,'fixture-other');assert.equal(firstPage.rows[0].server_message_id,'9007199254740993');assert.equal(firstPage.rows[1].sender_id,null);assert(firstPage.rows[1].gaps.includes('body_zstd_unreadable_or_oversized'));
  assert.deepEqual([ready.database_path,ready.database_path+'-wal'].map(path=>hash(readFileSync(path))),original,'reader never modifies source DB/WAL bytes');
  store=new Store(join(directory,'worktrace.sqlite'));const config=createOfflineIdentity({format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC ONLY',employee_id:'SYNTHETIC-WECHAT',employee_name:'SYNTHETIC',label:'SYNTHETIC NATIVE TEST'});store.addDevice(config);
  const storage=createWechatStorage(store,config),first=await pollWechatSource({provider,source,storage,budget:{max_ms:10000}});assert.equal(first.stats.created,2);assert.equal(store.stats().events,2);
  await command('append');assert.equal((await provider.head({source,deadline:Date.now()+5000})).high_watermark,'3');
  const more=await pollWechatSource({provider,source,storage,budget:{max_ms:10000}});assert.equal(more.stats.created,1);assert.equal(provider.reader.child.pid,nativeChild.pid,'native process persists across queries');
  await command('uncommitted');assert.equal((await provider.head({source,deadline:Date.now()+5000})).high_watermark,'3');await command('rollback');
  const chat=readWechatChat(store,config,{account_id:'fixture-self',conversation_id:'fixture-other'});assert.equal(chat.items.length,3);assert.equal(chat.items[0].server_message_id,'9007199254740993');assert.equal(chat.items[1].sender_id,null);assert.equal(chat.items[2].text,'third');
  const beforeFailure=canonical(storage.loadState(wechatSourceKeyForTest(source)));await command('oversize');await assert.rejects(pollWechatSource({provider,source,storage,budget:{max_ms:10000}}));assert.equal(store.stats().events,3);assert.equal(canonical(storage.loadState(wechatSourceKeyForTest(source))),beforeFailure);
  await provider.close();await waitClosed(nativeChild);assert(nativeChild.exitCode!==null||nativeChild.signalCode!==null);
 }finally{
  if(provider){const child=provider.reader.child;await provider.close();if(child)await waitClosed(child);}store?.close();fixture.stdin.end();await waitClosed(fixture);lines.close();assert(resolve(directory).startsWith(base+sep));rmSync(directory,{recursive:true,force:true});
 }
});
function wechatSourceKeyForTest(value){return hash(canonical(value));}
