import {existsSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,isAbsolute,dirname,relative,sep} from 'node:path';
import {assert,keys,utc,hash,canonical,str} from './protocol.mjs';
import {inSchedule} from './collector.mjs';
import {createWechatStorage} from './wechat-store.mjs';
import {pollWechatSource,wechatIncrementalCoverage} from './wechat-incremental.mjs';
import {wechatSourceKey,validateWechatSource} from './wechat-schema.mjs';
import {WechatProvider} from './wechat-provider.mjs';

export function defaultWechatPolicy(){return {enabled:false,interval_seconds:30,max_ms:1500,max_rows:150,capture_since:new Date().toISOString(),excluded_conversations:[]};}
export function validateWechatPolicy(p){
 keys(p,['enabled','interval_seconds','max_ms','max_rows','capture_since','excluded_conversations']);
 assert(typeof p.enabled==='boolean'&&Number.isInteger(p.interval_seconds)&&p.interval_seconds>=15&&p.interval_seconds<=600,'微信采集开关或间隔无效');
 assert(Number.isInteger(p.max_ms)&&p.max_ms>=250&&p.max_ms<=3000&&Number.isInteger(p.max_rows)&&p.max_rows>=10&&p.max_rows<=500,'微信单轮资源预算无效');
 assert(utc(p.capture_since),'微信启用起始时间必须是 UTC 毫秒格式');
 assert(Array.isArray(p.excluded_conversations)&&p.excluded_conversations.length<=500&&p.excluded_conversations.every(v=>str(v,160)&&v.trim()),'微信排除会话无效');return structuredClone(p);
}
export class WechatCollector{
 constructor({store,config,dir,getCollector,isActive=()=>true,providerFactory=c=>new WechatProvider(c),now=()=>Date.now()}){
  Object.assign(this,{store,config,dir,getCollector,isActive,providerFactory,now});
  this.policy=store.get('wechat_policy')||defaultWechatPolicy();this.provider=null;this.fingerprint=null;this.verified=null;this.busy=false;this.controller=null;this.generation=0;this.stopped=false;this.sources=[];this.heads=new Map();this.position=0;this.lastDiscovery=0;this.nextRun=0;this.failures=0;this.lastError=null;this.lastSuccess=null;this.lastRound=null;this.discoveryErrors=[];
  store.db.exec('CREATE TABLE IF NOT EXISTS wechat_pauses(start_at TEXT PRIMARY KEY,end_at TEXT); CREATE INDEX IF NOT EXISTS wechat_pauses_end ON wechat_pauses(end_at,start_at)');
 }
 readSourceConfig(){
  const file=join(this.dir,'wechat-source.json');assert(existsSync(file),'wechat_source_not_configured');
  assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink()&&lstatSync(file).size<=16384,'wechat_source_invalid');
  const cfg=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  keys(cfg,['format','reader_path','dll_path','profile_path','account_root','account_id']);assert(cfg.format==='worktrace.wechat-source/1.0'&&str(cfg.account_id,160)&&cfg.account_id.trim(),'wechat_source_invalid');
  for(const k of ['reader_path','dll_path','profile_path','account_root']){
   assert(typeof cfg[k]==='string'&&isAbsolute(cfg[k])&&existsSync(cfg[k]),'wechat_source_path_unavailable');
   const full=resolve(cfg[k]);assert(realpathSync(full).toLowerCase()===full.toLowerCase()&&!lstatSync(full).isSymbolicLink(),'wechat_source_link_rejected');
   assert(k==='account_root'?lstatSync(full).isDirectory():lstatSync(full).isFile(),'wechat_source_path_invalid');
  }
  const privateRoot=join(dirname(resolve(this.dir)),'private'),profileRelative=relative(privateRoot,resolve(cfg.profile_path));
  assert(profileRelative&&!isAbsolute(profileRelative)&&profileRelative!=='..'&&!profileRelative.startsWith('..'+sep),'wechat_profile_outside_private');
  // Check the public binding only; encrypted DPAPI material stays opaque and is
  // never copied into configuration, events, status or diagnostics.
  assert(lstatSync(cfg.profile_path).size<=1048576,'wechat_profile_invalid');let profile;
  try{profile=JSON.parse(readFileSync(cfg.profile_path,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('wechat_profile_invalid');}
  assert(profile?.format==='worktrace.wechat-native-profile/1.0'&&Object.keys(profile).every(k=>['format','account_root','account_id','created_at','key_count','encrypted_keymap_base64'].includes(k))&&typeof profile.account_root==='string'&&isAbsolute(profile.account_root)&&typeof profile.account_id==='string','wechat_profile_invalid');
  assert(profile.account_id===cfg.account_id,'wechat_profile_account_mismatch');
  const normalizePath=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
  assert(normalizePath(profile.account_root)===normalizePath(cfg.account_root),'wechat_profile_root_mismatch');
  assert(Number.isInteger(profile.key_count)&&profile.key_count>=1&&profile.key_count<=2000&&typeof profile.created_at==='string'&&Number.isFinite(Date.parse(profile.created_at))&&typeof profile.encrypted_keymap_base64==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(profile.encrypted_keymap_base64)&&profile.encrypted_keymap_base64.length>0,'wechat_profile_invalid');
  return cfg;
 }
 sourceConfig(){
  const cfg=this.readSourceConfig();
  // Keys and raw source paths never enter events, metadata or public status.
  const fingerprint=hash(canonical(cfg));if(this.fingerprint!==fingerprint){this.invalidate();this.provider=this.providerFactory(cfg);this.fingerprint=fingerprint;this.accountId=cfg.account_id;this.verified=null;this.sources=[];this.heads.clear();this.lastDiscovery=0;this.lastSuccess=null;this.lastCoverage=null;}
  return cfg;
 }
 closeProvider(){try{Promise.resolve(this.provider?.close()).catch(()=>{});}catch{}}
 active(){const c=this.getCollector();return !this.stopped&&this.policy.enabled&&!!c?.enabled&&inSchedule(c.policy,new Date(this.now()))&&this.isActive();}
 invalidate(){this.generation++;this.controller?.abort();this.closeProvider();}
 openPause(at){this.store.db.prepare('INSERT INTO wechat_pauses VALUES(?,NULL) ON CONFLICT(start_at) DO UPDATE SET end_at=NULL').run(at);}
 globalState(enabled){
  this.invalidate();if(!this.policy.enabled)return;
  const at=new Date(this.now()).toISOString();
  if(enabled)this.store.db.prepare('UPDATE wechat_pauses SET end_at=? WHERE end_at IS NULL').run(at);
  else if(!this.store.db.prepare('SELECT 1 FROM wechat_pauses WHERE end_at IS NULL').get())this.openPause(at);
 }
 include(message){
  if(!message.sent_at||message.sent_at<this.policy.capture_since||!inSchedule(this.getCollector().policy,new Date(message.sent_at))||this.policy.excluded_conversations.includes(message.conversation_id))return false;
  return !this.store.db.prepare('SELECT 1 FROM wechat_pauses WHERE start_at<=? AND (end_at IS NULL OR end_at>?) LIMIT 1').get(message.sent_at,message.sent_at);
 }
 configure(value){
  const policy=validateWechatPolicy(value);assert(!this.busy||!policy.enabled,'wechat_reader_busy');assert(!this.stopped,'wechat_reader_stopped');
  if(policy.enabled){this.sourceConfig();assert(this.verified===this.fingerprint||this.store.get('wechat_verified_source')===this.fingerprint,'wechat_probe_required');}
  this.invalidate();const wasEnabled=this.policy.enabled;this.policy=policy;this.store.set('wechat_policy',policy);this.nextRun=0;
  if(wasEnabled&&!policy.enabled){const at=new Date(this.now()).toISOString();if(!this.store.db.prepare('SELECT 1 FROM wechat_pauses WHERE end_at IS NULL').get())this.openPause(at);}
  if(policy.enabled)this.globalState(!!this.getCollector()?.enabled);
  return this.status();
 }
 async probe(){
  assert(!this.busy&&!this.stopped,'wechat_reader_busy');const cfg=this.sourceConfig(),fingerprint=this.fingerprint,generation=this.generation;this.busy=true;this.controller=new AbortController();const signal=this.controller.signal;
  try{
   const result=await this.provider.discover({signal,deadline:this.now()+5000});
   assert(!signal.aborted&&generation===this.generation&&!this.stopped,'wechat_probe_cancelled');
   if(cfg?.format)assert(hash(canonical(this.readSourceConfig()))===fingerprint,'wechat_source_changed_during_probe');
   this.applyDiscovery(result);assert(this.sources.length>0,'wechat_no_readable_message_tables');
   // A partial catalog is explicitly reported; readiness of one shard is never all-history readiness.
   this.verified=this.fingerprint;this.store.set('wechat_verified_source',this.fingerprint);this.lastError=null;this.failures=0;this.nextRun=0;
   return {ok:true,read_only:true,source_count:this.sources.length,has_more:!!result.has_more,errors:this.discoveryErrors,coverage:result.coverage||null,message_bodies_read:false,employee_version_e2e_verified:false};
  }catch(error){this.lastError=error.code||'wechat_probe_failed';throw error;}
  finally{this.busy=false;this.controller=null;this.closeProvider();}
 }
 applyDiscovery(result){
  assert(Array.isArray(result.sources)&&result.sources.length<=4096,'wechat_discovery_invalid');
  const seen=new Set();for(const s of result.sources){validateWechatSource(s);assert(!this.accountId||s.account_id===this.accountId,'wechat_discovery_account_mismatch');const key=wechatSourceKey(s);assert(!seen.has(key),'wechat_discovery_duplicate_source');seen.add(key);}
  // Provider returns its complete current readable cache, not a delta. Preserve
  // historical database records but stop querying removed/failed physical sources.
  this.sources=structuredClone(result.sources);this.heads=new Map([...this.heads].filter(([key])=>seen.has(key)));
  for(const h of result.heads||[]){const key=wechatSourceKey(h.source);if(seen.has(key))this.heads.set(key,h.high_watermark);}
  this.discoveryErrors=(result.errors||[]).map(e=>({shard_id:String(e.shard_id||'').slice(0,300),code:String(e.code||'source_unavailable').slice(0,100)})).slice(0,50);
  this.discoveryHasMore=!!result.has_more;this.lastDiscovery=this.now();
 }
 async tick(){
  if(this.busy||this.now()<this.nextRun)return {skipped:true};
  if(!this.active()){this.closeProvider();return {skipped:true,reason:'paused_or_outside_schedule'};}
  let sourceConfig;try{sourceConfig=this.sourceConfig();}catch{this.lastError='wechat_source_unavailable';this.failures=Math.min(5,this.failures+1);this.nextRun=this.now()+this.policy.interval_seconds*1000*2**this.failures;return {skipped:true,reason:this.lastError};}
  if(this.store.get('wechat_verified_source')!==this.fingerprint){this.lastError='wechat_probe_required';this.nextRun=this.now()+this.policy.interval_seconds*1000;return {skipped:true,reason:'wechat_probe_required'};}
  const generation=this.generation,started=this.now(),deadline=started+this.policy.max_ms;
  const assertActive=()=>assert(generation===this.generation&&this.active()&&!this.controller?.signal.aborted,'wechat_paused');
  this.busy=true;this.controller=new AbortController();this.nextRun=started+this.policy.interval_seconds*1000;
  const fingerprint=this.fingerprint;
  const storage=createWechatStorage(this.store,this.config,{policy:()=>this.getCollector().policy,assertActive:()=>{assertActive();if(sourceConfig?.format)assert(hash(canonical(this.readSourceConfig()))===fingerprint,'wechat_source_changed_during_read');}});
  const round={sources:0,rows:0,created:0,revised:0,skipped_scope:0,unknown_senders:0,media_not_collected:0,errors:0,duration_ms:0};
  try{
   if(!this.sources.length||started-this.lastDiscovery>=60000||this.discoveryHasMore){const discovery=await this.provider.discover({signal:this.controller.signal,deadline});assertActive();if(sourceConfig?.format)assert(hash(canonical(this.readSourceConfig()))===fingerprint,'wechat_source_changed_during_read');this.applyDiscovery(discovery);}
   // Alternate new-row priority with persisted source round-robin so an active group cannot starve all others.
   const ordered=[];const seen=new Set();const take=s=>{if(s&&!seen.has(wechatSourceKey(s))){ordered.push(s);seen.add(wechatSourceKey(s));}};
   const pending=this.sources.filter(s=>{const k=wechatSourceKey(s),state=storage.loadState(k),head=this.heads.get(k);return head&&(!state||BigInt(head)>BigInt(state.tail));});
   for(let i=0;i<this.sources.length;i++){if(i%2===0)take(pending.shift());take(this.sources[(this.position+i)%this.sources.length]);if(ordered.length>=32)break;}
   for(const source of ordered){
    assertActive();const remaining=deadline-this.now();if(remaining<100||round.rows>=this.policy.max_rows)break;
    try{
     const result=await pollWechatSource({provider:this.provider,source,storage,signal:this.controller.signal,clock:this.now,includeMessage:m=>this.include(m),budget:{max_rows:Math.max(1,this.policy.max_rows-round.rows),page_size:Math.min(50,this.policy.max_rows-round.rows),max_pages:3,max_ms:remaining,max_bytes:2097152,overlap_span:1000}});
     round.sources++;for(const k of ['rows','created','revised','skipped_scope'])round[k]+=result.stats[k];round.unknown_senders+=result.changes.filter(c=>c.message.identity_status==='unknown').length;round.media_not_collected+=result.changes.filter(c=>c.message.media.length>0).length;this.lastSuccess=new Date(this.now()).toISOString();this.lastCoverage={source_key:result.source_key,...result.coverage};
    }catch(error){assertActive();round.errors++;this.lastError=error.code||'wechat_source_query_failed';}
    this.position=(this.sources.indexOf(source)+1)%Math.max(1,this.sources.length);
   }
   this.failures=round.errors&&!round.sources?Math.min(5,this.failures+1):0;if(!round.errors)this.lastError=null;
  }catch(error){this.lastError=error.code||'wechat_source_unavailable';this.failures=Math.min(5,this.failures+1);}
  finally{round.duration_ms=this.now()-started;this.lastRound=round;this.nextRun=Math.max(this.nextRun,this.now()+this.policy.interval_seconds*1000*2**this.failures);this.busy=false;this.controller=null;if(!this.active())this.closeProvider();}
  return round;
 }
 status(){return {configured:existsSync(join(this.dir,'wechat-source.json')),policy:this.policy,busy:this.busy,state:!this.policy.enabled?'disabled':!this.active()?'paused_or_outside_schedule':!this.fingerprint||this.store.get('wechat_verified_source')!==this.fingerprint?'probe_required':this.lastError?'degraded':!this.lastSuccess?'waiting_for_first_read':'ready',known_sources:this.sources.length,discovery_has_more:!!this.discoveryHasMore,discovery_errors:this.discoveryErrors,last_success:this.lastSuccess,last_error:this.lastError,last_round:this.lastRound,last_coverage:this.lastCoverage||null,source:'wechat_database_readonly',media:'metadata_only',ui_control:false,all_history_complete:false};}
 stop(){this.stopped=true;this.invalidate();}
}
