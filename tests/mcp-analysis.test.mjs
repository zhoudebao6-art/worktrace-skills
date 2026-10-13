import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {uuid,hash} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
const tempRoot=resolve(process.env.TEMP||'../../work','worktrace-tests');mkdirSync(tempRoot,{recursive:true});
const freePort=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
test('总控 MCP 实际 stdio：汇总、按编号取证、增量分析与图片返回',async()=>{
 const dir=mkdtempSync(join(tempRoot,'mcp-'));const hub=await startApp({dir,port:0});let child,reader;
 try{
  const api=async(path,body)=>{const r=await fetch(new URL('/api/'+path,hub.url),{method:'POST',headers:{Authorization:'Bearer '+hub.token,'Content-Type':'application/json'},body:JSON.stringify(body)});const b=await r.json();assert(r.ok,JSON.stringify(b));return b;};
  await api('setup',{role:'hub',org_name:'MCP TEST ONLY',address:'127.0.0.1',hub_port:await freePort()});const dev=await api('devices',{employee_id:'CS001',employee_name:'TEST',label:'TEST'});
  // Minimal JPEG marker fixture checks MCP byte transport; decoded real JPEGs are checked in browser.verify.mjs.
  const bytes=Buffer.from([255,216,255,217]);const asset={sha256:hash(bytes),mime:'image/jpeg',data:bytes.toString('base64')};
  const e=hub.store.append({schema_version:'1.0',event_id:uuid(),org_id:dev.org_id,device_id:dev.device_id,employee_id:dev.employee_id,session_id:uuid(),occurred_at:'2026-10-13T01:00:00.000Z',timezone:'Asia/Shanghai',event_type:'activity.snapshot',collector_version:'0.1.0',policy_hash:hub.store.policy(defaultPolicy),app:{process_name:'fixture.exe',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{text:'TEST '.repeat(200),capture_status:'uia',idle_seconds:0,truncated:false,reason:''},attachments:[{sha256:asset.sha256,mime:asset.mime,size:bytes.length,kind:'window_capture'}]},[asset]);
  child=spawn(process.execPath,['src/mcp.mjs','--data',dir],{cwd:resolve('.'),windowsHide:true,stdio:['pipe','pipe','pipe']});reader=createInterface({input:child.stdout});const waiting=new Map();let next=0;reader.on('line',line=>{const r=JSON.parse(line);waiting.get(r.id)?.(r.result);waiting.delete(r.id);});
  const rpc=(method,params)=>new Promise((ok,no)=>{const id=++next;const timer=setTimeout(()=>{waiting.delete(id);no(Error('MCP timeout'));},30000);waiting.set(id,r=>{clearTimeout(timer);ok(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const call=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.content[0].type==='text'?JSON.parse(r.content[0].text):r.content[0];};
  const available=(await rpc('tools/list')).tools.map(t=>t.name);
  for(const name of ['worktrace_report','worktrace_get_evidence','worktrace_knowledge_search','worktrace_knowledge_read','worktrace_candidate_evaluate','worktrace_candidate_evaluations'])assert(available.includes(name));
  const report=await call('worktrace_report',{from:'2026-10-13T00:00:00.000Z',to:'2026-10-13T23:59:59.999Z'});assert.equal(report.event_count,1);
  const brief=await call('worktrace_read_events');assert(brief.items[0].payload.text_truncated);const full=await call('worktrace_get_evidence',{event_ids:[e.event_id]});assert.equal(full.items[0].payload.text.length,1000);
  const img=await call('worktrace_read_image',{sha256:asset.sha256});assert.equal(img.type,'image');assert.equal(img.data,asset.data);
  const {batch}=await call('worktrace_analysis_next');const result={summary:'测试记录，缺案件信息',findings:[{statement:'样本包含活动记录',basis:'observed',evidence_event_ids:[e.event_id]}],open_questions:['真实业务结果未知']};await call('worktrace_analysis_save',{batch_id:batch.batch_id,digest:batch.digest,result});assert.equal((await call('worktrace_analysis_next')).batch,null);assert.equal((await call('worktrace_analysis_history'))[0].result.summary,result.summary);
 }finally{if(child){child.kill();await new Promise(ok=>child.exitCode!==null?ok():child.once('exit',ok));}reader?.close();await hub.close();if(resolve(dir).startsWith(tempRoot+'\\'))rmSync(dir,{recursive:true,force:true});}
});
