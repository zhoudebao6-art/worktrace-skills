import {assert,keys,str,id,utc,hash,canonical} from './protocol.mjs';

export const WECHAT_SCHEMA='1.3';
export const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const nonempty=(value,max=160)=>str(value,max)&&value.trim().length>0;
export function validateWechatSource(source){
 keys(source,['account_id','db_generation','shard_id','table_id']);
 for(const key of Object.keys(source))assert(nonempty(source[key],300),'微信来源标识无效: '+key);
 assert(str(source.account_id,160),'微信账号标识过长');return source;
}
export const wechatSourceKey=source=>hash(canonical(validateWechatSource(source)));
export function validateWechatMessage(m){
 keys(m,['cursor','source_message_id','local_message_id','server_message_id','conversation_id','conversation_kind','sender_id','sender_display_name','direction','identity_status','message_kind','message_status','sent_at','text','raw_hash','media','gaps']);
 assert(decimal(m.cursor)&&nonempty(m.source_message_id,300),'微信记录游标或标识无效');
 for(const k of ['local_message_id','server_message_id'])assert(m[k]===null||decimal(m[k]),'微信消息编号必须是无损十进制字符串');
 assert(nonempty(m.conversation_id)&&['private','group','unknown'].includes(m.conversation_kind),'微信会话无效');
 assert(m.sender_id===null||nonempty(m.sender_id),'微信发送人编号无效');
 assert(m.sender_display_name===null||str(m.sender_display_name,300),'微信显示名无效');
 assert(['incoming','outgoing','unknown'].includes(m.direction)&&['verified','unknown'].includes(m.identity_status),'微信身份状态无效');
 assert(m.identity_status==='verified'?m.sender_id!==null:m.sender_id===null&&m.direction==='unknown','未知身份不得猜测方向或发送人');
 assert(m.conversation_kind!=='group'||m.sender_id!==m.conversation_id,'群编号不能充当发送人编号');
 assert(['text','image','voice','video','file','system','other'].includes(m.message_kind)&&['normal','revoked','unknown'].includes(m.message_status),'微信消息类型或状态无效');
 assert(m.sent_at===null||utc(m.sent_at),'微信消息时间无效');
 assert(str(m.text,60000)&&/^[a-f0-9]{64}$/.test(m.raw_hash),'微信正文或原始摘要无效');
 assert(Array.isArray(m.media)&&m.media.length<=20,'微信媒体数量无效');
 for(const a of m.media){keys(a,['kind','state','reference']);assert(['image','voice','video','file','other'].includes(a.kind)&&['not_collected','unavailable','unsupported'].includes(a.state)&&str(a.reference,500),'微信媒体状态无效');}
 assert(Array.isArray(m.gaps)&&m.gaps.length<=30&&m.gaps.every(g=>nonempty(g,500)),'微信缺口字段无效');return m;
}
export function validateWechatPayload(p){
 keys(p,['format','source','message_key','revision_id','revision','previous_revision_id','observed_at','message','text']);
 assert(p.format==='worktrace.wechat-message/1.0','微信消息规范无效');validateWechatSource(p.source);validateWechatMessage(p.message);
 assert(/^[a-f0-9]{64}$/.test(p.message_key)&&id(p.revision_id)&&Number.isSafeInteger(p.revision)&&p.revision>0,'微信修订编号无效');
 assert(p.revision===1?p.previous_revision_id===null:id(p.previous_revision_id),'微信修订链无效');
 assert(utc(p.observed_at)&&p.text===p.message.text,'微信观察时间或正文副本无效');
 const expected=hash(canonical([wechatSourceKey(p.source),p.message.source_message_id]));
 assert(p.message_key===expected,'微信来源与消息标识不匹配');
 if(p.message.direction==='outgoing')assert(p.message.sender_id===p.source.account_id,'本人发送身份不匹配');
 if(p.message.direction==='incoming')assert(p.message.sender_id!==p.source.account_id,'接收方向与本人身份冲突');
 return p;
}

export function wechatPreview(e){
 if(e.event_type!=='chat.message')return {};
 const p=e.payload,m=p.message;return {wechat:{account_id:p.source.account_id,conversation_id:m.conversation_id,conversation_kind:m.conversation_kind,sender_id:m.sender_id,sender_display_name:m.sender_display_name,direction:m.direction,identity_status:m.identity_status,message_key:p.message_key,source_message_key:p.message_key,local_message_id:m.local_message_id,server_message_id:m.server_message_id,logical_message_id:m.server_message_id&&m.server_message_id!=='0'?hash(canonical([p.source.account_id,m.conversation_id,m.server_message_id])):null,revision:p.revision,previous_revision_id:p.previous_revision_id,sent_at:m.sent_at,message_kind:m.message_kind,message_status:m.message_status,gaps:m.gaps,media:m.media}};
}
