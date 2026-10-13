import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {startApp} from '../src/server.mjs';
import {uuid,sealBundle,openBundle} from '../src/protocol.mjs';
import {Store} from '../src/store.mjs';
const temp=resolve(process.env.TEMP||'../../work','worktrace-learning-tests');mkdirSync(temp,{recursive:true});
const free=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
async function api(a,path,data){const r=await fetch(new URL('/api/'+path,a.url),{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
function summary(eid){const known=text=>({text,basis:'observed',evidence_event_ids:[eid]}),unknown=text=>({text,basis:'unknown',evidence_event_ids:[]});return {summary:'合成客服案例：缺进度时整理待查项目，不承诺完成时间。',coverage:'content',limitations:['合成样例；没有实际发出消息，也没有案件系统结果。'],procedures:[{name:'案件进度询问草稿',task_id:null,case_id:null,trigger:known('客户询问进度'),inputs:known('现有状态为待查'),steps:[{action:known('打开案件资料并查看状态'),decision:unknown('员工选择该资料的判断理由未记录'),check:unknown('未看到查询成功回执')}],outcome:unknown('只能看到草稿，未验证发送或办结'),exceptions:[unknown('系统不可用时的处理尚无样本')],corrections:[],gaps:['缺发送前核验过程']}],open_questions:['状态从哪一字段读取？']};}
test('个人学习经 MCP 落库、HTTPS 汇总、总控补证闭环、重放幂等及离线导出引用完整',async t=>{
 const dir=mkdtempSync(join(temp,'run-')),apps=[];let child,reader;
 t.after(async()=>{child?.kill();reader?.close();for(const a of apps.reverse())await a.close();if(resolve(dir).startsWith(temp+'\\'))rmSync(dir,{recursive:true,force:true});});
 const hub=await startApp({dir:join(dir,'hub'),port:0});apps.push(hub);await api(hub,'setup',{role:'hub',org_name:'LEARNING SYNTHETIC TEST',address:'127.0.0.1',hub_port:await free()});
 const clients=[];for(let i=1;i<=2;i++){const enrollment=await api(hub,'devices',{employee_id:'TEST'+i,employee_name:'同名员工',label:'TEST'+i});const c=await startApp({dir:join(dir,'node'+i),port:0});apps.push(c);await api(c,'setup',{role:'collector',enrollment});clients.push(c);}
 const c=clients[0];c.collector.record('activity.snapshot',{text:'合成测试：客户询问进度；打开案件资料：待查；形成草稿。',capture_status:'uia'});const raw=c.store.list().items[0];
 child=spawn(process.execPath,['src/mcp.mjs','--data',c.dir],{windowsHide:true,stdio:['pipe','pipe','pipe']});reader=createInterface({input:child.stdout});const waiting=new Map();let seq=0;reader.on('line',l=>{const r=JSON.parse(l);waiting.get(r.id)?.(r.result);waiting.delete(r.id);});
 const call=(name,args={})=>new Promise((ok,no)=>{const id=++seq;const timer=setTimeout(()=>no(Error('MCP timeout')),15000);waiting.set(id,r=>{clearTimeout(timer);r.isError?no(Error(r.content[0].text)):ok(JSON.parse(r.content[0].text));});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');});
 const {batch:b}=await call('worktrace_personal_next');assert.equal((await call('worktrace_personal_next')).batch.batch_id,b.batch_id);
 const p={batch_id:b.batch_id,digest:b.digest,result:summary(raw.event_id)};
 const bad=structuredClone(p);bad.result.procedures[0].steps[0].action.evidence_event_ids=[uuid()];await assert.rejects(()=>call('worktrace_personal_save',bad),/证据/);
 const saved=await call('worktrace_personal_save',p);assert(!saved.duplicate);assert((await call('worktrace_personal_save',p)).duplicate);await assert.rejects(()=>call('worktrace_personal_save',{...p,result:{...p.result,summary:'覆盖'}}),/禁止静默覆盖/);
 assert.equal((await call('worktrace_personal_next')).batch,null);assert(!(await c.synchronize()).error);
 const central=await api(hub,'personal/history?employee=TEST1');assert.equal(central.length,1);assert.equal(central[0].event_id,saved.event_id);assert.equal((await api(clients[1],'personal/history?employee=TEST1')).length,0);
 const analysis=await api(hub,'analysis/next',{source:'personal'});assert.equal(analysis.batch.events.length,1);assert.equal(analysis.batch.events[0].event_type,'learning.summary');
 const analysisResult={batch_id:analysis.batch.batch_id,digest:analysis.batch.digest,result:{summary:'合成方法待核验',findings:[],open_questions:['待留出案例验证']}};const completed=await api(hub,'analysis/save',analysisResult);assert.equal(completed.candidates.length,1);const candidates=await api(hub,'candidates');assert.equal(candidates.length,1);const detail=(await api(hub,'candidates?candidate_id='+candidates[0].candidate_id))[0];assert.equal(detail.loop.max_iterations,3);assert.equal(detail.status,'draft');assert(detail.evidence.raw_event_ids.includes(raw.event_id));assert(detail.skill_md.includes('name: worktrace-candidate-'));await api(hub,'analysis/save',analysisResult);assert.equal((await api(hub,'candidates')).length,1);
 const q={source_event_id:saved.event_id,questions:['状态具体来自哪个字段？只核实现有证据。']};const req=await api(hub,'learning/request',q);assert.equal((await api(hub,'learning/request',q)).request_id,req.request_id);assert(!(await c.synchronize()).error);
 const revise=(await call('worktrace_personal_next')).batch;assert.equal(revise.request.request_id,req.request_id);assert.equal((await api(clients[1],'personal/next',{})).batch,null);
 const answer=await call('worktrace_personal_save',{batch_id:revise.batch_id,digest:revise.digest,request_state:'blocked',result:p.result});assert(!(await c.synchronize()).error);assert.equal(hub.store.db.prepare('SELECT state FROM learning_requests WHERE request_id=?').get(req.request_id).state,'blocked');assert.equal((await call('worktrace_personal_next')).batch,null);
 await assert.rejects(()=>api(hub,'learning/request',{source_event_id:answer.event_id,questions:['继续追问']}),/补证链/);
 await api(hub,'learning/request',{source_event_id:saved.event_id,questions:['第二个不同问题']});await assert.rejects(()=>api(hub,'learning/request',{source_event_id:saved.event_id,questions:['第三个不同问题']}),/最多两次/);
 c.store.set('sync_cursor',0);assert(!(await c.synchronize()).error);assert.equal((await api(hub,'personal/history')).length,2);
 const bundle=c.store.exportBundle(c.config.org_id,{from:central[0].occurred_at});assert(bundle.events.some(e=>e.event_id===raw.event_id));const target=new Store(join(dir,'import.sqlite'));try{target.addDevice(c.store.devices()[0]);const decoded=openBundle(sealBundle(bundle,'test-only-long-password'),'test-only-long-password');target.importBundle(decoded,c.config.org_id);assert.equal(target.importBundle(decoded,c.config.org_id).added,0);}finally{target.close();}
 const foreign=structuredClone(bundle.events.find(e=>e.event_id===saved.event_id));foreign.event_id=uuid();foreign.device_id=clients[1].config.device_id;foreign.employee_id='TEST2';foreign.sequence=999;assert.throws(()=>hub.store.ingest([foreign],[],hub.config.org_id),/本员工本设备/);
 // Arrival order includes delayed raw evidence; no summary analyses itself.
 c.collector.record('activity.snapshot',{text:'晚到合成证据',capture_status:'uia'});const late=(await call('worktrace_personal_next')).batch;assert(late.events.every(e=>e.event_type!=='learning.summary'));
});
test('仅活动元数据的个人记录不得声明理解了内容',async t=>{
 const dir=mkdtempSync(join(temp,'metadata-')),apps=[];t.after(async()=>{for(const a of apps.reverse())await a.close();if(resolve(dir).startsWith(temp+'\\'))rmSync(dir,{recursive:true,force:true});});
 const hub=await startApp({dir:join(dir,'hub'),port:0});apps.push(hub);await api(hub,'setup',{role:'hub',org_name:'TEST',address:'127.0.0.1',hub_port:await free()});const enrollment=await api(hub,'devices',{employee_id:'TEST',employee_name:'TEST',label:'TEST'});const c=await startApp({dir:join(dir,'c'),port:0});apps.push(c);await api(c,'setup',{role:'collector',enrollment});c.collector.record('activity.snapshot',{capture_status:'activity_only'});const b=(await api(c,'personal/next',{})).batch;await assert.rejects(()=>api(c,'personal/save',{batch_id:b.batch_id,digest:b.digest,result:summary(b.events[0].event_id)}),/只有应用元数据/);const minimal={summary:'只观察到应用活动',coverage:'metadata_only',limitations:['没有正文，无法还原客户回复和决策'],procedures:[],open_questions:['需配置并验证业务应用内容采样']};await api(c,'personal/save',{batch_id:b.batch_id,digest:b.digest,result:minimal});assert.equal((await api(c,'personal/next',{})).batch,null);
});
