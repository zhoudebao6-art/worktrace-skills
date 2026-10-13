import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {admin} from '../src/admin-cli.mjs';
import {Store} from '../src/store.mjs';
import {uuid,openBundle} from '../src/protocol.mjs';

const temp=resolve(process.env.TEMP||'../../work','worktrace-integration-v03');mkdirSync(temp,{recursive:true});
const freePort=()=>new Promise(ok=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>ok(port));});});
const from='2026-10-13T00:00:00.000Z',to='2026-10-14T00:00:00.000Z';
const aw={buckets:{'window_SYNTHETIC-PC':{id:'window_SYNTHETIC-PC',type:'currentwindow',client:'aw-watcher-window',hostname:'SYNTHETIC-PC',events:[{timestamp:'2026-10-13T01:00:00Z',duration:30,data:{app:'synthetic.exe',title:'合成化工材料'}}]}}};
const screen={data:[{type:'OCR',content:{frame_id:1,text:'合成化工样例：缺少反应温度记录。',timestamp:'2026-10-13T01:01:00Z',app_name:'synthetic.exe',window_name:'合成材料'}}],pagination:{offset:0,limit:10,total:1}};

test('外部导入经真实本机 API、CLI、HTTPS、MCP 检索及加密移交保留来源和身份',async t=>{
 const dir=mkdtempSync(join(temp,'flow-')),apps=[];let child,reader,restored;
 t.after(async()=>{if(child){child.kill();if(child.exitCode===null)await new Promise(ok=>child.once('exit',ok));}reader?.close();restored?.close();for(const app of apps.reverse())await app.close();if(resolve(dir).startsWith(temp+'\\'))rmSync(dir,{recursive:true,force:true});});
 const api=async(app,path,body,ok=true)=>{const r=await fetch(new URL('/api/'+path,app.url),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.ok,ok,JSON.stringify(result));return result;};
 const hub=await startApp({dir:join(dir,'hub'),port:0});apps.push(hub);
 await api(hub,'setup',{role:'hub',org_name:'SYNTHETIC ONLY',address:'127.0.0.1',hub_port:await freePort()});
 const enrollment=await api(hub,'devices',{employee_id:'CHEM-TEST',employee_name:'SYNTHETIC',label:'SYNTHETIC-PC'});
 const other=await api(hub,'devices',{employee_id:'OTHER-TEST',employee_name:'OTHER SYNTHETIC',label:'OTHER-PC'});
 const node=await startApp({dir:join(dir,'collector'),port:0});apps.push(node);await api(node,'setup',{role:'collector',enrollment});
 const options={source:'activitywatch',source_instance:'SYNTHETIC-PC',timezone:'Asia/Shanghai',from,to};
 const preview=await api(node,'import/external',{...options,input:aw,dry_run:true});assert.equal(preview.event_count,1);assert.equal(node.store.stats().events,0);
 const inputFile=join(dir,'options.json'),recordsFile=join(dir,'synthetic-export.json');writeFileSync(inputFile,JSON.stringify(options));writeFileSync(recordsFile,JSON.stringify(aw));
 const receipt=await admin({command:'import-external',role:'collector',dir:node.dir,input:inputFile,records:recordsFile});assert.equal(receipt.added,1);
 assert.equal((await api(node,'import/external',{...options,input:aw})).duplicates,1);
 const ocr=await api(node,'import/external',{...options,source:'screenpipe',input:screen});assert.equal(ocr.added,1);
 assert.equal(node.collector.enabled,false);assert.equal(node.worker.policy.enabled,false);
 await api(hub,'import/external',{...options,input:aw},false);
 await api(node,'import/external',{...options,input:aw,employee_id:other.employee_id},false);
 const sent=await node.synchronize();assert.equal(sent.sent,2);assert.equal(sent.error,undefined);assert.equal(node.store.stats().pending,0);
 const rows=hub.store.list({employee:enrollment.employee_id}).items;assert.equal(rows.length,2);assert(rows.every(e=>e.schema_version==='1.1'&&e.provenance.read_only));
 const awEvent=rows.find(e=>e.provenance.source==='activitywatch');assert.equal(awEvent.payload.text,'');assert.equal(awEvent.provenance.duration_seconds,30);
 const scope={employee_id:enrollment.employee_id,device_id:enrollment.device_id,from,to};
 const searched=await api(hub,'knowledge/search?'+new URLSearchParams({...scope,include_raw:true,query:'化工'}));assert.equal(searched.layers.raw.length,2);assert.equal(searched.retrieval.model_calls,0);
 await api(node,'knowledge/search?'+new URLSearchParams({...scope,employee_id:other.employee_id,device_id:other.device_id}),undefined,false);
 const read=await admin({command:'knowledge-search',role:'collector',dir:node.dir,input:inputFile}).catch(e=>e);assert(read instanceof Error); // Missing identity/time query scope must not silently broaden.
 child=spawn(process.execPath,['src/mcp.mjs','--data',hub.dir],{cwd:resolve('.'),windowsHide:true,stdio:['pipe','pipe','pipe']});reader=createInterface({input:child.stdout});let sequence=0;const waiting=new Map();
 reader.on('line',line=>{const value=JSON.parse(line);waiting.get(value.id)?.(value.result);waiting.delete(value.id);});
 const rpc=(name,args)=>new Promise((ok,no)=>{const id=++sequence,timer=setTimeout(()=>{waiting.delete(id);no(Error('MCP timeout'));},15000);waiting.set(id,result=>{clearTimeout(timer);ok(result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');});
 const query=await rpc('worktrace_knowledge_search',{...scope,query:'反应温度',include_raw:true});assert(!query.isError);assert.equal(JSON.parse(query.content[0].text).layers.raw.length,1);
 const detail=await rpc('worktrace_knowledge_read',{...scope,layer:'raw',id:ocr.event_ids[0]});assert(!detail.isError);const record=JSON.parse(detail.content[0].text);assert.equal(record.record.external_provenance.source,'screenpipe');assert.equal(record.business_outcome_verified,false);
 const invalid=await rpc('worktrace_candidate_evaluate',{candidate_id:uuid(),idempotency_key:'invalid',cases:[]});assert(invalid.isError);
 const response=await fetch(new URL('/api/export',hub.url),{method:'POST',headers:{Authorization:'Bearer '+hub.token,'Content-Type':'application/json'},body:JSON.stringify({password:'SYNTHETIC-PACK-PASSWORD',filters:{employee:enrollment.employee_id,from,to}})});assert(response.ok);
 const bundle=openBundle(Buffer.from(await response.arrayBuffer()),'SYNTHETIC-PACK-PASSWORD');restored=new Store(join(dir,'restored.sqlite'));restored.addDevice({...enrollment});assert.equal(restored.importBundle(bundle,enrollment.org_id).added,2);
 assert.equal(restored.list().items.find(e=>e.event_id===ocr.event_ids[0]).provenance.source_sha256,rows.find(e=>e.event_id===ocr.event_ids[0]).provenance.source_sha256);
 assert.equal((await node.synchronize()).sent,0);
 // Exercise the whole candidate API with synthetic stored work, never a live model.
 const task=async case_id=>api(node,'work',{event_type:'task.created',case_id,payload:{task_id:uuid(),task_type:'draft.initial_review',title:'合成验收任务',customer_id:'SYNTHETIC',input_summary:'合成化工样例',acceptance_criteria:['核对参考'],authority_profile:'draft_only'}});
 const train=await task('TRAIN-SYNTHETIC'),batch=(await api(node,'personal/next',{})).batch;
 const claim={text:'仅依据合成输入整理草稿',basis:'observed',evidence_event_ids:[train.event_id]};
 const saved=await api(node,'personal/save',{batch_id:batch.batch_id,digest:batch.digest,result:{summary:'合成化工草稿方法',coverage:'content',limitations:['仅合成记录'],procedures:[{name:'合成草稿',task_id:train.payload.task_id,case_id:train.context.case_id,trigger:claim,inputs:claim,steps:[{action:claim,decision:claim,check:claim}],outcome:{text:'实际结果未核验',basis:'unknown',evidence_event_ids:[]},exceptions:[],corrections:[],gaps:['无业务执行器']}],open_questions:[]}});
 assert.equal((await node.synchronize()).error,undefined);
 const analysis=(await api(hub,'analysis/next',{source:'personal'})).batch;await api(hub,'analysis/save',{batch_id:analysis.batch_id,digest:analysis.digest,result:{summary:'合成候选',findings:[{statement:'保留来源',basis:'observed',evidence_event_ids:[saved.event_id]}],open_questions:[]}});
 const list=await api(hub,'candidates'),candidate=(await api(hub,'candidates?candidate_id='+list[0].candidate_id))[0];
 const cases=[];
 for(const [kind,expected_behavior,expected_text] of [['normal','draft','合成草稿'],['missing_input','request_input','请补充合成缺项'],['counterexample','halt','合成反例，停止处理']]){
  const origin=await task('HELDOUT-'+kind),task_id=origin.payload.task_id,case_id=origin.context.case_id,input_event_ids=[origin.event_id];
  const version=async(content_text,source_kind,versionKind)=>api(node,'work',{event_type:'artifact.version',case_id,payload:{task_id,artifact_id:uuid(),version:1,kind:versionKind,content_text,source_kind,parent_event_id:null}});
  const reference=await version(JSON.stringify({format:'worktrace.candidate-reference/1.0',candidate_id:candidate.candidate_id,candidate_hash:candidate.definition_sha256,kind,expected_behavior,input_event_ids,expected_text}),'human','review');
  const output=await version(expected_text,'ai','draft');
  const feedback=await api(node,'work',{event_type:'artifact.feedback',case_id,payload:{task_id,artifact_event_id:output.event_id,decision:'adopted',reason:'合成测试声明，不代表真实员工确认',reason_source:'user_confirmed'}});
  cases.push({kind,task_id,input_event_ids,reference_event_id:reference.event_id,output_event_id:output.event_id,feedback_event_id:feedback.event_id});
 }
 assert.equal((await node.synchronize()).error,undefined);
 const evaluation=await rpc('worktrace_candidate_evaluate',{candidate_id:candidate.candidate_id,idempotency_key:'integration-case-v1',cases});assert(!evaluation.isError,JSON.stringify(evaluation));
 const evaluated=JSON.parse(evaluation.content[0].text);assert.equal(evaluated.evaluation.status,'offline_evidence_passed');assert.equal(evaluated.execution_ready,false);
 const history=await rpc('worktrace_candidate_evaluations',{candidate_id:candidate.candidate_id});assert(!history.isError);assert.equal(JSON.parse(history.content[0].text).length,1);
 const revise=await rpc('worktrace_candidate_revise',{candidate_id:candidate.candidate_id,expected_definition_sha256:candidate.definition_sha256,idempotency_key:'integration-revision-v2',skill_md:candidate.skill_md+'\n缺少化工输入时保留待核验状态。\n',loop:{...candidate.loop,held_out_evaluation:'pending'},reason:'合成修订：明确缺少输入时的等待条件'});assert(!revise.isError,JSON.stringify(revise));assert.equal(JSON.parse(revise.content[0].text).current_evaluation_status,'pending');
 const revisions=await rpc('worktrace_candidate_revisions',{candidate_id:candidate.candidate_id});assert(!revisions.isError);assert.equal(JSON.parse(revisions.content[0].text).length,1);
 const old=await rpc('worktrace_candidate_evaluate',{candidate_id:candidate.candidate_id,idempotency_key:'integration-case-v1',cases});assert(!old.isError);assert.equal(JSON.parse(old.content[0].text).current_evaluation_status,'pending');
});
