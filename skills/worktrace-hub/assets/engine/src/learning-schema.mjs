// This schema travels with every personal summary. Claims remain model analysis.
const s={type:'string',minLength:1,maxLength:2000},u={type:'string',format:'uuid'};
const obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const arr=(items,maxItems,minItems=0)=>({type:'array',items,maxItems,minItems});
export const claimSchema=obj({text:s,basis:{enum:['observed','inferred','unknown']},evidence_event_ids:arr(u,120)});
export const personalResultSchema=obj({
 summary:{...s,maxLength:4000},coverage:{enum:['metadata_only','content','outcome_observed']},
 limitations:arr(s,20),procedures:arr(obj({
  name:s,task_id:{anyOf:[u,{type:'null'}]},case_id:{anyOf:[s,{type:'null'}]},
  trigger:claimSchema,inputs:claimSchema,
  steps:arr(obj({action:claimSchema,decision:claimSchema,check:claimSchema}),20,1),
  outcome:claimSchema,exceptions:arr(claimSchema,10),corrections:arr(claimSchema,10),gaps:arr(s,20)
 }),8),open_questions:arr(s,20)
});
const count={type:'integer',minimum:0,maximum:1000};
export const coverageSchema=obj({new_events:count,representative_events:count,context_events:count,metadata_groups:arr(obj({app:s,status:s,count,evidence_event_id:u,from:s,to:s}),100)});
export const personalPayloadSchema=obj({format:{const:'worktrace.personal/1.0'},batch_id:u,digest:{type:'string',pattern:'^[a-f0-9]{64}$'},
 source_coverage:coverageSchema,
 request_id:{anyOf:[u,{type:'null'}]},request_state:{enum:['none','answered','blocked']},
 evidence_event_ids:arr(u,120,1),result:personalResultSchema});
// Deliberately small validator for the subset above; no downloaded dependency.
export function validateShape(value,schema,path='summary'){
 const fail=msg=>{throw Error(path+': '+msg);};
 if(schema.anyOf){for(const option of schema.anyOf){try{validateShape(value,option,path);return;}catch{}}fail('字段类型无效');}
 if('const' in schema&&value!==schema.const)fail('固定值不匹配');
 if(schema.enum&&!schema.enum.includes(value))fail('枚举值无效');
 if(schema.type==='null'&&value!==null)fail('需要 null');
 if(schema.type==='integer'&&(!Number.isInteger(value)||value<schema.minimum||value>schema.maximum))fail('整数范围无效');
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('需要对象');
  for(const key of schema.required)if(!Object.hasOwn(value,key))fail('缺少 '+key);
  for(const key of Object.keys(value)){if(!schema.properties[key])fail('未知字段 '+key);validateShape(value[key],schema.properties[key],path+'.'+key);}
 }
 if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<(schema.minItems||0)||value.length>schema.maxItems)fail('数组长度无效');
  value.forEach((v,i)=>validateShape(v,schema.items,path+'['+i+']'));
 }
 if(schema.type==='string'){
  if(typeof value!=='string'||value.length<(schema.minLength||0)||value.length>(schema.maxLength||Infinity))fail('文字长度无效');
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail('格式无效');
  if(schema.format==='uuid'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))fail('编号无效');
 }
}
export function personalClaims(result){return result.procedures.flatMap(p=>[p.trigger,p.inputs,...p.steps.flatMap(s=>[s.action,s.decision,s.check]),p.outcome,...p.exceptions,...p.corrections]);}
export function validatePersonalPayload(p){
 validateShape(p,personalPayloadSchema);
 if(JSON.stringify(p).length>100000)throw Error('个人总结超过大小限制');
 if(new Set(p.evidence_event_ids).size!==p.evidence_event_ids.length)throw Error('证据编号重复');
 if((p.request_id===null)!==(p.request_state==='none'))throw Error('补证状态不匹配');
 const refs=new Set(p.evidence_event_ids);
 for(const c of personalClaims(p.result)){
  if(c.evidence_event_ids.some(x=>!refs.has(x)))throw Error('结论超出声明的证据范围');
  if(c.basis==='observed'&&!c.evidence_event_ids.length)throw Error('观察事实必须引用证据');
 }
 if(p.result.coverage==='metadata_only'&&!p.result.limitations.length)throw Error('只有活动元数据时必须说明局限');
}
