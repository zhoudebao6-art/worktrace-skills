import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateInvite,validateIdentity,prepareRequest,enrollFromInvite,redeemInvite,validateEnrollment,saveExclusive,origin} from '../src/invite-client.mjs';

const tempRoot=resolve(process.env.TEMP||'../../work','worktrace-tests');mkdirSync(tempRoot,{recursive:true});
const token=()=>randomBytes(32).toString('base64url');
const identity={employee_id:'SYNTHETIC_01',employee_name:'合成员工',label:'合成电脑'};
let certificate;
function fixture(t,{cleanup=true}={}){
 const dir=mkdtempSync(join(tempRoot,'invite-client-'));if(cleanup)t.after(()=>{if(resolve(dir).startsWith(tempRoot+'\\')||resolve(dir).startsWith(tempRoot+'/'))rmSync(dir,{recursive:true,force:true});});
 if(!certificate){
  const certDir=mkdtempSync(join(tempRoot,'invite-client-cert-')),password=token(),spec=join(certDir,'request.json');writeFileSync(spec,JSON.stringify({addresses:['127.0.0.1'],pfx:join(certDir,'hub.pfx'),pem:join(certDir,'hub.pem'),password}));
  const run=spawnSync(process.env.WORKTRACE_POWERSHELL||'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('bridge/certificate.ps1'),'-Spec',spec],{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,'合成 TLS 证书生成失败');
  certificate={pfx:readFileSync(join(certDir,'hub.pfx')),pem:readFileSync(join(certDir,'hub.pem'),'utf8'),password};rmSync(certDir,{recursive:true,force:true});
 }
 const invite={format:'worktrace.invitation/1.0',invite_id:randomUUID(),invite_token:token(),org_id:randomUUID(),org_name:'SYNTHETIC ONLY',hub_url:'https://127.0.0.1:19221',allowed_urls:['https://127.0.0.1:19221'],ca_pem:certificate.pem,created_at:'2026-01-01T00:00:00.000Z',expires_at:'2099-01-01T00:00:00.000Z'};
 const statePath=join(dir,'request.json');return {dir,invite,statePath};
}
function enrollment(invite,request){return {format:'worktrace.enrollment/1.0',org_id:invite.org_id,org_name:invite.org_name,device_id:randomUUID(),employee_id:request.employee_id,employee_name:request.employee_name,label:request.label,hub_url:request.hub_url,ca_pem:invite.ca_pem,device_token:token()};}
async function serve(t,handler){const server=https.createServer({pfx:certificate.pfx,passphrase:certificate.password},handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));return 'https://127.0.0.1:'+server.address().port;}
function setUrl(invite,url){invite.hub_url=url;invite.allowed_urls=[url];}

test('邀请固定 HTTPS 范围、公司公开证书及员工身份',t=>{
 const f=fixture(t);assert.equal(validateInvite(f.invite),f.invite);assert.equal(validateIdentity(identity),identity);
 for(const value of ['http://127.0.0.1','https://u:p@host','https://host/path','https://host?token=x','https://host/#key=x','https://host/','https://host:443'])assert.throws(()=>origin(value));
 for(const change of [{ca_pem:'not a certificate'},{allowed_urls:['https://other.example']},{allowed_urls:[f.invite.hub_url,f.invite.hub_url]},{extra:'field'},{expires_at:'2025-01-01'}])assert.throws(()=>validateInvite({...f.invite,...change}));
 assert.throws(()=>validateIdentity({...identity,employee_id:'../bad'}));assert.throws(()=>validateIdentity({...identity,employee_name:' 前后空格 '}));
});

test('原子持久化 request_id / request_secret，重试不能更换身份、邀请或 URL',t=>{
 const f=fixture(t),args={...f,identity};const first=prepareRequest(args),second=prepareRequest(args);assert.deepEqual(first,second);assert.match(first.request_secret,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(first.request_secret,f.invite.invite_token);
 assert.throws(()=>prepareRequest({...args,identity:{...identity,label:'另一台'}}),/不一致/);assert.throws(()=>prepareRequest({...args,invite:{...f.invite,invite_token:token()}}),/不一致/);assert.throws(()=>prepareRequest({...args,hubUrl:'https://other.example'}),/允许范围/);
 const before=readFileSync(f.statePath);assert.throws(()=>saveExclusive(f.statePath,{changed:true}));assert.deepEqual(readFileSync(f.statePath),before);
 writeFileSync(f.statePath,'{"partial":');assert.throws(()=>prepareRequest(args),/原文件已保留/);
});

test('TLS 邀请登记保存结果，重试复用已有文件且不重复发送',async t=>{
 const f=fixture(t);let calls=0;const url=await serve(t,async(req,res)=>{calls++;assert.equal(req.url,'/v1/enroll');assert.equal(req.method,'POST');const chunks=[];for await(const part of req)chunks.push(part);const request=JSON.parse(Buffer.concat(chunks));assert.equal(request.invite_token,f.invite.invite_token);assert.match(request.request_secret,/^[A-Za-z0-9_-]{43}$/);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(enrollment(f.invite,request)));});setUrl(f.invite,url);
 const invitePath=join(f.dir,'invite.json'),outputPath=join(f.dir,'enrollment.json');writeFileSync(invitePath,JSON.stringify(f.invite));const args={invitePath,statePath:f.statePath,outputPath,workDir:join(f.dir,'collector'),...identity};
 const result=await enrollFromInvite(args);assert.equal(result.employee_id,identity.employee_id);assert.equal(calls,1);assert(!JSON.stringify(result).includes(f.invite.invite_token));assert(!JSON.stringify(result).includes('request_secret'));
 assert.deepEqual(await enrollFromInvite(args),result);assert.equal(calls,1);assert(existsSync(outputPath));
 const saved=JSON.parse(readFileSync(outputPath,'utf8'));mkdirSync(join(args.workDir,'data'),{recursive:true});writeFileSync(join(args.workDir,'data','config.json'),JSON.stringify({...saved,role:'collector',connection_mode:'hub'}));assert.deepEqual(await enrollFromInvite(args),result);assert.equal(calls,1);
 const original=readFileSync(outputPath);await assert.rejects(()=>enrollFromInvite({...args,employee_name:'另一人'}),/未修改/);assert.deepEqual(readFileSync(outputPath),original);
});

test('原请求在网络失败后保留；响应身份/证书不一致、重定向及服务正文不泄露',async t=>{
 const f=fixture(t);let mode='reject',received=[];const url=await serve(t,async(req,res)=>{const chunks=[];for await(const p of req)chunks.push(p);const request=JSON.parse(Buffer.concat(chunks));received.push(request);if(mode==='reject'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'SECRET SHOULD NEVER APPEAR '+request.invite_token}));return;}if(mode==='redirect'){res.writeHead(302,{location:'https://example.invalid'});res.end();return;}let value=enrollment(f.invite,request);if(mode==='wrong')value.employee_id='OTHER';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));});setUrl(f.invite,url);
 const invitePath=join(f.dir,'invite.json'),outputPath=join(f.dir,'enrollment.json');writeFileSync(invitePath,JSON.stringify(f.invite));const args={invitePath,statePath:f.statePath,outputPath,...identity};
 await assert.rejects(()=>enrollFromInvite(args),error=>/邀请无效/.test(error.message)&&!error.message.includes('SECRET')&&!error.message.includes(f.invite.invite_token));assert(!existsSync(outputPath));
 mode='redirect';await assert.rejects(()=>enrollFromInvite(args),/不会跟随重定向/);mode='wrong';await assert.rejects(()=>enrollFromInvite(args),/不一致/);assert(!existsSync(outputPath));mode='good';await enrollFromInvite(args);assert(received.every(r=>r.request_id===received[0].request_id&&r.request_secret===received[0].request_secret));
 const request=received[0];for(const change of [{org_id:randomUUID()},{hub_url:'https://other.example'},{ca_pem:certificate.pem+' '},{device_token:'short'}])assert.throws(()=>validateEnrollment({...enrollment(f.invite,request),...change},f.invite,request));
});

test('TLS 未信任公司证书时拒绝；已有其他身份在网络兑换之前拒绝',async t=>{
 const f=fixture(t);let count=0;const url=await serve(t,(req,res)=>{count++;res.end();});setUrl(f.invite,url);const request=prepareRequest({...f,identity});
 await assert.rejects(()=>redeemInvite({...f.invite,ca_pem:''},request),/公司证书验证/);assert.equal(count,0);
 const workDir=join(f.dir,'collector'),invitePath=join(f.dir,'invite.json'),outputPath=join(f.dir,'enrollment.json');writeFileSync(invitePath,JSON.stringify(f.invite));mkdirSync(join(workDir,'data'),{recursive:true});writeFileSync(join(workDir,'data','config.json'),JSON.stringify({role:'hub',org_id:f.invite.org_id}));
 await assert.rejects(()=>enrollFromInvite({invitePath,statePath:f.statePath,outputPath,workDir,...identity}),/未修改/);assert.equal(count,0);
 const orphan=join(f.dir,'orphan');mkdirSync(join(orphan,'data'),{recursive:true});writeFileSync(join(orphan,'data','worktrace.sqlite'),'synthetic placeholder');await assert.rejects(()=>enrollFromInvite({invitePath,statePath:f.statePath,outputPath,workDir:orphan,...identity}),/缺少身份配置/);assert.equal(count,0);
});

test('受控目录拒绝 junction，保留外部目标',t=>{
 const f=fixture(t),target=join(f.dir,'target'),link=join(f.dir,'link');mkdirSync(target);symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>prepareRequest({invite:f.invite,identity,statePath:join(link,'request.json')}),/junction/);assert(!existsSync(join(target,'request.json')));
});

test('真实总控 API：邀请兑换、丢失响应恢复、分控身份心跳和指定模型',async t=>{
 const f=fixture(t,{cleanup:false}),{startApp}=await import('../src/server.mjs'),{localApi}=await import('../src/local-api.mjs');
 const apps=[];t.after(async()=>{for(const app of apps.reverse())await app.close();if(resolve(f.dir).startsWith(tempRoot+'\\')||resolve(f.dir).startsWith(tempRoot+'/'))rmSync(f.dir,{recursive:true,force:true});});
 const port=await new Promise(ok=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>ok(value));});});
 const hub=await startApp({dir:join(f.dir,'hub'),port:0});apps.push(hub);await localApi(hub.dir,'setup',{role:'hub',org_name:'SYNTHETIC CLIENT API TEST',address:'127.0.0.1',hub_port:port});
 const invite=await localApi(hub.dir,'invitations/create',{}),invitePath=join(f.dir,'invite.json'),outputPath=join(f.dir,'enrollment.json');writeFileSync(invitePath,JSON.stringify(invite));
 const request=prepareRequest({invite,identity,statePath:f.statePath});const lostResponse=await redeemInvite(invite,request);assert.equal(hub.store.devices().length,1);
 const result=await enrollFromInvite({invitePath,statePath:f.statePath,outputPath,...identity});assert.equal(result.device_id,lostResponse.device_id);assert.deepEqual(JSON.parse(readFileSync(outputPath,'utf8')),lostResponse);assert.equal(hub.store.devices().length,1);
 const client=await startApp({dir:join(f.dir,'collector'),port:0});apps.push(client);await localApi(client.dir,'setup',{role:'collector',enrollment:lostResponse});assert.deepEqual(await client.synchronize(),{sent:0});const status=client.status();
 assert.equal(status.org_id,hub.config.org_id);assert.equal(status.employee_id,identity.employee_id);assert.equal(status.device_id,result.device_id);assert(status.sync.last_success);assert.equal(status.sync.error,'');assert.equal(status.collection.enabled,false);assert.equal(status.worker.policy.model,'gpt-6.1-sol');assert.equal(status.worker.policy.reasoning_effort,'xhigh');assert.equal(hub.store.stats().events,0);assert(hub.store.devices()[0].last_seen);
});
