import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,utimesSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Store} from '../src/store.mjs';
import {uuid,hash} from '../src/protocol.mjs';
import {defaultPolicy} from '../src/collector.mjs';
import {defaultFilePolicy,FileEvidenceCollector} from '../src/file-evidence.mjs';

const temp=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-file-performance-tests');mkdirSync(temp,{recursive:true});
function fixture(t,{policy={},io={}}={}){
 const dir=mkdtempSync(join(temp,'run-')),docs=join(dir,'allowed'),data=join(dir,'data');mkdirSync(docs);
 const store=new Store(join(data,'worktrace.sqlite')),config={role:'collector',connection_mode:'offline',org_id:uuid(),device_id:uuid(),employee_id:'PERF_TEST',employee_name:'SYNTHETIC',label:'TEST'};
 store.addDevice(config);store.set('policy',{...defaultPolicy,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'23:59'});
 const f=new FileEvidenceCollector({store,config,dir:data,root:resolve('.'),isActive:()=>true,io});f.configure({...defaultFilePolicy,enabled:true,roots:[docs],interval_seconds:30,max_versions_per_scan:50,...policy});
 t.after(()=>{f.stop();store.close();rmSync(dir,{recursive:true,force:true});});let now=Date.now();
 return {dir,docs,store,config,f,scan(){now+=31000;return f.scan({now:new Date(now)});}};
}
function trackedReads(){
 const count={opens:0,bytes:0,max_request:0,paths:[],afterRead:null};
 return {count,io:{async open(...args){count.opens++;count.paths.push(args[0]);const fd=await open(...args);return {stat:(...x)=>fd.stat(...x),close:()=>fd.close(),async read(...x){count.max_request=Math.max(count.max_request,x[2]);const result=await fd.read(...x);count.bytes+=result.bytesRead;await count.afterRead?.(result);return result;}};}}};
}
test('unchanged originals require zero content reads; same-size edits preserve exact bytes and predecessor',async t=>{
 const tracked=trackedReads(),x=fixture(t,{io:tracked.io});for(let i=0;i<8;i++)writeFileSync(join(x.docs,`${i}.txt`),Buffer.alloc(256*1024,65+i));
 await x.scan();const saved=await x.scan();assert.equal(saved.saved,8);assert.equal(tracked.count.bytes,8*256*1024);const before=tracked.count.bytes;
 const steady=await x.scan();assert.equal(steady.cache_hits,8);assert.equal(steady.bytes_read,0);assert.equal(tracked.count.bytes,before);assert.equal(x.store.stats().events,8);
 const file=join(x.docs,'7.txt'),original=x.store.list().items.find(e=>e.payload.path===file),stat=statSync(file);writeFileSync(file,Buffer.alloc(256*1024,90));utimesSync(file,stat.atime,stat.mtime);
 assert.equal((await x.scan()).saved,0);assert.equal((await x.scan()).saved,1);assert.equal(tracked.count.bytes-before,256*1024);
 const latest=x.store.list().items.find(e=>e.payload.previous_event_id===original.event_id);assert(latest);assert.equal(latest.payload.file_sha256,hash(readFileSync(file)));assert.deepEqual(Buffer.from(x.store.db.prepare('SELECT data FROM file_versions WHERE sha256=?').get(latest.payload.file_sha256).data),readFileSync(file));
});
test('periodic verification re-reads cached originals without duplicating versions',async t=>{
 const tracked=trackedReads(),x=fixture(t,{io:tracked.io});writeFileSync(join(x.docs,'periodic.txt'),'synthetic periodic evidence');await x.scan();await x.scan();const before=tracked.count.bytes;x.f.contentRecheckMs=0;
 const checked=await x.scan();assert.equal(checked.files_read,1);assert(tracked.count.bytes>before);assert.equal(checked.saved,0);assert.equal(x.store.stats().events,1);
});
test('periodic verification obeys the content-read budget and eventually checks every cached original',async t=>{
 const tracked=trackedReads(),x=fixture(t,{io:tracked.io,policy:{max_versions_per_scan:1}});for(let i=0;i<50;i++)writeFileSync(join(x.docs,`${i}.txt`),'synthetic '+i);
 await x.scan();for(let i=0;i<50;i++){const result=await x.scan();assert.equal(result.saved,1);assert.equal(result.files_read,1);}await x.scan();
 assert.equal(x.store.stats().events,50);x.f.contentRecheckMs=0;tracked.count.paths=[];let checked=new Set();
 for(let i=0;i<55&&checked.size<50;i++){const before=tracked.count.opens,result=await x.scan();assert(result.files_read<=1);assert(tracked.count.opens-before<=1);assert.equal(result.saved,0);if(result.files_read)assert(result.gaps.some(g=>g.includes('内容读取或复核预算')));checked=new Set(tracked.count.paths);}
 assert.equal(checked.size,50);assert.equal(x.store.stats().events,50);
});
test('entry and version budgets resume traversal and eventually include later files and roots',async t=>{
 const x=fixture(t,{policy:{max_files_per_scan:3,max_versions_per_scan:1}}),second=join(x.dir,'second');mkdirSync(second);mkdirSync(join(x.docs,'nested'));
 const wanted=[];for(let i=0;i<13;i++){const file=join(i<5?x.docs:i<10?join(x.docs,'nested'):second,`${i}.txt`);wanted.push(file);writeFileSync(file,'synthetic item '+i);}
 x.f.configure({...x.f.policy,roots:[x.docs,second]});let rounds=0;
 while(x.store.stats().events<wanted.length&&rounds++<40){const result=await x.scan();assert(result.visited<=3);assert(result.saved<=1);}
 assert.equal(x.store.stats().events,wanted.length);assert.deepEqual(new Set(x.store.list().items.map(e=>e.payload.path)),new Set(wanted));
 // An unfinished directory cursor must be closed when collection is stopped.
 x.f.stop();assert.equal(x.f.walk,null);
});
test('large original reads are chunked and yield to the event loop',async t=>{
 const tracked=trackedReads(),x=fixture(t,{io:tracked.io});writeFileSync(join(x.docs,'large.txt'),Buffer.alloc(8*1024*1024,65));await x.scan();
 let during=0,active=true;const tick=()=>{if(!active)return;during++;setImmediate(tick);};setImmediate(tick);
 const result=await x.scan();active=false;assert.equal(result.saved,1);assert.equal(result.bytes_read,8*1024*1024);assert(tracked.count.max_request<=256*1024);assert(during>1,'other event-loop work must run before a large read completes');
 const source=x.store.list().items[0];assert.equal(source.payload.file_sha256,hash(readFileSync(join(x.docs,'large.txt'))));
});
test('revoking scope during a read stops before the next chunk and never saves an original',async t=>{
 const tracked=trackedReads(),x=fixture(t,{io:tracked.io});writeFileSync(join(x.docs,'cancel.txt'),Buffer.alloc(2*1024*1024,65));await x.scan();
 tracked.count.afterRead=()=>{x.f.configure({...x.f.policy,enabled:false});tracked.count.afterRead=null;};const result=await x.scan();assert.equal(result.saved,0);assert(tracked.count.bytes<=256*1024);assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n,0);assert.equal(x.store.stats().events,0);assert.equal(x.f.walk,null);
});
test('concurrent file modification is rejected and a later stable scan stores the complete replacement',async t=>{
 const tracked=trackedReads(),x=fixture(t,{io:tracked.io}),file=join(x.docs,'changing.txt');writeFileSync(file,Buffer.alloc(1024*1024,65));await x.scan();
 tracked.count.afterRead=()=>{tracked.count.afterRead=null;writeFileSync(file,Buffer.alloc(1024*1024,90));const changed=new Date(Date.now()+2000);utimesSync(file,changed,changed);};const unstable=await x.scan();assert.equal(unstable.saved,0);assert(unstable.gaps.some(g=>g.includes('发生变化')));assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n,0);
 await x.scan();assert.equal((await x.scan()).saved,1);const event=x.store.list().items[0];assert.equal(event.payload.file_sha256,hash(readFileSync(file)));
});
test('crossing the working-hours boundary stops the next chunk and closes the traversal',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-13T09:59:59.000Z')});
 const tracked=trackedReads(),x=fixture(t,{io:tracked.io});x.store.set('policy',{...defaultPolicy,workdays:[0,1,2,3,4,5,6],start:'00:00',end:'10:00',timezone:'UTC'});writeFileSync(join(x.docs,'end-of-day.txt'),Buffer.alloc(2*1024*1024,65));
 await x.f.scan({now:new Date('2026-10-13T09:58:00.000Z')});tracked.count.afterRead=()=>{tracked.count.afterRead=null;t.mock.timers.setTime(Date.parse('2026-10-13T10:00:00.000Z'));};
 const result=await x.f.scan({now:new Date('2026-10-13T09:58:31.000Z')});assert.equal(result.saved,0);assert(tracked.count.bytes<=256*1024);assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n,0);assert.equal(x.f.walk,null);
});
