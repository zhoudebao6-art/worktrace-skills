import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {startApp} from '../src/server.mjs';
import {Store} from '../src/store.mjs';
import {admin} from '../src/admin-cli.mjs';
import {localApi} from '../src/local-api.mjs';
import {uuid,hash} from '../src/protocol.mjs';
import {initInvitations,createInvitation,listInvitations,revokeInvitation,redeemInvitation,createEnrollmentLimiter} from '../src/invitations.mjs';

const tempRoot=resolve(process.env.TEMP||'../../work','worktrace-tests');mkdirSync(tempRoot,{recursive:true});
const secret=()=>randomBytes(32).toString('base64url');
const freePort=()=>new Promise(ok=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>ok(port));});});
function request(config,path,payload,{raw,chunked=false,headers={},method='POST'}={}){
 return new Promise((resolve,reject)=>{
  const bytes=Buffer.from(raw??JSON.stringify(payload));
  const req=https.request(new URL(path,config.hub_url),{method,ca:config.ca_pem,agent:false,headers:{'Content-Type':'application/json',...(!chunked?{'Content-Length':bytes.length}:{}),...headers},timeout:5000},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks))});}catch(error){reject(error);}});
  });
  req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('synthetic request timed out')));if(chunked)req.write(bytes);req.end(chunked?undefined:bytes);
 });
}
function redemption(invitation,overrides={}){return {invite_id:invitation.invite_id,invite_token:invitation.invite_token,request_id:uuid(),request_secret:secret(),employee_id:'SYNTHETIC-001',employee_name:'SYNTHETIC EMPLOYEE',label:'SYNTHETIC PC',hub_url:invitation.hub_url,...overrides};}

test('one-time invitations preserve authentication, identity, atomicity and bounded public enrollment',async t=>{
 const dir=mkdtempSync(join(tempRoot,'invitations-')),hub=await startApp({dir:join(dir,'hub'),port:0});
 t.after(async()=>{await hub.close();if(resolve(dir).startsWith(tempRoot+'\\')||resolve(dir).startsWith(tempRoot+'/'))rmSync(dir,{recursive:true,force:true});});
 await localApi(hub.dir,'setup',{role:'hub',org_name:'SYNTHETIC INVITATION TEST ONLY',address:'127.0.0.1',hub_port:await freePort()});
 const config=hub.config;
 function storeFor(name){const store=new Store(join(dir,name,'test.sqlite'));initInvitations(store);return store;}

 await t.test('creation restricts expiry and certificate-covered HTTPS origins; output contains no stored plaintext credentials',()=>{
  const store=storeFor('creation');try{
   const now=Date.now(),invitation=createInvitation(store,config,{},now);
   assert.equal(invitation.format,'worktrace.invitation/1.0');assert.equal(Date.parse(invitation.expires_at)-now,7*86400000);
   const row=store.db.prepare('SELECT * FROM invitations').get();assert.equal(row.token_hash,hash(invitation.invite_token));assert(!JSON.stringify(row).includes(invitation.invite_token));
   const alternate=`https://localhost:${new URL(config.hub_url).port}`;
   assert.deepEqual(createInvitation(store,config,{expires_in_days:30,allowed_urls:[alternate]}).allowed_urls,[config.hub_url,alternate]);
   for(const days of [0,-1,31,1.5,'7',null])assert.throws(()=>createInvitation(store,config,{expires_in_days:days}));
   for(const value of ['http://localhost','https://attacker.invalid','https://localhost/path','https://u:p@localhost','https://localhost?x=1','https://localhost/#x'])assert.throws(()=>createInvitation(store,config,{allowed_urls:[value]}));
   assert.throws(()=>createInvitation(store,config,{allowed_urls:Array.from({length:8},(_,n)=>`https://localhost:${21000+n}`)}),/总数/);
   const list=JSON.stringify(listInvitations(store,config));for(const field of ['invite_token','token_hash','request_id','request_secret','ca_pem'])assert(!list.includes(field));
  }finally{store.close();}
 });

 await t.test('one device, exact private retry, no replay or revoked-device recovery',()=>{
  const store=storeFor('redemption');try{
   const invitation=createInvitation(store,config),input=redemption(invitation),enrollment=redeemInvitation(store,config,input);
   assert.equal(enrollment.format,'worktrace.enrollment/1.0');assert.equal(store.devices().length,1);assert.deepEqual(redeemInvitation(store,config,input),enrollment);
   for(const replacement of [{request_id:uuid()},{request_secret:secret()},{employee_id:'SYNTHETIC-OTHER'},{label:'OTHER PC'},{employee_name:'OTHER NAME'}])assert.throws(()=>redeemInvitation(store,config,{...input,...replacement}),error=>error.status===401);
   const stored=JSON.stringify(store.db.prepare('SELECT * FROM invitations').get());for(const sensitive of [invitation.invite_token,input.request_secret,enrollment.device_token])assert(!stored.includes(sensitive));
   assert.equal(store.device(enrollment.device_id).token_hash,hash(enrollment.device_token));
   const other=createInvitation(store,config);assert.throws(()=>redeemInvitation(store,config,redemption(other)),error=>error.status===409);
   assert.equal(listInvitations(store,config).find(row=>row.invite_id===other.invite_id).state,'available');
   store.db.prepare('UPDATE devices SET revoked=1 WHERE device_id=?').run(enrollment.device_id);
   assert.throws(()=>redeemInvitation(store,config,input),error=>error.status===401);
   assert.throws(()=>redeemInvitation(store,config,redemption(other)),error=>error.status===409);
   assert.equal(store.devices().length,1);assert.equal(store.stats().events,0);
  }finally{store.close();}
 });

 await t.test('expired and revoked invitations reject unused and used requests; anonymous and malformed inputs make no registrations',()=>{
  const store=storeFor('invalid');try{
   const now=Date.now(),invitation=createInvitation(store,config,{},now),input=redemption(invitation);
   for(const bad of [{},{...input,invite_token:secret()},{...input,invite_id:uuid()},{...input,invite_id:'invalid'},{...input,request_secret:[input.request_secret]},{...input,employee_id:'bad id'},{...input,employee_name:' '},{...input,label:'a\nb'},{...input,unexpected:true}])assert.throws(()=>redeemInvitation(store,config,bad));
   assert.equal(store.devices().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM audit WHERE action=?').get('invitation.redeem').n,0);
   assert.throws(()=>redeemInvitation(store,config,input,now+7*86400000),error=>error.status===401);
   redeemInvitation(store,config,input,now);assert.throws(()=>redeemInvitation(store,config,input,now+7*86400000),error=>error.status===401);
   revokeInvitation(store,config,{invite_id:invitation.invite_id});assert.throws(()=>redeemInvitation(store,config,input,now),error=>error.status===401);
   const pending=createInvitation(store,config);revokeInvitation(store,config,{invite_id:pending.invite_id});assert.throws(()=>redeemInvitation(store,config,redemption(pending,{employee_id:'SYNTHETIC-002'})),error=>error.status===401);
   assert.equal(store.devices().length,1);
  }finally{store.close();}
 });

 await t.test('consumption failure rolls back device, audit and invitation changes as one transaction',()=>{
  const store=storeFor('atomic');try{
   const invitation=createInvitation(store,config),input=redemption(invitation);
   store.db.exec("CREATE TRIGGER synthetic_reject_consume BEFORE UPDATE ON invitations BEGIN SELECT RAISE(ABORT,'synthetic consume failure'); END;");
   assert.throws(()=>redeemInvitation(store,config,input),/synthetic consume failure/);assert.equal(store.devices().length,0);
   assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='device.register'").get().n,0);assert.equal(listInvitations(store,config)[0].state,'available');
   store.db.exec('DROP TRIGGER synthetic_reject_consume');redeemInvitation(store,config,input);assert.equal(store.devices().length,1);
  }finally{store.close();}
 });

 await t.test('IP and global limits are bounded, reset, and a blocked IP does not consume other peers allowance',()=>{
  let now=0;const allow=createEnrollmentLimiter({perIp:2,total:3,windowMs:1000,now:()=>now});
  assert(allow('a'));assert(allow('a'));assert(!allow('a'));assert(!allow('a'));assert(allow('b'));assert(!allow('c'));
  now=1000;assert(allow('a'));assert(allow('c'));
 });

 await t.test('local admin writes the invitation exclusively and prints only nonsecret metadata',async()=>{
  await assert.rejects(()=>admin({command:'invitations-create',role:'hub',dir:hub.dir}),/output/);
  assert.equal(listInvitations(hub.store,config).length,0);
  const output=join(dir,'single.invite.json'),saved=await admin({command:'invitations-create',role:'hub',dir:hub.dir,output});
  const invitation=JSON.parse(readFileSync(output,'utf8'));assert.equal(saved.invite_id,invitation.invite_id);assert(!JSON.stringify(saved).includes(invitation.invite_token));
  await assert.rejects(()=>admin({command:'invitations-create',role:'hub',dir:hub.dir,output}),/已存在/);assert.equal(listInvitations(hub.store,config).length,1);
  const input=join(dir,'revoke.json');writeFileSync(input,JSON.stringify({invite_id:invitation.invite_id}));
  assert.equal((await admin({command:'invitations-revoke',role:'hub',dir:hub.dir,input})).ok,true);
  assert.equal((await admin({command:'invitations-list',role:'hub',dir:hub.dir}))[0].state,'revoked');
 });

 await t.test('TLS endpoint rejects anonymous, oversize, malformed, replay and foreign-device requests while management remains local',async()=>{
  const invitation=createInvitation(hub.store,config),input=redemption(invitation);
  const attempts=await Promise.all([request(config,'/v1/enroll',input),request(config,'/v1/enroll',{...input,request_id:uuid(),request_secret:secret()})]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,401]);assert.equal(hub.store.devices().length,1);
  const enrollment=attempts.find(r=>r.status===200).body;
  const accepted=attempts[0].status===200?input:null;
  if(accepted)assert.deepEqual((await request(config,'/v1/enroll',input)).body,enrollment);
  assert.equal((await request(config,'/v1/enroll',{})).status,400);
  assert.equal((await request(config,'/v1/enroll',null,{raw:' '.repeat(8193)})).status,413);
  const oversized=await request(config,'/v1/enroll',null,{raw:' '.repeat(8193),chunked:true});assert.equal(oversized.status,413);assert.equal(oversized.headers.connection,'close');
  assert.equal((await request(config,'/v1/enroll',null,{raw:'{broken'})).status,400);
  const inaccessible=await request(config,'/api/status',{});assert.notEqual(inaccessible.status,200);assert.equal(inaccessible.body.org_name,undefined);
  const adminUrl=new URL(hub.url);const unauthorized=await fetch(adminUrl.origin+'/api/invitations');assert.notEqual(unauthorized.status,200);
  const badHost=await new Promise((resolve,reject)=>{const req=http.get(adminUrl.origin+'/api/status',{headers:{Host:'attacker.invalid',Authorization:'Bearer '+hub.token}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});assert.notEqual(badHost,200);
  const sync={org_id:config.org_id,device_id:enrollment.device_id,installation_id:uuid(),events:[],assets:[],policies:[]};
  assert.equal((await request(config,'/v1/sync',sync)).status,400);
  const headers={'Authorization':'Bearer '+enrollment.device_token,'X-Worktrace-Device':enrollment.device_id};
  assert.equal((await request(config,'/v1/sync',sync,{headers})).status,200);
  assert.equal((await request(config,'/v1/sync',{...sync,device_id:uuid()},{headers})).status,400);
  assert.equal((await request(config,'/api/invitations/create',{}, {headers})).status,400);
  assert.equal(hub.store.stats().events,0);assert.equal(hub.status().collection.enabled,false);
  let limited=false;for(let n=0;n<13;n++){const result=await request(config,'/v1/enroll',{});if(result.status===429){assert.equal(result.headers['retry-after'],'60');limited=true;break;}}assert(limited);
 });
});
