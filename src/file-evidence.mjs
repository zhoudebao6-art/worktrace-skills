import {lstatSync,realpathSync} from 'node:fs';
import * as fileIO from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,extname,parse} from 'node:path';
import {tmpdir,setPriority,constants as osConstants} from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {assert,keys,hash,uuid,SOFTWARE_VERSION} from './protocol.mjs';
import {defaultPolicy,inSchedule} from './collector.mjs';

export const defaultFilePolicy={enabled:false,roots:[],extensions:['.docx','.xlsx','.pdf','.txt','.md','.csv'],interval_seconds:60,max_file_bytes:20*1024*1024,max_files_per_scan:2000,max_versions_per_scan:10};
const mimeFor=ext=>({'.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pdf':'application/pdf','.csv':'text/csv','.md':'text/markdown','.txt':'text/plain'}[ext]||'application/octet-stream');
const within=(root,file)=>{const r=relative(root,file);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.birthtimeMs].join(':');
const readChunkBytes=256*1024,contentRecheckMs=6*60*60*1000;
export function initFileEvidence(s){s.db.exec('CREATE TABLE IF NOT EXISTS file_versions(sha256 TEXT PRIMARY KEY,mime TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL)');}
export function importFileVersions(s,rows){
 initFileEvidence(s);assert(Array.isArray(rows)&&rows.length<=10000,'文件版本批次过大');
 for(const r of rows){const data=typeof r.data==='string'?Buffer.from(r.data,'base64'):Buffer.from(r.data);assert(data.length>0&&data.length<=20*1024*1024&&r.size===data.length&&hash(data)===r.sha256&&typeof r.mime==='string'&&r.mime.length<160,'文件版本长度或摘要无效');if(typeof r.data==='string')assert(data.toString('base64')===r.data,'文件版本编码无效');putVerifiedFile(s,r,data);}
}
// Private: the scanner already computed this digest while reading owned bytes.
// External imports always pass through importFileVersions and its hash check.
function putVerifiedFile(s,r,data){const old=s.db.prepare('SELECT * FROM file_versions WHERE sha256=?').get(r.sha256);if(old){assert(old.size===r.size&&Buffer.from(old.data).equals(data)&&(old.mime===r.mime||old.mime==='application/octet-stream'||r.mime==='application/octet-stream'),'同摘要文件版本冲突');if(old.mime!==r.mime&&old.mime!=='application/octet-stream')s.db.prepare('UPDATE file_versions SET mime=? WHERE sha256=?').run('application/octet-stream',r.sha256);}else s.db.prepare('INSERT INTO file_versions VALUES(?,?,?,?)').run(r.sha256,r.mime,r.size,data);}
export function checkFileRelations(s,e){
 if(e.event_type!=='document.version')return;initFileEvidence(s);const r=s.db.prepare('SELECT size,mime FROM file_versions WHERE sha256=?').get(e.payload.file_sha256);assert(r&&r.size===e.payload.size&&(r.mime==='application/octet-stream'||r.mime===e.payload.mime),'缺少原始文件版本');
 if(e.payload.previous_event_id){const row=s.db.prepare('SELECT json FROM events WHERE event_id=?').get(e.payload.previous_event_id),p=row?JSON.parse(row.json):null;assert(p&&p.event_type==='document.version'&&p.device_id===e.device_id&&p.employee_id===e.employee_id&&p.org_id===e.org_id&&p.payload.path===e.payload.path,'文件前一版本不属于本员工本路径');}
}
export function validateFilePolicy(p,{dataDir,checkDirectories=true}={}){
 keys(p,Object.keys(defaultFilePolicy));assert(typeof p.enabled==='boolean'&&Array.isArray(p.roots)&&p.roots.length<=12&&(!p.enabled||p.roots.length),'文件取证须明确目录');
 const roots=p.roots.map(value=>{assert(typeof value==='string'&&isAbsolute(value),'资料目录必须为绝对路径');const dir=resolve(value);assert(dir!==parse(dir).root,'不得扫描整个磁盘');let actual=dir;if(checkDirectories){const stat=lstatSync(dir);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'资料目录不得是链接');actual=realpathSync(dir);assert(actual.toLowerCase()===dir.toLowerCase(),'资料目录不得经过链接');}if(dataDir)assert(!within(dir,resolve(dataDir))&&!within(resolve(dataDir),dir),'资料目录不得包含 WorkTrace 数据或位于数据内');return actual;});
 assert(Array.isArray(p.extensions)&&p.extensions.length>0&&p.extensions.every(x=>defaultFilePolicy.extensions.includes(x)),'不支持的取证扩展名');assert(Number.isInteger(p.interval_seconds)&&p.interval_seconds>=30&&p.interval_seconds<=3600,'文件检查间隔 30–3600 秒');assert(Number.isInteger(p.max_file_bytes)&&p.max_file_bytes>=1&&p.max_file_bytes<=20*1024*1024,'单文件最多 20MiB');assert(Number.isInteger(p.max_files_per_scan)&&p.max_files_per_scan>=1&&p.max_files_per_scan<=10000&&Number.isInteger(p.max_versions_per_scan)&&p.max_versions_per_scan>=1&&p.max_versions_per_scan<=50,'文件扫描预算无效');return {...p,roots};
}
export async function extractDocument(bytes,ext,{root,tempDir=process.env.TEMP||tmpdir(),signal}={}){
 if(['.txt','.md','.csv'].includes(ext)){let text,gaps=[],clipped=false;if(bytes[0]===0xff&&bytes[1]===0xfe){const end=Math.min(bytes.length,120004);text=bytes.subarray(2,end).toString('utf16le');clipped=end<bytes.length;}else {const end=Math.min(bytes.length,240004),decoder=new StringDecoder('utf8');text=(decoder.write(bytes.subarray(0,end))+(end===bytes.length?decoder.end():'')).replace(/^\uFEFF/,'');clipped=end<bytes.length;if(text.includes('\uFFFD'))gaps.push('文本编码未可靠识别；原件已保留，不能据此核对化学名称或数值。');}if(clipped||text.length>60000)gaps.push('提取文本超过 60000 字符，尾部未送入学习。');return {text:text.slice(0,60000),parser:'builtin-text',status:gaps.length?'partial':'text_extracted',gaps};}
 if(!['.docx','.xlsx'].includes(ext))return {text:'',parser:'original-only',status:'unparsed',gaps:['PDF 原件已保存；本版未解析 PDF 正文、扫描页或化学结构，不能宣称理解内容。']};
 await fileIO.mkdir(tempDir,{recursive:true});const dir=await fileIO.mkdtemp(join(tempDir,'worktrace-parse-')),file=join(dir,'source'+ext);
 try{await fileIO.writeFile(file,bytes,{flag:'wx',signal});signal?.throwIfAborted();return await new Promise(resolveResult=>{const child=spawn(process.env.WORKTRACE_POWERSHELL||'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'bridge','extract-document.ps1'),'-InputFile',file,'-Extension',ext],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',done=false;const abort=()=>child.kill();const finish=result=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolveResult(result);};const failure=()=>({text:'',parser:'ooxml',status:'unparsed',gaps:['Office 正文解析失败或超过资源限制；原件已保存。']});const timer=setTimeout(abort,20000);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();child.once('spawn',()=>{try{setPriority(child.pid,osConstants.priority.PRIORITY_BELOW_NORMAL);}catch{}});child.stdout.setEncoding('utf8');child.stdout.on('data',b=>{out+=b;if(out.length>1000000)abort();});child.stderr.resume();child.once('error',()=>finish(failure()));child.once('close',code=>{try{const p=JSON.parse(out.replace(/^\uFEFF/,''));assert(code===0&&typeof p.text==='string'&&p.text.length<=60000&&Array.isArray(p.gaps)&&p.gaps.length<=20&&p.gaps.every(x=>typeof x==='string'&&x.length<=1000),'解析输出无效');finish({text:p.text,parser:'ooxml',status:'partial',gaps:p.gaps});}catch{finish(failure());}});});}finally{await fileIO.rm(file,{force:true});await fileIO.rmdir(dir);}
}
export class FileEvidenceCollector{
 constructor({store,config,dir,root,isActive=()=>false,parser=extractDocument,io={}}){Object.assign(this,{store,config,dir,root,isActive,parser});this.io={...fileIO,...io};initFileEvidence(store);this.seen=new Map();this.busy=false;this.stopped=false;this.lastRun=0;this.lastResult=null;this.generation=0;this.walk=null;this.cycle=0;this.contentRecheckMs=contentRecheckMs;this.controller=null;}
 get policy(){return this.store.get('file_policy')||defaultFilePolicy;}
 invalidate(){this.generation++;this.controller?.abort();if(!this.busy)this.closeWalk();this.walk=null;}
 closeWalk(walk=this.walk){if(walk?.current){try{walk.current.handle.closeSync();}catch(error){if(error.code!=='ERR_DIR_CLOSED')throw error;}walk.current=null;}}
 configure(p){const result=validateFilePolicy(p,{dataDir:this.dir});assert(!result.enabled||this.config.connection_mode==='offline'||result.max_file_bytes<=4*1024*1024,'联网分控单文件须不超过 4MiB；较大原件使用离线完整移交');this.store.set('file_policy',result);this.seen.clear();this.invalidate();return this.status();}
 status(){return {policy:this.policy,busy:this.busy,last_result:this.lastResult,versions:this.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n};}
 async nextEntry(walk,policy,result){
  while(true){
   if(this.walk!==walk)return null;
   if(!walk.current){
    if(walk.head>=walk.directories.length)return null;
    const next=walk.directories[walk.head++];
    if(walk.head>1024){walk.directories=walk.directories.slice(walk.head);walk.head=0;}
    if(next.depth>16){result.gaps.push('目录深度超过 16 层，保留缺口');continue;}
    try{const stat=await this.io.lstat(next.path),actual=await this.io.realpath(next.path);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&actual.toLowerCase()===next.path.toLowerCase()&&policy.roots.some(r=>within(r,actual)),'目录离开允许范围');walk.current={...next,handle:await this.io.opendir(next.path,{bufferSize:32})};}catch(error){result.gaps.push(next.path+': '+error.message);continue;}
   }
   const current=walk.current;let entry;
   try{entry=await current.handle.read();}catch(error){result.gaps.push(current.path+': '+error.message);this.closeWalk(walk);continue;}
   if(!entry){await current.handle.close();walk.current=null;continue;}
   result.visited++;return {entry,path:join(current.path,entry.name),depth:current.depth+1};
  }
 }
 async readStable(file,stat,policy,result,valid){
  const fd=await this.io.open(file,'r');try{
   const before=await fd.stat();assert(signature(before)===signature(stat)&&before.size>0&&before.size<=policy.max_file_bytes,'文件大小变化或超限');
   const bounded=Buffer.allocUnsafe(before.size+1),digest=createHash('sha256');let read=0;result.files_read++;
   while(read<bounded.length){assert(valid(),'读取期间采集范围或启停状态改变');const {bytesRead}=await fd.read(bounded,read,Math.min(readChunkBytes,bounded.length-read),read);if(!bytesRead)break;digest.update(bounded.subarray(read,read+bytesRead));read+=bytesRead;result.bytes_read+=bytesRead;await yieldTurn();}
   const after=await fd.stat(),pathStat=await this.io.lstat(file),actual=await this.io.realpath(file);assert(signature(before)===signature(after)&&signature(before)===signature(pathStat)&&!pathStat.isSymbolicLink()&&policy.roots.some(r=>within(r,actual))&&after.size===read,'保存过程中发生变化，下轮重试');
   return {bytes:bounded.subarray(0,read),digest:digest.digest('hex')};
  }finally{await fd.close();}
 }
 async scan({now=new Date()}={}){
  const policy=this.policy,work=this.store.get('policy')||defaultPolicy;if(this.busy)return {skipped:true,reason:'paused_disabled_or_outside_work_hours'};if(this.stopped||!policy.enabled||!this.isActive()||!inSchedule(work,now)){this.closeWalk();this.walk=null;return {skipped:true,reason:'paused_disabled_or_outside_work_hours'};}
  if(now.getTime()-this.lastRun<policy.interval_seconds*1000)return {skipped:true,reason:'interval'};this.lastRun=now.getTime();this.busy=true;const generation=this.generation,started=performance.now();this.controller=new AbortController();
  const valid=()=>!this.stopped&&generation===this.generation&&this.isActive()&&inSchedule(work);
  const walk=this.walk||(this.walk={directories:policy.roots.map(path=>({path,depth:0})),head:0,current:null,cycle:++this.cycle});
  const result={at:now.toISOString(),visited:0,scanned:0,saved:0,unchanged:0,pending_stability:0,files_read:0,bytes_read:0,cache_hits:0,cycle_completed:false,gaps:[]};
  try{
   // Shape/boundary checks are synchronous; directory identity is verified
   // asynchronously by nextEntry and readStable on every traversal/read.
   validateFilePolicy(policy,{dataDir:this.dir,checkDirectories:false});
   while(valid()&&result.visited<policy.max_files_per_scan){
    if(result.visited%32===0&&!inSchedule(this.store.get('policy')||defaultPolicy))break;
    if(result.files_read>=policy.max_versions_per_scan){result.gaps.push('本轮原件内容读取或复核预算达到上限，下轮从后续文件继续；未修改原件也计入读取预算');break;}
    const item=await this.nextEntry(walk,policy,result);if(!valid())break;
    if(!item){result.cycle_completed=true;for(const [key,value] of this.seen)if(value.cycle!==walk.cycle)this.seen.delete(key);this.walk=null;break;}
    const {entry,path:file,depth}=item;if(entry.isSymbolicLink())continue;if(entry.isDirectory()){walk.directories.push({path:file,depth});continue;}if(!entry.isFile()||entry.name.startsWith('~$')||!policy.extensions.includes(extname(file).toLowerCase()))continue;result.scanned++;
    try{const stat=await this.io.lstat(file),actual=await this.io.realpath(file);if(stat.isSymbolicLink()||!stat.isFile()||!policy.roots.some(r=>within(r,actual)))throw Error('路径离开允许范围');if(stat.size<1||stat.size>policy.max_file_bytes){result.gaps.push('空文件或超过大小上限：'+file);continue;}const currentSignature=signature(stat);
     let last=this.seen.get(file);if(!last||last.signature!==currentSignature){last={signature:currentSignature,observed_at:now.getTime(),cycle:walk.cycle};this.seen.set(file,last);result.pending_stability++;continue;}last.cycle=walk.cycle;
     if(now.getTime()-last.observed_at<policy.interval_seconds*1000){result.pending_stability++;continue;}
     if(last.verified_at!==undefined&&now.getTime()-last.verified_at<this.contentRecheckMs){result.unchanged++;result.cache_hits++;continue;}
     const {bytes,digest}=await this.readStable(file,stat,policy,result,valid);
     const oldRow=this.store.db.prepare("SELECT json FROM events WHERE device_id=? AND event_type='document.version' AND json_extract(json,'$.payload.path')=? ORDER BY rowid DESC LIMIT 1").get(this.config.device_id,file),old=oldRow?JSON.parse(oldRow.json):null;
     if(old?.payload.file_sha256===digest){last.verified_at=now.getTime();result.unchanged++;continue;}
     const ext=extname(file).toLowerCase(),parsed=await this.parser(bytes,ext,{root:this.root,signal:this.controller.signal}),mime=mimeFor(ext);
     if(!valid()||!this.policy.enabled||!inSchedule(this.store.get('policy')||defaultPolicy)){result.gaps.push('解析期间采集范围或启停状态改变，本次未保存');break;}
     this.store.db.exec('SAVEPOINT file_version_record');try{putVerifiedFile(this.store,{sha256:digest,mime:'application/octet-stream',size:bytes.length},bytes);
     const c=this.config,payload={file_sha256:digest,path:file,extension:ext,mime,size:bytes.length,modified_at:stat.mtime.toISOString(),previous_event_id:old?.event_id||null,text:parsed.text,parser:parsed.parser,parser_version:'1.0',capture_status:parsed.status,gaps:parsed.gaps};
     this.store.append({schema_version:'1.2',event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:uuid(),occurred_at:new Date().toISOString(),timezone:work.timezone,event_type:'document.version',collector_version:SOFTWARE_VERSION,policy_hash:this.store.policy({...work,file_evidence:policy}),app:{process_name:'worktrace-file-reader',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload,attachments:[]});this.store.db.exec('RELEASE SAVEPOINT file_version_record');last.verified_at=now.getTime();result.saved++;}catch(error){this.store.db.exec('ROLLBACK TO SAVEPOINT file_version_record');this.store.db.exec('RELEASE SAVEPOINT file_version_record');throw error;}
     await yieldTurn();
    }catch(e){result.gaps.push(file+': '+e.message);}
   }
   if(result.visited>=policy.max_files_per_scan)result.gaps.push('扫描条目预算达到上限，下轮从目录游标继续，后续部分尚无证据');
  }catch(e){result.gaps.push(e.message);}finally{if(!valid()||this.walk!==walk){this.closeWalk(walk);if(this.walk===walk)this.walk=null;}this.controller=null;result.duration_ms=Math.round(performance.now()-started);result.gaps=[...new Set(result.gaps)].slice(0,40);this.lastResult=result;this.busy=false;this.store.set('file_scan_status',result);}return result;
 }
 stop(){this.stopped=true;this.invalidate();}
}
