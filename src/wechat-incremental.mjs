import {canonical,hash,id,uuid,keys,assert,utc} from './protocol.mjs';
import {decimal,validateWechatMessage,validateWechatSource,wechatSourceKey} from './wechat-schema.mjs';

export const WECHAT_INCREMENTAL_FORMAT='worktrace.wechat-cursor/1.0';
export const WECHAT_INCREMENTAL_DEFAULTS=Object.freeze({max_rows:150,page_size:50,max_pages:3,max_ms:1500,max_bytes:2097152,overlap_span:1000});
const LANES=['new','overlap','history'];
const digest=v=>hash(canonical(v));
const copy=v=>JSON.parse(JSON.stringify(v));
const nonnegative=v=>Number.isSafeInteger(v)&&v>=0;
const failure=(code,message)=>Object.assign(new Error(message),{code});
const requireValue=(ok,code,message)=>{if(!ok)throw failure(code,message);};

function limits(input={}){
 keys(input,Object.keys(WECHAT_INCREMENTAL_DEFAULTS),[]);
 const value={...WECHAT_INCREMENTAL_DEFAULTS,...input},maximum={max_rows:1000,page_size:1000,max_pages:20,max_ms:30000,max_bytes:8388608,overlap_span:1000000};
 for(const key of Object.keys(value))assert(Number.isSafeInteger(value[key])&&value[key]>=1&&value[key]<=maximum[key],'微信增量预算无效: '+key);
 return value;
}
function windowValid(value){return value===null||value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&Object.hasOwn(value,'after')&&Object.hasOwn(value,'through')&&decimal(value.after)&&decimal(value.through)&&BigInt(value.after)<=BigInt(value.through);}
function initialState(source){return {format:WECHAT_INCREMENTAL_FORMAT,source:copy(source),source_key:wechatSourceKey(source),version:0,tail:'0',next_lane:0,overlap:null,history:null,last_head:'0',history_verified_through:'0',overlap_verified_through:'0',history_cycles:0,last_success_at:null,totals:{pages:0,rows:0,created:0,revised:0,duplicates:0,skipped_scope:0}};}

/** The state is enumerable JSON containing identifiers/cursors only, never keys or raw bodies. */
export function validateWechatIncrementalState(state,source){
 validateWechatSource(source);
 keys(state,['format','source','source_key','version','tail','next_lane','overlap','history','last_head','history_verified_through','overlap_verified_through','history_cycles','last_success_at','totals']);
 requireValue(state.format===WECHAT_INCREMENTAL_FORMAT&&canonical(state.source)===canonical(source)&&state.source_key===wechatSourceKey(source),'WECHAT_STATE_SOURCE','微信游标属于其他账号、数据库代次、分片或表');
 requireValue(nonnegative(state.version)&&state.version<Number.MAX_SAFE_INTEGER&&Number.isInteger(state.next_lane)&&state.next_lane>=0&&state.next_lane<3,'WECHAT_STATE_INVALID','微信游标版本或轮转位置无效');
 for(const key of ['tail','last_head','history_verified_through','overlap_verified_through'])requireValue(decimal(state[key]),'WECHAT_STATE_INVALID','微信游标不是无损十进制字符串');
 requireValue(BigInt(state.tail)<=BigInt(state.last_head)&&BigInt(state.history_verified_through)<=BigInt(state.last_head)&&BigInt(state.overlap_verified_through)<=BigInt(state.last_head),'WECHAT_STATE_INVALID','微信游标超出已观察的来源边界');
 requireValue(windowValid(state.overlap)&&windowValid(state.history)&&[state.overlap,state.history].every(w=>!w||BigInt(w.through)<=BigInt(state.last_head)),'WECHAT_STATE_INVALID','微信复查窗口无效');
 requireValue(nonnegative(state.history_cycles)&&(state.last_success_at===null||utc(state.last_success_at)),'WECHAT_STATE_INVALID','微信复查进度无效');
 keys(state.totals,['pages','rows','created','revised','duplicates','skipped_scope']);
 requireValue(Object.values(state.totals).every(nonnegative),'WECHAT_STATE_INVALID','微信统计无效');return state;
}

/** A completed cursor sweep is not a claim of complete WeChat history or media availability. */
export function wechatIncrementalCoverage(state){
 validateWechatIncrementalState(state,state.source);
 return {new_rows_pending:BigInt(state.tail)<BigInt(state.last_head),history_cycle_active:state.history!==null,history_verified_through:state.history_verified_through,history_cycles:state.history_cycles,overlap_cycle_active:state.overlap!==null,overlap_verified_through:state.overlap_verified_through,scope:'readable_rows_only',missing_rows:'not_inferred_as_revoked'};
}

function sourceMatches(result,source){
 requireValue(result&&result.complete===true,'WECHAT_SOURCE_PARTIAL','微信来源未返回完整查询结果，游标保持不变');
 requireValue(canonical(result.source)===canonical(source),'WECHAT_SOURCE_CHANGED','微信查询途中账号、数据库代次、分片或表发生变化');
}

function message(row,source){
 // Provider output is data, not executable instructions. In particular, no media reference is opened.
 validateWechatMessage(row);
 requireValue(row.cursor!=='0','WECHAT_ROW_INVALID','SQLite rowid 必须是正十进制字符串');
 requireValue(row.direction!=='outgoing'||row.sender_id===source.account_id,'WECHAT_IDENTITY_INVALID','发件人身份与本人账号不符');
 requireValue(row.direction!=='incoming'||row.sender_id!==source.account_id,'WECHAT_IDENTITY_INVALID','接收方向与本人账号冲突');
 // A group/conversation ID is not an author ID; an unresolved author must remain unknown.
 requireValue(row.conversation_kind!=='group'||row.sender_id!==row.conversation_id,'WECHAT_IDENTITY_INVALID','群编号不能充当发送人编号');
 return copy(row);
}

/**
 * Read-only incremental engine. It does not discover/open databases, obtain keys, execute SQL,
 * install software, change collection authorization, or infer missing rows as deletions.
 *
 * provider.head({source,signal,deadline,priority:'background'}) returns
 *   {source,complete:true,high_watermark:'actual SQLite rowid'}.
 * provider.readPage({source,lane,after,through,limit,signal,deadline,priority}) returns
 *   {source,complete:true,rows:[validateWechatMessage-compatible rows],has_more:boolean}.
 * Pages MUST use actual rowid keyset order (after,through], one bounded read snapshot,
 * and has_more=false only after exhausting that interval. Source generation must change
 * when row identifiers can be reused (account restore/rebuild/table replacement).
 * An interrupted/unsupported query must throw or set complete:false, never return an empty success.
 * Provider must implement timeout/abort, e.g. a bounded read-only child process; a JS timeout
 * can prevent late commits but cannot cancel a native query that ignores its signal.
 *
 * storage.loadState(source_key) -> state|null; readMessage(message_key) ->
 *   {revision,revision_id,content_hash}|null. Both may be asynchronous point lookups.
 * storage.commit({source_key,expected_version,next_state,changes},{signal,assertActive})
 * MUST synchronously commit all revisions and the state in one transaction, checking the old
 * state version (absent=0) and each previous_revision_id, then assertActive just before COMMIT.
 * A successful return acknowledges that transaction. No file/SQLite transaction is opened here.
 * includeMessage(message,source) is a trusted synchronous configuration predicate, never code
 * supplied by a message. Excluded rows advance read cursors but are not looked up or persisted.
 * The caller must enforce enabled/paused, authorization dates and work schedules; historical
 * scans do not implicitly authorize recording earlier messages or messages from paused periods.
 */
export async function pollWechatSource({provider,source,storage,budget={},signal,clock=()=>Date.now(),includeMessage=()=>true}){
 validateWechatSource(source);const sourceCopy=Object.freeze(copy(source)),source_key=wechatSourceKey(sourceCopy),b=limits(budget);
 assert(typeof provider?.head==='function'&&typeof provider?.readPage==='function','缺少只读微信查询接口');
 assert(typeof storage?.loadState==='function'&&typeof storage?.readMessage==='function'&&typeof storage?.commit==='function','缺少微信原子提交接口');
 assert(typeof clock==='function','微信时钟无效');
 assert(typeof includeMessage==='function','微信工作范围过滤器无效');
 const started=clock();assert(Number.isFinite(started),'微信时钟无效');const observed_at=new Date(started).toISOString(),deadline=started+b.max_ms;
 const controller=new AbortController();
 const abortReason=()=>controller.signal.reason instanceof Error?controller.signal.reason:failure('WECHAT_ABORTED','微信读取已中止');
 const onAbort=()=>controller.abort(failure('WECHAT_ABORTED','微信读取已中止'));
 if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
 const timeout=setTimeout(()=>controller.abort(failure('WECHAT_DEADLINE','微信读取超过本轮时间预算')),b.max_ms);
 const assertActive=()=>{
  if(controller.signal.aborted)throw abortReason();
  if(clock()>=deadline){controller.abort(failure('WECHAT_DEADLINE','微信读取超过本轮时间预算'));throw abortReason();}
 };
 const request=async action=>{
  assertActive();
  const result=await new Promise((resolve,reject)=>{
   const aborted=()=>reject(abortReason());controller.signal.addEventListener('abort',aborted,{once:true});
   Promise.resolve().then(()=>{assertActive();return action();}).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',aborted));
  });
  assertActive();return result;
 };
 try{
  const saved=await request(()=>storage.loadState(source_key));
  const state=saved===null||saved===undefined?initialState(sourceCopy):copy(validateWechatIncrementalState(saved,sourceCopy));
  const expected_version=state.version;
  const query={source:sourceCopy,signal:controller.signal,deadline,priority:'background'};
  const head=await request(()=>provider.head({...query}));sourceMatches(head,sourceCopy);
  requireValue(decimal(head.high_watermark),'WECHAT_HEAD_INVALID','微信来源高水位不是无损十进制字符串');
  requireValue(BigInt(head.high_watermark)>=BigInt(state.last_head),'WECHAT_GENERATION_REGRESSED','同一数据库代次的行号回退；需要核对来源代次，不自动重置游标');
  state.last_head=head.high_watermark;
  // Start near the current head so a first deployment is not blocked behind years of
  // rows. The independent history lane still reconciles from zero, within its budget.
  if(expected_version===0)state.tail=(BigInt(head.high_watermark)>BigInt(b.overlap_span)?BigInt(head.high_watermark)-BigInt(b.overlap_span):0n).toString();
  const changes=[],seen=new Map(),stats={pages:0,rows:0,created:0,revised:0,duplicates:0,skipped_scope:0,bytes:0};
  while(stats.pages<b.max_pages&&stats.rows<b.max_rows){
   assertActive();const lane=LANES[state.next_lane];let interval;
   if(lane==='new')interval={after:state.tail,through:head.high_watermark};
   else if(lane==='overlap')interval=state.overlap||{after:(BigInt(state.tail)>BigInt(b.overlap_span)?BigInt(state.tail)-BigInt(b.overlap_span):0n).toString(),through:state.tail};
   else interval=state.history||{after:'0',through:head.high_watermark};
   const limit=Math.min(b.page_size,b.max_rows-stats.rows);
   const page=await request(()=>provider.readPage({...query,lane,...interval,limit}));sourceMatches(page,sourceCopy);
   requireValue(Array.isArray(page.rows)&&page.rows.length<=limit&&typeof page.has_more==='boolean','WECHAT_PAGE_INVALID','微信来源分页超出预算或缺少分页状态');
   let last=interval.after;
   for(const raw of page.rows){
    assertActive();const value=message(raw,sourceCopy);
    requireValue(BigInt(value.cursor)>BigInt(last)&&BigInt(value.cursor)<=BigInt(interval.through),'WECHAT_PAGE_ORDER','微信来源未按实际 rowid 严格递增，或超出查询区间');last=value.cursor;
    const serialized=canonical(value);stats.bytes+=Buffer.byteLength(serialized,'utf8');
    requireValue(stats.bytes<=b.max_bytes,'WECHAT_BYTE_BUDGET','微信读取超过本轮字节预算，游标保持不变');
    const included=includeMessage(copy(value),sourceCopy);
    requireValue(typeof included==='boolean','WECHAT_SCOPE_INVALID','微信工作范围过滤器必须同步返回布尔值');
    if(!included){stats.skipped_scope++;continue;}
    const message_key=digest([source_key,value.source_message_id]),content_hash=hash(serialized),priorSeen=seen.get(message_key);
    if(priorSeen){
     requireValue(priorSeen===content_hash,'WECHAT_SOURCE_UNSTABLE','同一消息在本轮读取中发生变化，整轮重试');stats.duplicates++;continue;
    }
    seen.set(message_key,content_hash);
    const previous=await request(()=>storage.readMessage(message_key));
    if(previous!==null&&previous!==undefined){
     requireValue(Number.isSafeInteger(previous.revision)&&previous.revision>0&&previous.revision<Number.MAX_SAFE_INTEGER&&id(previous.revision_id)&&/^[a-f0-9]{64}$/.test(previous.content_hash),'WECHAT_REVISION_INVALID','已保存的微信修订检查点无效');
     if(previous.content_hash===content_hash){stats.duplicates++;continue;}
    }
    const revision=(previous?.revision||0)+1;
    changes.push({source:sourceCopy,source_key,message_key,revision_id:uuid(),revision,previous_revision_id:previous?.revision_id||null,observed_at,message:value,raw_hash:value.raw_hash,content_hash});
    stats[previous?'revised':'created']++;
   }
   requireValue(!page.has_more||(page.rows.length>0&&BigInt(last)<BigInt(interval.through)),'WECHAT_PAGE_INCOMPLETE','微信分页声称还有记录但游标不能继续');
   const after=page.has_more?last:interval.through;
   if(lane==='new')state.tail=after;
   else if(page.has_more)state[lane]={after,through:interval.through};
   else{
    state[lane]=null;state[lane==='history'?'history_verified_through':'overlap_verified_through']=interval.through;
    if(lane==='history')state.history_cycles++;
   }
   state.next_lane=(state.next_lane+1)%LANES.length;stats.pages++;stats.rows+=page.rows.length;
  }
  state.version++;state.last_success_at=observed_at;
  for(const key of Object.keys(state.totals))state.totals[key]+=stats[key];
  validateWechatIncrementalState(state,sourceCopy);assertActive();
  const result=storage.commit({source_key,expected_version,next_state:copy(state),changes:copy(changes)},{signal:controller.signal,assertActive});
  // A synchronous transaction is the contract: asynchronous commits cannot be cancelled safely
  // after the caller has returned. Adapters must finish/rollback before returning from commit.
  requireValue(!result||typeof result.then!=='function','WECHAT_COMMIT_ASYNC','微信存储提交必须是同步原子事务');
  return {source_key,state,changes,stats,coverage:wechatIncrementalCoverage(state)};
 }finally{clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);}
}
