import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Store} from '../src/store.mjs';
import {uuid,canonical} from '../src/protocol.mjs';
import {addWork} from '../src/work.mjs';
import {nextPersonal,savePersonal} from '../src/learning.mjs';
import {nextAnalysis,saveAnalysis} from '../src/analysis.mjs';
import {candidateList,candidateEvaluate,candidateEvaluationHistory,candidateDefinitionHash,candidateRevise,candidateRevisionHistory,candidateRevisionSchema} from '../src/candidates.mjs';
const temp=resolve(process.env.TEMP||'../../work','worktrace-candidate-tests');mkdirSync(temp,{recursive:true});
const modes={normal:'draft',missing_input:'request_input',counterexample:'halt'};
const texts={normal:'合成参考草稿。',missing_input:'输入缺少必要材料，请先补充。',counterexample:'材料相互矛盾，停止并交人工核验。'};
function fixture(t){
 const dir=mkdtempSync(join(temp,'evaluation-'));let s=new Store(join(dir,'test.sqlite'));t.after(()=>{s.close();if(resolve(dir).startsWith(temp+'\\'))rmSync(dir,{recursive:true,force:true});});
 const config={role:'collector',org_id:uuid(),device_id:uuid(),employee_id:'EMP001'};
 s.addDevice({...config,employee_name:'SYNTHETIC',label:'TEST ONLY'});
 const task=(caseId='CASE-'+uuid(),cfg=config)=>{const task_id=uuid(),origin=addWork(s,cfg,'task.created',{task_id,task_type:'draft.initial_review',title:'合成离线样例',customer_id:'SYNTHETIC',input_summary:'合成样例输入，不访问任何桌面或客户材料',acceptance_criteria:['依据预登记的参考检查输出'],authority_profile:'draft_only'},caseId);return {task_id,caseId,origin};};
 const artifact=(a,text,source='ai',kind='draft',cfg=config,previous=null)=>addWork(s,cfg,'artifact.version',{task_id:a.task_id,artifact_id:previous?.payload.artifact_id||uuid(),version:(previous?.payload.version||0)+1,kind,content_text:text,source_kind:source,parent_event_id:previous?.event_id||null},a.caseId);
 const feedback=(a,output,{decision='adopted',reason_source='user_confirmed',cfg=config}={})=>addWork(s,cfg,'artifact.feedback',{task_id:a.task_id,artifact_event_id:output.event_id,decision,reason:'合成测试的人工核验记录，不代表真实业务验收',reason_source},a.caseId);
 const train=task('TRAINING-CASE'),trainingDraft=artifact(train,'合成训练草稿');
 const batch=nextPersonal(s,config,{limit:50}).batch;
 const claim={text:'合成演示观察',basis:'observed',evidence_event_ids:[train.origin.event_id]};
 const summary=savePersonal(s,config,{batch_id:batch.batch_id,digest:batch.digest,result:{summary:'合成方法，仍为候选',coverage:'content',limitations:['未验证业务效果'],procedures:[{name:'合成固定格式草稿',task_id:train.task_id,case_id:train.caseId,trigger:claim,inputs:claim,steps:[{action:claim,decision:claim,check:claim}],outcome:claim,exceptions:[],corrections:[],gaps:['尚无执行适配器']}],open_questions:[]}});
 const analysis=nextAnalysis(s,{source:'personal'}).batch;saveAnalysis(s,{batch_id:analysis.batch_id,digest:analysis.digest,result:{summary:'合成离线测试的总控分析',findings:[{statement:'仅产生候选，不发布',basis:'observed',evidence_event_ids:[summary.event_id]}],open_questions:[]}});
 const c=candidateList(s,{candidate_id:candidateList(s)[0].candidate_id})[0];
 function example(kind,{cfg=config,existingTask=null,caseId,observed=texts[kind],referenceSource='human',feedbackSource='user_confirmed',decision='adopted',lateReference=false,inputs,candidateHash=c.definition_sha256}={}){
  const a=existingTask||task(caseId,cfg),input_event_ids=inputs||[a.origin.event_id];
  const contract={format:'worktrace.candidate-reference/1.0',candidate_id:c.candidate_id,candidate_hash:candidateHash,kind,expected_behavior:modes[kind],input_event_ids,expected_text:texts[kind]};
  let output;if(lateReference)output=artifact(a,observed,'ai',kind==='normal'?'draft':'review',cfg);
  const reference=artifact(a,JSON.stringify(contract),referenceSource,'review',cfg);
  output??=artifact(a,observed,'ai',kind==='normal'?'draft':'review',cfg);
  const review=feedback(a,output,{decision,reason_source:feedbackSource,cfg});
  return {kind,task_id:a.task_id,input_event_ids,output_event_id:output.event_id,reference_event_id:reference.event_id,feedback_event_id:review.event_id,a,output,reference,review};
 }
 const spec=e=>Object.fromEntries(['kind','task_id','input_event_ids','output_event_id','reference_event_id','feedback_event_id'].map(k=>[k,e[k]]));
 const request=(examples,key=uuid())=>({candidate_id:c.candidate_id,org_id:config.org_id,idempotency_key:key,cases:examples.map(spec)});
 const all=()=>Object.keys(modes).map(k=>example(k));
 return {get s(){return s;},c,config,train,trainingDraft,task,artifact,feedback,example,spec,request,all,reopen(){s.close();s=new Store(join(dir,'test.sqlite'));}};
}

test('候选评估：真实存储的三类留出证据通过精确契约，持久化审计但仍不发布',t=>{
 const f=fixture(t),p=f.request(f.all(),'three-kinds');const first=candidateEvaluate(f.s,p);
 assert.equal(first.evaluation.status,'offline_evidence_passed');assert.equal(first.candidate_status,'draft');assert.equal(first.execution_ready,false);assert.equal(first.evaluation.business_effect_verified,false);
 for(const kind of Object.keys(modes))assert.deepEqual(first.evaluation.coverage[kind],{submitted:1,passed:1});
 assert.equal(first.evaluation.training_scope.task_count,1);assert(first.evaluation.cases.every(c=>c.evidence.length>=4&&c.expected_sha256===c.observed_sha256));
 assert(first.evaluation.limitations.some(x=>x.includes('没有独立验证')));f.reopen();
 const repeated=candidateEvaluate(f.s,p);assert.equal(repeated.duplicate,true);assert.equal(repeated.evaluation.evaluation_id,first.evaluation.evaluation_id);
 assert.equal(candidateEvaluationHistory(f.s,{candidate_id:f.c.candidate_id,org_id:f.config.org_id}).length,1);
 const c=candidateList(f.s,{candidate_id:f.c.candidate_id})[0];assert.equal(c.status,'draft');assert.equal(c.loop.status,'draft');assert.equal(c.loop.execution_adapter,null);assert.equal(c.evaluation.status,'offline_evidence_passed');assert.equal(c.definition_sha256,candidateDefinitionHash(c));
 assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='candidate.evaluated'").get().n,1);
});

test('候选评估：缺少种类不通过，失败覆盖旧通过，重试旧成功不恢复通过状态',t=>{
 const f=fixture(t);const incomplete=candidateEvaluate(f.s,f.request([f.example('normal')]));assert.equal(incomplete.evaluation.status,'incomplete');assert.deepEqual(incomplete.evaluation.missing_kinds,['missing_input','counterexample']);
 const successful=f.request(f.all(),'previous-pass');assert.equal(candidateEvaluate(f.s,successful).evaluation.status,'offline_evidence_passed');
 const failed=f.request([f.example('normal',{observed:'与参考不同的输出'}),f.example('missing_input'),f.example('counterexample')]);assert.equal(candidateEvaluate(f.s,failed).evaluation.status,'failed');
 const oldRetry=candidateEvaluate(f.s,successful);assert.equal(oldRetry.evaluation.status,'offline_evidence_passed');assert.equal(oldRetry.current_evaluation_status,'failed');assert.equal(candidateList(f.s)[0].evaluation_status,'failed');
 assert.throws(()=>candidateEvaluate(f.s,{...successful,notes:'改变幂等请求'}),/禁止覆盖/);assert.equal(candidateEvaluationHistory(f.s,{candidate_id:f.c.candidate_id,org_id:f.config.org_id}).length,3);
});

test('候选评估：训练事件、同任务、同案件及跨样例复用不得伪装为留出证据',t=>{
 const f=fixture(t);
 const sameTask=candidateEvaluate(f.s,f.request([f.example('normal',{existingTask:f.train})]));assert.equal(sameTask.evaluation.status,'failed');assert.match(sameTask.evaluation.cases[0].reason,/同一任务或案件/);
 const sameCase=candidateEvaluate(f.s,f.request([f.example('normal',{caseId:f.train.caseId})]));assert.match(sameCase.evaluation.cases[0].reason,/同一任务或案件/);
 const sameEvent=candidateEvaluate(f.s,f.request([f.example('normal',{inputs:[f.trainingDraft.event_id]})]));assert.match(sameEvent.evaluation.cases[0].reason,/证据重叠/);
 const a=f.example('normal'),b=f.example('missing_input',{caseId:a.a.caseId});const sharedCase=candidateEvaluate(f.s,f.request([a,b]));assert.match(sharedCase.evaluation.cases[1].reason,/不同任务和案件/);
});

test('候选评估：不存在、跨组织、跨员工证据不能进入通过记录',t=>{
 const f=fixture(t);assert.throws(()=>candidateEvaluate(f.s,{...f.request(f.all()),org_id:uuid()}),/不属于本公司/);
 const other={...f.config,device_id:uuid(),employee_id:'EMP002'};f.s.addDevice({...other,employee_name:'OTHER SYNTHETIC',label:'TEST'});
 const wrongPerson=candidateEvaluate(f.s,f.request([f.example('normal',{cfg:other})]));assert.equal(wrongPerson.evaluation.status,'failed');assert.match(wrongPerson.evaluation.cases[0].reason,/本员工/);
 const missing=f.request([f.example('normal')]);missing.cases[0].output_event_id=uuid();assert.match(candidateEvaluate(f.s,missing).evaluation.cases[0].reason,/证据不存在/);
 const foreignOrg={...f.config,org_id:uuid(),device_id:uuid()};f.s.addDevice({...foreignOrg,employee_name:'FOREIGN',label:'TEST'});
 assert.match(candidateEvaluate(f.s,f.request([f.example('normal',{cfg:foreignOrg})])).evaluation.cases[0].reason,/本公司/);
 assert.throws(()=>candidateEvaluationHistory(f.s,{candidate_id:f.c.candidate_id,org_id:foreignOrg.org_id}),/不属于本公司/);
});

test('候选评估：模型自报、事后参考和未采用反馈不能当作独立验收',t=>{
 const f=fixture(t);
 for(const [options,reason]of [[{referenceSource:'ai'},/人工 review/],[{feedbackSource:'agent_observation'},/人工核验来源/],[{lateReference:true},/先登记参考/],[{decision:'rejected'},/未采用/]]){
  const result=candidateEvaluate(f.s,f.request([f.example('normal',options)]));assert.equal(result.evaluation.status,'failed');assert.match(result.evaluation.cases[0].reason,reason);
 }
});

test('候选评估：新的否定反馈使已通过展示失效，不能挑选过期的采用反馈',t=>{
 const f=fixture(t),examples=f.all(),passed=candidateEvaluate(f.s,f.request(examples));assert.equal(passed.evaluation.status,'offline_evidence_passed');
 const correction=f.feedback(examples[0].a,examples[0].output,{decision:'rejected'});assert.equal(candidateList(f.s)[0].evaluation_status,'stale');
 const outdated=candidateEvaluate(f.s,f.request(examples));assert.equal(outdated.evaluation.status,'failed');assert.match(outdated.evaluation.cases[0].reason,/更新反馈/);
 examples[0].feedback_event_id=correction.event_id;assert.match(candidateEvaluate(f.s,f.request(examples)).evaluation.cases[0].reason,/未采用/);
});

test('候选评估：候选内容和适配器变更绑定新摘要，历史通过不能沿用',t=>{
 const f=fixture(t),examples=f.all();candidateEvaluate(f.s,f.request(examples));
 const c=JSON.parse(f.s.db.prepare('SELECT json FROM skill_candidates WHERE candidate_id=?').get(f.c.candidate_id).json);c.loop.execution_adapter='unqualified-adapter-v2';c.skill_md+='\n新的候选定义';f.s.db.prepare('UPDATE skill_candidates SET json=? WHERE candidate_id=?').run(canonical(c),c.candidate_id);
 const changed=candidateList(f.s,{candidate_id:c.candidate_id})[0];assert.equal(changed.evaluation.status,'stale');assert.notEqual(changed.definition_sha256,f.c.definition_sha256);assert.equal(changed.execution_ready,false);
 const attempt=candidateEvaluate(f.s,f.request(examples));assert.equal(attempt.evaluation.status,'failed');assert.match(attempt.evaluation.cases[0].reason,/绑定当前候选/);
 assert.equal(candidateEvaluationHistory(f.s,{candidate_id:c.candidate_id,org_id:f.config.org_id})[1].status,'offline_evidence_passed');
});

test('候选评估：新版参考或输出使旧通过失效，输入和结果不能复用同一事件',t=>{
 const f=fixture(t),examples=f.all();candidateEvaluate(f.s,f.request(examples));
 f.artifact(examples[0].a,'新的 AI 稿','ai','draft',f.config,examples[0].output);assert.equal(candidateList(f.s)[0].evaluation_status,'stale');
 const result=candidateEvaluate(f.s,f.request(examples));assert.equal(result.evaluation.status,'failed');assert.match(result.evaluation.cases[0].reason,/新版替代/);
 const one=f.example('normal');one.input_event_ids=[one.output_event_id];assert.match(candidateEvaluate(f.s,f.request([one])).evaluation.cases[0].reason,/不同事件/);
});

function reviseRequest(f,overrides={}){
 const c=candidateList(f.s,{candidate_id:f.c.candidate_id})[0];
 return {candidate_id:c.candidate_id,org_id:f.config.org_id,idempotency_key:uuid(),expected_definition_sha256:c.definition_sha256,skill_md:c.skill_md+'\n修订说明：资料不足时先保留缺口。',loop:{...structuredClone(c.loop),held_out_evaluation:'pending'},reason:'根据已核实的原训练材料补充说明',...overrides};
}

test('候选修订：保存新旧定义与来源，旧通过变待评估，重启后历史和审计可读',t=>{
 const f=fixture(t);candidateEvaluate(f.s,f.request(f.all()));const before=candidateList(f.s,{candidate_id:f.c.candidate_id})[0];assert.equal(before.revision.version,1);
 const p=reviseRequest(f);p.loop.steps[0].check.text='核对已有资料并保留未确认项';p.loop.stop_conditions.push('材料存在矛盾');
 const r=candidateRevise(f.s,p);assert.equal(r.current_revision_version,2);assert.equal(r.current_evaluation_status,'pending');assert.equal(r.candidate_status,'draft');assert.equal(r.execution_ready,false);assert.notEqual(r.current_definition_sha256,before.definition_sha256);assert.equal(r.revision.previous_definition_sha256,before.definition_sha256);
 f.reopen();const c=candidateList(f.s,{candidate_id:f.c.candidate_id})[0];assert.equal(c.candidate_id,f.c.candidate_id);assert.equal(c.revision.version,2);assert.equal(c.loop.held_out_evaluation,'pending');assert.equal(c.loop.execution_adapter,null);assert.deepEqual(c.evidence,before.evidence);assert.equal(c.source_event_id,before.source_event_id);
 const scope={candidate_id:c.candidate_id,org_id:f.config.org_id};const summaries=candidateRevisionHistory(f.s,scope);assert.equal(summaries.length,1);assert.equal(summaries[0].definition,undefined);assert.equal(summaries[0].previous_definition,undefined);
 const full=candidateRevisionHistory(f.s,{...scope,include_definitions:true})[0];assert.equal(full.previous_definition.skill_md,before.skill_md);assert.deepEqual(full.previous_definition.loop,before.loop);assert.equal(full.definition.skill_md,p.skill_md);assert.equal(full.definition.loop.steps[0].check.text,p.loop.steps[0].check.text);assert.equal(full.previous_evaluation.status,'offline_evidence_passed');
 assert.equal(candidateEvaluationHistory(f.s,scope)[0].status,'offline_evidence_passed');assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='candidate.revised'").get().n,1);
 assert.equal(candidateList(f.s)[0].revision.version,2);assert(!Object.hasOwn(candidateRevisionSchema.properties,'org_id'));
});

test('候选修订：摘要并发保护和幂等重试不回滚后续版本，也不恢复旧评估',t=>{
 const f=fixture(t),first=reviseRequest(f,{idempotency_key:'revision-1'}),competing=reviseRequest(f,{idempotency_key:'competing'});
 const r1=candidateRevise(f.s,first);const second=reviseRequest(f,{idempotency_key:'revision-2'});const r2=candidateRevise(f.s,second);assert.equal(r2.current_revision_version,3);
 const old=candidateRevise(f.s,first);assert.equal(old.duplicate,true);assert.equal(old.revision.revision_id,r1.revision.revision_id);assert.equal(old.revision.version,2);assert.equal(old.current_revision_version,3);assert.equal(old.current_definition_sha256,r2.current_definition_sha256);assert.equal(candidateList(f.s,{candidate_id:f.c.candidate_id})[0].skill_md,second.skill_md);
 assert.throws(()=>candidateRevise(f.s,competing),/定义已变化/);assert.throws(()=>candidateRevise(f.s,{...first,reason:'同键另一个请求'}),/禁止覆盖/);
 const c=candidateList(f.s,{candidate_id:f.c.candidate_id})[0];assert.throws(()=>candidateRevise(f.s,reviseRequest(f,{skill_md:c.skill_md})),/没有变化/);assert.equal(candidateRevisionHistory(f.s,{candidate_id:c.candidate_id,org_id:f.config.org_id}).length,2);
});

test('候选修订：拒绝扩大来源、模型总结证据、越权适配器及移除退出条件',t=>{
 const f=fixture(t),heldOut=f.example('normal');const invalid=[
  p=>{p.loop.source_event_id=uuid();},p=>{p.loop.trigger.evidence_event_ids=[heldOut.a.origin.event_id];},p=>{p.loop.trigger.evidence_event_ids=[f.c.source_event_id];},
  p=>{p.loop.steps[0].action.evidence_event_ids=[];},p=>{p.loop.steps[0].action.evidence_event_ids=[f.train.origin.event_id,f.train.origin.event_id];},
  p=>{p.loop.execution_adapter='desktop';},p=>{p.loop.status='published';},p=>{p.loop.held_out_evaluation='offline_evidence_passed';},p=>{p.loop.max_iterations=4;},p=>{p.loop.max_model_calls=4;},
  p=>{p.loop.stop_conditions=p.loop.stop_conditions.map(x=>x==='需要外发或修改业务系统'?'继续执行':x);},p=>{p.loop.allowed_actions=['send_message'];},p=>{p.loop.steps[0].constructor='unexpected';},p=>{p.loop.trigger.constructor='unexpected';},p=>{p.evidence={raw_event_ids:[heldOut.a.origin.event_id]};}
 ];
 for(const change of invalid){const p=reviseRequest(f);change(p);assert.throws(()=>candidateRevise(f.s,p));}
 assert.equal(candidateList(f.s)[0].revision.version,1);assert.equal(candidateRevisionHistory(f.s,{candidate_id:f.c.candidate_id,org_id:f.config.org_id}).length,0);assert.equal(candidateList(f.s)[0].definition_sha256,f.c.definition_sha256);
});

test('候选修订：frontmatter、正文长度、公司边界与完整历史读取预算均校验',t=>{
 const f=fixture(t),texts=['没有 frontmatter','---\nname: wrong-name\ndescription: test\n---\n正文','---\nname: '+f.c.name+'\ndescription: test\nname: duplicate\n---\n正文',f.c.skill_md+'x'.repeat(60000),'---\nname: '+f.c.name+'\ndescription: ""\n---\n正文'];
 for(const skill_md of texts)assert.throws(()=>candidateRevise(f.s,reviseRequest(f,{skill_md})));
 assert.throws(()=>candidateRevise(f.s,reviseRequest(f,{reason:' '})),/不能为空白/);assert.throws(()=>candidateRevise(f.s,reviseRequest(f,{org_id:uuid()})),/不属于本公司/);
 candidateRevise(f.s,reviseRequest(f));assert.throws(()=>candidateRevisionHistory(f.s,{candidate_id:f.c.candidate_id,org_id:uuid()}),/不属于本公司/);assert.throws(()=>candidateRevisionHistory(f.s,{candidate_id:f.c.candidate_id,org_id:f.config.org_id,include_definitions:true,limit:4}),/最多三份/);
});

test('候选修订：新拒绝后修订保留历史，旧参考不能验收新定义，新参考能重新验收',t=>{
 const f=fixture(t),examples=f.all(),oldEvaluation=f.request(examples,'original-evaluation');candidateEvaluate(f.s,oldEvaluation);f.feedback(examples[0].a,examples[0].output,{decision:'rejected'});assert.equal(candidateList(f.s)[0].evaluation_status,'stale');
 const revised=candidateRevise(f.s,reviseRequest(f));assert.equal(revised.revision.previous_evaluation.status,'stale');assert.equal(candidateEvaluate(f.s,oldEvaluation).current_evaluation_status,'pending');
 const staleReference=candidateEvaluate(f.s,f.request([f.example('normal')]));assert.equal(staleReference.evaluation.status,'failed');assert.match(staleReference.evaluation.cases[0].reason,/绑定当前候选/);
 const updated=Object.keys(modes).map(kind=>f.example(kind,{candidateHash:revised.current_definition_sha256}));const pass=candidateEvaluate(f.s,f.request(updated));assert.equal(pass.evaluation.status,'offline_evidence_passed');assert.equal(candidateList(f.s)[0].revision.version,2);assert.equal(candidateList(f.s)[0].execution_ready,false);
});

test('候选修订：审计写入失败整笔回滚，可用相同请求安全重试',t=>{
 const f=fixture(t),p=reviseRequest(f),original=f.s.audit;f.s.audit=function(action,detail){if(action==='candidate.revised')throw Error('synthetic audit failure');return original.call(this,action,detail);};
 assert.throws(()=>candidateRevise(f.s,p),/synthetic audit failure/);f.s.audit=original;
 assert.equal(candidateList(f.s)[0].definition_sha256,f.c.definition_sha256);assert.equal(candidateRevisionHistory(f.s,{candidate_id:f.c.candidate_id,org_id:f.config.org_id}).length,0);
 assert.equal(candidateRevise(f.s,p).current_revision_version,2);
});
