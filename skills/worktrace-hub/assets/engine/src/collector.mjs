import {SOFTWARE_VERSION} from './protocol.mjs';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { uuid,hash,canonical,VERSION,assert } from './protocol.mjs';
export const defaultPolicy={interval_seconds:15,idle_seconds:300,workdays:[1,2,3,4,5],start:'09:00',end:'18:00',timezone:'Asia/Shanghai',content_processes:[],excluded_processes:['keepass.exe','keepassxc.exe','1password.exe'],excluded_title_terms:['密码','password','支付验证','私人'],record_titles:false,screenshots:false};
export function validatePolicy(p){assert(p&&Number.isInteger(p.interval_seconds)&&p.interval_seconds>=5&&p.interval_seconds<=300,'采样间隔须为 5–300 秒');assert(Number.isInteger(p.idle_seconds)&&p.idle_seconds>=30&&p.idle_seconds<=3600,'空闲阈值无效');assert(Array.isArray(p.workdays)&&p.workdays.length>0&&p.workdays.every(x=>Number.isInteger(x)&&x>=0&&x<=6),'工作日无效');for(const k of ['start','end'])assert(typeof p[k]==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(p[k]),'工作时间无效');assert(p.start<p.end,'本版仅支持同日工作时间段');new Intl.DateTimeFormat('en',{timeZone:p.timezone});for(const k of ['content_processes','excluded_processes'])assert(Array.isArray(p[k])&&p[k].length<=40&&p[k].every(x=>typeof x==='string'&&/^[a-z0-9_.-]+\.exe$/.test(x)),'进程名必须是小写 exe 文件名');assert(Array.isArray(p.excluded_title_terms)&&p.excluded_title_terms.length<=50&&p.excluded_title_terms.every(x=>typeof x==='string'&&x.length>0&&x.length<=80),'排除词无效');assert(typeof p.record_titles==='boolean'&&typeof p.screenshots==='boolean','采集开关无效');return Object.fromEntries(Object.keys(defaultPolicy).map(k=>[k,p[k]]));}
const scheduleFormatters=new Map();
export function inSchedule(p,date=new Date()){let formatter=scheduleFormatters.get(p.timezone);if(!formatter){formatter=new Intl.DateTimeFormat('en-GB',{timeZone:p.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(scheduleFormatters.size>=16)scheduleFormatters.delete(scheduleFormatters.keys().next().value);scheduleFormatters.set(p.timezone,formatter);}const parts=Object.fromEntries(formatter.formatToParts(date).map(x=>[x.type,x.value]));const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),t=parts.hour+':'+parts.minute;return p.workdays.includes(day)&&t>=p.start&&t<p.end;}
export class Collector{
 constructor({store,config,dir,root,onError=()=>{},onStateChange=()=>{},clock=()=>Date.now(),spawnObserver=spawn}){Object.assign(this,{store,config,dir,root,onError,onStateChange,clock,spawnObserver});this.child=null;this.timer=null;this.enabled=false;this.lastSample=0;this.lastDigest='';this.lastSaved=0;this.restartFailures=0;this.restartAfter=0;this.validSamples=0;this.session=uuid();this.state='已暂停';this.policy=store.get('policy')||defaultPolicy;}
 record(type,payload,app={process_name:'',window_title:''},assets=[]){const c=this.config;return this.store.append({schema_version:VERSION,event_id:uuid(),org_id:c.org_id,device_id:c.device_id,employee_id:c.employee_id,session_id:this.session,occurred_at:new Date(this.clock()).toISOString(),timezone:this.policy.timezone,event_type:type,collector_version:SOFTWARE_VERSION,policy_hash:this.store.policy(this.policy),app,context:{case_id:null,conversation_id:null,sender_id:null,identity_source:'device_assignment'},payload:{text:'',capture_status:'status',idle_seconds:0,truncated:false,reason:'',...payload},attachments:assets.map(a=>({sha256:a.sha256,mime:a.mime,size:Buffer.byteLength(a.data,'base64'),kind:'window_capture'}))},assets);}
 accept(sample){
  const now=this.clock();if(!this.enabled||!inSchedule(this.policy,new Date(now)))return;
  const payload={text:String(sample.text||'').slice(0,12000),capture_status:sample.capture_status,idle_seconds:Math.max(0,Math.floor(Number(sample.idle_seconds)||0)),truncated:!!sample.truncated,reason:String(sample.reason||'').slice(0,500)},app={process_name:String(sample.process_name||'').slice(0,100),window_title:String(sample.window_title||'').slice(0,500)};
  const image=sample.image&&this.policy.screenshots&&payload.capture_status==='uia'?sample.image:null,imageHash=image?hash(Buffer.from(image,'base64')):null;
  const digest=hash(canonical({payload:{...payload,idle_seconds:0},app,image_hash:imageHash}));
  if(digest!==this.lastDigest||now-this.lastSaved>=60000){const assets=image?[{sha256:imageHash,mime:'image/jpeg',data:image}]:[];this.record('activity.snapshot',payload,app,assets);this.lastDigest=digest;this.lastSaved=now;}
  this.lastSample=now;this.validSamples++;if(this.validSamples>=2){this.restartFailures=0;this.restartAfter=0;}this.state=payload.capture_status==='uia'?'正在读取已配置应用':'正在记录活动';
 }
 deferRestart(reason){this.restartFailures=Math.min(this.restartFailures+1,6);const delay=Math.min(120000,5000*2**(this.restartFailures-1));this.restartAfter=this.clock()+delay;this.state='采集桥接暂不可用，'+delay/1000+' 秒后重试';this.record('collector.gap',{reason:reason+';retry-after-ms='+delay,capture_status:'unavailable'});}
 launch(){
  const file=join(this.dir,'observer-policy.json');writeFileSync(file,JSON.stringify(this.policy));const exe=process.env.WORKTRACE_POWERSHELL||'powershell.exe';let child;
  try{child=this.spawnObserver(exe,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(this.root,'bridge','observe.ps1'),'-Policy',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(e){this.deferRestart('observer-start-failed');this.onError(e.message);return;}
  this.child=child;this.lastSample=this.clock();this.validSamples=0;const reader=createInterface({input:child.stdout});
  reader.on('line',line=>{try{if(this.child===child)this.accept(JSON.parse(line.replace(/^\uFEFF/,'')));}catch(e){this.onError(e.message);}});
  child.stderr.on('data',()=>{if(this.child===child)this.state='采集桥接发生错误';});
  const ended=reason=>{reader.close();if(this.child!==child)return;this.child=null;if(this.enabled)this.deferRestart(reason);};
  child.on('error',()=>ended('observer-start-failed'));child.on('exit',()=>ended('observer-exited'));
 }
 tick(){const now=this.clock();if(!this.enabled)return;if(!inSchedule(this.policy,new Date(now))){this.state='工作时间外，采集休眠';this.stopChild();return;}if(!this.child){if(now>=this.restartAfter)this.launch();return;}if(now-this.lastSample>Math.max(45000,this.policy.interval_seconds*3000)){this.stopChild();this.deferRestart('observer-timeout');}}
 start(){if(this.enabled)return;assert(process.platform==='win32','桌面采集仅支持 Windows');this.enabled=true;this.onStateChange({enabled:true});this.session=uuid();this.lastDigest='';this.restartFailures=0;this.restartAfter=0;this.record('collector.started',{reason:'user-start'});this.tick();this.timer=setInterval(()=>{try{this.tick();}catch(e){this.onError(e.message);}},3000);this.timer.unref();}
 stopChild(){if(this.child){const child=this.child;this.child=null;child.kill();}}
 stop(){this.onStateChange({enabled:false});const was=this.enabled;this.enabled=false;clearInterval(this.timer);this.stopChild();this.state='已暂停';if(was)this.record('collector.paused',{reason:'user-pause'});}
 update(p){const checked=validatePolicy(p),enabled=this.enabled;this.stop();this.policy=checked;this.store.set('policy',this.policy);if(enabled)this.start();}
}
