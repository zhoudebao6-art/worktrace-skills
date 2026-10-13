import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.mjs';
import {uuid,hash} from '../src/protocol.mjs';
import {Collector,defaultPolicy} from '../src/collector.mjs';
import {nextPersonal,savePersonal,personalHistory,learningStatus} from '../src/learning.mjs';
import {addWork} from '../src/work.mjs';
import {startApp} from '../src/server.mjs';
const temp=resolve(process.env.TEMP||'../../work','worktrace-optimization');mkdirSync(temp,{recursive:true});
const minimal={summary:'活动记录不足以还原业务做法',coverage:'metadata_only',limitations:['只见应用元数据'],procedures:[],open_questions:['需要实际任务输入、决策和结果']};
function fixture(t){const dir=mkdtempSync(join(temp,'fixture-'));let s=new Store(join(dir,'db.sqlite'));t.after(()=>{s.close();if(resolve(dir).startsWith(temp+'\\'))rmSync(dir,{recursive:true,force:true});});const c={role:'collector',org_id:uuid(),device_id:uuid(),employee_id:'TEST'};s.addDevice({...c,employee_name:'TEST',label:'TEST'});const append=(text='',at='2026-10-13T01:00:00.000Z')=>s.append({schema_version:'1.0',event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:uuid(),occurred_at:at,timezone:'Asia/Shanghai',event_type:'activity.snapshot',collector_version:'0.2.0',policy_hash:s.policy(defaultPolicy),app:{process_name:'fixture.exe',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{text,capture_status:text?'uia':'activity_only',idle_seconds:0,truncated:false,reason:''},attachments:[]});return {get s(){return s;},c,dir,append,reopen(){s.close();s=new Store(join(dir,'db.sqlite'));}};}
test('200 条重复元数据聚合，正文变化独立保留，领取恢复且无自我学习',t=>{
 const f=fixture(t);for(let i=0;i<200;i++)f.append('',new Date(Date.UTC(2026,9,13,1,0,i)).toISOString());const first=f.append('第一份客户正文');const second=f.append('第二份客户正文');
 assert.equal(learningStatus(f.s,f.c).raw_unassigned,202);const b=nextPersonal(f.s,f.c).batch;assert.equal(b.events.length,3);assert.equal(b.source_coverage.new_events,202);assert.equal(b.source_coverage.metadata_groups[0].count,200);assert(b.events.some(e=>e.event_id===first.event_id)&&b.events.some(e=>e.event_id===second.event_id));f.reopen();assert.equal(nextPersonal(f.s,f.c).batch.batch_id,b.batch_id);
 savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});assert.equal(learningStatus(f.s,f.c).raw_unassigned,0);assert.equal(nextPersonal(f.s,f.c).batch,null);assert.equal(personalHistory(f.s)[0].details_omitted,true);assert.equal(personalHistory(f.s,{include_details:true,limit:1})[0].payload.source_coverage.new_events,202);
});
test('新批次自动补回任务起点和人工修改前版，时区沿用本机策略',t=>{
 const f=fixture(t);f.s.set('policy',{...defaultPolicy,timezone:'Asia/Tokyo'});const tid=uuid();const created=addWork(f.s,f.c,'task.created',{task_id:tid,task_type:'customer.progress_followup',title:'合成案例',customer_id:'TEST',input_summary:'测试',acceptance_criteria:['核对事实'],authority_profile:'draft_only'},'TEST-CASE');assert.equal(created.timezone,'Asia/Tokyo');let b=nextPersonal(f.s,f.c).batch;savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});const v1=addWork(f.s,f.c,'artifact.version',{task_id:tid,artifact_id:uuid(),version:1,kind:'reply',content_text:'合成 AI 稿件',source_kind:'ai',parent_event_id:null},'TEST-CASE');b=nextPersonal(f.s,f.c).batch;savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});const v2=addWork(f.s,f.c,'artifact.version',{...v1.payload,version:2,content_text:'合成人工改稿',source_kind:'human',parent_event_id:v1.event_id},'TEST-CASE');b=nextPersonal(f.s,f.c,{limit:1}).batch;assert(b.events.some(e=>e.event_id===created.event_id));assert(b.events.some(e=>e.event_id===v1.event_id));assert(b.events.some(e=>e.event_id===v2.event_id));assert.equal(b.source_coverage.new_events,1);assert.equal(b.source_coverage.context_events,2);
});
test('图像发生变化时不会被相同 UIA 文字去重吞掉；无效策略不暂停采集',t=>{
 const f=fixture(t),c=new Collector({store:f.s,config:f.c,dir:f.dir,root:resolve('.')});c.enabled=true;c.policy={...defaultPolicy,screenshots:true,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59'};
 const image=n=>Buffer.from([255,216,n,255,217]).toString('base64');const sample={text:'同一可访问文字',capture_status:'uia',process_name:'fixture.exe',idle_seconds:0,image:image(1)};c.accept(sample);c.accept({...sample,image:image(2)});assert.equal(f.s.stats().events,2);c.accept({...sample,image:image(2)});assert.equal(f.s.stats().events,2);assert.throws(()=>c.update({...c.policy,interval_seconds:0}));assert.equal(c.enabled,true);c.enabled=false;
});
test('大截图按字节拆包，经真实 HTTPS 全部补传，不在首个短包提前结束',async t=>{
 const dir=mkdtempSync(join(temp,'network-')),apps=[];t.after(async()=>{for(const a of apps.reverse())await a.close();if(resolve(dir).startsWith(temp+'\\'))rmSync(dir,{recursive:true,force:true});});
 const api=async(a,path,data)=>{const r=await fetch(new URL('/api/'+path,a.url),{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:JSON.stringify(data)});const b=await r.json();assert(r.ok,JSON.stringify(b));return b;};const free=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
 const hub=await startApp({dir:join(dir,'hub'),port:0});apps.push(hub);await api(hub,'setup',{role:'hub',org_name:'TEST',address:'127.0.0.1',hub_port:await free()});const enrollment=await api(hub,'devices',{employee_id:'TEST',employee_name:'TEST',label:'TEST'});const c=await startApp({dir:join(dir,'c'),port:0});apps.push(c);await api(c,'setup',{role:'collector',enrollment});
 // Byte transport fixtures, not decoded screenshots or employee content.
 for(let i=0;i<8;i++){const bytes=Buffer.alloc(2*1024*1024,i);bytes[0]=255;bytes[1]=216;bytes[bytes.length-2]=255;bytes[bytes.length-1]=217;const a={sha256:hash(bytes),mime:'image/jpeg',data:bytes.toString('base64')};c.collector.record('activity.snapshot',{capture_status:'uia',text:'SYNTHETIC SIZE TEST'},{process_name:'fixture.exe',window_title:''},[a]);}
 const first=c.store.batch();assert(first.events.length<8);assert(Buffer.byteLength(JSON.stringify(first))<=12*1024*1024);const r=await c.synchronize();assert.equal(r.error,undefined);assert.equal(r.sent,8);assert.equal(c.store.stats().pending,0);assert.equal(hub.store.stats().assets,8);
});
