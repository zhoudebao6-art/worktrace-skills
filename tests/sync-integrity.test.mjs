import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import https from 'node:https';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {uuid,hash,canonical} from '../src/protocol.mjs';
import {enqueueJob,job} from '../src/jobs.mjs';

const root=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-sync-integrity');mkdirSync(root,{recursive:true});
const freePort=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>ok(port));});});
async function api(a,path,data){const r=await fetch(new URL('/api/'+path,a.url),{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:JSON.stringify(data)});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;}
function event(c){return {schema_version:'1.0',event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,stream_id:uuid(),sequence:1,session_id:uuid(),occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',event_type:'activity.snapshot',collector_version:'synthetic-test',policy_hash:hash(canonical(defaultPolicy)),app:{process_name:'synthetic.exe',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{text:'SYNTHETIC ONLY',capture_status:'uia',idle_seconds:0,truncated:false,reason:''},attachments:[]};}
const payload=(c,events=[event(c)])=>({org_id:c.org_id,device_id:c.device_id,installation_id:uuid(),events,assets:[],policies:[{hash:hash(canonical(defaultPolicy)),value:defaultPolicy}]});
function heldRequest(t,c,p){const bytes=Buffer.from(JSON.stringify(p));let done,fail;const response=new Promise((yes,no)=>{done=yes;fail=no;});const req=https.request(new URL('/v1/sync',c.hub_url),{method:'POST',ca:c.ca_pem,agent:false,headers:{'Content-Type':'application/json','Content-Length':bytes.length,Authorization:'Bearer '+c.device_token,'X-Worktrace-Device':c.device_id}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>{try{done({status:res.statusCode,...JSON.parse(raw)});}catch(e){fail(e);}});});req.on('error',fail);t.after(()=>req.destroy());req.write(bytes.subarray(0,1));return {finish:()=>req.end(bytes.subarray(1)),response};}
// Observe the initial authentication read, so the test does not depend on sleeps.
function waitForAuthentication(t,s,device,count){const original=s.device;let remaining=count,done;const promise=new Promise(ok=>{done=ok;});const timeout=setTimeout(()=>done(false),5000);s.device=function(id){const result=original.call(this,id);if(id===device&&--remaining===0){clearTimeout(timeout);done(true);}return result;};t.after(()=>{clearTimeout(timeout);s.device=original;});return promise;}

test('HTTPS 同步：首次绑定、撤销与整个上传事务保持一致',async t=>{
 const dir=mkdtempSync(join(root,'case-')),app=await startApp({dir,port:0});t.after(async()=>{await app.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});
 await api(app,'setup',{role:'hub',org_name:'SYNTHETIC ONLY',address:'127.0.0.1',hub_port:await freePort()});
 const enroll=()=>api(app,'devices',{employee_id:'SYNTHETIC-'+uuid(),employee_name:'SYNTHETIC',label:'SYNTHETIC'});
 await t.test('同一登记并发首次同步仅一个安装可成功，另一个不能写入',async t=>{
  const c=await enroll(),first=payload(c),second=payload(c),authenticated=waitForAuthentication(t,app.store,c.device_id,2);
  const a=heldRequest(t,c,first),b=heldRequest(t,c,second);assert.equal(await authenticated,true);a.finish();assert.equal((await a.response).status,200);b.finish();const refused=await b.response;assert.equal(refused.status,400);assert.match(refused.error,/另一安装/);
  assert.equal(app.store.device(c.device_id).installation_id,first.installation_id);assert.equal(app.store.list({device:c.device_id}).count,1);assert(!app.store.db.prepare('SELECT 1 FROM events WHERE event_id=?').get(second.events[0].event_id));
 });
 await t.test('后续回执失败时事件、之前回执和安装绑定一起回滚；原包修正后可重传',async t=>{
  const c=await enroll(),p=payload(c),j=enqueueJob(app.store,{device_id:c.device_id,kind:'message',idempotency_key:'synthetic:'+uuid()});p.job_receipts=[{job_id:j.job_id,revision:1,state:'running',result:{synthetic:true}},{job_id:uuid(),revision:1,state:'succeeded',result:{}}];
  const attempt=heldRequest(t,c,p);attempt.finish();const refused=await attempt.response;assert.equal(refused.status,400);assert.equal(app.store.list({device:c.device_id}).count,0);assert.equal(app.store.device(c.device_id).installation_id,null);assert.equal(job(app.store,j.job_id).state,'queued');assert.equal(job(app.store,j.job_id).revision,0);
  p.job_receipts.pop();const retry=heldRequest(t,c,p);retry.finish();assert.equal((await retry.response).status,200);assert.equal(app.store.list({device:c.device_id}).count,1);assert.equal(job(app.store,j.job_id).revision,1);
  const duplicate=heldRequest(t,c,p);duplicate.finish();const duplicateResult=await duplicate.response;assert.equal(duplicateResult.status,200);assert.equal(duplicateResult.added,0);assert.equal(duplicateResult.duplicates,1);
 });
 await t.test('请求体尚未收完时撤销设备，空事件心跳也必须重新认证',async t=>{
  const c=await enroll(),p=payload(c,[]),authenticated=waitForAuthentication(t,app.store,c.device_id,1),request=heldRequest(t,c,p);assert.equal(await authenticated,true);await api(app,'revoke',{device_id:c.device_id});request.finish();const refused=await request.response;assert.equal(refused.status,400);assert.match(refused.error,/认证失败/);assert.equal(app.store.device(c.device_id).installation_id,null);
 });
});
