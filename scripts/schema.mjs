import {personalPayloadSchema} from '../src/learning-schema.mjs';
import { writeFileSync } from 'node:fs';
const s=(max=200)=>({type:'string',maxLength:max}),u={type:'string',format:'uuid'},nullable={anyOf:[s(160),{type:'null'}]},obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const payloads={
 'learning.summary':personalPayloadSchema,
 'activity.snapshot':obj({text:s(12000),capture_status:{enum:['activity_only','uia','unavailable','excluded','idle','outside_schedule','status','locked']},idle_seconds:{type:'number',minimum:0,exclusiveMaximum:1e9},truncated:{type:'boolean'},reason:s(500)}),
 'task.created':obj({task_id:u,task_type:{enum:['customer.progress_followup','draft.initial_review']},title:{...s(200),minLength:1},customer_id:{...s(160),minLength:1},input_summary:s(20000),acceptance_criteria:{type:'array',minItems:1,maxItems:20,items:{...s(500),minLength:1}},authority_profile:{const:'draft_only'}}),
 'task.transition':obj({task_id:u,from:{enum:['queued','in_progress','waiting_external','needs_review']},to:{enum:['in_progress','waiting_external','needs_review','completed']},reason:s(2000),evidence_event_ids:{type:'array',maxItems:20,items:u}}),
 'artifact.version':obj({task_id:u,artifact_id:u,version:{type:'integer',minimum:1},kind:{enum:['reply','draft','review','followup']},content_text:{...s(200000),minLength:1},source_kind:{enum:['ai','human']},parent_event_id:{anyOf:[u,{type:'null'}]}}),
 'artifact.feedback':obj({task_id:u,artifact_event_id:u,decision:{enum:['adopted','edited','rejected']},reason:s(4000),reason_source:{enum:['user_confirmed','agent_observation','unknown']}})
};for(const k of ['collector.started','collector.paused','collector.gap'])payloads[k]=payloads['activity.snapshot'];
const schema={$schema:'https://json-schema.org/draft/2020-12/schema',$id:'urn:worktrace:event:1.0',title:'WorkTrace normalized event v1.0',...obj({schema_version:{const:'1.0'},event_id:u,org_id:u,device_id:u,employee_id:{...s(80),minLength:1,pattern:'^[\\p{L}\\p{N}_.-]+$'},stream_id:u,sequence:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},session_id:u,occurred_at:{type:'string',format:'date-time',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'},timezone:{...s(100),minLength:1},event_type:{enum:Object.keys(payloads)},collector_version:s(40),policy_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},app:obj({process_name:s(100),window_title:s(500)}),context:obj({case_id:nullable,conversation_id:nullable,sender_id:nullable,identity_source:{const:'device_assignment'}}),payload:{type:'object'},attachments:{type:'array',maxItems:1,items:obj({sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},size:{type:'integer',minimum:1,maximum:2097152},mime:{const:'image/jpeg'},kind:{const:'window_capture'}})}}),allOf:Object.entries(payloads).map(([k,v])=>({if:{properties:{event_type:{const:k}}},then:{properties:{payload:v,...(k.startsWith('task.')||k.startsWith('artifact.')?{attachments:{maxItems:0},context:{properties:{case_id:{...s(160),minLength:1}}}}:{})}}})),description:'跨记录约束（员工设备归属、状态转换、父版本、附件存在和摘要、策略存在）由接收端另行验证。时间格式必须包含 UTC 毫秒；timezone 为有效 IANA 时区。'};
schema.$id='urn:worktrace:event:1.1';
schema.title='WorkTrace normalized event v1.0 and external evidence v1.1';
schema.properties.schema_version={enum:['1.0','1.1']};
schema.properties.provenance=obj({format:{const:'worktrace.external/1.0'},source:{enum:['activitywatch','screenpipe']},source_instance:{...s(160),minLength:1},source_record_id:{...s(300),minLength:1},source_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},source_timestamp:{...s(80),minLength:1},evidence_kind:{enum:['activity_metadata','screen_text']},read_only:{const:true},duration_seconds:{anyOf:[{type:'number',minimum:0,exclusiveMaximum:1e9},{type:'null'}]},source_type:{...s(100),minLength:1}});
payloads['activity.snapshot'].properties.capture_status.enum.push('external_text');
schema.allOf.push({
  if:{properties:{schema_version:{const:'1.1'}}},
  then:{
    required:['provenance'],
    properties:{event_type:{const:'activity.snapshot'},attachments:{maxItems:0}},
    allOf:[{
      if:{properties:{provenance:{properties:{evidence_kind:{const:'activity_metadata'}}}}},
      then:{properties:{payload:{properties:{text:{const:''},capture_status:{const:'activity_only'}}}}},
      else:{properties:{provenance:{properties:{source:{const:'screenpipe'}}},payload:{properties:{capture_status:{const:'external_text'}}}}}
    }]
  },
  else:{not:{required:['provenance']},properties:{payload:{properties:{capture_status:{not:{const:'external_text'}}}}}}
});
writeFileSync(new URL('../data-standard-v1.schema.json',import.meta.url),JSON.stringify(schema,null,2)+'\n');
