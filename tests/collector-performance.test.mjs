import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {Collector,defaultPolicy,inSchedule} from '../src/collector.mjs';
import {Store} from '../src/store.mjs';
import {uuid} from '../src/protocol.mjs';

const temp=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-collector-performance');mkdirSync(temp,{recursive:true});
function fixture(t){
 const dir=mkdtempSync(join(temp,'case-')),store=new Store(join(dir,'worktrace.sqlite')),config={org_id:uuid(),device_id:uuid(),employee_id:'SYNTHETIC_ONLY'};store.addDevice({...config,employee_name:'SYNTHETIC',label:'SYNTHETIC'});
 let now=Date.parse('2026-10-13T02:00:00.000Z');const children=[],errors=[];
 const spawnObserver=(exe,args,options)=>{assert.equal(options.windowsHide,true);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true;child.emit('exit',0);};children.push(child);return child;};
 const collector=new Collector({store,config,dir,root:resolve('.'),clock:()=>now,spawnObserver,onError:message=>errors.push(message)});
 t.after(()=>{collector.stop();store.close();assert.equal(dirname(dir),temp);rmSync(dir,{recursive:true,force:true});});
 return {collector,store,children,errors,advance(ms){now+=ms;},events(type){return store.list({limit:1000}).items.filter(e=>e.event_type===type);},sample(child,p={}){child.stdout.write(JSON.stringify({capture_status:'uia',process_name:'synthetic.exe',window_title:'',text:'SYNTHETIC EVIDENCE',idle_seconds:0,truncated:false,reason:'',image:null,...p})+'\n');}};
}

test('schedule formatter is reused with a bounded 16-timezone cache and retains timezone/DST/window semantics',t=>{
 const Original=Intl.DateTimeFormat;let constructions=0;Intl.DateTimeFormat=function(...args){constructions++;return new Original(...args);};
 const date=new Date('2026-10-13T02:00:00.000Z'),p={...defaultPolicy,timezone:'UTC'};let cachedMs,uncachedMs;
 try{
  const started=performance.now();for(let i=0;i<1000;i++)assert.equal(inSchedule(p,date),false);cachedMs=performance.now()-started;assert.equal(constructions,1);
  for(let i=0;i<16;i++)inSchedule({...p,timezone:'Etc/GMT'+(i<8?'+':'-')+(i%8+1)},date);assert.equal(constructions,17);inSchedule(p,date);assert.equal(constructions,18,'old timezone should have been evicted after 16 others');
 }finally{Intl.DateTimeFormat=Original;}
 const started=performance.now();for(let i=0;i<1000;i++)new Original('en-GB',{timeZone:'UTC',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);uncachedMs=performance.now()-started;
 assert.equal(inSchedule(defaultPolicy,date),true);assert.equal(inSchedule({...defaultPolicy,end:'10:00'},date),false);
 const dst={...defaultPolicy,timezone:'America/New_York',workdays:[0],start:'01:00',end:'02:00'};assert.equal(inSchedule(dst,new Date('2026-03-08T06:30:00.000Z')),true);assert.equal(inSchedule(dst,new Date('2026-03-08T07:30:00.000Z')),false);
 t.diagnostic(`1000 schedule checks: cached ${cachedMs.toFixed(1)}ms; constructing a formatter each time ${uncachedMs.toFixed(1)}ms; constructions reduced 1000 to 1 (timing is diagnostic only).`);
});

test('healthy observer stays in one process; unchanged samples keep its watchdog alive and preserve one-minute evidence heartbeat',t=>{
 const f=fixture(t),c=f.collector;c.enabled=true;c.tick();const child=f.children[0];f.sample(child);
 for(let seconds=3;seconds<=120;seconds+=3){f.advance(3000);if(seconds%15===0)f.sample(child);c.tick();}
 assert.equal(f.children.length,1);assert.equal(child.killed,false);assert.equal(f.events('collector.gap').length,0);assert.equal(f.events('activity.snapshot').length,3);assert.equal(c.validSamples,9);assert.equal(defaultPolicy.interval_seconds,15);
});

test('repeated observer failures back off instead of respawning every three seconds and each outage is recorded',t=>{
 const f=fixture(t),c=f.collector;c.enabled=true;
 for(let seconds=0;seconds<=300;seconds+=3){if(seconds)f.advance(3000);c.tick();if(c.child){const child=c.child;child.emit('error',Error('synthetic failure'));child.emit('exit',1);}}
 assert(f.children.length<=8);assert.equal(f.events('collector.gap').length,f.children.length);assert.equal(c.restartFailures,6);assert.match(c.state,/120 秒/);assert.equal(f.events('activity.snapshot').length,0);
 t.diagnostic(`Five simulated minutes of immediate failures: ${f.children.length} spawns; original three-second loop would attempt 101.`);
});

test('a single startup sample does not reset crash backoff, but two valid samples recover normal operation',t=>{
 const f=fixture(t),c=f.collector;c.enabled=true;c.tick();f.children[0].emit('exit',1);assert.equal(c.restartFailures,1);
 f.advance(5000);c.tick();const second=c.child;f.sample(second);second.emit('exit',1);assert.equal(c.restartFailures,2);f.advance(9000);c.tick();assert.equal(f.children.length,2);
 f.advance(1000);c.tick();const third=c.child;f.sample(third);f.advance(15000);f.sample(third);assert.equal(c.restartFailures,0);third.emit('exit',1);assert.equal(c.restartFailures,1);assert.match(c.state,/5 秒/);
});

test('watchdog timeout stops only its own child; stale child output and paused output cannot write evidence',t=>{
 const f=fixture(t),c=f.collector;c.enabled=true;c.tick();const first=c.child;f.advance(46000);c.tick();assert.equal(first.killed,true);assert.equal(f.events('collector.gap').length,1);assert.match(f.events('collector.gap')[0].payload.reason,/observer-timeout/);
 f.sample(first,{text:'MUST NOT RECORD STALE CHILD'});assert.equal(f.events('activity.snapshot').length,0);c.tick();assert.equal(f.children.length,1);
 f.advance(5000);c.tick();const second=c.child;f.sample(second);const count=f.store.stats().events;c.stop();assert.equal(second.killed,true);assert.equal(f.store.stats().events,count+1);f.sample(second,{text:'MUST NOT RECORD AFTER PAUSE'});c.accept({capture_status:'uia',text:'MUST NOT RECORD DIRECT AFTER PAUSE'});second.emit('error',Error('late synthetic failure'));f.advance(300000);c.tick();assert.equal(f.store.stats().events,count+1);assert.equal(f.children.length,2);
});

test('schedule exit stops the observer without treating it as a failure, and image changes retain evidence at original cadence',t=>{
 const f=fixture(t),c=f.collector;c.enabled=true;c.policy={...defaultPolicy,screenshots:true};c.tick();const child=c.child;
 const image=n=>Buffer.from([255,216,n,255,217]).toString('base64');f.sample(child,{image:image(1)});f.advance(15000);f.sample(child,{image:image(2)});assert.equal(f.events('activity.snapshot').length,2);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assets').get().n,2);
 f.advance(15000);f.sample(child,{image:image(2)});assert.equal(f.events('activity.snapshot').length,2);c.policy={...c.policy,workdays:[0]};c.tick();assert.equal(child.killed,true);assert.equal(f.events('collector.gap').length,0);f.sample(child,{image:image(3)});assert.equal(f.events('activity.snapshot').length,2);assert.equal(c.restartFailures,0);
});

test('Windows UIA self-test preserves password masking, processes all admitted synthetic nodes, and bounds sibling traversal/pixel allocation',{skip:process.platform!=='win32'},t=>{
 const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(resolve('.'),'bridge','observe.ps1'),'-Policy',join(temp,'unused-synthetic-policy.json'),'-SelfTest'],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});assert.equal(r.status,0,r.stderr||r.error?.message);const result=JSON.parse(r.stdout.trim());assert.equal(result.passed,true);assert.equal(result.password_not_collected,true);assert.equal(result.password_control_skipped,true);assert.equal(result.hidden_control_name,'fixture-visible-text');assert.equal(result.wide_visited,40);assert.equal(result.wide_enqueued,40);assert.equal(result.wide_truncated,true);assert.equal(result.wide_navigation_calls,39);assert(result.wide_peak_queue<=39);assert.equal(result.timed_truncated,true);assert(result.timed_navigation_calls<20);assert.equal(result.max_bitmap_pixels,10000000);assert.equal(result.priority,'BelowNormal');
 t.diagnostic(`Synthetic 400-wide tree / 40-node budget: ${result.wide_visited} nodes processed, ${result.wide_navigation_calls} navigation calls, peak queue ${result.wide_peak_queue}; slow provider ${result.timed_navigation_calls} calls before budget. Maximum source bitmap 10M instead of 25M pixels; normal 4K remains supported.`);
});
