import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {normalizeExternalRecords,importExternalRecords,EXTERNAL_LIMITS} from '../src/external-records.mjs';
import {Store} from '../src/store.mjs';
import {uuid,validateEvent,sealBundle,openBundle} from '../src/protocol.mjs';
import {validatePolicy} from '../src/collector.mjs';

const options=(extra={})=>({source:'activitywatch',source_instance:'SYNTHETIC-PC',org_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',device_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',employee_id:'SYNTHETIC-EMPLOYEE',timezone:'Asia/Shanghai',from:'2026-10-12T00:00:00+08:00',to:'2026-10-13T00:00:00+08:00',...extra});
const awEvent=(extra={})=>({timestamp:'2026-10-12T09:30:00+08:00',duration:30,data:{app:'synthetic.exe',title:'合成标题，不是正文',text:'不可冒充正文',command:'never execute'},...extra});
const aw=(events=[awEvent()],extra={})=>({buckets:{'aw-watcher-window_SYNTHETIC-PC':{id:'aw-watcher-window_SYNTHETIC-PC',type:'currentwindow',client:'aw-watcher-window',hostname:'SYNTHETIC-PC',created:'2026-10-01T00:00:00Z',events,...extra}}});
const row=(type='OCR',number=1,extra={})=>({type,content:{...(type==='OCR'?{frame_id:number}:{id:number}),text:'合成可见文字：待核查，不代表已经发送。',timestamp:`2026-10-12T01:30:0${number}.000Z`,app_name:'synthetic.exe',window_name:'合成工作窗口',file_path:'Z:\\never-open\\recording.mp4',offset_index:0,browser_url:'https://example.invalid/never-fetch',...extra}});
const page=(data=[row()],offset=0,limit=data.length||1,total=data.length)=>({data,pagination:{offset,limit,total}});
function storeFor(t){const base=resolve(process.env.TEMP||'D:/codex+/temp','worktrace-external-tests');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'case-')),store=new Store(join(dir,'synthetic.sqlite'));store.addDevice({...options(),employee_name:'SYNTHETIC',label:'SYNTHETIC'});t.after(()=>{store.close();assert(resolve(dir).startsWith(base+sep));rmSync(dir,{recursive:true,force:true});});return {store,dir};}

test('AW official bucket-map export without IDs stays metadata; source time and duration survive',()=>{
 const result=normalizeExternalRecords(Buffer.from(JSON.stringify(aw())),options()),e=result.events[0];validateEvent(e);validatePolicy(result.policies[0].value);
 assert.equal(e.schema_version,'1.1');assert.equal(e.occurred_at,'2026-10-12T01:30:00.000Z');assert.equal(e.provenance.source_timestamp,'2026-10-12T09:30:00+08:00');assert.equal(e.provenance.duration_seconds,30);assert.equal(e.provenance.read_only,true);
 assert.equal(e.payload.text,'');assert.equal(e.payload.capture_status,'activity_only');assert.equal(e.provenance.evidence_kind,'activity_metadata');assert.equal(e.context.sender_id,null);assert.equal(e.attachments.length,0);assert.equal(e.app.window_title,'合成标题，不是正文');
 const rust=normalizeExternalRecords(aw([awEvent({id:27})]),options());assert.deepEqual(rust.events,result.events);
 assert.equal(result.report.coverage,'exported_buckets_only');
});

test('bounded date selection is half-open; all options and calendar fields are validated',()=>{
 const result=normalizeExternalRecords(aw([awEvent(),awEvent({timestamp:options().to})]),options());assert.equal(result.events.length,1);assert.equal(result.report.excluded_records,1);
 for(const replacement of [{from:'2026-10-12T00:00:00'},{to:'2026-12-01T00:00:00Z'},{from:'2026-02-30T00:00:00Z'},{from:'2026-10-12T00:00:00+14:30'},{employee_id:'../other'},{timezone:'Nowhere/Time'},{source_instance:'OTHER-PC'}])assert.throws(()=>normalizeExternalRecords(aw(),options(replacement)));
 assert.throws(()=>normalizeExternalRecords(aw(),{...options(),run_command:'whoami'}),/未知字段/);
 assert.throws(()=>normalizeExternalRecords(aw([awEvent({duration:-1})]),options()),/duration/);
 assert.throws(()=>normalizeExternalRecords(aw([awEvent({timestamp:'2026-02-30T00:00:00Z'})]),options()),/日期/);
});

test('AW rejects multiple source machines, mismatched buckets and ambiguous same-time changes',()=>{
 const mixed=aw();mixed.buckets.other={...Object.values(aw().buckets)[0],id:'other',hostname:'OTHER-PC'};assert.throws(()=>normalizeExternalRecords(mixed,options()),/其他电脑/);
 assert.throws(()=>normalizeExternalRecords(aw(undefined,{id:'other'}),options()),/桶编号/);
 assert.throws(()=>normalizeExternalRecords({buckets:[]},options()),/buckets/);
 assert.throws(()=>normalizeExternalRecords(aw([awEvent(),awEvent({duration:31})]),options()),/冲突/);
 const duplicate=normalizeExternalRecords(aw([awEvent(),awEvent()]),options());assert.equal(duplicate.events.length,1);assert.equal(duplicate.report.duplicate_records,1);
});

test('Screenpipe OCR and UI pages preserve source kind without granting actions or fetching media',()=>{
 const input={pages:[page([row('OCR',1,{device_name:'Synthetic Display 1'})],0,1,2),page([row('UI',2)],1,1,2)]};const result=normalizeExternalRecords(input,options({source:'screenpipe'}));
 assert.equal(result.events.length,2);for(const e of result.events){validateEvent(e);assert.equal(e.payload.capture_status,'external_text');assert.equal(e.provenance.evidence_kind,'screen_text');assert.equal(e.provenance.duration_seconds,null);assert.deepEqual(e.attachments,[]);assert.equal(e.context.conversation_id,null);}
 assert.deepEqual(result.events.map(e=>e.provenance.source_type),['OCR','UI']);assert.equal(result.report.pages,2);assert.equal(result.report.coverage,'supplied_search_results_only');
 const empty=normalizeExternalRecords(page([row('OCR',1,{text:'   '})]),options({source:'screenpipe'})).events[0];assert.equal(empty.payload.capture_status,'activity_only');assert.equal(empty.payload.text,'');
});

test('Screenpipe fails closed on missing, shifted, duplicated, changed-total and unsupported pages',()=>{
 const o=options({source:'screenpipe'});
 for(const input of [page([row()],0,1,2),page([row()],1,1,2),{data:[row()]},{pages:[page([row()],0,1,2),page([row()],1,1,2)]},{pages:[page([row()],0,1,2),page([row('UI',2)],1,1,3)]},page([row('Audio')]),page([row('Input')]),page([row('Memory')]),page([row('OCR',1,{machine_id:'OTHER-PC'})])])assert.throws(()=>normalizeExternalRecords(input,o));
 assert.equal(normalizeExternalRecords(page([],0,1,0),o).events.length,0);
});

test('oversized, deeply nested, invalid UTF-8 and unsafe JSON shapes are rejected before storage',()=>{
 assert.throws(()=>normalizeExternalRecords(Buffer.alloc(EXTERNAL_LIMITS.bytes+1),options()),/16MiB/);
 assert.throws(()=>normalizeExternalRecords(Buffer.from([0xff]),options()));
 const deep={};let cur=deep;for(let i=0;i<30;i++)cur=cur.child={};assert.throws(()=>normalizeExternalRecords(deep,options()),/结构过深/);
 assert.throws(()=>normalizeExternalRecords(aw(Array.from({length:10001},()=>awEvent())),options()),/10000/);
 assert.throws(()=>normalizeExternalRecords({buckets:new Date()},options()),/普通 JSON/);
 const getter={};Object.defineProperty(getter,'buckets',{enumerable:true,get(){throw Error('must not execute');}});assert.throws(()=>normalizeExternalRecords(getter,options()),/访问器/);
 const clipped=normalizeExternalRecords(page([row('OCR',1,{text:'测'.repeat(12001),window_name:'x'.repeat(501)})]),options({source:'screenpipe'})).events[0];assert.equal(clipped.payload.text.length,12000);assert.equal(clipped.payload.truncated,true);assert.equal(clipped.app.window_title.length,500);
});

test('imports use the local ACK stream; reordered/re-exported records remain idempotent; conflicts are atomic',t=>{
 const {store}=storeFor(t),o=options(),a=awEvent(),b=awEvent({timestamp:'2026-10-12T10:30:00+08:00'});
 store.set('policy',{keep:'existing local setting'});const first=importExternalRecords(store,aw([b,a]),o);assert.equal(first.added,2);assert.equal(first.duplicates,0);assert.deepEqual(store.get('policy'),{keep:'existing local setting'});
 assert.equal(store.stats().pending,2);const batch=store.batch(0);assert.equal(batch.events.length,2);assert(batch.events.every(e=>e.stream_id===store.get('stream_id')));assert.deepEqual(batch.events.map(e=>e.sequence),[1,2]);
 store.set('sync_cursor',2);assert.equal(store.stats().pending,0);
 const replay=importExternalRecords(store,aw([a,b]),{...o,from:'2026-10-11T00:00:00+08:00'});assert.equal(replay.added,0);assert.equal(replay.duplicates,2);assert.equal(store.stats().pending,0);
 const c=awEvent({timestamp:'2026-10-12T11:30:00+08:00'});assert.throws(()=>importExternalRecords(store,aw([c,{...a,duration:55}]),o),/冲突/);assert.equal(store.stats().events,2);assert.equal(store.stats().pending,0);
 const third=importExternalRecords(store,aw([c]),o);assert.equal(third.added,1);assert.equal(store.batch(2).events[0].sequence,3);
});

test('registered employee binding and source-instance separation are enforced',t=>{
 const {store}=storeFor(t),o=options();assert.throws(()=>importExternalRecords(store,aw(),{...o,employee_id:'OTHER'}),/归属/);assert.throws(()=>importExternalRecords(store,aw(),{...o,device_id:uuid()}),/未登记/);assert.equal(store.stats().events,0);
 const one=normalizeExternalRecords(page(),options({source:'screenpipe'}));const two=normalizeExternalRecords(page(),options({source:'screenpipe',source_instance:'ANOTHER-INSTALLATION'}));assert.notEqual(one.events[0].event_id,two.events[0].event_id);
 store.db.prepare('UPDATE devices SET revoked=1').run();assert.throws(()=>importExternalRecords(store,aw(),o),/撤销/);
});

test('external observations and provenance survive encrypted offline bundle roundtrip to the hub',t=>{
 const {store,dir}=storeFor(t),o=options();importExternalRecords(store,aw(),o);importExternalRecords(store,page(),{...o,source:'screenpipe'});
 const hub=new Store(join(dir,'hub.sqlite'));try{hub.addDevice({...o,employee_name:'SYNTHETIC',label:'SYNTHETIC'});const bundle=openBundle(sealBundle(store.exportBundle(o.org_id),'synthetic-only-password'),'synthetic-only-password');for(const p of bundle.policies)validatePolicy(p.value);assert.equal(hub.importBundle(bundle,o.org_id).added,2);assert.equal(hub.importBundle(bundle,o.org_id).duplicates,2);assert(hub.list().items.every(e=>e.provenance.read_only));}finally{hub.close();}
});
