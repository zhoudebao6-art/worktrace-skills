import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {networkInterfaces} from 'node:os';
import {parseConnectionLink,validateConnection,prepareLanRequest,enrollFromLan,requestLanEnrollment,validateLanEnrollment} from '../src/lan-join-client.mjs';

const tempRoot=resolve(process.env.TEMP||'../../work','worktrace-tests');mkdirSync(tempRoot,{recursive:true});
const token=()=>randomBytes(32).toString('base64url');
const identity={employee_id:'SYNTHETIC_LAN_01',employee_name:'局域网合成员工',label:'局域网合成电脑'};
const privateIP=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal&&/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(i.address))?.address;
assert(privateIP,'LAN client verification requires a private IPv4 interface');
let certificate;
function fixture(t){
 const dir=mkdtempSync(join(tempRoot,'lan-client-'));t.after(()=>{if(resolve(dir).startsWith(tempRoot+'\\')||resolve(dir).startsWith(tempRoot+'/'))rmSync(dir,{recursive:true,force:true});});
 if(!certificate){
  const certDir=mkdtempSync(join(tempRoot,'lan-client-cert-')),password=token(),spec=join(certDir,'request.json');writeFileSync(spec,JSON.stringify({addresses:[privateIP],pfx:join(certDir,'hub.pfx'),pem:join(certDir,'hub.pem'),password}));
  const run=spawnSync(process.env.WORKTRACE_POWERSHELL||'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('bridge/certificate.ps1'),'-Spec',spec],{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,'合成 TLS 证书生成失败');
  certificate={pfx:readFileSync(join(certDir,'hub.pfx')),pem:readFileSync(join(certDir,'hub.pem'),'utf8'),password};rmSync(certDir,{recursive:true,force:true});
 }
 const connection={format:'worktrace.lan-link/1.0',org_id:randomUUID(),org_name:'SYNTHETIC LAN ONLY',hub_url:`https://${privateIP}:19221`,ca_pem:certificate.pem};
 return {dir,connection,statePath:join(dir,'request.json')};
}
function link(connection){return 'https://github.com/zhoudebao6-art/worktrace-skills/tree/main#worktrace-join=v1.'+Buffer.from(JSON.stringify(connection)).toString('base64url');}
function enrollment(connection,request){return {format:'worktrace.enrollment/1.0',org_id:connection.org_id,org_name:connection.org_name,device_id:randomUUID(),employee_id:request.employee_id,employee_name:request.employee_name,label:request.label,hub_url:request.hub_url,ca_pem:connection.ca_pem,device_token:request.device_token};}
async function serve(t,handler){const server=https.createServer({pfx:certificate.pfx,passphrase:certificate.password},handler);await new Promise(ok=>server.listen(0,privateIP,ok));t.after(()=>new Promise(ok=>server.close(ok)));return `https://${privateIP}:`+server.address().port;}

test('公司技能链接严格固定 repository、fragment 版本及公开字段',t=>{
 const f=fixture(t),valid=link(f.connection);assert.deepEqual(parseConnectionLink(valid),f.connection);assert.equal(validateConnection(f.connection),f.connection);
 for(const bad of [valid.replace('github.com','github.com.evil.invalid'),valid.replace('/tree/main','/tree/other'),valid.replace('#worktrace-join=v1.','?worktrace-join=v1.'),valid.replace('https:','http:'),valid+'=',valid+'&extra=1',valid.replace('v1.','v2.'),'https://github.com/zhoudebao6-art/worktrace-skills/tree/main'])assert.throws(()=>parseConnectionLink(bad));
 for(const change of [{ca_pem:'not a certificate'},{ca_pem:certificate.pem+certificate.pem},{device_token:token()},{org_name:' trailing '},{hub_url:'https://127.0.0.1:19221/'},{hub_url:'https://u:p@host'},{hub_url:'https://8.8.8.8:19221'},{hub_url:'https://127.0.0.1:19221'},{hub_url:'https://192.168.254.254:19221'},{format:'worktrace.invitation/1.0'}])assert.throws(()=>parseConnectionLink(link({...f.connection,...change})));
 assert(!JSON.stringify(f.connection).includes('device_token'));assert(!JSON.stringify(f.connection).includes('request_secret'));
});

test('接入前原子保存两个独立密钥，重试不能更换身份、证书或地址',t=>{
 const f=fixture(t),args={...f,identity},first=prepareLanRequest(args);assert.deepEqual(prepareLanRequest(args),first);
 assert.match(first.request_secret,/^[A-Za-z0-9_-]{43}$/);assert.match(first.device_token,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(first.request_secret,first.device_token);
 const original=readFileSync(f.statePath);for(const args2 of [{...args,identity:{...identity,label:'OTHER'}},{...args,connection:{...f.connection,ca_pem:certificate.pem+' '}},{...args,connection:{...f.connection,hub_url:`https://${privateIP}:19222`}}])assert.throws(()=>prepareLanRequest(args2),/不一致/);assert.deepEqual(readFileSync(f.statePath),original);
 writeFileSync(f.statePath,'{"partial":');assert.throws(()=>prepareLanRequest(args),/原文件已保留/);
});

test('公司 CA 验证后登记，重复接入复用凭据并保留本地运行身份',async t=>{
 const f=fixture(t);let calls=0;f.connection.hub_url=await serve(t,async(req,res)=>{
  calls++;assert.equal(req.url,'/v1/lan/enroll');assert.equal(req.method,'POST');const chunks=[];for await(const part of req)chunks.push(part);const request=JSON.parse(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(request).sort(),['org_id','request_id','request_secret','device_token','employee_id','employee_name','label','hub_url'].sort());assert.equal(request.org_id,f.connection.org_id);assert.notEqual(request.request_secret,request.device_token);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(enrollment(f.connection,request)));
 });
 const outputPath=join(f.dir,'enrollment.json'),workDir=join(f.dir,'collector'),args={connectionLink:link(f.connection),statePath:f.statePath,outputPath,workDir,...identity};
 const result=await enrollFromLan(args);assert.equal(result.employee_id,identity.employee_id);assert.equal(calls,1);assert(!JSON.stringify(result).includes('device_token'));assert(!JSON.stringify(result).includes('request_secret'));
 assert.deepEqual(await enrollFromLan(args),result);assert.equal(calls,1);
 const stored=JSON.parse(readFileSync(outputPath,'utf8'));mkdirSync(join(workDir,'data'),{recursive:true});writeFileSync(join(workDir,'data','config.json'),JSON.stringify({...stored,role:'collector',connection_mode:'hub'}));
 assert.deepEqual(await enrollFromLan(args),result);assert.equal(calls,1);await assert.rejects(()=>enrollFromLan({...args,employee_name:'OTHER'}),/未修改/);
});

test('丢失响应原样重试，远程错误正文不泄密，重定向及凭据被替换均拒绝',async t=>{
 const f=fixture(t);let mode='reject';const received=[];
 f.connection.hub_url=await serve(t,async(req,res)=>{const chunks=[];for await(const part of req)chunks.push(part);const request=JSON.parse(Buffer.concat(chunks));received.push(request);
  if(mode==='reject'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'SECRET '+request.request_secret+' '+request.device_token}));return;}
  if(mode==='redirect'){res.writeHead(302,{location:'https://example.invalid'});res.end();return;}
  const value=enrollment(f.connection,request);if(mode==='wrong')value.device_token=token();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 });
 const args={connectionLink:link(f.connection),statePath:f.statePath,outputPath:join(f.dir,'enrollment.json'),...identity};
 await assert.rejects(()=>enrollFromLan(args),error=>/来源网络/.test(error.message)&&!error.message.includes('SECRET')&&!error.message.includes(received[0].device_token));assert(!existsSync(args.outputPath));
 mode='redirect';await assert.rejects(()=>enrollFromLan(args),/不会跟随重定向/);mode='wrong';await assert.rejects(()=>enrollFromLan(args),/不一致/);mode='good';await enrollFromLan(args);
 assert(received.every(r=>r.request_id===received[0].request_id&&r.request_secret===received[0].request_secret&&r.device_token===received[0].device_token));
 for(const change of [{org_id:randomUUID()},{org_name:'OTHER'},{ca_pem:certificate.pem+' '},{employee_id:'OTHER'},{hub_url:'https://other.invalid'},{device_token:token()}])assert.throws(()=>validateLanEnrollment({...enrollment(f.connection,received[0]),...change},f.connection,received[0]));
});

test('其他公司证书失败及旧 hub、offline、残留数据均在登记前拒绝',async t=>{
 const f=fixture(t);let calls=0;f.connection.hub_url=await serve(t,(_,res)=>{calls++;res.end();});const request=prepareLanRequest({...f,identity});
 const original=f.connection;const spec=join(f.dir,'other-cert.json'),password=token();writeFileSync(spec,JSON.stringify({addresses:[privateIP],pfx:join(f.dir,'other.pfx'),pem:join(f.dir,'other.pem'),password}));
 const run=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('bridge/certificate.ps1'),'-Spec',spec],{windowsHide:true,encoding:'utf8'});assert.equal(run.status,0);
 await assert.rejects(()=>requestLanEnrollment({...original,ca_pem:readFileSync(join(f.dir,'other.pem'),'utf8')},request),/公司证书验证/);assert.equal(calls,0);
 const workDir=join(f.dir,'collector'),args={connectionLink:link(f.connection),statePath:f.statePath,outputPath:join(f.dir,'enrollment.json'),workDir,...identity};mkdirSync(join(workDir,'data'),{recursive:true});
 for(const change of [{role:'hub'},{role:'collector',connection_mode:'offline'},{role:'collector',org_id:randomUUID()}]){writeFileSync(join(workDir,'data','config.json'),JSON.stringify({...f.connection,...identity,...change}));await assert.rejects(()=>enrollFromLan(args),/未修改/);}
 const orphan=join(f.dir,'orphan');mkdirSync(join(orphan,'data'),{recursive:true});writeFileSync(join(orphan,'data','worktrace.sqlite'),'placeholder');await assert.rejects(()=>enrollFromLan({...args,workDir:orphan}),/缺少身份配置/);assert.equal(calls,0);
});

test('接入状态拒绝 junction 且不写入外部目标',t=>{
 const f=fixture(t),target=join(f.dir,'target'),junction=join(f.dir,'link');mkdirSync(target);symlinkSync(target,junction,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>prepareLanRequest({connection:f.connection,identity,statePath:join(junction,'request.json')}),/junction/);assert(!existsSync(join(target,'request.json')));
});

// Exercise the real Windows PowerShell wrapper and TLS client with a hashed
// synthetic source. Service/startup operations are stubs: no HKCU Run, desktop
// observation, MCP registration, or real employee service is touched.
function wrapperFixture(t){
 const f=fixture(t),source=join(f.dir,'source'),workDir=join(f.dir,'collector'),skillsDir=join(f.dir,'skills'),log=join(f.dir,'calls.jsonl');
 const put=(path,value)=>{const file=join(source,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,value);};
 for(const path of ['scripts/Join-Lan.ps1','scripts/provision-common.ps1','src/lan-join-client.mjs','src/invite-client.mjs'])put(path,readFileSync(resolve(path)));
 put('scripts/Join-Node.ps1',"throw 'Legacy Join-Node must not be replayed.'\r\n");
 put('scripts/Ensure-Runtime.ps1',`param([string]$Root,[string]$Candidate)\r\nNew-Item -ItemType Directory -Path (Join-Path $Root 'runtime') -Force|Out-Null\r\n$target=Join-Path $Root 'runtime\\node.exe'\r\nif(!(Test-Path -LiteralPath $target)){try{New-Item -ItemType HardLink -Path $target -Target '${process.execPath.replaceAll("'","''")}'|Out-Null}catch{Copy-Item -LiteralPath '${process.execPath.replaceAll("'","''")}' -Destination $target}}\r\n`);
 put('Start.ps1',"param([switch]$NoBrowser)\r\n");
 put('scripts/Connect-Node.ps1',`param([string]$WorkDir,[string]$SkillsDirectory,[switch]$SkipMcp,[switch]$SkipLogonStartup)
@{command='connect';root=$WorkDir;skip_mcp=$SkipMcp.IsPresent;skip_logon_startup=$SkipLogonStartup.IsPresent}|ConvertTo-Json -Compress|Add-Content -LiteralPath $env:WORKTRACE_LAN_WRAPPER_LOG -Encoding UTF8
$connectionStatus='connected';if($env:WORKTRACE_LAN_WRAPPER_STATUS){$connectionStatus=$env:WORKTRACE_LAN_WRAPPER_STATUS}
@{format='worktrace.connection/1.0';status=$connectionStatus}|ConvertTo-Json -Compress
`);
 put('src/admin-cli.mjs',`import {existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,item,index,all)=>index%2?rows:[...rows,[item,all[index+1]]],[]));
const file=join(args['--dir'],'config.json'),command=args['--command'];appendFileSync(process.env.WORKTRACE_LAN_WRAPPER_LOG,JSON.stringify({command})+'\\n');
const read=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\\uFEFF/,''));let config=existsSync(file)?read(file):null;
if(command==='init'){config={...read(args['--input']),role:'collector',connection_mode:'hub'};writeFileSync(file,JSON.stringify(config));}
if(command==='capture'){config.collection_enabled=true;writeFileSync(file,JSON.stringify(config));}
console.log(JSON.stringify(command==='status'?(config?{...config,configured:true,collection:{enabled:config.collection_enabled||false},sync:{last_success:'2026-01-01T00:00:00.000Z',error:null},worker:{policy:{model:'gpt-6.1-sol',reasoning_effort:'xhigh'}}}:{configured:false}):{ok:true}));
`);
 const paths=['scripts/Join-Lan.ps1','scripts/Connect-Node.ps1','scripts/Join-Node.ps1','scripts/provision-common.ps1','scripts/Ensure-Runtime.ps1','src/lan-join-client.mjs','src/invite-client.mjs','src/admin-cli.mjs','Start.ps1'];
 const files=paths.map(path=>{const bytes=readFileSync(join(source,path));return {path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
 put('engine-manifest.json',JSON.stringify({format:'worktrace.source/1.0',files}));
 const run=(extra=[],environment={})=>new Promise((accept,reject)=>{
  const child=spawn(process.env.WORKTRACE_POWERSHELL||'powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(source,'scripts/Join-Lan.ps1'),'-WorkDir',workDir,'-SkillsDirectory',skillsDir,'-SkipMcp',...extra],{env:{...process.env,WORKTRACE_LAN_WRAPPER_LOG:log,...environment},windowsHide:true});
  let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);child.on('error',reject);child.on('close',status=>accept({status,output}));
 });
 const calls=()=>existsSync(log)?readFileSync(log,'utf8').split(/\r?\n/).filter(Boolean).map(row=>JSON.parse(row.replace(/^\uFEFF/,''))):[];
 const saveConfig=(changes={})=>{const value={...enrollment(f.connection,{...identity,hub_url:f.connection.hub_url,device_token:token()}),role:'collector',connection_mode:'hub',...changes};mkdirSync(join(workDir,'data'),{recursive:true});writeFileSync(join(workDir,'data/config.json'),JSON.stringify(value));return value;};
 return {...f,source,workDir,skillsDir,log,run,calls,saveConfig};
}

for(const effort of ['high','xhigh'])test('Join-Lan 已有 '+effort+' 联网身份无需链接或旧登记文件，不重放旧源码和采集参数',async t=>{
 const f=wrapperFixture(t);f.saveConfig({collection_enabled:false,worker_paused:true,worker_policy:{reasoning_effort:effort}});const config=join(f.workDir,'data/config.json'),before=readFileSync(config);
 mkdirSync(join(f.workDir,'scripts'),{recursive:true});writeFileSync(join(f.workDir,'scripts/Join-Lan.ps1'),'synthetic newer deployed version');
 mkdirSync(join(f.workDir,'setup/lan-enrollment'),{recursive:true});writeFileSync(join(f.workDir,'setup/lan-enrollment/join.json'),JSON.stringify({start_capture:true,enable_logon_startup:true}));
 const resumed=await f.run(['-StartCapture','-SkipLogonStartup']);assert.equal(resumed.status,0,resumed.output);assert.deepEqual(readFileSync(config),before);
 assert.deepEqual(f.calls().map(row=>row.command),['connect']);assert.equal(f.calls()[0].skip_logon_startup,true);assert.equal(f.calls()[0].skip_mcp,true);
 assert.equal(readFileSync(join(f.workDir,'scripts/Join-Lan.ps1'),'utf8'),'synthetic newer deployed version');assert(!existsSync(join(f.workDir,'setup/lan-enrollment/request.json')));
 const same=await f.run(['-ConnectionLink',link(f.connection),'-EmployeeId',identity.employee_id,'-SkipLogonStartup']);assert.equal(same.status,0,same.output);
});

test('Join-Lan 首装缺失字段明确拒绝，已有身份、公司、证书冲突均在启动前拒绝',async t=>{
 const f=wrapperFixture(t);let result=await f.run(['-SkipLogonStartup']);assert.notEqual(result.status,0);assert.match(result.output,/ConnectionLink/);assert(!existsSync(f.workDir));
 result=await f.run(['-ConnectionLink',link(f.connection),'-SkipLogonStartup']);assert.notEqual(result.status,0);assert.match(result.output,/EmployeeId/);assert(!existsSync(f.workDir));
 f.saveConfig();const config=join(f.workDir,'data/config.json'),before=readFileSync(config);
 for(const extra of [['-EmployeeId','OTHER'],['-EmployeeName','OTHER'],['-ComputerLabel','OTHER'],['-ConnectionLink',link({...f.connection,org_id:randomUUID()})],['-ConnectionLink',link({...f.connection,hub_url:`https://${privateIP}:19222`})],['-ConnectionLink',link({...f.connection,ca_pem:f.connection.ca_pem+' '})]]){
  result=await f.run([...extra,'-SkipLogonStartup']);assert.notEqual(result.status,0);assert.deepEqual(readFileSync(config),before);assert.equal(f.calls().length,0);
 }
 f.saveConfig({connection_mode:'offline'});result=await f.run(['-SkipLogonStartup']);assert.notEqual(result.status,0);assert.equal(f.calls().length,0);
});

test('Join-Lan 丢失登记响应后无链接重试原请求，已部署后离网不再 enroll',async t=>{
 const f=wrapperFixture(t),received=[];let accept=false;
 f.connection.hub_url=await serve(t,async(req,res)=>{const chunks=[];for await(const part of req)chunks.push(part);const request=JSON.parse(Buffer.concat(chunks));received.push(request);res.writeHead(accept?200:401,{'content-type':'application/json'});res.end(JSON.stringify(accept?enrollment(f.connection,request):{error:'synthetic failure'}));});
 const first=await f.run(['-ConnectionLink',link(f.connection),'-EmployeeId',identity.employee_id,'-EmployeeName',identity.employee_name,'-ComputerLabel',identity.label,'-SkipLogonStartup']);assert.notEqual(first.status,0);assert.equal(received.length,1);
 const state=join(f.workDir,'setup/lan-enrollment/request.json'),before=readFileSync(state);accept=true;
 const retried=await f.run(['-SkipLogonStartup'],{WORKTRACE_LAN_WRAPPER_STATUS:'retrying'});assert.equal(retried.status,0,retried.output);assert.match(retried.output,/后台重试/);assert.equal(received.length,2);assert.deepEqual(received[1],received[0]);assert.deepEqual(readFileSync(state),before);
 const config=join(f.workDir,'data/config.json'),saved=readFileSync(config);accept=false;const priorCalls=f.calls().length;
 const resumed=await f.run(['-StartCapture','-SkipLogonStartup']);assert.equal(resumed.status,0,resumed.output);assert.equal(received.length,2);assert.deepEqual(readFileSync(config),saved);assert.deepEqual(f.calls().slice(priorCalls).map(row=>row.command),['connect']);
});

test('Join-Lan 新接入默认登录启动，历史启停参数不要求原样重传且明确 skip 生效',async t=>{
 const f=wrapperFixture(t);let enrolls=0;f.connection.hub_url=await serve(t,async(req,res)=>{enrolls++;const chunks=[];for await(const part of req)chunks.push(part);const request=JSON.parse(Buffer.concat(chunks));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(enrollment(f.connection,request)));});
 // The connection helper is a stub, so checking the default cannot write Run.
 const first=await f.run(['-ConnectionLink',link(f.connection),'-EmployeeId',identity.employee_id,'-EmployeeName',identity.employee_name,'-ComputerLabel',identity.label]);assert.equal(first.status,0,first.output);
 const settings=join(f.workDir,'setup/lan-enrollment/join.json'),prior=readFileSync(settings);assert.equal(JSON.parse(prior).enable_logon_startup,true);assert.equal(f.calls().find(row=>row.command==='connect').skip_logon_startup,false);
 // Simulate interruption immediately before initialization, retaining the exact
 // request, enrollment and historical settings in the private setup directory.
 rmSync(join(f.workDir,'data/config.json'));const calls=f.calls().length;
 const retry=await f.run(['-StartCapture','-SkipLogonStartup'],{WORKTRACE_LAN_WRAPPER_STATUS:'action_required'});assert.equal(retry.status,0,retry.output);assert.match(retry.output,/心跳尚未通过/);assert.doesNotMatch(retry.output,/心跳验证通过/);assert.equal(enrolls,1);assert.deepEqual(readFileSync(settings),prior);
 const newCalls=f.calls().slice(calls);assert(!newCalls.some(row=>row.command==='capture'));assert.equal(newCalls.find(row=>row.command==='connect').skip_logon_startup,true);
});
