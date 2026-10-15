import {assert,canonical,hash,uuid,SOFTWARE_VERSION,id,str} from './protocol.mjs';
import {wechatSourceKey,validateWechatPayload,wechatPreview} from './wechat-schema.mjs';
import {defaultPolicy} from './collector.mjs';

export function initWechatStore(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS wechat_sources(source_key TEXT PRIMARY KEY,state_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS wechat_messages(device_id TEXT NOT NULL,message_key TEXT NOT NULL,source_key TEXT NOT NULL,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,sender_id TEXT,direction TEXT NOT NULL,revision INTEGER NOT NULL,revision_id TEXT NOT NULL,content_hash TEXT NOT NULL,observed_at TEXT NOT NULL,sent_at TEXT,PRIMARY KEY(device_id,message_key),FOREIGN KEY(revision_id) REFERENCES events(event_id));
 CREATE INDEX IF NOT EXISTS wechat_conversation ON wechat_messages(device_id,account_id,conversation_id,observed_at,message_key);
 `);}
export function checkWechatRelations(store,e){
 if(e.event_type!=='chat.message')return;
 const p=e.payload;validateWechatPayload(p);
 const current=store.db.prepare('SELECT revision,revision_id FROM wechat_messages WHERE device_id=? AND message_key=?').get(e.device_id,p.message_key);
 assert(current?p.previous_revision_id===current.revision_id&&p.revision===current.revision+1:p.revision===1&&p.previous_revision_id===null,'微信消息修订缺失或分叉');
 if(p.previous_revision_id){const row=store.db.prepare('SELECT json FROM events WHERE event_id=?').get(p.previous_revision_id);const previous=row&&JSON.parse(row.json);assert(previous?.event_type==='chat.message'&&previous.org_id===e.org_id&&previous.device_id===e.device_id&&previous.employee_id===e.employee_id&&previous.payload.message_key===p.message_key,'微信消息修订不能跨身份或会话');}
}
export function materializeWechatEvent(store,e){
 if(e.event_type!=='chat.message')return;
 const p=e.payload,m=p.message;
 store.db.prepare(`INSERT INTO wechat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,message_key) DO UPDATE SET conversation_id=excluded.conversation_id,sender_id=excluded.sender_id,direction=excluded.direction,revision=excluded.revision,revision_id=excluded.revision_id,content_hash=excluded.content_hash,observed_at=excluded.observed_at,sent_at=excluded.sent_at`).run(e.device_id,p.message_key,wechatSourceKey(p.source),p.source.account_id,m.conversation_id,m.sender_id,m.direction,p.revision,p.revision_id,hash(canonical(m)),p.observed_at,m.sent_at);
}
export function createWechatStorage(store,config,{policy=()=>store.get('policy')||defaultPolicy,assertActive=()=>{}}={}){
 const session=uuid();
 return {
  loadState:key=>{const row=store.db.prepare('SELECT state_json FROM wechat_sources WHERE source_key=?').get(key);return row?JSON.parse(row.state_json):null;},
  readMessage:key=>store.db.prepare('SELECT revision,revision_id,content_hash FROM wechat_messages WHERE device_id=? AND message_key=?').get(config.device_id,key)||null,
  commit(batch,guard={}){
   assertActive();guard.assertActive?.();assert(!guard.signal?.aborted,'wechat_paused');
   store.db.exec('SAVEPOINT wechat_poll');
   try{
    const old=this.loadState(batch.source_key);assert((old?.version||0)===batch.expected_version,'wechat_cursor_conflict');
    for(const change of batch.changes){
     const previous=this.readMessage(change.message_key);assert((previous?.revision_id||null)===change.previous_revision_id,'wechat_revision_conflict');
     const m=change.message,p=policy();
     const payload={format:'worktrace.wechat-message/1.0',source:change.source,message_key:change.message_key,revision_id:change.revision_id,revision:change.revision,previous_revision_id:change.previous_revision_id,observed_at:change.observed_at||batch.observed_at||new Date().toISOString(),message:m,text:m.text};
     store.append({schema_version:'1.3',event_id:change.revision_id,org_id:config.org_id,device_id:config.device_id,employee_id:config.employee_id,session_id:session,occurred_at:payload.observed_at,timezone:p.timezone,event_type:'chat.message',collector_version:SOFTWARE_VERSION,policy_hash:store.policy(p),app:{process_name:'weixin.exe',window_title:''},context:{case_id:null,conversation_id:m.conversation_id,sender_id:m.sender_id,identity_source:'device_assignment'},payload,attachments:[]});
    }
    store.db.prepare('INSERT INTO wechat_sources VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET state_json=excluded.state_json').run(batch.source_key,JSON.stringify(batch.next_state));
    assertActive();guard.assertActive?.();assert(!guard.signal?.aborted,'wechat_paused');store.db.exec('RELEASE SAVEPOINT wechat_poll');
   }catch(error){store.db.exec('ROLLBACK TO SAVEPOINT wechat_poll');store.db.exec('RELEASE SAVEPOINT wechat_poll');throw error;}
  }
 };
}
function queryScope(c,q){
 assert(c&&['collector','hub'].includes(c.role),'微信查询需要已配置的角色');
 const device=q.device_id||c.device_id;assert(id(device),'微信查询需要明确设备');assert(c.role!=='collector'||device===c.device_id,'分控只能读取本设备');return device;
}
export function listWechatChats(store,c,q={}){
 const device=queryScope(c,q),limit=Number(q.limit??50),offset=Number(q.offset??0);
 assert(Number.isInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(offset)&&offset>=0,'微信会话分页无效');
 assert(store.device(device)?.org_id===c.org_id,'微信设备不属于本公司');
 const rows=store.db.prepare(`SELECT account_id,conversation_id,MAX(observed_at) latest_observed_at,COUNT(*) saved_messages,SUM(CASE WHEN sender_id IS NULL THEN 1 ELSE 0 END) unknown_sender_messages FROM wechat_messages WHERE device_id=? GROUP BY account_id,conversation_id ORDER BY latest_observed_at DESC,account_id,conversation_id LIMIT ? OFFSET ?`).all(device,limit+1,offset);
 return {source:'worktrace_database',device_id:device,items:rows.slice(0,limit),has_more:rows.length>limit,next_offset:rows.length>limit?offset+limit:null,count_semantics:'physical_source_records_latest_revision',scope:'已采集的本地物理来源记录；不是跨库去重消息数、全部好友或全部历史'};
}
export function readWechatChat(store,c,q={}){
 const device=queryScope(c,q),limit=Number(q.limit??50),before=Number(q.before??Number.MAX_SAFE_INTEGER);
 assert(store.device(device)?.org_id===c.org_id,'微信设备不属于本公司');
 for(const k of ['account_id','conversation_id'])assert(str(q[k],160)&&q[k].trim(),'微信查询需要明确账号与会话 ID');
 assert(Number.isInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(before)&&before>0,'微信消息分页无效');
 const rows=store.db.prepare(`SELECT w.rowid AS position,e.json FROM wechat_messages w JOIN events e ON e.event_id=w.revision_id WHERE w.device_id=? AND w.account_id=? AND w.conversation_id=? AND w.rowid<? ORDER BY w.rowid DESC LIMIT ?`).all(device,q.account_id,q.conversation_id,before,limit+1);
 const selected=[];let characters=0;const maxCharacters=100000,maxText=6000;
 for(const row of rows.slice(0,limit)){
  const e=JSON.parse(row.json),full=e.payload.text;let text=full.slice(0,maxText);if(text.length<full.length&&/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
  const item={event_id:e.event_id,observed_at:e.payload.observed_at,source:e.payload.source,...wechatPreview(e).wechat,text,text_truncated:full.length>text.length,text_omitted_characters:full.length-text.length};
  const cost=JSON.stringify(item).length;if(selected.length&&characters+cost>maxCharacters)break;
  characters+=cost;selected.push({position:row.position,item});
 }
 const hasMore=rows.length>selected.length;
 return {source:'worktrace_database',device_id:device,account_id:q.account_id,conversation_id:q.conversation_id,items:selected.map(r=>r.item).reverse(),has_more:hasMore,next_before:hasMore&&selected.length?Math.min(...selected.map(r=>r.position)):null,order:'source_discovery_order',count_semantics:'physical_source_records_latest_revision',output_budget:{max_characters:maxCharacters,max_text_characters_per_message:maxText,characters},read_receipt_changed:false};
}
