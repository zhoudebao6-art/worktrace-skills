import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {startApp} from '../src/server.mjs';
import {admin} from '../src/admin-cli.mjs';
import {readiness} from '../src/readiness.mjs';
import {definitions} from '../src/mcp.mjs';
import {uuid} from '../src/protocol.mjs';
const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-readiness-tests');mkdirSync(base,{recursive:true});
async function api(a,path,data){const r=await fetch(new URL('/api/'+path,a.url),{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
const minimal={summary:'合成样例，证据不足。',coverage:'metadata_only',limitations:['SYNTHETIC'],procedures:[],open_questions:[]};
test('readiness distinguishes a running service, real evidence and an unverified personal summary; manual save writes a report',async t=>{
 const dir=mkdtempSync(join(base,'run-')),a=await startApp({dir,port:0});t.after(async()=>{await a.close();if(resolve(dir).startsWith(base+sep))rmSync(dir,{recursive:true,force:true});});
 assert((await api(a,'readiness')).findings.some(x=>x.code==='not_configured'));
 await api(a,'setup',{role:'collector',offline:{format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC',employee_id:'TEST',employee_name:'SYNTHETIC',label:'SYNTHETIC'}});
 a.collector.record('collector.started',{reason:'SYNTHETIC status only'});let report=await admin({command:'readiness',role:'collector',dir});assert.equal(report.devices[0].evidence_count,0);assert(report.findings.some(x=>x.code==='metadata_only_scope'));
 a.collector.record('activity.snapshot',{capture_status:'activity_only',text:''});report=await api(a,'readiness');assert.equal(report.devices[0].needs_personal_summary,true);assert.equal(report.devices[0].evidence_count,1);assert.equal(report.mode,'offline');assert(report.storage.database_bytes>0);
 const batch=(await api(a,'personal/next',{})).batch,result=await api(a,'personal/save',{batch_id:batch.batch_id,digest:batch.digest,result:minimal});assert.equal(result.saved,true);assert.equal(result.daily_report.derived_from_database,true);assert(readFileSync(result.daily_report.path,'utf8').includes('合成样例'));
 report=await api(a,'readiness');assert.equal(report.devices[0].personal_summary_count,1);assert.equal(report.devices[0].needs_personal_summary,false);assert(report.limitations.some(x=>x.includes('不代表岗位已学会')));
 await assert.rejects(()=>api(a,'readiness?device_id='+uuid()),/本设备/);await assert.rejects(()=>api(a,'readiness?limit=1000'),/分页无效/);assert(definitions.some(x=>x.name==='worktrace_readiness'));
 const other={...a.config,device_id:uuid(),employee_id:'RAW_ONLY'};a.store.addDevice(other);const raw=JSON.parse(a.store.db.prepare("SELECT json FROM events WHERE event_type='activity.snapshot'").get().json);a.store.append({...raw,event_id:uuid(),device_id:other.device_id,employee_id:other.employee_id});
 const hub=readiness(a.store,{role:'hub',org_id:a.config.org_id},{dir,status:{...a.status(),worker:null},query:{device_id:other.device_id}});assert.equal(hub.devices[0].needs_personal_summary,true);assert(hub.findings.find(x=>x.code==='personal_summary_missing').next_action.includes('source=all'));assert.equal(hub.pagination.total,1);
 const page=readiness(a.store,{role:'hub',org_id:a.config.org_id},{dir,status:{...a.status(),worker:null},query:{limit:1}});assert.equal(page.devices.length,1);assert.equal(page.pagination.has_more,true);
});
