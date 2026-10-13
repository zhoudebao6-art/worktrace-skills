import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {networkInterfaces} from 'node:os';
import {randomBytes} from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {Store} from '../src/store.mjs';
import {localApi} from '../src/local-api.mjs';
import {admin} from '../src/admin-cli.mjs';
import {uuid,hash} from '../src/protocol.mjs';
import {initLanJoin,lanJoinPolicy,currentLanCidrs,normalizePeerAddress,configureLanJoin,lanJoinStatus,createLanJoinLink,assertLanJoinAllowed,enrollLanDevice} from '../src/lan-join.mjs';

const tempRoot=resolve(process.env.TEMP||'../../work','worktrace-tests');mkdirSync(tempRoot,{recursive:true});
const secret=()=>randomBytes(32).toString('base64url');
const freePort=()=>new Promise(ok=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>ok(port));});});
function request(config,payload,{path='/v1/lan/enroll',raw,chunked=false,headers={},method='POST',hostname}={}){
 return new Promise((resolve,reject)=>{const target=new URL(path,config.hub_url);if(hostname)target.hostname=hostname;const bytes=Buffer.from(raw??JSON.stringify(payload));
  const req=https.request(target,{method,ca:config.ca_pem,agent:false,headers:{'Content-Type':'application/json',...(!chunked?{'Content-Length':bytes.length}:{}),...headers},timeout:5000},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks))});}catch(error){reject(error);}});});
  req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('synthetic request timed out')));if(chunked)req.write(bytes);req.end(chunked?undefined:bytes);
 });
}
function inputFor(config,overrides={}){return {org_id:config.org_id,request_id:uuid(),request_secret:secret(),device_token:secret(),employee_id:'SYNTHETIC-LAN-001',employee_name:'SYNTHETIC EMPLOYEE',label:'SYNTHETIC LAN PC',hub_url:config.hub_url,...overrides};}

test('LAN autojoin scopes transport, preserves independent credentials and never grants management',async t=>{
 const rows=Object.values(networkInterfaces()).flat().filter(row=>!row.internal&&row.family==='IPv4'&&currentLanCidrs({test:[row]}).length);
 const selected=rows.find(row=>row.address.startsWith('192.168.'))||rows[0];if(!selected){t.skip('requires one current RFC1918 IPv4 interface for the isolated TLS integration');return;}
 const interfaces={synthetic:[selected]},cidr=currentLanCidrs(interfaces)[0],peer=selected.address,dir=mkdtempSync(join(tempRoot,'lan-join-')),hub=await startApp({dir:join(dir,'hub'),port:0});
 t.after(async()=>{await hub.close();assert(resolve(dir).startsWith(tempRoot+sep));rmSync(dir,{recursive:true,force:true});});
 await localApi(hub.dir,'setup',{role:'hub',org_name:'SYNTHETIC LAN JOIN TEST ONLY',address:peer,hub_port:await freePort()});const config=hub.config;
 function storeFor(name,enabled=true){const store=new Store(join(dir,name,'test.sqlite'));initLanJoin(store);if(enabled)configureLanJoin(store,config,{enabled:true,allowed_cidrs:[cidr]},{interfaces});return store;}
 const options={interfaces,remoteAddress:peer};

 await t.test('disabled by default, only exact current private interface networks and configured address can enable',()=>{
  const store=storeFor('scope',false);try{
   assert.deepEqual(lanJoinPolicy(store),{enabled:false,allowed_cidrs:[]});assert.throws(()=>assertLanJoinAllowed(store,config,peer,{interfaces}),error=>error.status===401);
   assert.throws(()=>createLanJoinLink(store,config,{interfaces}));
   for(const ranges of [[],['0.0.0.0/0'],['127.0.0.0/8'],['100.64.0.0/10'],['8.8.8.0/24'],['192.168.0.0/16'],[peer+'/24'],[cidr,cidr]])assert.throws(()=>configureLanJoin(store,config,{enabled:true,allowed_cidrs:ranges},{interfaces}));
   assert.throws(()=>configureLanJoin(store,config,{enabled:true,allowed_cidrs:[cidr],unknown:true},{interfaces}));
   assert.throws(()=>configureLanJoin(store,{...config,hub_url:'https://192.168.250.251:19221'},{enabled:true,allowed_cidrs:[cidr]},{interfaces}));
   configureLanJoin(store,config,{enabled:true,allowed_cidrs:[cidr]},{interfaces});assert(lanJoinStatus(store,config,{interfaces}).active);
   assertLanJoinAllowed(store,config,peer,{interfaces});assertLanJoinAllowed(store,config,'::ffff:'+peer,{interfaces});assert.equal(normalizePeerAddress('::FFFF:'+peer),peer);
   for(const source of ['127.0.0.1','::1','8.8.8.8','100.64.0.1','::ffff:8.8.8.8','fe80::1','::ffff:c0a8:1','192.168.999.1','attacker.invalid'])assert.throws(()=>assertLanJoinAllowed(store,config,source,{interfaces}),error=>error.status===401);
   assert.throws(()=>assertLanJoinAllowed(store,config,peer,{interfaces:{}}),error=>error.status===401);assert.equal(lanJoinStatus(store,config,{interfaces:{}}).active,false);
   const changed={synthetic:[{...selected,address:selected.address.split('.').slice(0,3).join('.')+'.253'}]};if(changed.synthetic[0].address!==peer)assert.throws(()=>assertLanJoinAllowed(store,config,peer,{interfaces:changed}),error=>error.status===401);
   configureLanJoin(store,config,{enabled:false,allowed_cidrs:[]},{interfaces:{}});assert.throws(()=>assertLanJoinAllowed(store,config,peer,{interfaces}),error=>error.status===401);
   assert.equal(store.devices().length,0);
  }finally{store.close();}
 });

 await t.test('public bootstrap is fixed to official source and has exactly public fields',()=>{
  const store=storeFor('link');try{const output=createLanJoinLink(store,config,{interfaces}),url=new URL(output.url);assert.equal(url.origin+url.pathname,'https://github.com/zhoudebao6-art/worktrace-skills/tree/main');assert(url.hash.startsWith('#worktrace-join=v1.'));
   const payload=JSON.parse(Buffer.from(url.hash.slice('#worktrace-join=v1.'.length),'base64url'));assert.deepEqual(payload,{format:'worktrace.lan-link/1.0',hub_url:config.hub_url,org_id:config.org_id,org_name:config.org_name,ca_pem:config.ca_pem});
   for(const value of ['cert_password','PRIVATE KEY','request_secret','device_token'])assert(!JSON.stringify(output).includes(value));assert.equal(store.devices().length,0);
  }finally{store.close();}
 });

 await t.test('request id and both independent secrets bind one device and all identity fields',()=>{
  const store=storeFor('identity');try{const input=inputFor(config),enrollment=enrollLanDevice(store,config,input,options);assert.equal(enrollment.format,'worktrace.enrollment/1.0');assert.equal(enrollment.device_token,input.device_token);assert.deepEqual(enrollLanDevice(store,config,input,options),enrollment);assert.equal(store.devices().length,1);
   for(const patch of [{request_secret:secret()},{device_token:secret()},{employee_id:'SYNTHETIC-OTHER'},{employee_name:'OTHER NAME'},{label:'OTHER PC'},{hub_url:'https://192.168.250.251:19221'},{org_id:uuid()}])assert.throws(()=>enrollLanDevice(store,config,{...input,...patch},options),error=>error.status===401);
   assert.throws(()=>enrollLanDevice(store,config,{...input,request_id:uuid()},options),error=>error.status===409);
   assert.throws(()=>enrollLanDevice(store,config,{...input,request_id:uuid(),request_secret:secret(),employee_id:'SYNTHETIC-TOKEN-REUSE'},options),error=>error.status===409);
   const row=store.db.prepare('SELECT * FROM lan_join_requests').get();assert.equal(row.request_secret_hash,hash(input.request_secret));assert.equal(row.device_token_hash,hash(input.device_token));assert.equal(store.device(enrollment.device_id).token_hash,hash(input.device_token));
   for(const sensitive of [input.request_secret,input.device_token])assert(!JSON.stringify(row).includes(sensitive));
   configureLanJoin(store,config,{enabled:false,allowed_cidrs:[cidr]},{interfaces});assert.throws(()=>enrollLanDevice(store,config,input,options),error=>error.status===401);
   configureLanJoin(store,config,{enabled:true,allowed_cidrs:[cidr]},{interfaces});store.db.prepare('UPDATE devices SET revoked=1 WHERE device_id=?').run(enrollment.device_id);
   assert.throws(()=>enrollLanDevice(store,config,input,options),error=>error.status===401);assert.throws(()=>enrollLanDevice(store,config,inputFor(config),options),error=>error.status===409);assert.equal(store.devices().length,1);assert.equal(store.stats().events,0);
  }finally{store.close();}
 });

 await t.test('input errors and transaction failures cannot leave partial identities or audits',()=>{
  const store=storeFor('atomic');try{const input=inputFor(config);
   for(const bad of [{},{...input,device_token:input.request_secret},{...input,request_secret:'x'.repeat(43)},{...input,request_id:'invalid'},{...input,employee_id:'bad id'},{...input,employee_name:' name '},{...input,label:'a\nb'},{...input,unexpected:true}])assert.throws(()=>enrollLanDevice(store,config,bad,options));assert.equal(store.devices().length,0);
   store.db.exec("CREATE TRIGGER synthetic_reject_lan BEFORE INSERT ON lan_join_requests BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");assert.throws(()=>enrollLanDevice(store,config,input,options),/synthetic failure/);assert.equal(store.devices().length,0);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='device.register'").get().n,0);
   store.db.exec('DROP TRIGGER synthetic_reject_lan');enrollLanDevice(store,config,input,options);assert.equal(store.devices().length,1);
  }finally{store.close();}
 });

 await t.test('private retry survives reopening the database without stored plaintext secrets',()=>{
  const name='restart',store=storeFor(name),input=inputFor(config),enrollment=enrollLanDevice(store,config,input,options);store.close();const reopened=new Store(join(dir,name,'test.sqlite'));
  try{assert.deepEqual(enrollLanDevice(reopened,config,input,options),enrollment);assert.equal(reopened.devices().length,1);}finally{reopened.close();}
 });

 await t.test('real HTTPS is disabled until local config; LAN enrollment, sync, caps and management boundary',async()=>{
  const input=inputFor(config);assert.equal((await request(config,input)).status,401);
  const file=join(dir,'lan-policy.json');writeFileSync(file,JSON.stringify({enabled:true,allowed_cidrs:[cidr]}));assert.deepEqual(await admin({command:'lan-join-configure',role:'hub',dir:hub.dir,input:file}),{enabled:true,allowed_cidrs:[cidr]});assert((await admin({command:'lan-join-status',role:'hub',dir:hub.dir})).active);assert((await admin({command:'lan-join-link',role:'hub',dir:hub.dir})).url.includes('#worktrace-join=v1.'));
  const first=await request(config,input);assert.equal(first.status,200);assert.deepEqual((await request(config,input)).body,first.body);assert.equal(hub.store.devices().length,1);
  assert.equal((await request(config,{...input,request_secret:secret()})).status,401);
  assert.equal((await request(config,{}, {headers:{'X-Forwarded-For':peer},hostname:'127.0.0.1'})).status,401);
  const competing=inputFor(config,{employee_id:'SYNTHETIC-LAN-002'}),results=await Promise.all([request(config,competing),request(config,{...competing,request_id:uuid(),request_secret:secret(),device_token:secret()})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(hub.store.devices().length,2);
  assert.equal((await request(config,null,{raw:' '.repeat(8193)})).status,413);assert.equal((await request(config,null,{raw:' '.repeat(8193),chunked:true})).status,413);assert.equal((await request(config,null,{raw:'{broken'})).status,400);
  const sync={org_id:config.org_id,device_id:first.body.device_id,installation_id:uuid(),events:[],assets:[],policies:[]},headers={'Authorization':'Bearer '+input.device_token,'X-Worktrace-Device':first.body.device_id};assert.equal((await request(config,sync,{path:'/v1/sync',headers})).status,200);assert.equal((await request(config,{...sync,device_id:uuid()},{path:'/v1/sync',headers})).status,400);
  assert.notEqual((await request(config,{},{path:'/api/lan-join/configure',headers})).status,200);const localOrigin=new URL(hub.url).origin;assert.notEqual((await fetch(localOrigin+'/api/lan-join')).status,200);
  let limited=false;for(let n=0;n<13;n++){const value=await request(config,{});if(value.status===429){assert.equal(value.headers['retry-after'],'60');limited=true;break;}}assert(limited);assert.equal(hub.store.stats().events,0);assert.equal(hub.status().collection.enabled,false);
 });
});
