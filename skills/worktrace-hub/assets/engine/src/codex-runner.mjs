import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,isAbsolute,basename} from 'node:path';
import {createInterface} from 'node:readline';
import {assert} from './protocol.mjs';
// Runs the installed CLI using its own login. No credentials are copied and no
// user MCP, desktop controls, shell, plugins, hooks or unrelated skills load.
export function codexArgs({cwd,schemaFile,outputFile,model,reasoningEffort='xhigh',images=[]}){
 const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--cd',cwd,'--json','--output-schema',schemaFile,'--output-last-message',outputFile,'-c','web_search="disabled"','-c','approval_policy="never"','-c','model_reasoning_effort='+JSON.stringify(reasoningEffort)];
 for(const f of ['shell_tool','unified_exec','apps','plugins','hooks','plugin_hooks','browser_use','browser_use_external','computer_use','multi_agent','multi_agent_v2','image_generation','memories','skill_search','workspace_dependencies','view_image'])args.push('--disable',f);
 args.push('--enable','skip_host_skill_discovery');if(model)args.push('--model',model);for(const img of images)args.push('--image',img);args.push('-');return args;
}
export async function runCodex({executable,dir,prompt,schema,model='',reasoningEffort='xhigh',timeoutSeconds=300,images=[],signal}){
 assert(isAbsolute(executable)&&basename(executable).toLowerCase()==='codex.exe'&&existsSync(executable),'请配置本机已登录 Codex CLI 的 codex.exe 绝对路径');
 assert(timeoutSeconds>=30&&timeoutSeconds<=900&&images.length<=6,'模型执行预算无效');mkdirSync(dir,{recursive:true});const outputFile=join(dir,'result.json'),schemaFile=join(dir,'schema.json');writeFileSync(schemaFile,JSON.stringify(schema));
 // Unique run directories prevent a previous successful output being mistaken
 // for the result of an interrupted call.
 assert(!existsSync(outputFile),'模型输出路径已存在，禁止重复执行');
 const env={...process.env,TEMP:process.env.TEMP||join(dir,'temp'),TMP:process.env.TMP||join(dir,'temp'),TMPDIR:process.env.TMPDIR||join(dir,'temp')};
 delete env.CODEX_THREAD_ID;delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;delete env.CODEX_APP_TOOLS_PIPE_PATH;
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,codexArgs({cwd:dir,schemaFile,outputFile,model,reasoningEffort,images}),{cwd:dir,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let bytes=0,error='',usage=null,blocked='';
  const stop=reason=>{blocked=reason;child.kill();};const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>stop('model_timeout_result_uncertain'),timeoutSeconds*1000);
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{bytes+=Buffer.byteLength(line);if(bytes>2*1024*1024){stop('model_output_limit');return;}try{const e=JSON.parse(line);if(e.type==='turn.completed')usage=e.usage||null;const kind=e.item?.type;if(kind==='error'||e.type==='error'||e.type==='turn.failed')error=String(e.item?.message||e.message||e.error?.message||'model_turn_failed').slice(-3000);if(kind&&!['agent_message','reasoning','todo_list','error'].includes(kind))stop('unexpected_tool_attempt:'+kind);}catch{}});
  child.stderr.on('data',b=>{error=(error+b.toString()).slice(-3000);});child.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);lines.close();reject(e);});
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);lines.close();if(blocked||code!==0){reject(Error(blocked||('codex_failed: '+error)));return;}try{const result=JSON.parse(readFileSync(outputFile,'utf8'));resolve({result,usage});}catch{reject(Error('invalid_or_missing_structured_output'));}});
  child.stdin.on('error',()=>{});child.stdin.end(prompt);
 });
}
