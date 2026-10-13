import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {Store} from '../src/store.mjs';
import {uuid,VERSION,hash,canonical} from '../src/protocol.mjs';
import {deriveCandidates,candidateDefinitionHash} from '../src/candidates.mjs';
import {knowledgeSearch,knowledgeRead} from '../src/knowledge.mjs';

const temp=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-knowledge-tests');mkdirSync(temp,{recursive:true});
function fixture(t){
 const dir=mkdtempSync(join(temp,'run-')),s=new Store(join(dir,'data.sqlite')),org_id=uuid();
 t.after(()=>{s.close();if(resolve(dir).startsWith(temp+sep))rmSync(dir,{recursive:true,force:true});});
 const own={role:'collector',org_id,employee_id:'员工甲',device_id:uuid()};
 const samePerson={...own,device_id:uuid()},other={...own,employee_id:'员工乙',device_id:uuid()},foreign={...own,org_id:uuid(),device_id:uuid()};
 for(const c of [own,samePerson,other,foreign])s.addDevice({...c,employee_name:'同名',label:'SYNTHETIC'});
 const hub={role:'hub',org_id};const scope={employee_id:own.employee_id,device_id:own.device_id,from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T23:59:59.999Z'};
 const policy=s.policy({synthetic:true});let offset=0;
 function event(c=own,{type='activity.snapshot',text='合成证据：核对机械结构的配比',payload,at,caseId=null,windowTitle=''}={}){
  return s.append({schema_version:VERSION,event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:uuid(),occurred_at:at||new Date(Date.parse('2026-10-01T12:00:00.000Z')+offset++*1000).toISOString(),timezone:'Asia/Shanghai',event_type:type,collector_version:'test',policy_hash:policy,app:{process_name:'Synthetic.exe',window_title:windowTitle},context:{case_id:caseId,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:payload||{text,capture_status:'uia',idle_seconds:0,truncated:false,reason:''},attachments:[]});
 }
 function summary(c,raw,names=['机械结构配比核对'],at){
  const claim=text=>({text,basis:'observed',evidence_event_ids:[raw.event_id]});
  const result={summary:'合成个人方法：核对机械结构配比，草稿尚未发出。',coverage:'content',limitations:['没有业务完成回执'],procedures:names.map(name=>({name,task_id:null,case_id:null,trigger:claim('收到草稿'),inputs:claim('合成资料'),steps:[{action:claim('核对配比'),decision:{text:'推测按资料排序',basis:'inferred',evidence_event_ids:[raw.event_id]},check:{text:'未知结果',basis:'unknown',evidence_event_ids:[]}}],outcome:claim('已完成全部业务（合成的未经证实主张）'),exceptions:[],corrections:[],gaps:[]})),open_questions:[]};
  return event(c,{type:'learning.summary',at,payload:{format:'worktrace.personal/1.0',batch_id:uuid(),digest:hash('synthetic'),source_coverage:{new_events:1,representative_events:1,context_events:0,metadata_groups:[]},request_id:null,request_state:'none',evidence_event_ids:[raw.event_id],result}});
 }
 function candidates(summaryEvent){
  s.db.exec('CREATE TABLE IF NOT EXISTS analysis_batches(batch_id TEXT PRIMARY KEY,status TEXT);CREATE TABLE IF NOT EXISTS analysis_members(event_id TEXT PRIMARY KEY,batch_id TEXT);');
  const b=uuid();s.db.prepare('INSERT INTO analysis_batches VALUES(?,?)').run(b,'done');s.db.prepare('INSERT INTO analysis_members VALUES(?,?)').run(summaryEvent.event_id,b);return deriveCandidates(s,b);
 }
 return {s,own,samePerson,other,foreign,hub,scope,event,summary,candidates};
}

test('分层检索默认摘要，中文可查，员工/设备/公司和时间范围不可混用',t=>{
 const f=fixture(t),a=f.event(),personal=f.summary(f.own,a),candidate=f.candidates(personal)[0];
 const b=f.event(f.other,{text:'机械结构另一员工秘密'});f.candidates(f.summary(f.other,b));
 const c=f.event(f.samePerson,{text:'机械结构另一设备秘密'});f.candidates(f.summary(f.samePerson,c));
 f.event(f.foreign,{text:'机械结构另一公司秘密'});f.event(f.own,{text:'机械结构日期外秘密',at:'2026-09-01T00:00:00.000Z'});
 const result=knowledgeSearch(f.s,f.hub,{...f.scope,query:'机械结构 配比'});
 assert.equal(result.layers.personal.length,1);assert.equal(result.layers.personal[0].event_id,personal.event_id);
 assert.equal(result.layers.candidate.length,1);assert.equal(result.layers.candidate[0].candidate_id,candidate);
 assert.deepEqual(result.layers.raw,[]);assert.equal(result.retrieval.model_calls,0);
 assert(!JSON.stringify(result).includes('秘密'));
 const ref=result.layers.personal[0].evidence.items[0];assert.equal(ref.event_id,a.event_id);assert.equal(ref.read.tool,'worktrace_knowledge_read');
 const raw=knowledgeRead(f.s,f.own,ref.read.arguments);assert.equal(raw.record.payload.text,a.payload.text);
 assert.throws(()=>knowledgeRead(f.s,f.hub,{...f.scope,layer:'raw',id:b.event_id}),/范围/);
 assert.throws(()=>knowledgeSearch(f.s,f.own,{...f.scope,device_id:f.samePerson.device_id}),/本员工本设备/);
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,employee_id:f.other.employee_id}),/归属/);
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,device_id:f.foreign.device_id}),/归属/);
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,from:undefined}),/时间/);
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,to:'2026-12-01T00:00:00.000Z'}),/31/);
});

test('游标可遍历每层有界窗口且候选同来源多条不丢失、不重复',t=>{
 const f=fixture(t),expected={raw:[],personal:[],candidate:[]};
 for(let n=0;n<4;n++){const r=f.event(f.own,{text:'合成检索样本 '+n});expected.raw.push(r.event_id);const p=f.summary(f.own,r,['方法一','方法二']);expected.personal.push(p.event_id);expected.candidate.push(...f.candidates(p));}
 const found={raw:[],personal:[],candidate:[]};let cursor,round=0;
 do{
  const page=knowledgeSearch(f.s,f.hub,{...f.scope,include_raw:true,limit:1,scan_limit:1,cursor});
  for(const layer of Object.keys(found)){assert(page.scan[layer].scanned<=1);for(const row of page.layers[layer])found[layer].push(row.event_id||row.candidate_id);}
  cursor=page.next_cursor;assert(++round<30,'cursor must make progress');
 }while(cursor);
 for(const layer of Object.keys(found)){assert.equal(new Set(found[layer]).size,found[layer].length);assert.deepEqual(found[layer].sort(),expected[layer].sort());}
 const first=knowledgeSearch(f.s,f.hub,{...f.scope,include_raw:true,limit:1,scan_limit:1});
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,include_raw:true,query:'changed',cursor:first.next_cursor}),/游标/);
 const otherScope={...f.scope,employee_id:f.other.employee_id,device_id:f.other.device_id};
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...otherScope,include_raw:true,cursor:first.next_cursor}),/游标/);
});

test('模型 observed 和代理自报不升级为事实，反馈 user_confirmed 保留声明边界',t=>{
 const f=fixture(t),raw=f.event(),personal=f.summary(f.own,raw),candidate=f.candidates(personal)[0];
 const detail=knowledgeRead(f.s,f.hub,{...f.scope,layer:'personal',id:personal.event_id});
 const outcome=detail.record.payload.result.procedures[0].outcome;
 assert.equal(outcome.claimed_basis,'observed');assert.equal(outcome.basis,'hypothesis');assert.equal(detail.business_outcome_verified,false);
 const draft=knowledgeRead(f.s,f.hub,{...f.scope,layer:'candidate',id:candidate});assert.equal(draft.basis,'hypothesis');assert.equal(draft.record.loop.outcome.basis,'hypothesis');
 const task_id=uuid(),artifact_id=uuid();f.event(f.own,{type:'task.created',caseId:'SYNTHETIC',payload:{task_id,task_type:'draft.initial_review',title:'合成稿件',customer_id:'SYNTHETIC',input_summary:'合成输入',acceptance_criteria:['核对'],authority_profile:'draft_only'}});
 const ai=f.event(f.own,{type:'artifact.version',caseId:'SYNTHETIC',payload:{task_id,artifact_id,version:1,kind:'draft',content_text:'AI 声称客户已经同意（无业务依据）',source_kind:'ai',parent_event_id:null}});
 const fb=f.event(f.own,{type:'artifact.feedback',caseId:'SYNTHETIC',payload:{task_id,artifact_event_id:ai.event_id,decision:'adopted',reason:'调用方声称已确认',reason_source:'user_confirmed'}});
 assert.equal(knowledgeRead(f.s,f.hub,{...f.scope,layer:'raw',id:ai.event_id}).basis,'hypothesis');
 const declared=knowledgeRead(f.s,f.hub,{...f.scope,layer:'raw',id:fb.event_id});assert.equal(declared.basis,'unknown');assert.equal(declared.identity_verified,false);assert.equal(declared.claimed_source,'user_confirmed');
});

test('原始正文显式读取且输出截断，NFKC匹配与SQL样式输入不越权',t=>{
 const f=fixture(t),raw=f.event(f.own,{text:'１２３ 配比 '+ '化工证据'.repeat(2500)});
 const normalized=knowledgeSearch(f.s,f.own,{...f.scope,query:'123 配比',include_raw:true});
 assert.equal(normalized.layers.raw[0].event_id,raw.event_id);assert(normalized.layers.raw[0].preview.length<=160);
 const detail=knowledgeRead(f.s,f.own,{...f.scope,layer:'raw',id:raw.event_id});assert.equal(detail.content_truncated,true);assert(detail.record.payload.text.length<=1000);assert(Buffer.byteLength(JSON.stringify(detail))<128*1024);
 assert.deepEqual(knowledgeSearch(f.s,f.own,{...f.scope,query:"%' OR 1=1 --",include_raw:true}).layers.raw,[]);
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,query:'a'.repeat(201)}),/200/);
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,scan_limit:1001}),/1000/);
 assert.throws(()=>knowledgeSearch(f.s,f.hub,{...f.scope,limit:21}),/20/);
 assert.throws(()=>knowledgeRead(f.s,f.hub,{...f.scope,layer:'personal',id:raw.event_id}),/层级/);
});

test('范围外证据不跟随总结泄露；候选源设备和载荷身份都复核',t=>{
 const f=fixture(t),old=f.event(f.own,{at:'2026-09-01T00:00:00.000Z',text:'早期来源'}),p=f.summary(f.own,old),cid=f.candidates(p)[0];
 const r=knowledgeRead(f.s,f.hub,{...f.scope,layer:'personal',id:p.event_id});assert.equal(r.evidence.items.length,0);assert.equal(r.evidence.not_returned,1);assert(!JSON.stringify(r).includes(old.event_id));
 assert.throws(()=>knowledgeRead(f.s,f.hub,{...f.scope,device_id:f.samePerson.device_id,layer:'candidate',id:cid}),/范围/);
 const candidate=JSON.parse(f.s.db.prepare('SELECT json FROM skill_candidates WHERE candidate_id=?').get(cid).json);candidate.employee_id=f.other.employee_id;
 f.s.db.prepare('UPDATE skill_candidates SET json=? WHERE candidate_id=?').run(canonical(candidate),cid);
 assert.throws(()=>knowledgeRead(f.s,f.hub,{...f.scope,layer:'candidate',id:cid}),/范围/);
 assert.equal(knowledgeSearch(f.s,f.hub,f.scope).layers.candidate.length,0);
});

test('预算内无匹配仍给后续游标，可找到更旧的中文材料',t=>{
 const f=fixture(t),target=f.event(f.own,{text:'早期机械结构独有关键词'});
 for(let n=0;n<5;n++)f.event(f.own,{text:'较新无关内容 '+n});
 let cursor,found=[],round=0;
 do{const page=knowledgeSearch(f.s,f.hub,{...f.scope,query:'独有关键词',include_raw:true,scan_limit:2,cursor});found.push(...page.layers.raw);cursor=page.next_cursor;assert(++round<10);}while(cursor);
 assert.deepEqual(found.map(x=>x.event_id),[target.event_id]);
});

test('候选详情使用当前评估视图，失去评估证据的旧通过标记显示 stale',t=>{
 const f=fixture(t),raw=f.event(),p=f.summary(f.own,raw),cid=f.candidates(p)[0];
 const saved=JSON.parse(f.s.db.prepare('SELECT json FROM skill_candidates WHERE candidate_id=?').get(cid).json);
 saved.evaluation={status:'offline_evidence_passed',evaluation_id:uuid(),candidate_hash:candidateDefinitionHash(saved)};
 saved.loop.held_out_evaluation='offline_evidence_passed';
 f.s.db.prepare('UPDATE skill_candidates SET json=? WHERE candidate_id=?').run(canonical(saved),cid);
 const record=knowledgeRead(f.s,f.hub,{...f.scope,layer:'candidate',id:cid}).record;
 assert.equal(record.evaluation.status,'stale');assert.equal(record.loop.held_out_evaluation,'stale');assert.equal(record.execution_ready,false);assert.equal(record.status,'draft');
});

test('窗口标题可以按中文搜索，但明确保留元数据性质，不伪装成正文',t=>{
 const f=fixture(t),raw=f.event(f.own,{text:'',windowTitle:'合成化工材料'});
 const result=knowledgeSearch(f.s,f.hub,{...f.scope,query:'化工',include_raw:true});
 assert.equal(result.layers.raw.length,1);const item=result.layers.raw[0];assert.equal(item.event_id,raw.event_id);
 assert.equal(item.preview,'合成化工材料');assert.equal(item.preview_field,'app.window_title');assert.equal(item.window_title_is_body,false);
 const detail=knowledgeRead(f.s,f.hub,item.read.arguments);assert.equal(detail.record.payload.text,'');assert.equal(detail.record.app.window_title,'合成化工材料');
});
