import {WechatCollector} from './wechat-collector.mjs';
import {listWechatChats,readWechatChat} from './wechat-store.mjs';
import {readiness} from './readiness.mjs';
import {personalDigest} from './personal-digest.mjs';
import {acquireRuntimeLock,acquireIdentityLock,RuntimeTasks} from './runtime-lifecycle.mjs';
import {initInvitations,createInvitation,listInvitations,revokeInvitation,redeemInvitation,createEnrollmentLimiter,readEnrollmentBody} from './invitations.mjs';
import {initLanJoin,configureLanJoin,lanJoinStatus,createLanJoinLink,assertLanJoinAllowed,enrollLanDevice} from './lan-join.mjs';
import {createOfflineHandoff,importOfflineHandoff} from './offline-handoff.mjs';
import {createOfflineIdentity,validateAdoptionIdentity,adoptOfflineDevice} from './offline-identity.mjs';
import {FileEvidenceCollector} from './file-evidence.mjs';
import {replyToJob,pendingReplies,acceptReplies,ackReplies,listReplies} from './messages.mjs';
import {candidateList,candidateEvaluate,candidateEvaluationHistory,candidateRevise,candidateRevisionHistory} from './candidates.mjs';
import {knowledgeSearch,knowledgeRead} from './knowledge.mjs';
import {normalizeExternalRecords,importExternalRecords} from './external-records.mjs';
import http from 'node:http';
import https from 'node:https';
import { readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,unlinkSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces,hostname } from 'node:os';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from './store.mjs';
import { Collector,defaultPolicy,validatePolicy } from './collector.mjs';
import { uuid,hash,assert,str,id,keys,SOFTWARE_VERSION,MAX_BATCH,sealBundle,openBundle } from './protocol.mjs';
import { tasks,addWork } from './work.mjs';
import { report } from './report.mjs';
import {LearningWorker} from './worker.mjs';
import {enqueueJob,listJobs,outgoingJobs,receiveJobs,pendingReceipts,acceptReceipts,ackReceipts,transitionJob,job} from './jobs.mjs';
import { nextAnalysis,saveAnalysis,analysisHistory } from './analysis.mjs';
import {nextPersonal,savePersonal,personalHistory,requestLearning,requestsFor,receiveRequests,settleRequests,learningStatus} from './learning.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function ips(){return [...new Set(['127.0.0.1',...Object.values(networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal).map(x=>x.address)])];}
const secret=()=>randomBytes(32).toString('base64url');
const safeEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function atomicJSON(file,obj){writeFileSync(file+'.tmp',JSON.stringify(obj,null,2),{mode:0o600});renameSync(file+'.tmp',file);}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req,max=14*1024*1024){let n=0;const chunks=[];for await(const c of req){n+=c.length;assert(n<=max,'请求体过大');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function postSync(config,payload,{signal}={}){return new Promise((resolve,reject)=>{
 const u=new URL('/v1/sync',config.hub_url);assert(u.protocol==='https:','同步必须使用 HTTPS');const data=Buffer.from(JSON.stringify(payload));
 let settled=false,timer;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
 const r=https.request(u,{method:'POST',ca:config.ca_pem,signal,headers:{'Content-Type':'application/json','Content-Length':data.length,'Authorization':'Bearer '+config.device_token,'X-Worktrace-Device':config.device_id}},res=>{
  let n=0;const parts=[];
  res.on('data',b=>{n+=b.length;if(n>1024*1024){r.destroy(new Error('响应过大'));return;}parts.push(b);});
  res.once('aborted',()=>finish(new Error('同步响应中断，保留待重传')));res.once('error',error=>finish(error));
  res.on('end',()=>{try{const v=JSON.parse(Buffer.concat(parts));if(res.statusCode!==200)throw Error(v.error||'同步被拒绝');finish(null,v);}catch(error){finish(error);}});
 });
 r.once('error',error=>finish(error));timer=setTimeout(()=>r.destroy(new Error('连接管理端超时')),15000);timer.unref();r.end(data);
});}
export async function startApp({dir=process.env.WORKTRACE_DATA||join(root,'data'),port=Number(process.env.WORKTRACE_PORT||19220),open=false,workerRunner,syncTransport=postSync}={}){
 assert(!existsSync(join(dir,'REVIEW-ONLY.json')),'此目录仅供审阅，禁止初始化或启动为活跃分控；原主机使用显式 Recover 恢复入口');mkdirSync(dir,{recursive:true});const releaseDirectory=acquireRuntimeLock(dir),runtimeTasks=new RuntimeTasks(),cfgFile=join(dir,'config.json');
 let store,config=null,server,releaseIdentity=null,closing=false,closePromise=null,runningUrl=null,setupInProgress=false;
 const token=secret();let collector=null,hub=null,syncing=false,lastSync=null,lastError='',timer,workerTimer,worker=null,fileCollector=null,fileTimer=null,wechatCollector=null,wechatTimer=null,handoffBusy=false,syncController=null;
 try{
 config=existsSync(cfgFile)?JSON.parse(readFileSync(cfgFile,'utf8')):null;assert(!config||['hub','collector'].includes(config.role),'配置角色无效，请恢复原配置而非重新初始化');
 if(config?.role==='collector'){assert(config.host_binding===hash(config.org_id+':'+hostname()),'此运行数据目录属于另一台电脑，请用独立登记文件重新配置');releaseIdentity=await acquireIdentityLock(config);}
 store=new Store(join(dir,'worktrace.sqlite'));
 function persistCollector(c,action){
  store.db.exec('SAVEPOINT collector_setup');let configWritten=false;
  try{store.addDevice(c);store.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(c.installation_id,c.device_id);store.audit(action,c.device_id);atomicJSON(cfgFile,c);configWritten=true;store.db.exec('RELEASE SAVEPOINT collector_setup');config=c;}
  catch(error){store.db.exec('ROLLBACK TO SAVEPOINT collector_setup');store.db.exec('RELEASE SAVEPOINT collector_setup');if(configWritten)unlinkSync(cfgFile);throw error;}
 }
 function attachWorker(){if(!worker)worker=new LearningWorker({store,config,dir,...(workerRunner?{runner:workerRunner}:{})});}
 function attachCollector(){assert(config.host_binding===hash(config.org_id+':'+hostname()),'此运行数据目录属于另一台电脑，请用独立登记文件重新配置');collector=new Collector({store,config,dir,root,onStateChange:state=>{fileCollector?.invalidate();wechatCollector?.globalState(state.enabled);},onError:m=>{lastError=m;}});fileCollector=new FileEvidenceCollector({store,config,dir,root,isActive:()=>!!collector?.enabled});wechatCollector=new WechatCollector({store,config,dir,getCollector:()=>collector,isActive:()=>!closing&&!handoffBusy});}
 async function listenHub(){if(hub||config?.role!=='hub')return;initInvitations(store);initLanJoin(store);const allowEnrollment=createEnrollmentLimiter(),allowLanEnrollment=createEnrollmentLimiter();hub=https.createServer({pfx:readFileSync(join(dir,'hub.pfx')),passphrase:config.cert_password},async(req,res)=>{
  try{assert(!closing,'service_stopping');
   if(req.url==='/v1/lan/enroll'){
    if(!allowLanEnrollment(req.socket.remoteAddress||'unknown')){res.setHeader('Retry-After','60');const error=new Error('接入请求过于频繁，请稍后重试');error.status=429;throw error;}
    assert(req.method==='POST','接入接口仅接受 POST');assertLanJoinAllowed(store,config,req.socket.remoteAddress);const input=await readEnrollmentBody(req);assert(!closing,'service_stopping');const enrollment=enrollLanDevice(store,config,input,{remoteAddress:req.socket.remoteAddress});json(res,200,enrollment);return;
   }
   if(req.url==='/v1/enroll'){
    if(!allowEnrollment(req.socket.remoteAddress||'unknown')){res.setHeader('Retry-After','60');const error=new Error('接入请求过于频繁，请稍后重试');error.status=429;throw error;}
    assert(req.method==='POST','接入接口仅接受 POST');const input=await readEnrollmentBody(req);assert(!closing,'service_stopping');const enrollment=redeemInvitation(store,config,input);json(res,200,enrollment);return;
   }
   assert(req.method==='POST'&&req.url==='/v1/sync','仅提供同步接口');const deviceId=req.headers['x-worktrace-device'];assert(id(deviceId),'设备认证失败');let device=store.device(deviceId);assert(device&&!device.revoked&&safeEqual(device.token_hash,hash(String(req.headers.authorization||'').replace(/^Bearer /,''))),'设备认证失败');const b=await body(req);assert(!closing,'service_stopping');device=store.device(req.headers['x-worktrace-device']);assert(device&&!device.revoked&&safeEqual(device.token_hash,hash(String(req.headers.authorization||'').replace(/^Bearer /,''))),'设备认证失败');assert(b.org_id===config.org_id&&b.device_id===device.device_id&&id(b.installation_id),'设备信息不匹配');assert(!device.installation_id||device.installation_id===b.installation_id,'登记文件已用于另一安装，请单独登记设备');assert(Array.isArray(b.events)&&b.events.length<=MAX_BATCH,'单批最多 50 条事件');assert(Array.isArray(b.policies),'缺少策略');for(const p of b.policies)validatePolicy(p.value);
   store.db.exec('SAVEPOINT sync_request');try{const result=store.ingest(b.events,b.assets,config.org_id,device.device_id,b.policies,b.files||[]);const jobAcks=acceptReceipts(store,device.device_id,b.job_receipts||[]);const replyAcks=acceptReplies(store,device.device_id,b.replies||[]);store.db.prepare('UPDATE devices SET installation_id=?,last_seen=?,last_error=NULL WHERE device_id=?').run(b.installation_id,new Date().toISOString(),device.device_id);settleRequests(store,b.events);const response={...result,event_ids:b.events.map(e=>e.event_id),learning_requests:requestsFor(store,device.device_id),jobs:outgoingJobs(store,device.device_id),job_acks:jobAcks,reply_acks:replyAcks,server_time:new Date().toISOString()};store.db.exec('RELEASE SAVEPOINT sync_request');json(res,200,response);}catch(error){store.db.exec('ROLLBACK TO SAVEPOINT sync_request');store.db.exec('RELEASE SAVEPOINT sync_request');throw error;}
  }catch(e){if(req.url==='/v1/enroll'||req.url==='/v1/lan/enroll')res.setHeader('Connection','close');json(res,[400,401,409,413,429].includes(e.status)?e.status:400,{error:e.message});}
 });hub.requestTimeout=30000;hub.headersTimeout=10000;await new Promise((ok,no)=>{hub.once('error',no);hub.listen(config.hub_port,config.listen_host||'0.0.0.0',ok);});}
 function synchronize(){return runtimeTasks.run('sync',syncOnce);}
 async function syncOnce(){
  if(closing)return {skipped:true,reason:'service_stopping'};if(handoffBusy)return {skipped:true,reason:'handoff_in_progress'};
  if(config?.connection_mode==='offline')return {skipped:true,mode:'offline',reason:'离线记录，等待人工移交'};
  if(!config||config.role!=='collector')return {skipped:true};syncing=true;syncController=new AbortController();
  try{let sent=0;for(let i=0;i<10;i++){
   const batch=store.batch(store.get('sync_cursor')||0,20);
   const r=await syncTransport(config,{org_id:config.org_id,device_id:config.device_id,installation_id:config.installation_id,job_receipts:pendingReceipts(store),replies:pendingReplies(store),...batch},{signal:syncController.signal});
   assert(!closing,'service_stopping');assert(Array.isArray(r.event_ids)&&r.event_ids.length===batch.events.length&&batch.events.every(e=>r.event_ids.includes(e.event_id)),'同步确认不完整，保留本地待重传');
   store.db.exec('SAVEPOINT sync_response');try{
    receiveRequests(store,config,r.learning_requests||[]);receiveJobs(store,config,r.jobs||[]);ackReceipts(store,r.job_acks||[]);ackReplies(store,r.reply_acks||[]);
    if(batch.events.length)store.set('sync_cursor',batch.events.at(-1).sequence);store.db.exec('RELEASE SAVEPOINT sync_response');
   }catch(error){store.db.exec('ROLLBACK TO SAVEPOINT sync_response');store.db.exec('RELEASE SAVEPOINT sync_response');throw error;}
   if(worker?.activeJob&&job(store,worker.activeJob)?.state==='cancelled')worker.controller?.abort();
   sent+=batch.events.length;lastSync=new Date().toISOString();lastError='';if(!batch.events.length||store.stats().pending===0)break;
  }return {sent};}catch(error){lastError=error.message;return {error:error.message};}finally{syncing=false;syncController=null;}
 }
 function status(){return {configured:!!config,runtime:runtimeTasks.snapshot(),role:config?.role||null,org_name:config?.org_name,org_id:config?.org_id,employee_id:config?.employee_id,employee_name:config?.employee_name,device_id:config?.device_id,hub_url:config?.hub_url,connection_mode:config?.connection_mode||(config?.role==='collector'?'hub':null),ips:config?.connection_mode==='offline'?['127.0.0.1']:ips(),stats:store.stats(),learning:learningStatus(store,config),worker:worker?.status()||null,devices:config?.role==='hub'?store.devices():[],collection:{enabled:!!collector?.enabled,state:collector?.state||'未启用采集',policy:collector?.policy||store.get('policy')||defaultPolicy,last_sample:collector?.lastSample||null},files:fileCollector?.status()||null,wechat:wechatCollector?.status()||null,sync:{mode:config?.connection_mode==='offline'?'offline':'network',state:config?.connection_mode==='offline'?'离线记录，等待人工移交':null,running:syncing,last_success:lastSync,error:lastError},protocol:'1.3',supported_protocols:['1.0','1.1','1.2','1.3'],version:SOFTWARE_VERSION};}
 server=http.createServer(async(req,res)=>{
  try{
   assert(!closing,'service_stopping');assert(['127.0.0.1','localhost'].includes(String(req.headers.host||'').split(':')[0]),'拒绝非本机管理请求');const u=new URL(req.url,'http://127.0.0.1');
   if(u.pathname==='/health'){json(res,200,{service:'worktrace',version:SOFTWARE_VERSION});return;}
   if(!u.pathname.startsWith('/api/')){const names={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const f=names[u.pathname];if(!f){json(res,404,{error:'不存在'});return;}res.writeHead(200,{'Content-Type':f.endsWith('.js')?'text/javascript; charset=utf-8':f.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(readFileSync(join(root,'public',f)));return;}
   assert(safeEqual(req.headers.authorization,'Bearer '+token),'管理授权失效，请从启动程序重新打开面板');if(req.headers.origin)assert(req.headers.origin===`http://127.0.0.1:${server.address().port}`||req.headers.origin===`http://localhost:${server.address().port}`,'拒绝跨来源请求');
   // The visible tray polls frequently and only needs live flags. Keep this
   // path independent of history counts, JSON parsing, job queues and blobs.
   if(req.method==='GET'&&u.pathname==='/api/status/brief'){json(res,200,{configured:!!config,runtime:runtimeTasks.snapshot(),role:config?.role||null,version:SOFTWARE_VERSION,collection:{enabled:!!collector?.enabled,state:collector?.state||'未启用采集',last_sample:collector?.lastSample||null},worker:{busy:!!worker?.busy},files:{busy:!!fileCollector?.busy},wechat:{busy:!!wechatCollector?.busy,enabled:!!wechatCollector?.policy.enabled}});return;}
   if(req.method==='GET'&&u.pathname==='/api/wechat/status'){json(res,200,wechatCollector?.status()||{state:'not_collector',source:'worktrace_database'});return;}
   if(req.method==='GET'&&u.pathname==='/api/wechat/list-chats'){json(res,200,listWechatChats(store,config,Object.fromEntries(u.searchParams)));return;}
   if(req.method==='GET'&&u.pathname==='/api/wechat/read-chat'){json(res,200,readWechatChat(store,config,Object.fromEntries(u.searchParams)));return;}
   if(req.method==='GET'&&u.pathname==='/api/status'){json(res,200,status());return;}
   if(req.method==='GET'&&u.pathname==='/api/readiness'){json(res,200,readiness(store,config,{dir,status:status(),query:Object.fromEntries(u.searchParams)}));return;}
   if(req.method==='GET'&&u.pathname==='/api/invitations'){json(res,200,listInvitations(store,config));return;}
   if(req.method==='GET'&&u.pathname==='/api/lan-join'){json(res,200,lanJoinStatus(store,config));return;}
   if(req.method==='GET'&&u.pathname==='/api/lan-join/link'){json(res,200,createLanJoinLink(store,config));return;}
   if(req.method==='GET'&&u.pathname==='/api/knowledge/search'){
    assert(config,'请先配置角色');const q=Object.fromEntries(u.searchParams);
    for(const k of ['limit','scan_limit'])if(Object.hasOwn(q,k))q[k]=Number(q[k]);
    if(Object.hasOwn(q,'include_raw')){assert(['true','false'].includes(q.include_raw),'include_raw 必须为布尔值');q.include_raw=q.include_raw==='true';}
    json(res,200,knowledgeSearch(store,config,q));return;
   }
   if(req.method==='GET'&&u.pathname==='/api/knowledge/read'){assert(config,'请先配置角色');json(res,200,knowledgeRead(store,config,Object.fromEntries(u.searchParams)));return;}
   if(req.method==='GET'&&u.pathname==='/api/candidates/evaluations'){assert(config?.role==='hub','仅总控可读取候选验收');json(res,200,candidateEvaluationHistory(store,{candidate_id:u.searchParams.get('candidate_id'),org_id:config.org_id,limit:Number(u.searchParams.get('limit')||20)}));return;}
   if(req.method==='GET'&&u.pathname==='/api/candidates/revisions'){assert(config?.role==='hub','仅总控可读取修订历史');const detail=u.searchParams.get('include_definitions')||'false';assert(['true','false'].includes(detail),'include_definitions 必须为布尔值');json(res,200,candidateRevisionHistory(store,{candidate_id:u.searchParams.get('candidate_id'),org_id:config.org_id,limit:Number(u.searchParams.get('limit')||(detail==='true'?3:20)),include_definitions:detail==='true'}));return;}
   if(req.method==='GET'&&u.pathname==='/api/personal/history'){assert(config,'请先配置角色');json(res,200,personalHistory(store,{employee:config.role==='collector'?config.employee_id:u.searchParams.get('employee')||'',limit:Number(u.searchParams.get('limit')||(u.searchParams.get('include_details')==='true'?5:20)),include_details:u.searchParams.get('include_details')==='true'}));return;}
   if(req.method==='GET'&&u.pathname==='/api/replies'){assert(config,'请先配置角色');json(res,200,listReplies(store,{device_id:config.role==='collector'?config.device_id:u.searchParams.get('device_id')||'',limit:Number(u.searchParams.get('limit')||30)}));return;}
   if(req.method==='GET'&&u.pathname==='/api/candidates'){assert(config?.role==='hub','仅总控可读取候选');json(res,200,candidateList(store,{candidate_id:u.searchParams.get('candidate_id')||'',limit:Number(u.searchParams.get('limit')||20)}));return;}
   if(req.method==='GET'&&u.pathname==='/api/jobs'){assert(config,'请先配置角色');json(res,200,listJobs(store,{device_id:config.role==='collector'?config.device_id:u.searchParams.get('device_id')||'',limit:Number(u.searchParams.get('limit')||30)}));return;}
   if(req.method==='GET'&&u.pathname==='/api/report'){json(res,200,report(store,Object.fromEntries(u.searchParams)));return;}
   if(req.method==='GET'&&u.pathname==='/api/analysis/history'){assert(config?.role==='hub','只有总控可分析汇总证据');json(res,200,analysisHistory(store,{employee:u.searchParams.get('employee')||'',limit:Number(u.searchParams.get('limit')||20)}));return;}
   if(req.method==='GET'&&u.pathname==='/api/evidence'){
    const ids=JSON.parse(u.searchParams.get('ids')||'[]');assert(Array.isArray(ids)&&ids.length>0&&ids.length<=10&&ids.every(id),'一次读取 1–10 个有效事件编号');
    const items=ids.map(eventId=>store.db.prepare('SELECT json FROM events WHERE event_id=?').get(eventId)).filter(Boolean).map(r=>JSON.parse(r.json));json(res,200,{count:items.length,items});return;
   }
   if(req.method==='GET'&&u.pathname==='/api/tasks'){const all=tasks(store);const found=u.searchParams.get('task_id');json(res,200,found?all.find(t=>t.task_id===found)||null:all.map(({events,...t})=>({...t,event_count:events.length})));return;}
   if(req.method==='GET'&&u.pathname==='/api/events'){const limit=Math.max(1,Math.min(200,Number(u.searchParams.get('limit'))||100)),offset=Math.max(0,Math.floor(Number(u.searchParams.get('offset'))||0));json(res,200,store.list({employee:u.searchParams.get('employee')||'',device:u.searchParams.get('device')||'',from:u.searchParams.get('from')||'',to:u.searchParams.get('to')||'',search:u.searchParams.get('search')||'',limit,offset}));return;}
   if(req.method==='GET'&&u.pathname==='/api/files/original'){assert(config,'请先配置角色');const eventId=u.searchParams.get('event_id');assert(id(eventId),'文件事件编号无效');const row=store.db.prepare("SELECT json FROM events WHERE event_id=? AND event_type='document.version'").get(eventId);assert(row,'文件证据不存在');const e=JSON.parse(row.json);assert(e.org_id===config.org_id&&(config.role==='hub'||e.device_id===config.device_id),'文件不属于本机身份');const file=store.db.prepare('SELECT data,mime FROM file_versions WHERE sha256=?').get(e.payload.file_sha256);assert(file,'原件缺失');res.writeHead(200,{'Content-Type':e.payload.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment'});res.end(Buffer.from(file.data));return;}
   if(req.method==='GET'&&u.pathname.startsWith('/api/assets/')){const a=store.db.prepare('SELECT mime,data FROM assets WHERE sha256=?').get(u.pathname.split('/').at(-1));assert(a,'附件不存在');res.writeHead(200,{'Content-Type':a.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(Buffer.from(a.data));return;}
   assert(req.method==='POST','不支持的请求');assert(String(req.headers['content-type']||'').startsWith('application/json'),'需要 JSON 请求');const b=await body(req,145*1024*1024);assert(!closing,'service_stopping');
   if(u.pathname==='/api/setup'){
    assert(!config&&!setupInProgress,'已配置或正在配置，请勿重复初始化');assert(store.devices().length===0&&store.stats().events===0,'existing_data_without_config: 原配置缺失但已有身份或证据，请恢复原配置，禁止重新初始化');setupInProgress=true;try{if(b.role==='hub'){
     assert(str(b.org_name,100)&&b.org_name.trim(),'请填写公司名称');const addresses=ips();assert(addresses.includes(b.address),'请选择本机局域网地址');const hubPort=Number(b.hub_port||19221);assert(Number.isInteger(hubPort)&&hubPort>=1024&&hubPort<=65535&&hubPort!==server.address().port,'同步端口无效');
     if(b.offline_identity)validateAdoptionIdentity(b.offline_identity);const c={role:'hub',org_id:b.offline_identity?.org_id||uuid(),org_name:b.org_name.trim(),hub_port:hubPort,hub_url:`https://${b.address}:${hubPort}`,cert_password:secret()};const spec=join(dir,'certificate-request.json');atomicJSON(spec,{addresses,pfx:join(dir,'hub.pfx'),pem:join(dir,'hub.pem'),password:c.cert_password});const ps=spawnSync(process.env.WORKTRACE_POWERSHELL||'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'bridge','certificate.ps1'),'-Spec',spec],{windowsHide:true,encoding:'utf8',timeout:30000});assert(ps.status===0,'无法生成局域网证书；需要 Windows PowerShell 5.1 / .NET 4.7.2 以上');c.ca_pem=readFileSync(join(dir,'hub.pem'),'utf8');config=c;try{await listenHub();assert(!closing,'service_stopping');store.db.exec('SAVEPOINT hub_setup');let configWritten=false;try{if(b.offline_identity)adoptOfflineDevice(store,c,b.offline_identity);store.audit('hub.setup',c.org_id);atomicJSON(cfgFile,c);configWritten=true;store.db.exec('RELEASE SAVEPOINT hub_setup');}catch(error){store.db.exec('ROLLBACK TO SAVEPOINT hub_setup');store.db.exec('RELEASE SAVEPOINT hub_setup');if(configWritten)unlinkSync(cfgFile);throw error;}}catch(error){config=null;const failedHub=hub;hub=null;if(failedHub?.listening)await new Promise(resolve=>failedHub.close(()=>resolve()));throw error;}
    }else if(b.role==='collector'&&b.offline){
     const c=createOfflineIdentity(b.offline);releaseIdentity=await acquireIdentityLock(c);assert(!closing,'service_stopping');persistCollector(c,'collector.offline.setup');attachCollector();
    }else{
     assert(b.role==='collector','角色无效');const e=b.enrollment;assert(e?.format==='worktrace.enrollment/1.0'&&id(e.org_id)&&id(e.device_id),'登记文件无效');assert(str(e.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(e.employee_id)&&str(e.employee_name,100)&&str(e.label,100)&&str(e.org_name,100),'登记人员字段无效');assert(typeof e.device_token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(e.device_token),'设备密钥无效');assert(str(e.ca_pem,20000)&&e.ca_pem.includes('BEGIN CERTIFICATE'),'证书无效');const url=new URL(e.hub_url);assert(url.protocol==='https:'&&!url.username&&!url.password,'管理端必须使用 HTTPS');const c={...e,role:'collector',connection_mode:'hub',installation_id:uuid(),host_binding:hash(e.org_id+':'+hostname())};releaseIdentity=await acquireIdentityLock(c);assert(!closing,'service_stopping');persistCollector(c,'collector.setup');attachCollector();
    }assert(!closing,'service_stopping');attachWorker();json(res,200,status());return;}finally{if(!config&&releaseIdentity){await releaseIdentity();releaseIdentity=null;}setupInProgress=false;}
   }
   if(u.pathname==='/api/shutdown'){assert(!handoffBusy,'移交正在进行，请完成后再关闭');json(res,200,{ok:true});setTimeout(()=>close().catch(error=>console.error('WorkTrace shutdown failed: '+error.message)),100);return;}
   assert(config&&!setupInProgress,'请先完成本机角色配置');
   assert(!handoffBusy,'完整移交正在进行，暂不能修改本机状态');
   if(u.pathname==='/api/invitations/create'){json(res,200,createInvitation(store,config,b));return;}
   if(u.pathname==='/api/invitations/revoke'){json(res,200,revokeInvitation(store,config,b));return;}
   if(u.pathname==='/api/lan-join/configure'){json(res,200,configureLanJoin(store,config,b));return;}
   if(u.pathname==='/api/handoff/export'){
    assert(config.role==='collector'&&typeof b.finish_pilot==='boolean','仅分控可生成完整移交包');assert(!worker.busy&&!fileCollector?.busy&&!wechatCollector?.busy&&!syncing,'采集解析或学习正在完成，请暂停后等待再导出');
    const previous={capture_enabled:!!collector.enabled,worker_policy:worker.policy};let exported=null,failure=null;handoffBusy=true;
    try{store.set('handoff_previous_state',previous);collector.stop();store.set('capture_enabled',false);worker.configure({...previous.worker_policy,paused:true});exported=await createOfflineHandoff(store,config,{output:b.output,password:b.password,source:{base_version:SOFTWARE_VERSION,...(existsSync(join(root,'engine-manifest.json'))?{source_sha256:hash(readFileSync(join(root,'engine-manifest.json')))}:{})}});}
    catch(error){failure=error;}
    finally{try{if(!closing&&(!b.finish_pilot||!exported)){worker.configure(previous.worker_policy);store.set('capture_enabled',previous.capture_enabled);if(previous.capture_enabled)collector.start();}}
     catch(error){failure=new Error((failure?failure.message+'；':'')+'恢复原运行状态失败：'+error.message+'；请检查本机状态，原始数据保留');}finally{handoffBusy=false;}}
    if(failure)throw failure;
    json(res,200,{path:exported.path,sha256:exported.sha256,bytes:exported.bytes,counts:exported.manifest.counts,identity:exported.manifest.identity,mode:closing?'service_stopping_paused':b.finish_pilot?'pilot_finished_paused':'previous_state_restored',source_retained:true});return;
   }
   if(u.pathname==='/api/handoff/import'){assert(config.role==='hub'&&!worker.busy,'仅空闲总控可归并移交包');handoffBusy=true;try{json(res,200,await importOfflineHandoff(store,config,{input:b.input,password:b.password}));}finally{handoffBusy=false;}return;}
   if(u.pathname==='/api/offline/adopt-device'){json(res,200,adoptOfflineDevice(store,config,b));return;}
   if(u.pathname==='/api/personal/digest'){json(res,200,personalDigest(store,config,{directory:join(dir,'daily-reports'),day:b.day}));return;}
   if(u.pathname==='/api/files/configure'){assert(fileCollector,'仅分控可设置文件取证');json(res,200,fileCollector.configure(b));return;}
   if(u.pathname==='/api/files/scan'){assert(fileCollector,'仅分控可扫描已允许目录');json(res,200,await runtimeTasks.run('files',()=>fileCollector.scan()));return;}
   if(u.pathname==='/api/worker/retry-local'){json(res,200,worker.retryLocal(b));return;}
   if(u.pathname==='/api/import/external'){
    assert(config.role==='collector','外部来源先在对应分控导入，再由既有通道汇总');
    keys(b,['source','source_instance','timezone','from','to','input','dry_run'],['source','source_instance','timezone','from','to','input']);
    assert(b.dry_run===undefined||typeof b.dry_run==='boolean','dry_run 必须为布尔值');
    const {input,dry_run,...options}=b;
    Object.assign(options,{org_id:config.org_id,device_id:config.device_id,employee_id:config.employee_id});
    if(dry_run){const normalized=normalizeExternalRecords(input,options);json(res,200,{dry_run:true,report:normalized.report,event_count:normalized.events.length});}
    else json(res,200,importExternalRecords(store,input,options));return;
   }
   if(u.pathname==='/api/candidates/evaluate'){assert(config.role==='hub','仅总控可记录候选验收');json(res,200,candidateEvaluate(store,{...b,org_id:config.org_id}));return;}
   if(u.pathname==='/api/candidates/revise'){assert(config.role==='hub','仅总控可登记候选修订');json(res,200,candidateRevise(store,{...b,org_id:config.org_id}));return;}
   if(u.pathname==='/api/worker/configure'){json(res,200,worker.configure(b));return;}
   if(u.pathname==='/api/replies/create'){json(res,200,replyToJob(store,config,b));return;}
   if(u.pathname==='/api/jobs/enqueue'){assert(config.role==='hub','只有总控可下发任务');json(res,200,enqueueJob(store,b));return;}
   if(u.pathname==='/api/jobs/cancel'){assert(config.role==='hub'&&id(b.job_id),'只有总控可取消有效任务');json(res,200,transitionJob(store,b.job_id,'cancelled',{reason:'hub_cancelled'}));return;}
   if(u.pathname==='/api/worker/run'){assert(!worker.busy,'本机学习正在运行');runtimeTasks.launch('worker',()=>worker.tick());json(res,200,{accepted:true,note:'仍受时段、暂停和每日预算限制'});return;}
   if(u.pathname==='/api/personal/next'){assert(!worker.busy&&(!worker.policy.enabled||worker.policy.paused),'手动复盘前请先暂停本机自动学习');json(res,200,nextPersonal(store,config,b));return;}
   if(u.pathname==='/api/personal/save'){assert(!worker.busy&&(!worker.policy.enabled||worker.policy.paused),'手动复盘前请先暂停本机自动学习');const saved=savePersonal(store,config,b);try{saved.daily_report=personalDigest(store,config,{directory:join(dir,'daily-reports')});}catch(error){saved.daily_report={saved:false,error:String(error.message).slice(0,1000),summary_preserved:true};}json(res,200,saved);return;}
   if(u.pathname==='/api/learning/request'){assert(config.role==='hub','只有总控可要求补证');json(res,200,requestLearning(store,b));return;}
   if(u.pathname==='/api/analysis/next'){assert(!worker.busy&&(!worker.policy.enabled||worker.policy.paused),'手动复盘前请先暂停本机自动学习');assert(config.role==='hub','只有总控可分析汇总证据');json(res,200,nextAnalysis(store,b));return;}
   if(u.pathname==='/api/analysis/save'){assert(!worker.busy&&(!worker.policy.enabled||worker.policy.paused),'手动复盘前请先暂停本机自动学习');assert(config.role==='hub','只有总控可保存汇总分析');json(res,200,saveAnalysis(store,b));return;}
   if(u.pathname==='/api/work'){assert(['task.created','task.transition','artifact.version','artifact.feedback'].includes(b.event_type),'业务事件类型无效');json(res,200,addWork(store,config,b.event_type,b.payload,b.case_id));return;}
   if(u.pathname==='/api/devices'){assert(config.role==='hub','仅管理端可登记');assert(str(b.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(b.employee_id)&&str(b.employee_name,100)&&b.employee_name.trim()&&str(b.label,100)&&b.label.trim(),'请填写员工编号、姓名及电脑名称');const d={device_id:uuid(),org_id:config.org_id,employee_id:b.employee_id,employee_name:b.employee_name.trim(),label:b.label.trim()};const deviceToken=secret();store.addDevice(d,deviceToken);json(res,200,{format:'worktrace.enrollment/1.0',org_name:config.org_name,...d,hub_url:config.hub_url,ca_pem:config.ca_pem,device_token:deviceToken});return;}
   if(u.pathname==='/api/revoke'){assert(config.role==='hub'&&id(b.device_id),'无效设备');store.db.prepare('UPDATE devices SET revoked=1 WHERE device_id=?').run(b.device_id);store.audit('device.revoke',b.device_id);json(res,200,{ok:true});return;}
   if(u.pathname==='/api/wechat/probe'){assert(wechatCollector,'仅分控配置微信来源');assert(!wechatCollector.busy&&!runtimeTasks.snapshot().tasks.wechat?.running,'wechat_reader_busy');json(res,200,await runtimeTasks.run('wechat',()=>wechatCollector.probe()));return;}
   if(u.pathname==='/api/wechat/configure'){assert(wechatCollector,'仅分控配置微信来源');json(res,200,wechatCollector.configure(b));return;}
   if(u.pathname==='/api/policy'){assert(collector,'仅采集端可设置');collector.update(validatePolicy(b));json(res,200,{ok:true});return;}
   if(u.pathname==='/api/capture'){assert(collector&&typeof b.enabled==='boolean','无效采集状态');if(b.enabled)collector.start();else collector.stop();store.set('capture_enabled',b.enabled);json(res,200,status());return;}
   if(u.pathname==='/api/sync'){json(res,200,await synchronize());return;}
   if(u.pathname==='/api/export'){const bundle=store.exportBundle(config.org_id,b.filters||{});const bytes=sealBundle(bundle,b.password);store.audit('bundle.export',`${bundle.events.length} events`);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="worktrace.wpack"','Cache-Control':'no-store'});res.end(bytes);return;}
   if(u.pathname==='/api/import'){assert(config.role==='hub','请在管理端汇总导入');assert(str(b.data,140*1024*1024),'数据包过大');const bundle=openBundle(Buffer.from(b.data,'base64'),b.password);for(const p of bundle.policies)validatePolicy(p.value);json(res,200,store.importBundle(bundle,config.org_id));return;}
   json(res,404,{error:'接口不存在'});
  }catch(e){json(res,400,{error:e.message});}
 });server.requestTimeout=60000;server.headersTimeout=10000;
 await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
 if(config?.role==='hub')await listenHub();if(config?.role==='collector'){attachCollector();if(store.get('capture_enabled'))collector.start();}
 const url=`http://127.0.0.1:${server.address().port}/#key=${token}`;runningUrl=url;atomicJSON(join(dir,'running.json'),{pid:process.pid,port:server.address().port,url});
 if(config)attachWorker();timer=setInterval(()=>runtimeTasks.launch('sync',syncOnce),30000);timer.unref();
 workerTimer=setInterval(()=>{if(worker&&!handoffBusy)runtimeTasks.launch('worker',()=>worker.tick());},5000);workerTimer.unref();
 wechatTimer=setInterval(()=>{if(wechatCollector&&!handoffBusy)runtimeTasks.launch('wechat',()=>wechatCollector.tick());},5000);wechatTimer.unref();
 fileTimer=setInterval(()=>{if(fileCollector&&!handoffBusy)runtimeTasks.launch('files',()=>fileCollector.scan());},5000);fileTimer.unref();
 return {server,store,get config(){return config;},get collector(){return collector;},get worker(){return worker;},get fileCollector(){return fileCollector;},get wechatCollector(){return wechatCollector;},token,url,dir,synchronize,close,status};
 }catch(error){try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],error.message+'; startup_cleanup_failed');}throw error;}
 function close(){
  if(closePromise)return closePromise;closing=true;runtimeTasks.stop();clearInterval(timer);clearInterval(workerTimer);clearInterval(fileTimer);clearInterval(wechatTimer);
  const stopErrors=[];for(const stop of [()=>syncController?.abort(),()=>fileCollector?.stop(),()=>wechatCollector?.stop(),()=>worker?.stop(),()=>collector?.stop()])try{stop();}catch(error){stopErrors.push(error);}
  const stopServer=s=>!s?.listening?Promise.resolve():new Promise(resolve=>s.close(()=>resolve()));
  closePromise=(async()=>{try{
   await Promise.all([runtimeTasks.drain(),stopServer(server)]);await stopServer(hub);
   if(runningUrl&&existsSync(join(dir,'running.json'))){const current=JSON.parse(readFileSync(join(dir,'running.json'),'utf8'));if(current.pid===process.pid&&current.url===runningUrl)unlinkSync(join(dir,'running.json'));}
  }finally{try{store?.close();}finally{try{await releaseIdentity?.();}finally{releaseDirectory();}}}if(stopErrors.length)throw new AggregateError(stopErrors,'shutdown_cleanup_failed');})();return closePromise;
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const app=await startApp();console.log('WorkTrace management ready on loopback.');for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>app.close().then(()=>process.exit(0)));}
