import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmdirSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {startApp} from '../src/server.mjs';
import {acquireRuntimeLock,acquireIdentityLock,RuntimeTasks} from '../src/runtime-lifecycle.mjs';
import {uuid} from '../src/protocol.mjs';
const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-lifecycle-tests');mkdirSync(base,{recursive:true});
async function api(a,path,data){const r=await fetch(new URL('/api/'+path,a.url),{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
const identity={format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC',employee_id:'SYNTHETIC',employee_name:'SYNTHETIC',label:'SYNTHETIC'};
function fixture(t){const dir=mkdtempSync(join(base,'run-')),apps=[];t.after(async()=>{for(const a of apps.reverse())await a.close();if(resolve(dir).startsWith(base+sep))rmSync(dir,{recursive:true,force:true});});return {dir,apps};}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('a data directory has one owner; failed duplicate does not replace discovery or disturb its service',async t=>{
 const f=fixture(t),dir=join(f.dir,'data'),a=await startApp({dir,port:0});f.apps.push(a);const running=readFileSync(join(dir,'running.json'),'utf8');
 await assert.rejects(()=>startApp({dir,port:0}),/runtime_already_owned/);
 assert.equal(readFileSync(join(dir,'running.json'),'utf8'),running);assert.equal((await api(a,'status')).configured,false);
 await a.close();assert(!existsSync(join(dir,'running.json')));const b=await startApp({dir,port:0});f.apps.push(b);assert.equal((await api(b,'status')).configured,false);
});
test('same collector identity in a copied directory is rejected before creating its evidence database',async t=>{
 const f=fixture(t),a=await startApp({dir:join(f.dir,'a'),port:0});f.apps.push(a);await api(a,'setup',{role:'collector',offline:identity});
 const copy=join(f.dir,'copy');mkdirSync(copy);writeFileSync(join(copy,'config.json'),JSON.stringify(a.config));
 await assert.rejects(()=>startApp({dir:copy,port:0}),/runtime_identity_active|runtime_already_owned/);assert(!existsSync(join(copy,'worktrace.sqlite')));assert.equal((await api(a,'status')).device_id,a.config.device_id);
 await a.close();const release=await acquireIdentityLock(a.config);await release();
});
test('startup listener failure releases ownership and does not leave a second live service',async t=>{
 const f=fixture(t),a=await startApp({dir:join(f.dir,'a'),port:0});f.apps.push(a);const dir=join(f.dir,'b');
 await assert.rejects(()=>startApp({dir,port:a.server.address().port}),/EADDRINUSE/);const b=await startApp({dir,port:0});f.apps.push(b);assert.equal((await api(b,'status')).configured,false);
});
test('missing config cannot initialize over existing evidence and identity',async t=>{
 const f=fixture(t),a=await startApp({dir:join(f.dir,'data'),port:0});f.apps.push(a);a.store.addDevice({org_id:uuid(),device_id:uuid(),employee_id:'OLD',employee_name:'OLD',label:'OLD'});
 await assert.rejects(()=>api(a,'setup',{role:'collector',offline:identity}),/existing_data_without_config/);assert.equal(a.store.devices().length,1);assert(!existsSync(join(a.dir,'config.json')));
});
test('failed first config write rolls back new enrollment, releases identity, and can retry after repair',async t=>{
 const f=fixture(t),a=await startApp({dir:join(f.dir,'data'),port:0});f.apps.push(a);const blocker=join(a.dir,'config.json.tmp');mkdirSync(blocker);
 await assert.rejects(()=>api(a,'setup',{role:'collector',offline:identity}),/EISDIR|EPERM|EACCES/);
 assert.equal(a.store.devices().length,0);assert(!existsSync(join(a.dir,'config.json')));assert.equal(a.config,null);
 rmdirSync(blocker);await api(a,'setup',{role:'collector',offline:identity});assert.equal(a.store.devices().length,1);assert.equal(a.config.role,'collector');
});
test('failed hub config write closes its TLS listener and leaves a retryable local service',async t=>{
 const f=fixture(t),a=await startApp({dir:join(f.dir,'hub'),port:0});f.apps.push(a);const blocker=join(a.dir,'config.json.tmp');mkdirSync(blocker);
 const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const input={role:'hub',org_name:'SYNTHETIC',address:'127.0.0.1',hub_port:port};await assert.rejects(()=>api(a,'setup',input),/EISDIR|EPERM|EACCES/);
 assert.equal(a.config,null);assert.equal(a.store.devices().length,0);assert.equal((await api(a,'status')).configured,false);
 await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(port,'127.0.0.1',resolve);});await new Promise(resolve=>listener.close(resolve));
 rmdirSync(blocker);await api(a,'setup',input);assert.equal(a.config.role,'hub');assert(existsSync(join(a.dir,'config.json')));
});
test('OS releases both identity and directory ownership after an abrupt process exit',async t=>{
 const f=fixture(t),dir=join(f.dir,'child');mkdirSync(dir);const c={org_id:uuid(),device_id:uuid()},moduleUrl=pathToFileURL(resolve('src/runtime-lifecycle.mjs')).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireRuntimeLock,acquireIdentityLock} from ${JSON.stringify(moduleUrl)};const owned=[acquireRuntimeLock(process.argv[1]),await acquireIdentityLock(JSON.parse(process.argv[2]))];process.stdout.write('ready');setInterval(()=>{if(owned.length!==2)process.exit(9);},1000);`,dir,JSON.stringify(c)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());await once(child.stdout,'data');assert.throws(()=>acquireRuntimeLock(dir),/runtime_already_owned/);await assert.rejects(()=>acquireIdentityLock(c),/runtime_identity_active|runtime_already_owned/);
 const exited=once(child,'exit');child.kill();await exited;const release=acquireRuntimeLock(dir),releaseId=await acquireIdentityLock(c);await releaseId();release();
});
test('shared task slots coalesce callers, drain the original operation and retain failure diagnostics',async()=>{
 const tasks=new RuntimeTasks(),gate=deferred();let calls=0,drained=false;
 const first=tasks.run('files',()=>{calls++;return gate.promise;});assert.equal(tasks.run('files',()=>{calls++;}),first);tasks.stop();const draining=tasks.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(calls,1);assert.equal(drained,false);assert.equal((await tasks.run('files',()=>{})).reason,'service_stopping');gate.resolve('done');assert.equal(await first,'done');await draining;assert.equal(tasks.snapshot().tasks.files.running,false);
 const failures=new RuntimeTasks();failures.launch('sync',()=>{throw Error('SYNTHETIC failure');});await failures.drain();assert.equal(failures.snapshot().tasks.sync.last_error,'SYNTHETIC failure');
});
test('shutdown aborts sync and waits for a late transport without advancing its cursor or closing SQLite early',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();let signal;
 const a=await startApp({dir:join(f.dir,'data'),port:0,syncTransport:async(c,p,o)=>{signal=o.signal;entered.resolve();await gate.promise;return {event_ids:p.events.map(e=>e.event_id)};}});f.apps.push(a);await api(a,'setup',{role:'collector',offline:identity});a.config.connection_mode='hub';a.collector.record('activity.snapshot',{text:'SYNTHETIC',capture_status:'uia'});
 const syncing=a.synchronize();await entered.promise;let closed=false;const closing=a.close().then(()=>{closed=true;});await Promise.resolve();assert(signal.aborted);assert.equal(closed,false);assert.equal(a.store.stats().events,1);assert.equal(a.store.get('sync_cursor'),null);gate.resolve();assert.equal((await syncing).error,'service_stopping');await closing;
 const b=await startApp({dir:a.dir,port:0});f.apps.push(b);assert.equal(b.store.get('sync_cursor'),null);assert.equal(b.store.stats().events,1);
});
