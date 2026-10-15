import {readFileSync,writeFileSync,existsSync,mkdirSync,statSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localApi} from './local-api.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function admin({command,role,dir=join(root,'data'),input,output,records}){
 if(!['hub','collector'].includes(role))throw Error('需要明确本机角色 hub 或 collector');
 const data=input?JSON.parse(readFileSync(input,'utf8').replace(/^\uFEFF/,'')):{};
 const status=await localApi(dir,'status');if(status.configured&&status.role!==role)throw Error('已配置角色与 Skill 角色不一致，不能覆盖初始化');
 if(command==='status')return status;
 if(command==='wechat-status')return localApi(dir,'wechat/status');
 if(command==='wechat-probe')return localApi(dir,'wechat/probe',{});
 if(command==='wechat-configure')return localApi(dir,'wechat/configure',data);
 if(command==='readiness')return localApi(dir,'readiness?'+new URLSearchParams(data));
 if(command==='shutdown')return localApi(dir,'shutdown',{});
 if(command==='init'){
  if(status.configured)return {already_configured:true,...status};
  return localApi(dir,'setup',role==='hub'?{...data,role:'hub'}:{role:'collector',...(data.format==='worktrace.offline-identity/1.0'?{offline:data}:{enrollment:data})});
 }
 if(!status.configured)throw Error('请先初始化本机');
 if(['lan-join-status','lan-join-configure','lan-join-link'].includes(command)){
  if(role!=='hub')throw Error('只有总控可以管理局域网自动接入');
  return command==='lan-join-configure'?localApi(dir,'lan-join/configure',data):localApi(dir,command==='lan-join-link'?'lan-join/link':'lan-join');
 }
 if(command==='invitations-list'||command==='invitations-revoke'){
  if(role!=='hub')throw Error('只有总控可以管理接入码');
  return command==='invitations-list'?localApi(dir,'invitations'):localApi(dir,'invitations/revoke',data);
 }
 if(command==='invitations-create'){
  if(role!=='hub')throw Error('只有总控可以生成接入码');
  if(!output)throw Error('接入码必须通过 --output 保存，不能打印密钥');
  const dest=resolve(output);if(existsSync(dest))throw Error('目标文件已存在，不覆盖接入码');
  mkdirSync(dirname(dest),{recursive:true});
  const invitation=await localApi(dir,'invitations/create',data);
  try{writeFileSync(dest,JSON.stringify(invitation,null,2),{flag:'wx',mode:0o600});}
  catch(error){await localApi(dir,'invitations/revoke',{invite_id:invitation.invite_id}).catch(()=>{});throw Error('接入码文件保存失败，请检查文件权限及接入码状态');}
  return {saved:dest,invite_id:invitation.invite_id,expires_at:invitation.expires_at};
 }
 if(command==='import-external'){
  if(role!=='collector'||!records)throw Error('外部记录导入需要 collector 角色及 --records 本地 JSON 文件');
  const stat=statSync(records);if(!stat.isFile()||stat.size>16*1024*1024)throw Error('导出 JSON 必须是至多 16MiB 的文件');
  const source=JSON.parse(readFileSync(records,'utf8').replace(/^\uFEFF/,''));
  return localApi(dir,'import/external',{...data,input:source});
 }
 if(command==='knowledge-search'||command==='knowledge-read')return localApi(dir,'knowledge/'+command.slice(10)+'?'+new URLSearchParams(data));
 if(command==='candidate-evaluate')return localApi(dir,'candidates/evaluate',data);
 if(command==='candidate-evaluations')return localApi(dir,'candidates/evaluations?'+new URLSearchParams(data));
 if(command==='candidate-revise')return localApi(dir,'candidates/revise',data);
 if(command==='candidate-revisions')return localApi(dir,'candidates/revisions?'+new URLSearchParams(data));
 if(command==='enroll'){
  if(role!=='hub')throw Error('只有总控可以登记设备');
  if(!output)throw Error('登记文件必须通过 --output 保存，不能打印密钥');
  const dest=resolve(output);if(existsSync(dest))throw Error('目标文件已存在，不覆盖登记密钥');
  mkdirSync(dirname(dest),{recursive:true});
  const enrollment=await localApi(dir,'devices',data);writeFileSync(dest,JSON.stringify(enrollment,null,2),{flag:'wx',mode:0o600});
  return {saved:dest,device_id:enrollment.device_id,employee_id:enrollment.employee_id};
 }
 if(command==='personal-digest')return localApi(dir,'personal/digest',data);
 if(command==='file-extract'){if(!output||existsSync(resolve(output)))throw Error('需要未存在的 --output 原件保存路径');const result=await localApi(dir,'files/original?event_id='+encodeURIComponent(data.event_id),undefined,{binary:true});mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(resolve(output),result.bytes,{flag:'wx',mode:0o600});return {path:resolve(output),bytes:result.bytes.length};}
 if(command==='files-configure')return localApi(dir,'files/configure',data);
 if(command==='files-scan')return localApi(dir,'files/scan',{});
 if(command==='adopt-offline-device')return localApi(dir,'offline/adopt-device',data);
 if(command==='worker-retry-local')return localApi(dir,'worker/retry-local',data);
 if(command==='worker-configure')return localApi(dir,'worker/configure',data);
 if(command==='worker-run')return localApi(dir,'worker/run',{});
 if(command==='candidates')return localApi(dir,'candidates?'+new URLSearchParams(data));
 if(command==='replies')return localApi(dir,'replies?'+new URLSearchParams(data));
 if(command==='jobs')return localApi(dir,'jobs?'+new URLSearchParams(data));
 if(command==='enqueue'){if(role!=='hub')throw Error('只有总控可下发任务');return localApi(dir,'jobs/enqueue',data);}
 if(command==='report')return localApi(dir,'report?'+new URLSearchParams(data));
 if(command==='policy'||command==='capture'||command==='sync'){
  if(role!=='collector')throw Error('此命令仅用于分控');
  const value=await localApi(dir,command,data);if(value.error)throw Error(value.error);return value;
 }
 throw Error('不支持的管理命令');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts={};try{for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--command','--role','--dir','--input','--output','--records'].includes(key)||!process.argv[i+1])throw Error('管理参数无效');opts[key.slice(2)]=process.argv[i+1];}
  console.log(JSON.stringify(await admin(opts)));}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
}
