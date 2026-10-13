import {randomBytes,createHmac,timingSafeEqual,X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import {uuid,hash,canonical,id,str} from './protocol.mjs';

const FORMAT='worktrace.invitation/1.0', SECRET=/^[A-Za-z0-9_-]{43}$/;
const denied=()=>failure(401,'接入码无效、已过期、已撤销或已用于其他接入请求');
function failure(status,message){const error=new Error(message);error.status=status;return error;}
function requireValue(value,message,status=400){if(!value)throw failure(status,message);}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function fields(value,allowed,required=allowed){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(value,k)),'接入参数字段无效');}
function hubOnly(config){requireValue(config?.role==='hub'&&id(config.org_id),'仅总控可管理接入码');}

export function initInvitations(store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS invitations(
  invite_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
  public_json TEXT NOT NULL,request_id TEXT,request_secret_hash TEXT,request_hash TEXT,
  device_id TEXT,consumed_at TEXT,FOREIGN KEY(device_id) REFERENCES devices(device_id));
  CREATE INDEX IF NOT EXISTS invitations_org ON invitations(org_id,created_at);`);
}
function normalizeUrl(value){
 requireValue(str(value,1000)&&value.length>0,'接入地址无效');let url;try{url=new URL(value);}catch{throw failure(400,'接入地址无效');}
 requireValue(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/','接入地址必须是无路径、参数和凭据的 HTTPS 地址');
 return url.origin;
}
function certifiedUrls(config,alternatives){
 requireValue(alternatives===undefined||Array.isArray(alternatives)&&alternatives.length<=8,'备用接入地址至多 8 个');
 const urls=[...new Set([config.hub_url,...(alternatives||[])].map(normalizeUrl))];
 requireValue(urls.length<=8,'接入地址总数至多 8 个');
 let cert;try{cert=new X509Certificate(config.ca_pem);}catch{throw failure(400,'总控证书无效');}
 for(const url of urls){const hostname=new URL(url).hostname.replace(/^\[|\]$/g,'');requireValue(isIP(hostname)?cert.checkIP(hostname):cert.checkHost(hostname),'接入地址未包含在总控证书中，请先配置可验证证书');}
 return urls;
}
export function createInvitation(store,config,input={},now=Date.now()){
 hubOnly(config);fields(input,['expires_in_days','allowed_urls'],[]);
 const days=input.expires_in_days===undefined?7:input.expires_in_days;requireValue(Number.isInteger(days)&&days>=1&&days<=30,'接入码有效期须为 1 至 30 天');
 const urls=certifiedUrls(config,input.allowed_urls),inviteToken=randomBytes(32).toString('base64url');
 const value={format:FORMAT,invite_id:uuid(),org_id:config.org_id,org_name:config.org_name,hub_url:urls[0],allowed_urls:urls,ca_pem:config.ca_pem,created_at:new Date(now).toISOString(),expires_at:new Date(now+days*86400000).toISOString()};
 initInvitations(store);store.db.exec('BEGIN IMMEDIATE');try{
  store.db.prepare('INSERT INTO invitations(invite_id,org_id,token_hash,created_at,expires_at,public_json) VALUES(?,?,?,?,?,?)').run(value.invite_id,config.org_id,hash(inviteToken),value.created_at,value.expires_at,JSON.stringify(value));
  store.audit('invitation.create',value.invite_id);store.db.exec('COMMIT');
 }catch(error){store.db.exec('ROLLBACK');throw error;}
 return {...value,invite_token:inviteToken};
}
export function listInvitations(store,config,now=Date.now()){
 hubOnly(config);initInvitations(store);
 return store.db.prepare('SELECT invite_id,created_at,expires_at,revoked,device_id,consumed_at FROM invitations WHERE org_id=? ORDER BY created_at DESC LIMIT 500').all(config.org_id).map(row=>({...row,state:row.revoked?'revoked':Date.parse(row.expires_at)<=now?'expired':row.consumed_at?'consumed':'available'}));
}
export function revokeInvitation(store,config,input){
 hubOnly(config);fields(input,['invite_id']);requireValue(id(input.invite_id),'接入码编号无效');initInvitations(store);
 const result=store.db.prepare('UPDATE invitations SET revoked=1 WHERE invite_id=? AND org_id=?').run(input.invite_id.toLowerCase(),config.org_id);
 requireValue(result.changes===1,'接入码不存在');store.audit('invitation.revoke',input.invite_id.toLowerCase());return {ok:true,invite_id:input.invite_id.toLowerCase()};
}
export function redeemInvitation(store,config,input,now=Date.now()){
 hubOnly(config);fields(input,['invite_id','invite_token','request_id','request_secret','employee_id','employee_name','label','hub_url']);
 requireValue(id(input.invite_id)&&id(input.request_id)&&typeof input.invite_token==='string'&&SECRET.test(input.invite_token)&&typeof input.request_secret==='string'&&SECRET.test(input.request_secret),'接入码或请求编号无效');
 requireValue(str(input.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(input.employee_id)&&str(input.employee_name,100)&&input.employee_name.trim()&&str(input.label,100)&&input.label.trim()&&!/[\u0000-\u001f\u007f]/.test(input.employee_name+input.label),'请填写有效员工编号、姓名及电脑名称');
 const inviteId=input.invite_id.toLowerCase(),requestId=input.request_id.toLowerCase();
 const identity={employee_id:input.employee_id,employee_name:input.employee_name.trim(),label:input.label.trim(),hub_url:normalizeUrl(input.hub_url)};
 const requestHash=hash(canonical(identity)),secretHash=hash(input.request_secret);
 initInvitations(store);store.db.exec('BEGIN IMMEDIATE');try{
  const invitation=store.db.prepare('SELECT * FROM invitations WHERE invite_id=? AND org_id=?').get(inviteId,config.org_id);
  if(!invitation||!equal(invitation.token_hash,hash(input.invite_token))||invitation.revoked||Date.parse(invitation.expires_at)<=now)throw denied();
  const publicInfo=JSON.parse(invitation.public_json);requireValue(publicInfo.allowed_urls.includes(identity.hub_url),'接入地址未获得此接入码授权');
  const deviceToken=createHmac('sha256',input.invite_token).update('worktrace.enrollment/1.0:'+inviteId+':'+requestId+':'+input.request_secret).digest('base64url');
  let device;
  if(invitation.consumed_at){
   if(invitation.request_id!==requestId||!equal(invitation.request_secret_hash,secretHash)||!equal(invitation.request_hash,requestHash))throw denied();
   device=store.device(invitation.device_id);
   if(!device||device.revoked||device.org_id!==config.org_id||device.employee_id!==identity.employee_id||device.employee_name!==identity.employee_name||device.label!==identity.label||!equal(device.token_hash,hash(deviceToken)))throw denied();
  }else{
   requireValue(!store.db.prepare('SELECT 1 FROM devices WHERE org_id=? AND employee_id=? LIMIT 1').get(config.org_id,identity.employee_id),'此员工编号已有登记，请由总控核对后单独登记其他电脑',409);
   device={device_id:uuid(),org_id:config.org_id,employee_id:identity.employee_id,employee_name:identity.employee_name,label:identity.label};store.addDevice(device,deviceToken);
   store.db.prepare('UPDATE invitations SET request_id=?,request_secret_hash=?,request_hash=?,device_id=?,consumed_at=? WHERE invite_id=?').run(requestId,secretHash,requestHash,device.device_id,new Date(now).toISOString(),inviteId);
   store.audit('invitation.redeem',inviteId+':'+device.device_id);
  }
  const enrollment={format:'worktrace.enrollment/1.0',org_id:config.org_id,org_name:publicInfo.org_name,device_id:device.device_id,employee_id:device.employee_id,employee_name:device.employee_name,label:device.label,hub_url:identity.hub_url,ca_pem:publicInfo.ca_pem,device_token:deviceToken};
  store.db.exec('COMMIT');return enrollment;
 }catch(error){store.db.exec('ROLLBACK');throw error;}
}

// Limit every attempt before parsing a body. Forwarded headers are deliberately
// ignored: only the TLS peer address is an authority for the per-address bucket.
export function createEnrollmentLimiter({perIp=12,total=120,windowMs=60000,now=Date.now}={}){
 let start=now(),count=0;const addresses=new Map();
 return address=>{
  const time=now();if(time-start>=windowMs){start=time;count=0;addresses.clear();}
  const used=addresses.get(address)||0;if(count>=total||used>=perIp)return false;
  count++;addresses.set(address,used+1);return true;
 };
}
export function readEnrollmentBody(req){
 const max=8192;requireValue(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/json','需要 JSON 请求');
 const length=req.headers['content-length'];if(length!==undefined)requireValue(/^\d+$/.test(length)&&Number(length)<=max,'接入请求体过大',413);
 return new Promise((resolve,reject)=>{
  let size=0;const chunks=[];
  function cleanup(){req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);}
  function error(){cleanup();reject(failure(400,'接入请求读取失败'));}
  function aborted(){cleanup();reject(failure(400,'接入请求未完成'));}
  function data(chunk){size+=chunk.length;if(size>max){cleanup();req.pause();reject(failure(413,'接入请求体过大'));return;}chunks.push(chunk);}
  function end(){cleanup();try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(failure(400,'接入请求不是有效 JSON'));}}
  req.on('data',data);req.on('end',end);req.on('error',error);req.on('aborted',aborted);
 });
}
