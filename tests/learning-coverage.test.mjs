import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {Store} from '../src/store.mjs';
import {Collector} from '../src/collector.mjs';
import {nextPersonal,savePersonal,learningStatus} from '../src/learning.mjs';
import {personalDigest} from '../src/personal-digest.mjs';
import {uuid,hash} from '../src/protocol.mjs';
import {importFileVersions} from '../src/file-evidence.mjs';
import {addWork} from '../src/work.mjs';

const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-learning-coverage');mkdirSync(base,{recursive:true});
const minimal={summary:'合成样例：仅描述可见活动，不证明业务完成。',coverage:'metadata_only',limitations:['SYNTHETIC，未验证业务方法'],procedures:[],open_questions:[]};
function fixture(t){
 const dir=mkdtempSync(join(base,'run-')),file=join(dir,'data.sqlite');
 const c={role:'collector',connection_mode:'offline',org_id:uuid(),device_id:uuid(),employee_id:'SYNTHETIC',employee_name:'SYNTHETIC',label:'SYNTHETIC'};let s=new Store(file);s.addDevice(c);
 const create=()=>new Collector({store:s,config:c,dir,root:dir,clock:()=>Date.parse('2026-10-12T01:00:00.000Z')});
 let collector=create();t.after(()=>{s.close();if(resolve(dir).startsWith(base+sep))rmSync(dir,{recursive:true,force:true});});
 return {dir,c,get s(){return s;},record(title,text=''){return collector.record('activity.snapshot',{capture_status:text?'uia':'activity_only',text},{process_name:'synthetic.exe',window_title:title});},reopen(){s.close();s=new Store(file);collector=create();}};
}
test('bounded window selects content ahead of title-only activity and preserves the original events',t=>{
 const f=fixture(t);for(let i=0;i<450;i++)f.record('相同合成资料标题');
 const content=f.record('合成化工核对','合成配比核对文字');
 const before=f.s.db.prepare('SELECT event_id,hash,json FROM events ORDER BY rowid').all();
 const b=nextPersonal(f.s,f.c,{limit:2}).batch;
 assert.equal(b.events[0].event_id,content.event_id);assert.equal(b.events.length,2);
 assert.equal(b.source_coverage.new_events,451);assert.equal(b.source_coverage.metadata_groups[0].count,450);
 assert.equal(b.selection.scanned,451);assert.equal(b.selection.unselected_in_window,0);assert.equal(b.selection.has_more_beyond_window,false);
 f.reopen();const resumed=nextPersonal(f.s,f.c).batch;assert.deepEqual(resumed,b);
 savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});
 for(const e of before)assert.deepEqual(f.s.db.prepare('SELECT event_id,hash,json FROM events WHERE event_id=?').get(e.event_id),e);
 assert.equal(learningStatus(f.s,f.c).raw_unassigned,0);
});
test('different titles do not collapse and later duplicates of selected groups remain counted',t=>{
 const f=fixture(t);const first=f.record('合成案件 A');const other=f.record('合成案件 B');f.record('合成案件 A');
 const b=nextPersonal(f.s,f.c,{limit:1}).batch;
 assert.equal(b.events[0].event_id,first.event_id);assert.equal(b.source_coverage.new_events,2);assert.equal(b.source_coverage.metadata_groups[0].count,2);
 assert.equal(b.selection.unselected_in_window,1);assert.equal(f.s.db.prepare('SELECT 1 FROM personal_members WHERE event_id=?').get(other.event_id),undefined);
 savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});assert.equal(nextPersonal(f.s,f.c,{limit:1}).batch.events[0].event_id,other.event_id);
});
test('selection reports its 1000-event bound without claiming to inspect or consume later content',t=>{
 const f=fixture(t);for(let i=0;i<1000;i++)f.record('合成重复活动');
 const later=f.record('合成正文','窗口外的合成正文');const b=nextPersonal(f.s,f.c).batch;
 assert.equal(b.selection.scanned,1000);assert.equal(b.selection.has_more_beyond_window,true);assert.equal(b.source_coverage.new_events,1000);assert.equal(b.events.length,1);
 assert(!b.events.some(e=>e.event_id===later.event_id));savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});
 assert.equal(nextPersonal(f.s,f.c).batch.events[0].event_id,later.event_id);
});
test('old open batches remain resumable when selection metadata is absent',t=>{
 const f=fixture(t);f.record('合成旧批次');const b=nextPersonal(f.s,f.c).batch;
 f.s.db.prepare('DELETE FROM meta WHERE key=?').run('personal_selection:'+b.batch_id);f.reopen();
 const resumed=nextPersonal(f.s,f.c).batch;assert.equal(resumed.batch_id,b.batch_id);assert.equal(resumed.digest,b.digest);assert.equal(resumed.selection,null);
 savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});
 assert.equal(nextPersonal(f.s,f.c).batch,null);
});
test('unparsed document originals and structured tasks precede activity while unselected events stay pending',t=>{
 const f=fixture(t),seed=f.record('合成活动');for(let i=0;i<25;i++)f.record('合成活动 '+i);
 const bytes=Buffer.from('SYNTHETIC original, never opened'),sha=hash(bytes);importFileVersions(f.s,[{sha256:sha,mime:'application/pdf',size:bytes.length,data:bytes}]);
 const doc=f.s.append({...seed,event_id:uuid(),schema_version:'1.2',event_type:'document.version',payload:{file_sha256:sha,path:join(f.dir,'synthetic.pdf'),extension:'.pdf',mime:'application/pdf',size:bytes.length,modified_at:seed.occurred_at,previous_event_id:null,text:'',parser:'original-only',parser_version:'1.0',capture_status:'unparsed',gaps:['合成原件，未解析']}});
 const task=addWork(f.s,f.c,'task.created',{task_id:uuid(),task_type:'draft.initial_review',title:'合成检查',customer_id:'SYNTHETIC',input_summary:'合成资料',acceptance_criteria:['标明未知'],authority_profile:'draft_only'},'SYNTHETIC');
 const b=nextPersonal(f.s,f.c,{limit:2}).batch;assert.deepEqual(b.events.map(e=>e.event_id),[doc.event_id,task.event_id]);
 assert.equal(b.selection.unselected_in_window,26);assert.equal(b.source_coverage.new_events,2);
 assert.equal(f.s.db.prepare('SELECT 1 FROM personal_members WHERE event_id=?').get(seed.event_id),undefined);
});
test('derived daily report separates summary save day, original evidence dates and network mode',t=>{
 const f=fixture(t);f.record('合成历史活动');const b=nextPersonal(f.s,f.c).batch;
 savePersonal(f.s,f.c,{batch_id:b.batch_id,digest:b.digest,result:minimal});
 const r=personalDigest(f.s,{...f.c,connection_mode:'hub'},{directory:join(f.dir,'reports')});
 const text=readFileSync(r.path,'utf8');assert.match(text,/总结保存日/);assert.match(text,/2026-10-12T01:00:00.000Z/);assert.match(text,/联网/);assert.doesNotMatch(text,/离线个人分析/);
 assert.match(text,/扫描 1/);assert.match(text,/不是工时/);
});
