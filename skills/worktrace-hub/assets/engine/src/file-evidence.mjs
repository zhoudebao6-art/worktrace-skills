import {lstatSync,realpathSync,readdirSync,openSync,readSync,fstatSync,closeSync,mkdirSync,mkdtempSync,writeFileSync,rmSync,rmdirSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,extname,parse} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {assert,keys,hash,uuid,SOFTWARE_VERSION} from './protocol.mjs';
import {defaultPolicy,inSchedule} from './collector.mjs';

export const defaultFilePolicy={enabled:false,roots:[],extensions:['.docx','.xlsx','.pdf','.txt','.md','.csv'],interval_seconds:60,max_file_bytes:20*1024*1024,max_files_per_scan:2000,max_versions_per_scan:10};
const mimeFor=ext=>({'.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pdf':'application/pdf','.csv':'text/csv','.md':'text/markdown','.txt':'text/plain'}[ext]||'application/octet-stream');
const within=(root,file)=>{const r=relative(root,file);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
export function initFileEvidence(s){s.db.exec('CREATE TABLE IF NOT EXISTS file_versions(sha256 TEXT PRIMARY KEY,mime TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL)');}
export function importFileVersions(s,rows){
 initFileEvidence(s);assert(Array.isArray(rows)&&rows.length<=10000,'文件版本批次过大');
 for(const r of rows){const data=typeof r.data==='string'?Buffer.from(r.data,'base64'):Buffer.from(r.data);assert(data.length>0&&data.length<=20*1024*1024&&r.size===data.length&&hash(data)===r.sha256&&typeof r.mime==='string'&&r.mime.length<160,'文件版本长度或摘要无效');if(typeof r.data==='string')assert(data.toString('base64')===r.data,'文件版本编码无效');const old=s.db.prepare('SELECT * FROM file_versions WHERE sha256=?').get(r.sha256);if(old)assert(old.mime===r.mime&&old.size===r.size&&Buffer.from(old.data).equals(data),'同摘要文件版本冲突');else s.db.prepare('INSERT INTO file_versions VALUES(?,?,?,?)').run(r.sha256,r.mime,r.size,data);}
}
export function checkFileRelations(s,e){
 if(e.event_type!=='document.version')return;initFileEvidence(s);const r=s.db.prepare('SELECT size,mime FROM file_versions WHERE sha256=?').get(e.payload.file_sha256);assert(r&&r.size===e.payload.size&&(r.mime==='application/octet-stream'||r.mime===e.payload.mime),'缺少原始文件版本');
 if(e.payload.previous_event_id){const row=s.db.prepare('SELECT json FROM events WHERE event_id=?').get(e.payload.previous_event_id),p=row?JSON.parse(row.json):null;assert(p&&p.event_type==='document.version'&&p.device_id===e.device_id&&p.employee_id===e.employee_id&&p.org_id===e.org_id&&p.payload.path===e.payload.path,'文件前一版本不属于本员工本路径');}
}
export function validateFilePolicy(p,{dataDir}={}){
 keys(p,Object.keys(defaultFilePolicy));assert(typeof p.enabled==='boolean'&&Array.isArray(p.roots)&&p.roots.length<=12&&(!p.enabled||p.roots.length),'文件取证须明确目录');
 const roots=p.roots.map(value=>{assert(typeof value==='string'&&isAbsolute(value),'资料目录必须为绝对路径');const dir=resolve(value);assert(dir!==parse(dir).root,'不得扫描整个磁盘');assert(lstatSync(dir).isDirectory()&&!lstatSync(dir).isSymbolicLink(),'资料目录不得是链接');const actual=realpathSync(dir);assert(actual.toLowerCase()===dir.toLowerCase(),'资料目录不得经过链接');if(dataDir)assert(!within(dir,resolve(dataDir))&&!within(resolve(dataDir),dir),'资料目录不得包含 WorkTrace 数据或位于数据内');return actual;});
 assert(Array.isArray(p.extensions)&&p.extensions.length>0&&p.extensions.every(x=>defaultFilePolicy.extensions.includes(x)),'不支持的取证扩展名');assert(Number.isInteger(p.interval_seconds)&&p.interval_seconds>=30&&p.interval_seconds<=3600,'文件检查间隔 30–3600 秒');assert(Number.isInteger(p.max_file_bytes)&&p.max_file_bytes>=1&&p.max_file_bytes<=20*1024*1024,'单文件最多 20MiB');assert(Number.isInteger(p.max_files_per_scan)&&p.max_files_per_scan>=1&&p.max_files_per_scan<=10000&&Number.isInteger(p.max_versions_per_scan)&&p.max_versions_per_scan>=1&&p.max_versions_per_scan<=50,'文件扫描预算无效');return {...p,roots};
}
export async function extractDocument(bytes,ext,{root,tempDir=process.env.TEMP||tmpdir()}={}){
 if(['.txt','.md','.csv'].includes(ext)){let text,gaps=[];if(bytes[0]===0xff&&bytes[1]===0xfe)text=bytes.subarray(2).toString('utf16le');else {text=bytes.toString('utf8').replace(/^\uFEFF/,'');if(text.includes('\uFFFD'))gaps.push('文本编码未可靠识别；原件已保留，不能据此核对化学名称或数值。');}if(text.length>60000)gaps.push('提取文本超过 60000 字符，尾部未送入学习。');return {text:text.slice(0,60000),parser:'builtin-text',status:gaps.length?'partial':'text_extracted',gaps};}
 if(!['.docx','.xlsx'].includes(ext))return {text:'',parser:'original-only',status:'unparsed',gaps:['PDF 原件已保存；本版未解析 PDF 正文、扫描页或化学结构，不能宣称理解内容。']};
 mkdirSync(tempDir,{recursive:true});const dir=mkdtempSync(join(tempDir,'worktrace-parse-')),file=join(dir,'source'+ext);writeFileSync(file,bytes,{flag:'wx'});
 try{return await new Promise(resolveResult=>{const child=spawn(process.env.WORKTRACE_POWERSHELL||'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'bridge','extract-document.ps1'),'-InputFile',file,'-Extension',ext],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',done=false;const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolveResult(result);};const failure=()=>({text:'',parser:'ooxml',status:'unparsed',gaps:['Office 正文解析失败或超过资源限制；原件已保存。']});const timer=setTimeout(()=>{child.kill();},20000);child.stdout.setEncoding('utf8');child.stdout.on('data',b=>{out+=b;if(out.length>1000000)child.kill();});child.stderr.resume();child.once('error',()=>finish(failure()));child.once('close',code=>{try{const p=JSON.parse(out.replace(/^\uFEFF/,''));assert(code===0&&typeof p.text==='string'&&p.text.length<=60000&&Array.isArray(p.gaps)&&p.gaps.length<=20&&p.gaps.every(x=>typeof x==='string'&&x.length<=1000),'解析输出无效');finish({text:p.text,parser:'ooxml',status:'partial',gaps:p.gaps});}catch{finish(failure());}});});}finally{rmSync(file,{force:true});rmdirSync(dir);}
}
export class FileEvidenceCollector{
 constructor({store,config,dir,root,isActive=()=>false,parser=extractDocument}){Object.assign(this,{store,config,dir,root,isActive,parser});initFileEvidence(store);this.seen=new Map();this.busy=false;this.stopped=false;this.lastRun=0;this.lastResult=null;this.generation=0;}
 get policy(){return this.store.get('file_policy')||defaultFilePolicy;}
 invalidate(){this.generation++;}
 configure(p){const result=validateFilePolicy(p,{dataDir:this.dir});assert(!result.enabled||this.config.connection_mode==='offline'||result.max_file_bytes<=4*1024*1024,'联网分控单文件须不超过 4MiB；较大原件使用离线完整移交');this.store.set('file_policy',result);this.seen.clear();this.invalidate();return this.status();}
 status(){return {policy:this.policy,busy:this.busy,last_result:this.lastResult,versions:this.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n};}
 async scan({now=new Date()}={}){
  const policy=this.policy,work=this.store.get('policy')||defaultPolicy;if(this.stopped||this.busy||!policy.enabled||!this.isActive()||!inSchedule(work,now))return {skipped:true,reason:'paused_disabled_or_outside_work_hours'};
  if(now.getTime()-this.lastRun<policy.interval_seconds*1000)return {skipped:true,reason:'interval'};this.lastRun=now.getTime();this.busy=true;const generation=this.generation;
  const result={at:now.toISOString(),scanned:0,saved:0,unchanged:0,pending_stability:0,gaps:[]};
  try{
   validateFilePolicy(policy,{dataDir:this.dir});let visited=0;const files=[];const walk=(dir,depth)=>{if(depth>16){result.gaps.push('目录深度超过 16 层，保留缺口');return;}for(const ent of readdirSync(dir,{withFileTypes:true})){if(++visited>policy.max_files_per_scan){result.gaps.push('扫描条目预算达到上限；缩小允许目录，未遍历部分没有证据');return;}const file=join(dir,ent.name);if(ent.isSymbolicLink())continue;if(ent.isDirectory())walk(file,depth+1);else if(ent.isFile()&&!ent.name.startsWith('~$')&&policy.extensions.includes(extname(file).toLowerCase()))files.push(file);if(visited>policy.max_files_per_scan)return;}};
   for(const dir of policy.roots){walk(dir,0);if(visited>policy.max_files_per_scan)break;}
   const current=new Set(files);for(const key of this.seen.keys())if(!current.has(key))this.seen.delete(key);
   for(const file of files){if(this.stopped||generation!==this.generation||!this.isActive()||!inSchedule(this.store.get('policy')||defaultPolicy))break;if(result.saved>=policy.max_versions_per_scan){result.gaps.push('本轮版本预算达到上限，余下留后续扫描');break;}result.scanned++;
    try{const stat=lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||!policy.roots.some(r=>within(r,realpathSync(file))))throw Error('路径离开允许范围');if(stat.size<1||stat.size>policy.max_file_bytes){result.gaps.push('空文件或超过大小上限：'+file);continue;}const signature=stat.size+':'+stat.mtimeMs+':'+stat.ctimeMs;
     const last=this.seen.get(file);this.seen.set(file,{signature,at:now.getTime()});if(!last||last.signature!==signature){result.pending_stability++;continue;}
     const fd=openSync(file,'r');let bytes;try{const before=fstatSync(fd);assert(before.size===stat.size&&before.size<=policy.max_file_bytes,'文件大小变化或超限');const bounded=Buffer.alloc(before.size+1);let read=0;while(read<bounded.length){const n=readSync(fd,bounded,read,bounded.length-read,null);if(!n)break;read+=n;}bytes=bounded.subarray(0,read);const after=fstatSync(fd);assert(before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&after.size===bytes.length&&before.size===stat.size&&before.mtimeMs===stat.mtimeMs&&before.ctimeMs===stat.ctimeMs,'保存过程中发生变化，下轮重试');}finally{closeSync(fd);}
     const digest=hash(bytes),oldRow=this.store.db.prepare("SELECT json FROM events WHERE device_id=? AND event_type='document.version' AND json_extract(json,'$.payload.path')=? ORDER BY rowid DESC LIMIT 1").get(this.config.device_id,file),old=oldRow?JSON.parse(oldRow.json):null;if(old?.payload.file_sha256===digest){result.unchanged++;continue;}
     const ext=extname(file).toLowerCase(),parsed=await this.parser(bytes,ext,{root:this.root}),mime=mimeFor(ext);
     if(this.stopped||generation!==this.generation||!this.isActive()||!this.policy.enabled||!inSchedule(this.store.get('policy')||defaultPolicy)){result.gaps.push('解析期间采集范围或启停状态改变，本次未保存');break;}
     this.store.db.exec('SAVEPOINT file_version_record');try{importFileVersions(this.store,[{sha256:digest,mime:'application/octet-stream',size:bytes.length,data:bytes}]);
     const c=this.config,payload={file_sha256:digest,path:file,extension:ext,mime,size:bytes.length,modified_at:stat.mtime.toISOString(),previous_event_id:old?.event_id||null,text:parsed.text,parser:parsed.parser,parser_version:'1.0',capture_status:parsed.status,gaps:parsed.gaps};
     this.store.append({schema_version:'1.2',event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:uuid(),occurred_at:new Date().toISOString(),timezone:work.timezone,event_type:'document.version',collector_version:SOFTWARE_VERSION,policy_hash:this.store.policy({...work,file_evidence:policy}),app:{process_name:'worktrace-file-reader',window_title:''},context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload,attachments:[]});this.store.db.exec('RELEASE SAVEPOINT file_version_record');result.saved++;}catch(error){this.store.db.exec('ROLLBACK TO SAVEPOINT file_version_record');this.store.db.exec('RELEASE SAVEPOINT file_version_record');throw error;}
    }catch(e){result.gaps.push(file+': '+e.message);}
   }
  }catch(e){result.gaps.push(e.message);}finally{result.gaps=[...new Set(result.gaps)].slice(0,40);this.lastResult=result;this.store.set('file_scan_status',result);this.busy=false;}return result;
 }
 stop(){this.stopped=true;this.invalidate();}
}
