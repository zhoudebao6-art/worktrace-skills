import https from 'node:https';
import {existsSync,lstatSync,readFileSync,readdirSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHash,X509Certificate} from 'node:crypto';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const secret=/^[A-Za-z0-9_-]{43}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
function check(value,message){if(!value)throw Error(message);}
function fields(value,names){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)),'JSON 字段不完整或包含未知字段。');}
function text(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u001f\u007f]/u.test(value);}
export function origin(value){
 check(typeof value==='string'&&value.length<=2048,'接入地址无效。');let url;try{url=new URL(value);}catch{throw Error('接入地址无效。');}
 check(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&(url.pathname==='/'||url.pathname==='')&&value===url.origin,'接入地址必须是规范的 HTTPS origin，不能包含路径、账号或查询参数。');return url.origin;
}
export function validateIdentity(value){
 fields(value,['employee_id','employee_name','label']);check(typeof value.employee_id==='string'&&/^[\p{L}\p{N}_.-]{1,80}$/u.test(value.employee_id),'员工编号无效。');
 check(text(value.employee_name,100)&&text(value.label,100),'请提供员工姓名及电脑名称。');return value;
}
export function validateInvite(value){
 fields(value,['format','invite_id','invite_token','org_id','org_name','hub_url','allowed_urls','ca_pem','created_at','expires_at']);
 check(value.format==='worktrace.invitation/1.0'&&uuid.test(value.invite_id)&&uuid.test(value.org_id)&&secret.test(value.invite_token)&&text(value.org_name,100),'邀请文件格式或公司身份无效。');
 const primary=origin(value.hub_url);check(Array.isArray(value.allowed_urls)&&value.allowed_urls.length>=1&&value.allowed_urls.length<=8&&new Set(value.allowed_urls).size===value.allowed_urls.length&&value.allowed_urls.map(origin).includes(primary),'邀请允许的接入地址无效。');
 check(typeof value.ca_pem==='string'&&value.ca_pem.length<=20000&&!value.ca_pem.includes('PRIVATE KEY')&&value.ca_pem.trim().match(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/)&&value.ca_pem.match(/BEGIN CERTIFICATE/g)?.length===1,'邀请必须包含公司的公开证书。');
 try{new X509Certificate(value.ca_pem);}catch{throw Error('邀请证书无法解析。');}
 check(typeof value.created_at==='string'&&typeof value.expires_at==='string'&&Number.isFinite(Date.parse(value.created_at))&&Date.parse(value.expires_at)>Date.parse(value.created_at),'邀请有效期无效。');return value;
}
export function assertPlainPath(file){
 let cursor=resolve(file);while(true){if(existsSync(cursor))check(!lstatSync(cursor).isSymbolicLink(),'拒绝链接或 junction 路径。');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}return resolve(file);
}
function readJSON(file,max=65536){assertPlainPath(file);const stat=lstatSync(file);check(stat.isFile()&&stat.size<=max,'JSON 文件类型或大小无效。');try{return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('JSON 文件损坏；原文件已保留，不能重置身份后重试。');}}
// Flush a private temporary file, then create the destination without replacing
// any existing entry. A crash before the hard link leaves only an unused temp;
// a crash afterwards leaves the complete original request available for retry.
export function saveExclusive(file,value){
 file=assertPlainPath(file);mkdirSync(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';let fd;
 try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;linkSync(temp,file);}finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp);}
}
function expectedState(invite,identity,hubUrl){return {format:'worktrace.join-request/1.0',invite_id:invite.invite_id,invite_sha256:sha(JSON.stringify(invite)),org_id:invite.org_id,hub_url:hubUrl,...identity};}
export function prepareRequest({invite,identity,hubUrl=invite.hub_url,statePath}){
 validateInvite(invite);validateIdentity(identity);hubUrl=origin(hubUrl);check(invite.allowed_urls.includes(hubUrl),'目标地址不在邀请允许范围内。');
 const expected=expectedState(invite,identity,hubUrl);let state;
 if(existsSync(statePath))state=readJSON(statePath,16384);
 else{state={...expected,request_id:randomUUID(),request_secret:randomBytes(32).toString('base64url')};try{saveExclusive(statePath,state);}catch(error){if(error.code!=='EEXIST')throw error;state=readJSON(statePath,16384);}}
 fields(state,[...Object.keys(expected),'request_id','request_secret']);check(Object.keys(expected).every(k=>state[k]===expected[k])&&uuid.test(state.request_id)&&secret.test(state.request_secret),'已有接入请求与本次邀请、身份或地址不一致，未覆盖。');
 return {invite_id:invite.invite_id,invite_token:invite.invite_token,request_id:state.request_id,request_secret:state.request_secret,...identity,hub_url:hubUrl};
}
export function validateEnrollment(enrollment,invite,request){
 fields(enrollment,['format','org_id','org_name','device_id','employee_id','employee_name','label','hub_url','ca_pem','device_token']);
 check(enrollment.format==='worktrace.enrollment/1.0'&&uuid.test(enrollment.device_id)&&secret.test(enrollment.device_token),'登记结果格式无效。');
 check(['org_id','org_name','ca_pem'].every(k=>enrollment[k]===invite[k])&&['employee_id','employee_name','label','hub_url'].every(k=>enrollment[k]===request[k]),'登记结果与公司证书、员工身份或接入地址不一致。');return enrollment;
}
export async function redeemInvite(invite,request){
 const target=new URL('/v1/enroll',request.hub_url),payload=Buffer.from(JSON.stringify(request));check(payload.length<=8192,'接入请求过大。');
 return new Promise((accept,reject)=>{
  const req=https.request(target,{method:'POST',ca:invite.ca_pem,rejectUnauthorized:true,timeout:15000,headers:{'Content-Type':'application/json','Content-Length':payload.length}},res=>{
   const chunks=[];let size=0;res.on('data',part=>{size+=part.length;if(size>65536){req.destroy(Error('接入响应过大。'));return;}chunks.push(part);});
   res.on('error',()=>reject(Error('接入响应读取失败；保留原请求后重试。')));
   res.on('end',()=>{try{
    check(res.statusCode===200,({400:'接入请求被拒绝，请核对邀请和身份。',401:'邀请无效、过期、已撤销或不能用于本次请求。',409:'员工已登记，请联系总控核对，不能覆盖原身份。',429:'接入请求过于频繁，请稍后使用原请求重试。'})[res.statusCode]||'总控未接受接入请求；不会跟随重定向。');
    check(String(res.headers['content-type']||'').startsWith('application/json'),'接入响应类型无效。');let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('接入响应不是有效 JSON。');}accept(validateEnrollment(value,invite,request));
   }catch(error){reject(error);}});
  });
  // Remote messages and raw TLS errors may contain credentials or addresses;
  // never relay them to Codex or the terminal.
  req.on('error',()=>reject(Error('无法建立经过公司证书验证的 HTTPS 连接；请核对网络、地址和邀请证书后使用原请求重试。')));
  req.on('timeout',()=>req.destroy());req.end(payload);
 });
}
export async function enrollFromInvite({invitePath,statePath,outputPath,workDir,employee_id,employee_name,label,hubUrl}){
 const invite=validateInvite(readJSON(invitePath,32768)),identity=validateIdentity({employee_id,employee_name,label});
 if(workDir){const configPath=join(assertPlainPath(workDir),'data','config.json');if(existsSync(configPath)){
  const config=readJSON(configPath);check(config.role==='collector'&&config.connection_mode!=='offline'&&config.org_id===invite.org_id&&config.org_name===invite.org_name&&Object.keys(identity).every(k=>config[k]===identity[k]),'目标已有不同角色、模式、公司或员工身份，未修改。');
  check(existsSync(outputPath)&&existsSync(statePath),'目标已初始化但没有原接入状态，不能重新兑换邀请。');
  const stored=readJSON(outputPath);check(stored.device_id===config.device_id&&stored.device_token===config.device_token,'已有运行身份与接入文件不一致，未修改。');
 }else{const dataDir=dirname(configPath);check(!existsSync(dataDir)||readdirSync(dataDir).length===0,'目标数据目录已有文件但缺少身份配置；请先核对恢复，不能兑换邀请。');}}
 const request=prepareRequest({invite,identity,hubUrl,statePath});let enrollment;
 if(existsSync(outputPath))enrollment=validateEnrollment(readJSON(outputPath,32768),invite,request);
 else{enrollment=await redeemInvite(invite,request);try{saveExclusive(outputPath,enrollment);}catch(error){if(error.code!=='EEXIST')throw error;const stored=validateEnrollment(readJSON(outputPath,32768),invite,request);check(JSON.stringify(stored)===JSON.stringify(enrollment),'并发登记结果不一致，未覆盖已有文件。');enrollment=stored;}}
 return {saved:resolve(outputPath),org_id:enrollment.org_id,employee_id:enrollment.employee_id,device_id:enrollment.device_id};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];check(['--invite','--state','--output','--work-dir','--employee-id','--employee-name','--label','--hub-url'].includes(key)&&process.argv[i+1]!==undefined&&!Object.hasOwn(args,key),'接入参数无效。');args[key]=process.argv[i+1];}
  check(['--invite','--state','--output','--work-dir','--employee-id','--employee-name','--label'].every(k=>args[k]),'缺少接入参数。');
  console.log(JSON.stringify(await enrollFromInvite({invitePath:args['--invite'],statePath:args['--state'],outputPath:args['--output'],workDir:args['--work-dir'],employee_id:args['--employee-id'],employee_name:args['--employee-name'],label:args['--label'],hubUrl:args['--hub-url']})));
 }catch(error){console.error(JSON.stringify({error:error.code?'本地文件无法安全读写；原文件已保留。':error.message}));process.exitCode=1;}
}
