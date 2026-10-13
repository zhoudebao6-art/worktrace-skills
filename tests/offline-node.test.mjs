import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {admin} from '../src/admin-cli.mjs';
import {uuid} from '../src/protocol.mjs';
const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-offline-node');mkdirSync(base,{recursive:true});
async function api(a,path,data){const r=await fetch(new URL('/api/'+path,a.url),{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
const free=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
const identity={format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC CHEM',employee_id:'CHEM_TEST',employee_name:'合成员工',label:'合成设备'};
test('offline first enrollment, persisted identity, no hub credentials/listener or retry; restart is safe',async t=>{
 const dir=mkdtempSync(join(base,'node-'));let app=await startApp({dir,port:0});t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const input=join(dir,'test-identity.json');writeFileSync(input,JSON.stringify(identity));let status=await admin({command:'init',role:'collector',dir,input});assert.equal(status.connection_mode,'offline');assert.equal(status.role,'collector');assert.equal(status.collection.enabled,false);assert.equal(status.worker.policy.enabled,false);assert.equal(status.files.policy.enabled,false);
 assert.deepEqual(await app.synchronize(),{skipped:true,mode:'offline',reason:'离线记录，等待人工移交'});assert.equal(status.sync.last_success,null);assert.equal(existsSync(join(dir,'hub.pfx')),false);
 const saved=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));for(const key of ['hub_url','device_token','ca_pem','cert_password'])assert.equal(Object.hasOwn(saved,key),false);const stream=app.store.get('stream_id');
 app.collector.record('activity.snapshot',{capture_status:'uia',text:'合成化工资料：配比待核对，不代表实验结果。'});
 await assert.rejects(()=>api(app,'setup',{role:'collector',offline:identity}),/重复初始化/);await app.close();app=await startApp({dir,port:0});assert.equal(app.config.device_id,saved.device_id);assert.equal(app.store.get('stream_id'),stream);assert.equal(app.status().stats.events,1);assert.equal((await app.synchronize()).mode,'offline');
});
test('new hub can explicitly adopt original offline company/device, conflicting company or identity rejected',async t=>{
 const dir=mkdtempSync(join(base,'adopt-')),apps=[];t.after(async()=>{for(const app of apps.reverse())await app.close();rmSync(dir,{recursive:true,force:true});});
 const node=await startApp({dir:join(dir,'node'),port:0});apps.push(node);await api(node,'setup',{role:'collector',offline:identity});const original={...node.config,stream_id:node.store.get('stream_id')};
 const hub=await startApp({dir:join(dir,'hub'),port:0});apps.push(hub);await api(hub,'setup',{role:'hub',org_name:original.org_name,address:'127.0.0.1',hub_port:await free(),offline_identity:original});assert.equal(hub.config.org_id,original.org_id);assert.equal(hub.store.device(original.device_id).token_hash,null);assert.equal((await api(hub,'offline/adopt-device',original)).already_registered,true);
 await assert.rejects(()=>api(hub,'offline/adopt-device',{...original,org_id:uuid()}),/公司编号不同/);await assert.rejects(()=>api(hub,'offline/adopt-device',{...original,employee_id:'OTHER'}),/冲突/);
});
