import https from 'node:https';
import {isIP} from 'node:net';
import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHash,X509Certificate} from 'node:crypto';
import {origin,validateIdentity,assertPlainPath,saveExclusive} from './invite-client.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const secret=/^[A-Za-z0-9_-]{43}$/;
const canonicalSecret=value=>typeof value==='string'&&secret.test(value)&&Buffer.from(value,'base64url').length===32&&Buffer.from(value,'base64url').toString('base64url')===value;
const repository='https://github.com/zhoudebao6-art/worktrace-skills/tree/main';
const prefix=repository+'#worktrace-join=v1.';
const sha=value=>createHash('sha256').update(value).digest('hex');
function check(value,message){if(!value)throw Error(message);}
function fields(value,names){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)),'JSON 字段不完整或包含未知字段。');}
function readJSON(file,max=65536){assertPlainPath(file);const stat=lstatSync(file);check(stat.isFile()&&stat.size<=max,'JSON 文件类型或大小无效。');try{return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('JSON 文件损坏；原文件已保留，不能重置身份后重试。');}}

export function validateConnection(value){
 fields(value,['format','hub_url','org_id','org_name','ca_pem']);
 check(value.format==='worktrace.lan-link/1.0'&&uuid.test(value.org_id),'公司连接信息格式无效。');
 check(typeof value.org_name==='string'&&value.org_name.length>=1&&value.org_name.length<=100&&value.org_name===value.org_name.trim()&&!/[\u0000-\u001f\u007f]/u.test(value.org_name),'公司名称无效。');
 const host=new URL(origin(value.hub_url)).hostname,parts=host.split('.').map(Number);
 check(isIP(host)===4&&(parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168)),'局域网总控地址必须使用 RFC1918 私有 IPv4 地址。');
 check(typeof value.ca_pem==='string'&&value.ca_pem.length<=20000&&!value.ca_pem.includes('PRIVATE KEY')&&/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(value.ca_pem.trim())&&value.ca_pem.match(/BEGIN CERTIFICATE/g)?.length===1,'连接信息必须包含公司的单个公开证书。');
 let certificate;try{certificate=new X509Certificate(value.ca_pem);}catch{throw Error('公司证书无法解析。');}
 check(certificate.checkIP(host)===host,'公司证书未覆盖总控局域网地址。');
 check(Date.parse(certificate.validFrom)<=Date.now()&&Date.now()<Date.parse(certificate.validTo),'公司证书尚未生效或已经过期。');return value;
}
export function parseConnectionLink(link){
 check(typeof link==='string'&&link.length<=32768&&link.startsWith(prefix),'请提供公司发出的完整 GitHub 技能连接链接，包含 #worktrace-join=v1. 部分。');
 const encoded=link.slice(prefix.length);check(/^[A-Za-z0-9_-]+$/.test(encoded),'公司连接链接编码无效。');
 const bytes=Buffer.from(encoded,'base64url');check(bytes.length<=24576&&bytes.toString('base64url')===encoded,'公司连接链接编码无效。');
 let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('公司连接链接不是有效 JSON。');}return validateConnection(value);
}
function expectedState(connection,identity){return {format:'worktrace.lan-request/1.0',link_sha256:sha(JSON.stringify(connection)),org_id:connection.org_id,hub_url:connection.hub_url,...identity};}
export function prepareLanRequest({connection,identity,statePath}){
 validateConnection(connection);validateIdentity(identity);const expected=expectedState(connection,identity);let state;
 if(existsSync(statePath))state=readJSON(statePath,16384);
 else{
  state={...expected,request_id:randomUUID(),request_secret:randomBytes(32).toString('base64url'),device_token:randomBytes(32).toString('base64url')};
  try{saveExclusive(statePath,state);}catch(error){if(error.code!=='EEXIST')throw error;state=readJSON(statePath,16384);}
 }
 fields(state,[...Object.keys(expected),'request_id','request_secret','device_token']);
 check(Object.keys(expected).every(k=>state[k]===expected[k])&&uuid.test(state.request_id)&&canonicalSecret(state.request_secret)&&canonicalSecret(state.device_token)&&state.request_secret!==state.device_token,'已有接入请求与本次公司、证书、地址或员工身份不一致，未覆盖。');
 return {org_id:connection.org_id,request_id:state.request_id,request_secret:state.request_secret,device_token:state.device_token,...identity,hub_url:connection.hub_url};
}
export function validateLanEnrollment(enrollment,connection,request){
 fields(enrollment,['format','org_id','org_name','device_id','employee_id','employee_name','label','hub_url','ca_pem','device_token']);
 check(enrollment.format==='worktrace.enrollment/1.0'&&uuid.test(enrollment.device_id),'登记结果格式无效。');
 check(['org_id','org_name','ca_pem'].every(k=>enrollment[k]===connection[k])&&['employee_id','employee_name','label','hub_url','device_token'].every(k=>enrollment[k]===request[k]),'登记结果与公司证书、员工身份、设备凭据或接入地址不一致。');return enrollment;
}
export async function requestLanEnrollment(connection,request){
 validateConnection(connection);const target=new URL('/v1/lan/enroll',connection.hub_url),payload=Buffer.from(JSON.stringify(request));check(payload.length<=8192,'接入请求过大。');
 return new Promise((accept,reject)=>{
  const req=https.request(target,{method:'POST',ca:connection.ca_pem,rejectUnauthorized:true,timeout:15000,headers:{'Content-Type':'application/json','Content-Length':payload.length}},res=>{
   const chunks=[];let size=0;res.on('data',part=>{size+=part.length;if(size>65536){req.destroy(Error('接入响应过大。'));return;}chunks.push(part);});
   res.on('error',()=>reject(Error('接入响应读取失败；保留原请求后重试。')));
   res.on('end',()=>{try{
    check(res.statusCode===200,({400:'接入请求被拒绝，请核对公司链接和员工身份。',401:'总控未允许此公司或来源网络接入，请核对总控局域网接入设置。',409:'员工编号或请求已被登记，请联系总控核对，不能覆盖原身份。',429:'接入请求过于频繁，请稍后使用原请求重试。'})[res.statusCode]||'总控未接受接入请求；不会跟随重定向。');
    check(String(res.headers['content-type']||'').startsWith('application/json'),'接入响应类型无效。');let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('接入响应不是有效 JSON。');}accept(validateLanEnrollment(value,connection,request));
   }catch(error){reject(error);}});
  });
  // Neither server-supplied error bodies nor raw TLS errors may print secrets.
  req.on('error',()=>reject(Error('无法建立经过公司证书验证的 HTTPS 连接；请核对总控地址、局域网和公司链接后使用原请求重试。')));
  req.on('timeout',()=>req.destroy());req.end(payload);
 });
}
export async function enrollFromLan({connectionLink,connectionPath,statePath,outputPath,workDir,employee_id,employee_name,label}){
 check((typeof connectionLink==='string')!==!!connectionPath,'公司连接信息必须由完整链接或本地文件提供其中一种。');
 const connection=connectionPath?validateConnection(readJSON(connectionPath,32768)):parseConnectionLink(connectionLink),identity=validateIdentity({employee_id,employee_name,label});
 if(workDir){const configPath=join(assertPlainPath(workDir),'data','config.json');if(existsSync(configPath)){
  const config=readJSON(configPath);check(config.role==='collector'&&config.connection_mode!=='offline'&&['org_id','org_name','hub_url','ca_pem'].every(k=>config[k]===connection[k])&&Object.keys(identity).every(k=>config[k]===identity[k]),'目标已有不同角色、模式、公司、地址、证书或员工身份，未修改。');
  check(existsSync(outputPath)&&existsSync(statePath),'目标已初始化但没有原接入状态，不能重新登记。');
  const stored=readJSON(outputPath);check(stored.device_id===config.device_id&&stored.device_token===config.device_token,'已有运行身份与接入文件不一致，未修改。');
 }else{const dataDir=dirname(configPath);check(!existsSync(dataDir)||readdirSync(dataDir).length===0,'目标数据目录已有文件但缺少身份配置；请先核对恢复，不能重新登记。');}}
 const request=prepareLanRequest({connection,identity,statePath});let enrollment;
 if(existsSync(outputPath))enrollment=validateLanEnrollment(readJSON(outputPath,32768),connection,request);
 else{
  enrollment=await requestLanEnrollment(connection,request);try{saveExclusive(outputPath,enrollment);}catch(error){if(error.code!=='EEXIST')throw error;const stored=validateLanEnrollment(readJSON(outputPath,32768),connection,request);check(JSON.stringify(stored)===JSON.stringify(enrollment),'并发登记结果不一致，未覆盖已有文件。');enrollment=stored;}
 }
 return {saved:resolve(outputPath),org_id:enrollment.org_id,employee_id:enrollment.employee_id,device_id:enrollment.device_id};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length===3&&process.argv[2]==='--validate-link'){
   parseConnectionLink(readFileSync(0,'utf8').trimEnd());console.log(JSON.stringify({valid:true}));
  }else{
  const args={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];check(['--connection','--state','--output','--work-dir','--employee-id','--employee-name','--label'].includes(key)&&process.argv[i+1]!==undefined&&!Object.hasOwn(args,key),'接入参数无效。');args[key]=process.argv[i+1];}
  check(['--connection','--state','--output','--work-dir','--employee-id','--employee-name','--label'].every(k=>args[k]),'缺少接入参数。');
  console.log(JSON.stringify(await enrollFromLan({connectionPath:args['--connection'],statePath:args['--state'],outputPath:args['--output'],workDir:args['--work-dir'],employee_id:args['--employee-id'],employee_name:args['--employee-name'],label:args['--label']})));
  }
 }catch(error){console.error(JSON.stringify({error:error.code?'本地文件无法安全读写；原文件已保留。':error.message}));process.exitCode=1;}
}
