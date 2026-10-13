import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {startApp} from '../src/server.mjs';
import {Store} from '../src/store.mjs';
import {Collector,defaultPolicy} from '../src/collector.mjs';
import {LearningWorker} from '../src/worker.mjs';
import {learningStatus,nextPersonal} from '../src/learning.mjs';
import {uuid} from '../src/protocol.mjs';

const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-performance-tests');mkdirSync(base,{recursive:true});
test('tray status is authenticated, live and independent of historical SQL and content',async t=>{
 const dir=mkdtempSync(join(base,'brief-')),app=await startApp({dir,port:0});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const setup=await fetch(new URL('/api/setup',app.url),{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({role:'collector',offline:{format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC',employee_id:'PERF_TEST',employee_name:'TEST',label:'TEST'}})});assert.equal(setup.status,200);
 const url=new URL('/api/status/brief',app.url);
 assert.equal((await fetch(url)).status,400);
 const prepare=app.store.db.prepare;
 app.store.db.prepare=()=>{throw Error('Brief status must not query the database');};
 try{
  let r=await fetch(url,{headers:{Authorization:'Bearer '+app.token}});assert.equal(r.status,200);let s=await r.json();assert.equal(s.collection.enabled,false);assert.equal(s.role,'collector');assert.equal(s.stats,undefined);assert.equal(s.learning,undefined);assert.equal(s.worker.policy,undefined);
  app.collector.enabled=true;app.collector.state='SYNTHETIC LIVE FLAG';app.worker.busy=true;
  r=await fetch(url,{headers:{Authorization:'Bearer '+app.token}});assert.equal(r.status,200);s=await r.json();assert.equal(s.collection.enabled,true);assert.equal(s.collection.state,'SYNTHETIC LIVE FLAG');assert.equal(s.worker.busy,true);
 }finally{app.store.db.prepare=prepare;app.collector.enabled=false;app.worker.busy=false;}
});

test('old database receives lookup indexes without changing evidence or personal batch counts',t=>{
 const dir=mkdtempSync(join(base,'indexes-')),file=join(dir,'evidence.sqlite');let s=new Store(file);
 t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const c={role:'collector',connection_mode:'offline',org_id:uuid(),device_id:uuid(),employee_id:'PERF_TEST'};s.addDevice({...c,employee_name:'SYNTHETIC',label:'SYNTHETIC'});
 const collector=new Collector({store:s,config:c,dir,root:resolve('.')});
 s.db.exec('BEGIN');for(let i=0;i<80;i++)collector.record('activity.snapshot',{capture_status:'uia',text:'SYNTHETIC '+i},{process_name:'fixture.exe',window_title:''});s.db.exec('COMMIT');
 const before=s.db.prepare('SELECT event_id,hash,sequence,json FROM events ORDER BY rowid').all();
 s.db.exec('DROP INDEX events_stream_sequence;DROP INDEX events_type_time;DROP INDEX events_device_evidence');s.close();s=new Store(file);
 assert.deepEqual(s.db.prepare('SELECT event_id,hash,sequence,json FROM events ORDER BY rowid').all(),before);
 const worker=new LearningWorker({store:s,config:c,dir});t.after(()=>worker.stop());
 assert.equal(s.stats().pending,80);assert.equal(learningStatus(s,c).raw_unassigned,80);assert.equal(worker.localState().pending_raw_events,80);
 s.set('sync_cursor',79);assert.equal(s.batch(79).events.length,1);assert.equal(s.stats().pending,1);
 const batch=nextPersonal(s,c,{limit:50}).batch;assert.equal(batch.source_coverage.new_events,50);assert.equal(learningStatus(s,c).raw_unassigned,30);assert.equal(worker.localState().pending_raw_events,30);
 const next=new Collector({store:s,config:c,dir,root:resolve('.')}).record('activity.snapshot',{capture_status:'uia',text:'NEXT'},{process_name:'fixture.exe',window_title:''});assert.equal(next.sequence,81);
 assert(worker.scheduleLocal());const prepare=s.db.prepare;
 s.db.prepare=function(sql){assert(!/COUNT\(\*\).*FROM events/i.test(sql),'Existing daily job must not cause another historical count');return prepare.call(this,sql);};
 try{assert.equal(worker.scheduleLocal(),null);}finally{s.db.prepare=prepare;}
 const plans=[
  ["SELECT COUNT(*) FROM events WHERE stream_id=? AND sequence>?",[s.get('stream_id'),79]],
  ["SELECT COUNT(*),MAX(occurred_at) FROM events WHERE event_type='learning.summary'",[]],
  ["SELECT COALESCE(MAX(sequence),0) FROM events WHERE org_id=? AND device_id=? AND stream_id=?",[c.org_id,c.device_id,s.get('stream_id')]],
  ["SELECT COUNT(*) FROM events e LEFT JOIN personal_members m ON m.event_id=e.event_id WHERE m.event_id IS NULL AND e.org_id=? AND e.employee_id=? AND e.device_id=? AND e.event_type<>'learning.summary'",[c.org_id,c.employee_id,c.device_id]]
 ];
 for(const [query,args]of plans){const plan=s.db.prepare('EXPLAIN QUERY PLAN '+query).all(...args).map(r=>r.detail).join('\n');assert.match(plan,/SEARCH .*USING (?:COVERING )?INDEX/);assert.doesNotMatch(plan,/SCAN (?:events|e)\b/);}
});
