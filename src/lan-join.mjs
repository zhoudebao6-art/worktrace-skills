import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {timingSafeEqual,X509Certificate} from 'node:crypto';
import {uuid,hash,canonical,id,str} from './protocol.mjs';

const SECRET=/^[A-Za-z0-9_-]{43}$/, POLICY='lan_join_policy';
const denied=()=>failure(401,'局域网自动接入未开放、来源不符或原接入身份无效');
function failure(status,message){const error=new Error(message);error.status=status;return error;}
function check(value,message,status=400){if(!value)throw failure(status,message);}
function fields(value,names){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key)),'局域网接入字段无效');}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function hubOnly(config){check(config?.role==='hub'&&id(config.org_id),'仅总控可管理局域网接入');}
function currentHubAddress(config,interfaces){let hostname;try{hostname=new URL(config.hub_url).hostname;}catch{return false;}return Object.values(interfaces).flat().some(row=>row&&!row.internal&&(row.family==='IPv4'||row.family===4)&&row.address===hostname);}
function validSecret(value){return typeof value==='string'&&SECRET.test(value)&&Buffer.from(value,'base64url').length===32&&Buffer.from(value,'base64url').toString('base64url')===value;}
function ipNumber(value){check(isIP(value)===4,'需要 IPv4 地址');return value.split('.').reduce((n,v)=>((n<<8)+Number(v))>>>0,0);}
function ipText(value){return [24,16,8,0].map(n=>(value>>>n)&255).join('.');}
function privateNumber(value){return (value>>>24)===10||(value>>>20)===(ipNumber('172.16.0.0')>>>20)||(value>>>16)===(ipNumber('192.168.0.0')>>>16);}
function parseCidr(value,{canonicalOnly=true}={}){
 check(typeof value==='string'&&/^\d+\.\d+\.\d+\.\d+\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(value),'局域网范围必须是 IPv4 CIDR');
 const [address,bits]=value.split('/'),prefix=Number(bits),number=ipNumber(address),mask=prefix===0?0:(0xffffffff<<(32-prefix))>>>0,network=(number&mask)>>>0,last=(network|(~mask>>>0))>>>0;
 check(privateNumber(network)&&privateNumber(last),'仅允许 RFC1918 私有 IPv4 网段');
 const normalized=ipText(network)+'/'+prefix;check(!canonicalOnly||value===normalized,'请使用规范网段地址，例如 192.168.1.0/24');
 return {cidr:normalized,network,mask};
}
function prefixFromMask(value){const number=ipNumber(value),binary=number.toString(2).padStart(32,'0');check(/^1*0*$/.test(binary),'本机接口掩码无效');return binary.indexOf('0')===-1?32:binary.indexOf('0');}
export function currentLanCidrs(interfaces=networkInterfaces()){
 const found=new Set();for(const row of Object.values(interfaces).flat()){
  if(!row||row.internal||!(row.family==='IPv4'||row.family===4))continue;
  try{const prefix=prefixFromMask(row.netmask),value=parseCidr(row.address+'/'+prefix,{canonicalOnly:false});found.add(value.cidr);}catch{}
 }return [...found].sort();
}
function validatePolicy(value,interfaces){
 fields(value,['enabled','allowed_cidrs']);check(typeof value.enabled==='boolean'&&Array.isArray(value.allowed_cidrs)&&value.allowed_cidrs.length<=8&&new Set(value.allowed_cidrs).size===value.allowed_cidrs.length,'局域网接入策略无效');
 const ranges=value.allowed_cidrs.map(entry=>parseCidr(entry).cidr);check(!value.enabled||ranges.length>0,'启用接入时必须明确本机局域网范围');
 if(value.enabled){const current=currentLanCidrs(interfaces);check(ranges.every(entry=>current.includes(entry)),'允许网段必须精确匹配当前本机接口；网络变化后请重新核对');}
 return {enabled:value.enabled,allowed_cidrs:ranges};
}
export function lanJoinPolicy(store){const value=store.get(POLICY);return value||{enabled:false,allowed_cidrs:[]};}
export function configureLanJoin(store,config,input,{interfaces=networkInterfaces()}={}){
 hubOnly(config);const policy=validatePolicy(input,interfaces);if(policy.enabled){check(currentHubAddress(config,interfaces),'总控地址不是当前本机接口，请先核对网络地址与证书');publicBootstrap(config);}store.set(POLICY,policy);store.audit('lan_join.configure',JSON.stringify(policy));return policy;
}
export function normalizePeerAddress(value){
 if(typeof value!=='string')return null;let result=value;if(/^::ffff:/i.test(result))result=result.slice(7);return isIP(result)===4?result:null;
}
export function assertLanJoinAllowed(store,config,remoteAddress,{interfaces=networkInterfaces()}={}){
 hubOnly(config);let policy;try{policy=validatePolicy(lanJoinPolicy(store),interfaces);}catch{throw denied();}
 const peer=normalizePeerAddress(remoteAddress);if(!policy.enabled||!peer||!currentHubAddress(config,interfaces))throw denied();const number=ipNumber(peer);
 if(!privateNumber(number)||!policy.allowed_cidrs.some(cidr=>{const range=parseCidr(cidr);return ((number&range.mask)>>>0)===range.network;}))throw denied();return policy;
}
function publicBootstrap(config){
 hubOnly(config);let url,cert;try{url=new URL(config.hub_url);cert=new X509Certificate(config.ca_pem);}catch{throw failure(400,'总控地址或公开证书无效');}
 check(url.protocol==='https:'&&config.hub_url===url.origin&&!url.username&&!url.password&&isIP(url.hostname)===4&&privateNumber(ipNumber(url.hostname)),'局域网总控地址必须为 RFC1918 IPv4 HTTPS origin');
 check(cert.checkIP(url.hostname)&&Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now(),'总控证书未覆盖当前地址或已过期');
 check(str(config.org_name,100)&&config.org_name.trim(),'总控公司名称无效');
 return {format:'worktrace.lan-link/1.0',hub_url:config.hub_url,org_id:config.org_id,org_name:config.org_name,ca_pem:config.ca_pem};
}
export function lanJoinStatus(store,config,{interfaces=networkInterfaces()}={}){
 hubOnly(config);const policy=lanJoinPolicy(store);let active=false;try{active=validatePolicy(policy,interfaces).enabled&&currentHubAddress(config,interfaces);publicBootstrap(config);}catch{active=false;}
 return {policy,active,current_cidrs:currentLanCidrs(interfaces)};
}
export function createLanJoinLink(store,config,{interfaces=networkInterfaces()}={}){
 const status=lanJoinStatus(store,config,{interfaces});check(status.active,'请先为当前局域网明确启用自动接入');const bootstrap=publicBootstrap(config);
 return {url:'https://github.com/zhoudebao6-art/worktrace-skills/tree/main#worktrace-join=v1.'+Buffer.from(JSON.stringify(bootstrap)).toString('base64url'),hub_url:bootstrap.hub_url,org_id:bootstrap.org_id,org_name:bootstrap.org_name,allowed_cidrs:status.policy.allowed_cidrs};
}
export function initLanJoin(store){store.db.exec('CREATE TABLE IF NOT EXISTS lan_join_requests(request_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,request_secret_hash TEXT NOT NULL,device_token_hash TEXT NOT NULL,identity_hash TEXT NOT NULL,device_id TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(device_id) REFERENCES devices(device_id));');}
export function enrollLanDevice(store,config,input,{remoteAddress,interfaces=networkInterfaces(),now=Date.now()}={}){
 assertLanJoinAllowed(store,config,remoteAddress,{interfaces});fields(input,['org_id','request_id','request_secret','device_token','employee_id','employee_name','label','hub_url']);
 check(id(input.org_id)&&id(input.request_id)&&validSecret(input.request_secret)&&validSecret(input.device_token)&&input.request_secret!==input.device_token,'公司或请求编号及设备凭据无效');
 if(input.org_id!==config.org_id||input.hub_url!==config.hub_url)throw denied();const bootstrap=publicBootstrap(config);
 check(str(input.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(input.employee_id)&&str(input.employee_name,100)&&input.employee_name.trim()===input.employee_name&&input.employee_name.length>0&&str(input.label,100)&&input.label.trim()===input.label&&input.label.length>0&&!/[\u0000-\u001f\u007f]/.test(input.employee_name+input.label),'请填写有效员工编号、真实姓名及电脑名称');
 const requestId=input.request_id.toLowerCase(),secretHash=hash(input.request_secret),tokenHash=hash(input.device_token),identity={org_id:input.org_id,employee_id:input.employee_id,employee_name:input.employee_name,label:input.label,hub_url:input.hub_url,ca_sha256:hash(config.ca_pem)},identityHash=hash(canonical(identity));
 initLanJoin(store);store.db.exec('BEGIN IMMEDIATE');try{
  const prior=store.db.prepare('SELECT * FROM lan_join_requests WHERE request_id=?').get(requestId);let device;
  if(prior){
   if(prior.org_id!==config.org_id||!equal(prior.request_secret_hash,secretHash)||!equal(prior.device_token_hash,tokenHash)||!equal(prior.identity_hash,identityHash))throw denied();
   device=store.device(prior.device_id);if(!device||device.revoked||device.org_id!==config.org_id||device.employee_id!==input.employee_id||device.employee_name!==input.employee_name||device.label!==input.label||!equal(device.token_hash,tokenHash))throw denied();
  }else{
   check(!store.db.prepare('SELECT 1 FROM devices WHERE org_id=? AND employee_id=? LIMIT 1').get(config.org_id,input.employee_id),'此员工编号已有登记，请由总控核对后单独登记其他电脑',409);
   check(!store.db.prepare('SELECT 1 FROM devices WHERE token_hash=? LIMIT 1').get(tokenHash),'设备凭据已用于其他登记；请保留原请求并核对设备身份',409);
   device={device_id:uuid(),org_id:config.org_id,employee_id:input.employee_id,employee_name:input.employee_name,label:input.label};store.addDevice(device,input.device_token);
   store.db.prepare('INSERT INTO lan_join_requests(request_id,org_id,request_secret_hash,device_token_hash,identity_hash,device_id,created_at) VALUES(?,?,?,?,?,?,?)').run(requestId,config.org_id,secretHash,tokenHash,identityHash,device.device_id,new Date(now).toISOString());store.audit('lan_join.enroll',requestId+':'+device.device_id);
  }
  const result={format:'worktrace.enrollment/1.0',org_id:config.org_id,org_name:bootstrap.org_name,device_id:device.device_id,employee_id:device.employee_id,employee_name:device.employee_name,label:device.label,hub_url:bootstrap.hub_url,ca_pem:bootstrap.ca_pem,device_token:input.device_token};store.db.exec('COMMIT');return result;
 }catch(error){store.db.exec('ROLLBACK');throw error;}
}
