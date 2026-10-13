import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {localApi} from './local-api.mjs';
import {inspectOfflineHandoff,restoreOfflineHandoff} from './offline-handoff.mjs';
import {assert} from './protocol.mjs';

// Secrets arrive on stdin from a local SecureString prompt, never in argv/files.
export async function handoffCommand({action,dir,input,output,destination,finish_pilot=false},password){
 assert(['Export','Inspect','Restore','Recover','Import'].includes(action),'移交操作无效');
 if(action==='Export')return localApi(dir,'handoff/export',{output,password,finish_pilot},{timeout:30*60*1000});
 if(action==='Import')return localApi(dir,'handoff/import',{input,password},{timeout:30*60*1000});
 if(action==='Inspect'){
  const result=await inspectOfflineHandoff({input,password});
  if(output)writeFileSync(resolve(output),JSON.stringify(result.manifest.identity,null,2),{flag:'wx',mode:0o600});
  return {valid:result.valid,identity:result.manifest.identity,counts:result.manifest.counts,time_range:result.manifest.time_range,source:result.manifest.source,...(output?{identity_saved:resolve(output)}:{})};
 }
 return restoreOfflineHandoff({input,password,directory:destination,resumeConfig:action==='Recover'});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options={};for(let i=2;i<process.argv.length;i+=2){assert(['--action','--dir','--input','--output','--destination','--finish-pilot'].includes(process.argv[i])&&process.argv[i+1],'移交参数无效');options[process.argv[i].slice(2).replaceAll('-','_')]=process.argv[i+1];}options.finish_pilot=options.finish_pilot==='true';let secret='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin){secret+=chunk.toString('utf8');assert(secret.length<=4096,'密码输入过大');}const data=JSON.parse(secret.replace(/^\uFEFF/,''));console.log(JSON.stringify(await handoffCommand(options,data.password)));}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
}
