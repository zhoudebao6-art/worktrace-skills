import {spawn} from 'node:child_process';
import {setPriority,constants as osConstants} from 'node:os';
import {createHash} from 'node:crypto';
import {lstat,opendir,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname,sep} from 'node:path';
import {zstdDecompressSync} from 'node:zlib';
import {assert,canonical,hash} from './protocol.mjs';
import {decimal,validateWechatSource,validateWechatMessage,wechatSourceKey} from './wechat-schema.mjs';

const MAX_OUTPUT=8*1024*1024,MAX_RAW=2*1024*1024,MAX_TEXT_BYTES=256*1024,MAX_NAMES=50000,MAX_TABLES=4096,MAX_SHARDS=128;
const TABLE=/^Msg_[a-f0-9]{32}$/i,SHARD=/^message_[0-9]+\.db$/i;
const fail=(code)=>Object.assign(new Error(code),{code});
const check=(ok,code)=>{if(!ok)throw fail(code);};
const clone=value=>JSON.parse(JSON.stringify(value));
const validName=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\u0000-\u001f]/.test(value);
const NATIVE_ERRORS=new Set(['query_timeout','key_not_prepared','database_generation_changed','page_byte_limit','cell_limit','database_outside_profile','filesystem_link_rejected','readonly_open_required','readonly_statement_required','invalid_cursor_range','query_not_allowed','startup_failed','request_failed']);
const safeError=error=>typeof error?.code==='string'&&/^wechat_[a-z0-9_]{1,70}$/.test(error.code)?error.code:'wechat_reader_failed';
const nativeError=code=>NATIVE_ERRORS.has(code)||typeof code==='string'&&/^database_error_[0-9]{1,3}$/.test(code)&&Number(code.slice(15))<=255?code:'wechat_native_failed';
const md5=value=>createHash('md5').update(value,'utf8').digest('hex');
const rawInteger=value=>value===null||typeof value==='string'&&/^-?(0|[1-9][0-9]{0,18})$/.test(value);

/** All calls (including injected readers) are single-flight and bounded in the queue. */
class SerialRead{
 constructor(read,close=()=>{}){this.action=read;this.stop=close;this.queue=Promise.resolve();this.pending=0;this.epoch=0;this.active=null;}
 read(request,{signal,deadline=Date.now()+5000}={}){
  check(Number.isFinite(deadline),'wechat_deadline_invalid');check(this.pending<8,'wechat_reader_queue_full');
  const epoch=this.epoch;this.pending++;
  const run=this.queue.then(async()=>{
   check(epoch===this.epoch&&!signal?.aborted,'wechat_reader_cancelled');check(Date.now()<deadline,'wechat_reader_timeout');
   const controller=new AbortController(),abort=()=>controller.abort(fail('wechat_reader_cancelled'));
   const timer=setTimeout(()=>controller.abort(fail('wechat_reader_timeout')),Math.max(1,Math.min(deadline-Date.now(),10000)));
   this.active=controller;signal?.addEventListener('abort',abort,{once:true});
   try{return await new Promise((accept,reject)=>{
    const cancelled=()=>{this.stop();reject(controller.signal.reason);};controller.signal.addEventListener('abort',cancelled,{once:true});
    Promise.resolve().then(()=>{check(!controller.signal.aborted,'wechat_reader_cancelled');return this.action(request,{signal:controller.signal,deadline});}).then(value=>{if(controller.signal.aborted)reject(controller.signal.reason);else accept(value);},reject).finally(()=>controller.signal.removeEventListener('abort',cancelled));
   });}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(this.active===controller)this.active=null;}
  });
  this.queue=run.catch(()=>{});return run.finally(()=>this.pending--);
 }
 close(){this.epoch++;this.active?.abort(fail('wechat_reader_cancelled'));this.stop();}
}

/** Persistent, hidden native child; only its own PID is reprioritized or terminated. */
export class WechatJsonReader{
 constructor({reader_path,dll_path,profile_path,spawnImpl=spawn,setPriorityImpl=setPriority}){
  for(const path of [reader_path,dll_path,profile_path])assert(typeof path==='string'&&isAbsolute(path),'微信读取器路径必须是绝对路径');
  this.options={reader_path,dll_path,profile_path};this.spawn=spawnImpl;this.setPriority=setPriorityImpl;this.child=null;this.current=null;this.sequence=0;this.buffer=Buffer.alloc(0);
  this.serial=new SerialRead((request,options)=>this.request(request,options),()=>this.kill());
 }
 read(request,options){return this.serial.read(request,options);}
 start(){
  if(this.child)return this.child;const {reader_path,dll_path,profile_path}=this.options;
  const child=this.spawn(reader_path,['--dll',dll_path,'--profile',profile_path],{cwd:dirname(reader_path),windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env}});this.child=child;this.buffer=Buffer.alloc(0);
  child.once('spawn',()=>{if(this.child===child&&child.pid)try{this.setPriority(child.pid,osConstants.priority.PRIORITY_BELOW_NORMAL);}catch{/* Native reader also lowers its own priority. */}});
  child.stdout.on('data',chunk=>{
   if(this.child!==child)return;
   if(!this.current){this.break('wechat_reader_unsolicited_output');return;}
   this.current.bytes+=chunk.length;if(this.current.bytes>MAX_OUTPUT){this.break('wechat_reader_output_limit');return;}
   this.buffer=Buffer.concat([this.buffer,Buffer.from(chunk)]);
   let end;
   while((end=this.buffer.indexOf(10))>=0){
    const line=this.buffer.subarray(0,end).toString('utf8').trim();this.buffer=this.buffer.subarray(end+1);if(!line)continue;
    let result;try{result=JSON.parse(line);}catch{this.break('wechat_reader_invalid_json');return;}
    const pending=this.current;
    if(!pending||result.id!==pending.id){this.break('wechat_reader_response_mismatch');return;}
    this.current=null;pending.resolve(result);
    if(this.buffer.toString('utf8').trim()){this.break('wechat_reader_unsolicited_output');return;}
   }
  });
  // Never retain or return native stderr: it may include paths, SQL diagnostics or key material.
  child.stderr.resume();child.stdin.on('error',()=>{if(this.child===child)this.break('wechat_reader_pipe_failed');});
  child.once('error',()=>{if(this.child===child)this.break('wechat_reader_start_failed');});
  child.once('close',()=>{if(this.child===child)this.break('wechat_reader_exited');});return child;
 }
 request(request,{signal}){
  check(!signal.aborted,'wechat_reader_cancelled');check(!this.current,'wechat_reader_busy');
  return new Promise((resolveResult,reject)=>{
   let child;try{child=this.start();}catch{reject(fail('wechat_reader_start_failed'));return;}
   const id=String(++this.sequence);this.current={id,bytes:0,resolve:resolveResult,reject};
   child.stdin.write(JSON.stringify({...request,id})+'\n',error=>{if(error&&this.child===child)this.break('wechat_reader_pipe_failed');});
  });
 }
 break(code){const pending=this.current;this.current=null;this.kill();pending?.reject(fail(code));}
 kill(){const child=this.child;this.child=null;this.buffer=Buffer.alloc(0);const pending=this.current;this.current=null;pending?.reject(fail('wechat_reader_cancelled'));if(child)try{child.kill();}catch{}}
 close(){this.serial.close();}
}

function rawBytes(value){
 if(value===null)return null;
 if(typeof value==='string'){const bytes=Buffer.from(value,'utf8');check(bytes.length<=MAX_RAW,'wechat_raw_value_limit');return bytes;}
 check(value&&typeof value==='object'&&Object.keys(value).length===2&&value.encoding==='base64'&&typeof value.data==='string'&&value.data.length<=Math.ceil(MAX_RAW/3)*4,'wechat_blob_invalid');
 check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data),'wechat_blob_invalid');
 const bytes=Buffer.from(value.data,'base64');check(bytes.length<=MAX_RAW&&bytes.toString('base64')===value.data,'wechat_blob_invalid');return bytes;
}
function rawDigest(row){
 const digest=createHash('sha256');let size=0;
 for(const field of ['cursor','local_id','server_id','sort_seq','create_time','local_type','real_sender_id','sender_username','message_content','source','WCDB_CT_message_content']){
  const value=row[field]??null,bytes=rawBytes(value);size+=bytes?.length||0;check(size<=MAX_RAW,'wechat_raw_row_limit');
  digest.update(field+'\0'+(value===null?'null':typeof value==='string'?'text':'blob')+'\0'+String(bytes?.length||0)+'\0');if(bytes)digest.update(bytes);
 }
 return digest.digest('hex');
}
function zstdFrames(bytes){
 // Node 22 can return partial/empty output for a truncated frame. Check complete frame
 // boundaries before delegating decompression; do not implement the compression codec.
 // RFC 8878 sections 3.1.1-3.1.2: https://www.rfc-editor.org/rfc/rfc8878.html
 let offset=0,frames=0,blocks=0,total=0n;const result=[];
 const need=n=>check(offset+n<=bytes.length,'wechat_zstd_truncated');
 while(offset<bytes.length){
  const start=offset;check(++frames<=64,'wechat_zstd_frame_limit');need(4);const magic=bytes.readUInt32LE(offset);offset+=4;
  if((magic&0xfffffff0)===0x184d2a50){need(4);const size=bytes.readUInt32LE(offset);offset+=4;need(size);offset+=size;continue;}
  check(magic===0xfd2fb528,'wechat_zstd_magic');need(1);const descriptor=bytes[offset++],single=!!(descriptor&32),flag=descriptor>>>6;
  check(!(descriptor&8),'wechat_zstd_reserved');
  if(!single){need(1);const window=bytes[offset++],base=2**(10+(window>>>3));check(base+(base/8)*(window&7)<=8*1024*1024,'wechat_zstd_window_limit');}
  const dictSize=[0,1,2,4][descriptor&3];need(dictSize);offset+=dictSize;
  const sizeBytes=flag===0?(single?1:0):[0,2,4,8][flag];need(sizeBytes);
  let contentSize=null;
  if(sizeBytes){let size=0n;for(let i=0;i<sizeBytes;i++)size|=BigInt(bytes[offset+i])<<BigInt(8*i);if(sizeBytes===2)size+=256n;check(size<=BigInt(MAX_TEXT_BYTES),'wechat_zstd_content_limit');total+=size;check(total<=BigInt(MAX_TEXT_BYTES),'wechat_zstd_content_limit');contentSize=Number(size);}
  offset+=sizeBytes;let last=false;
  while(!last){
   check(++blocks<=4096,'wechat_zstd_block_limit');need(3);const header=bytes.readUIntLE(offset,3);offset+=3;last=!!(header&1);const type=(header>>>1)&3,size=header>>>3;
   check(type!==3&&size<=128*1024,'wechat_zstd_block_invalid');const payload=type===1?1:size;need(payload);offset+=payload;
  }
  if(descriptor&4){need(4);offset+=4;}
  result.push({start,end:offset,size:contentSize});
 }
 return result;
}
function decodeBody(value,gaps){
 let bytes=rawBytes(value);if(bytes===null){gaps.push('body_missing');return '';}
 if(bytes.length>=4&&(bytes.readUInt32LE(0)===0xfd2fb528||(bytes.readUInt32LE(0)&0xfffffff0)===0x184d2a50)){
  try{
   const decoded=[];let total=0;
   for(const frame of zstdFrames(bytes)){
    // Node 22 can stop after the first frame in a concatenated stream. Decode each
    // already validated frame independently and enforce the combined output bound.
    const output=zstdDecompressSync(bytes.subarray(frame.start,frame.end),{maxOutputLength:MAX_TEXT_BYTES});
    check(frame.size===null||output.length===frame.size,'wechat_zstd_size_mismatch');total+=output.length;check(total<=MAX_TEXT_BYTES,'wechat_zstd_content_limit');decoded.push(output);
   }
   bytes=Buffer.concat(decoded,total);
  }catch{gaps.push('body_zstd_unreadable_or_oversized');return '';}
 }
 const clipped=bytes.length>MAX_TEXT_BYTES;if(clipped){bytes=bytes.subarray(0,MAX_TEXT_BYTES);gaps.push('body_byte_limit');}
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:clipped});}catch{gaps.push('body_utf8_unreadable');return '';}
 if(text.length>60000){let end=60000;if(/[\uD800-\uDBFF]/.test(text[end-1]))end--;text=text.slice(0,end);gaps.push('body_text_limit');}
 return text;
}

/** Decode only explicitly supported source types. Media paths/URLs and XML instructions are never opened. */
export function normalizeWechatRow(row,source,{conversation_id=null}={}){
 validateWechatSource(source);check(row&&typeof row==='object'&&decimal(row.cursor)&&row.cursor!=='0','wechat_rowid_invalid');
 for(const key of ['local_id','server_id','sort_seq','create_time','local_type','real_sender_id','WCDB_CT_message_content'])check(row[key]===undefined||rawInteger(row[key]),'wechat_integer_invalid');
 const gaps=[],raw_hash=rawDigest(row),body=decodeBody(row.message_content??null,gaps);
 const conversation=validName(conversation_id)?conversation_id:'unresolved:'+source.table_id;
 const conversation_kind=conversation.startsWith('unresolved:')?'unknown':conversation.endsWith('@chatroom')?'group':'private';
 if(conversation_kind==='unknown')gaps.push('conversation_id_unresolved');
 const sender=validName(row.sender_username)&&!row.sender_username.endsWith('@chatroom')?row.sender_username:null;
 if(sender===null)gaps.push('sender_id_unresolved');
 let sent_at=null;
 if(decimal(row.create_time)&&BigInt(row.create_time)<=253402300799n)sent_at=new Date(Number(row.create_time)*1000).toISOString();else gaps.push('source_timestamp_unresolved');
 const type=typeof row.local_type==='string'?Number(BigInt(row.local_type)&0xffffffffn):null;
 let message_kind=({1:'text',3:'image',34:'voice',43:'video',10000:'system',10002:'system'})[type]||'other';
 if(type===49&&/<appmsg(?:\s|>)/i.test(body)&&/<type>\s*6\s*<\/type>/i.test(body))message_kind='file';
 let text='';
 if(message_kind==='text'&&!/^\s*<(?:\?xml|msg\b|sysmsg\b|appmsg\b)/i.test(body)){
  text=body;if(conversation_kind==='group'&&sender&&text.startsWith(sender+':\n'))text=text.slice(sender.length+2);
 }else if(body){text=body;gaps.push('non_text_raw_payload');if(message_kind==='text')message_kind='other';}
 if(/<sysmsg\b[^>]*\btype\s*=\s*["']revokemsg["']/i.test(body))gaps.push('revoke_notice_target_unresolved');
 if(message_kind==='other')gaps.push('message_type_unsupported:'+String(row.local_type??'null'));
 const media=['image','voice','video','file'].includes(message_kind)?[{kind:message_kind,state:'not_collected',reference:'sha256:'+raw_hash}]:message_kind==='other'?[{kind:'other',state:'unsupported',reference:'sha256:'+raw_hash}]:[];
 if(media.length)gaps.push('media_not_collected');
 const message={cursor:row.cursor,source_message_id:'rowid:'+row.cursor+':local:'+(row.local_id??'null'),local_message_id:decimal(row.local_id)?row.local_id:null,server_message_id:decimal(row.server_id)&&row.server_id!=='0'?row.server_id:null,conversation_id:conversation,conversation_kind,sender_id:sender,sender_display_name:null,direction:sender===null?'unknown':sender===source.account_id?'outgoing':'incoming',identity_status:sender===null?'unknown':'verified',message_kind,message_status:'normal',sent_at,text,raw_hash,media,gaps};
 return validateWechatMessage(message);
}

export class WechatProvider{
 constructor({reader_path,dll_path,profile_path,account_root,account_id,read,clock=()=>Date.now()}){
  assert(typeof account_root==='string'&&isAbsolute(account_root),'微信账号根目录必须是绝对路径');assert(validName(account_id),'微信账号编号无效');assert(typeof clock==='function','微信提供器时钟无效');
  this.root=resolve(account_root);this.account=account_id;this.clock=clock;this.reader=read?null:new WechatJsonReader({reader_path,dll_path,profile_path});
  assert(!read||typeof read==='function','微信注入读取器无效');this.serial=read?new SerialRead(read):null;
  this.shards=new Map();this.shardIndex=0;this.directory=null;this.directoryRoot=null;this.scanFinished=0;this.discoveryBusy=false;this.names=0;this.tables=0;this.epoch=0;this.scanSeen=new Set();
 }
 async close(){this.epoch++;this.serial?.close();this.reader?.close();const directory=this.directory;this.directory=null;if(directory)try{await directory.close();}catch{}}
 async request(shard,query,fields,options={}){
  const deadline=options.deadline??Date.now()+5000,epoch=options.epoch??this.epoch;
  check(epoch===this.epoch,'wechat_reader_cancelled');
  check(!options.signal?.aborted,'wechat_reader_cancelled');check(Date.now()<deadline,'wechat_reader_timeout');
  const request={query,database_path:shard.path,shard_id:shard.id,...fields,timeout_ms:Math.max(50,Math.min(10000,Math.floor(deadline-Date.now()))),...(shard.generation?{expected_generation:shard.generation}:{})};
  const result=await (this.serial||this.reader).read(request,{...options,deadline});
  check(epoch===this.epoch,'wechat_reader_cancelled');
  check(result&&result.ok===true,nativeError(result?.error));check(result.complete===true&&result.readonly===true,'wechat_source_partial');
  check(result.query===query&&result.shard_id===shard.id&&(fields.table_id===undefined||result.table_id===fields.table_id),'wechat_source_mismatch');
  check(typeof result.db_generation==='string'&&result.db_generation.length>0&&result.db_generation.length<=300,'wechat_generation_invalid');
  if(shard.generation&&shard.generation!==result.db_generation){this.resetShard(shard,result.db_generation);throw fail('wechat_generation_changed');}
  shard.generation=result.db_generation;return result;
 }
 resetShard(shard,generation=null){this.names-=shard.names.size;this.tables-=shard.tables.size;shard.names.clear();shard.tables.clear();shard.schemaSeen.clear();shard.namesSeen.clear();shard.generation=generation;shard.schemaAfter='0';shard.namesAfter='0';shard.schemaDone=false;shard.namesDone=false;shard.phase=0;shard.tableIndex=0;shard.readable=false;}
 async scanDirectory(errors,options){
  if(!this.directory&&this.scanFinished&&this.clock()-this.scanFinished<60000)return;
  if(!this.directory){
   const directory=join(this.root,'db_storage','message');
   for(const path of [this.root,join(this.root,'db_storage'),directory]){const stat=await lstat(path);check(stat.isDirectory()&&!stat.isSymbolicLink(),'wechat_directory_link_or_invalid');}
   const actual=await realpath(directory),rel=relative(await realpath(this.root),actual);check(rel&&!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel),'wechat_directory_outside_account');
   this.directoryRoot=directory;const opened=await opendir(directory);if(options.epoch!==this.epoch){await opened.close();throw fail('wechat_reader_cancelled');}this.directory=opened;this.scanSeen.clear();
  }
  for(let i=0;i<64;i++){
   check(options.epoch===this.epoch&&!options.signal?.aborted,'wechat_reader_cancelled');check(Date.now()<options.deadline,'wechat_reader_timeout');const entry=await this.directory.read();
   if(!entry){await this.directory.close();this.directory=null;this.scanFinished=this.clock();for(const [name,shard] of this.shards)if(!this.scanSeen.has(name)){this.resetShard(shard);this.shards.delete(name);}break;}
   if(!SHARD.test(entry.name))continue;
   if(!entry.isFile()||entry.isSymbolicLink()){errors.push({shard_id:entry.name,code:'wechat_shard_link_or_invalid'});continue;}
   this.scanSeen.add(entry.name);if(this.shards.has(entry.name))continue;
   if(this.shards.size>=MAX_SHARDS){errors.push({shard_id:entry.name,code:'wechat_shard_limit'});continue;}
   this.shards.set(entry.name,{id:entry.name,path:join(this.directoryRoot,entry.name),generation:null,names:new Map(),tables:new Map(),schemaSeen:new Set(),namesSeen:new Set(),schemaAfter:'0',namesAfter:'0',schemaDone:false,namesDone:false,phase:0,tableIndex:0,headPriorityTurn:false,readable:false,schemaAt:0,namesAt:0});
  }
 }
 validatePage(page,after,limit){
  check(Array.isArray(page.rows)&&page.rows.length<=limit&&typeof page.has_more==='boolean','wechat_page_invalid');let last=after;
  for(const row of page.rows){check(decimal(row.cursor)&&BigInt(row.cursor)>BigInt(last),'wechat_page_order');last=row.cursor;}
  check(!page.has_more||page.rows.length>0,'wechat_page_stalled');return last;
 }
 source(shard,table){return {account_id:this.account,db_generation:shard.generation,shard_id:shard.id,table_id:table};}
 async discover({signal,deadline=Date.now()+3000}={}){
  check(!this.discoveryBusy,'wechat_discovery_busy');this.discoveryBusy=true;
  const epoch=this.epoch,errors=[],heads=[],failed=new Set(),finished=new Set(),headVisited=new Set(),options={signal,deadline,epoch};let requests=0,attempts=0;
  try{
   try{await this.scanDirectory(errors,options);}catch(error){if(epoch!==this.epoch||signal?.aborted||['wechat_reader_timeout','wechat_reader_cancelled'].includes(safeError(error)))throw error;errors.push({shard_id:null,code:safeError(error)});}
   const shards=[...this.shards.values()];
   while(shards.length&&requests<8&&attempts++<32&&Date.now()<deadline){
    check(epoch===this.epoch&&!signal?.aborted,'wechat_reader_cancelled');const shard=shards[this.shardIndex++%shards.length];
    if(failed.has(shard.id)||finished.has(shard.id))continue;
    if(shard.schemaDone&&this.clock()-shard.schemaAt>=300000){shard.schemaDone=false;shard.schemaAfter='0';shard.schemaSeen.clear();}
    if(shard.namesDone&&this.clock()-shard.namesAt>=300000){shard.namesDone=false;shard.namesAfter='0';shard.namesSeen.clear();}
    const phase=shard.phase++%3;
    try{
     if(!shard.schemaDone&&(phase===0||shard.tables.size===0)){
      requests++;
      const page=await this.request(shard,'schema',{after:shard.schemaAfter,limit:64},options),last=this.validatePage(page,shard.schemaAfter,64);
      for(const row of page.rows){check(typeof row.name==='string','wechat_schema_invalid');if(!TABLE.test(row.name))continue;shard.schemaSeen.add(row.name);if(shard.tables.has(row.name))continue;check(this.tables<MAX_TABLES,'wechat_table_cache_limit');shard.tables.set(row.name,{head:null,checked:0,changed:0});this.tables++;}
      shard.schemaAfter=last;shard.schemaDone=!page.has_more;shard.schemaAt=this.clock();shard.readable=true;
      if(shard.schemaDone)for(const name of shard.tables.keys())if(!shard.schemaSeen.has(name)){shard.tables.delete(name);this.tables--;}
     }else if(!shard.namesDone&&(phase===1||shard.tables.size===0)){
      requests++;
      const page=await this.request(shard,'name2id',{after:shard.namesAfter,limit:256},options),last=this.validatePage(page,shard.namesAfter,256);
      for(const row of page.rows){check(validName(row.user_name),'wechat_name2id_invalid');const key=md5(row.user_name);shard.namesSeen.add(key);if(!shard.names.has(key)){check(this.names<MAX_NAMES,'wechat_name_cache_limit');this.names++;}shard.names.set(key,row.user_name);}
      shard.namesAfter=last;shard.namesDone=!page.has_more;shard.namesAt=this.clock();shard.readable=true;
      if(shard.namesDone)for(const name of shard.names.keys())if(!shard.namesSeen.has(name)){shard.names.delete(name);this.names--;}
     }else if(shard.tables.size){
      const entries=[...shard.tables.entries()],available=entries.filter(([name])=>!headVisited.has(shard.id+'/'+name));
      if(!available.length){if(shard.schemaDone&&shard.namesDone)finished.add(shard.id);continue;}
      let chosen=shard.headPriorityTurn?available.reduce((best,item)=>item[1].changed>best[1].changed?item:best):null;
      if(!chosen||chosen[1].changed===0){do{chosen=entries[shard.tableIndex++%entries.length];}while(headVisited.has(shard.id+'/'+chosen[0]));}
      shard.headPriorityTurn=!shard.headPriorityTurn;const [table,cache]=chosen;headVisited.add(shard.id+'/'+table);requests++;
      const result=await this.request(shard,'head',{table_id:table},options);check(decimal(result.high_watermark),'wechat_head_invalid');
      if(cache.head!==result.high_watermark)cache.changed=this.clock();cache.head=result.high_watermark;cache.checked=this.clock();shard.readable=true;
      heads.push({source:this.source(shard,table),high_watermark:cache.head,checked_at:new Date(cache.checked).toISOString(),changed_at:cache.changed?new Date(cache.changed).toISOString():null});
     }else finished.add(shard.id);
    }catch(error){
     if(epoch!==this.epoch||signal?.aborted||safeError(error)==='wechat_reader_cancelled')throw error;shard.readable=false;failed.add(shard.id);errors.push({shard_id:shard.id,code:nativeError(error.code)!=='wechat_native_failed'?error.code:safeError(error)});
     if(error.code==='database_generation_changed')this.resetShard(shard);
     // A single unreadable shard cannot monopolize the request budget.
     finished.add(shard.id);
    }
   }
   const sources=[];
   for(const shard of this.shards.values())if(shard.readable&&!failed.has(shard.id))for(const table of shard.tables.keys())sources.push(this.source(shard,table));
   const changed=new Map(heads.map(h=>[wechatSourceKey(h.source),h.changed_at||'']));sources.sort((a,b)=>(changed.get(wechatSourceKey(b))||'').localeCompare(changed.get(wechatSourceKey(a))||''));
   return {sources,heads,errors,has_more:!!this.directory||[...this.shards.values()].some(s=>!s.schemaDone||!s.namesDone||[...s.tables.values()].some(t=>t.head===null)),coverage:{scope:'cached_tables_revalidated_on_read',shards:this.shards.size,tables:this.tables,names:this.names,requests,directory_refresh_ms:60000,catalog_refresh_ms:300000,media_collected:false}};
  }finally{this.discoveryBusy=false;}
 }
 getShard(source){
  validateWechatSource(source);check(source.account_id===this.account,'wechat_account_mismatch');const shard=this.shards.get(source.shard_id);
  check(shard&&shard.tables.has(source.table_id)&&shard.generation===source.db_generation,'wechat_source_not_discovered');return shard;
 }
 async head({source,signal,deadline=Date.now()+1500}={}){
  const shard=this.getShard(source),result=await this.request(shard,'head',{table_id:source.table_id},{signal,deadline});check(decimal(result.high_watermark),'wechat_head_invalid');
  const cache=shard.tables.get(source.table_id);if(cache.head!==result.high_watermark)cache.changed=this.clock();cache.head=result.high_watermark;cache.checked=this.clock();
  return {source:clone(source),complete:true,high_watermark:result.high_watermark};
 }
 async readPage({source,after,through,limit,signal,deadline=Date.now()+1500}={}){
  const shard=this.getShard(source);check(decimal(after)&&decimal(through)&&BigInt(after)<=BigInt(through)&&Number.isInteger(limit)&&limit>=1&&limit<=500,'wechat_page_request_invalid');
  const page=await this.request(shard,'messages',{table_id:source.table_id,after,through,limit},{signal,deadline});this.validatePage(page,after,limit);
  const conversation_id=shard.names.get(source.table_id.slice(4).toLowerCase())||null;
  const rows=page.rows.map(row=>{check(BigInt(row.cursor)<=BigInt(through),'wechat_page_order');return normalizeWechatRow(row,source,{conversation_id});});
  return {source:clone(source),complete:true,rows,has_more:page.has_more};
 }
}
