import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const windows=process.platform==='win32';
const base=process.env.WORKTRACE_CONNECT_TEST_ROOT||(windows&&existsSync('D:/')?'D:/codex+/temp/worktrace-connect-verification':join(process.env.TEMP||process.env.TMPDIR||repo,'worktrace-connect-verification'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const names=['worktrace-collector','worktrace-personal','worktrace-evidence'];
function snapshot(folder){const out={};function walk(at,prefix=''){for(const e of readdirSync(at,{withFileTypes:true})){const path=join(at,e.name),relative=prefix+e.name;if(e.isDirectory())walk(path,relative+'/');else out[relative]=hash(readFileSync(path));}}walk(folder);return out;}
function copyTree(from,to){mkdirSync(to,{recursive:true});for(const entry of readdirSync(from,{withFileTypes:true})){if(entry.isDirectory())copyTree(join(from,entry.name),join(to,entry.name));else copyFileSync(join(from,entry.name),join(to,entry.name));}}
function invoke(folder,args){const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(repo,'scripts/Connect-Node.ps1'),...args],{cwd:folder,encoding:'utf8',windowsHide:true,timeout:90000,env:{...process.env,TEMP:'D:/codex+/temp',TMP:'D:/codex+/temp',TMPDIR:'D:/codex+/temp',WORKTRACE_PORT:'0'}});if(r.error)throw r.error;return {code:r.status,text:r.stdout+r.stderr,stdout:r.stdout};}
function rejected(r,pattern){assert.notEqual(r.code,0,r.text);assert.match(r.text,pattern);}
function fixture(){
 mkdirSync(base,{recursive:true});const folder=mkdtempSync(join(base,'connect-unit-')),root=join(folder,'原分控'),skills=join(folder,'skills');
 assert.equal(hash(readFileSync(process.execPath)),'0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4','Run these deployment tests with the pinned Node v22.23.2 x64 runtime');
 copyTree(join(repo,'skills/worktrace-hub/assets/engine'),root);mkdirSync(join(root,'runtime'),{recursive:true});copyFileSync(process.execPath,join(root,'runtime/node.exe'));
 mkdirSync(join(root,'data'));mkdirSync(join(root,'setup'));writeFileSync(join(root,'setup','preserved.txt'),'retain original setup bytes');
 const config={role:'collector',connection_mode:'offline',org_id:randomUUID(),device_id:randomUUID(),installation_id:randomUUID(),employee_id:'TEST_CONNECT',employee_name:'隔离测试员工',org_name:'CONNECT TEST ONLY',label:'Synthetic node',host_binding:''};
 config.host_binding=hash(config.org_id+':'+hostname());writeFileSync(join(root,'data/config.json'),JSON.stringify(config));
 for(const name of names){const dest=join(skills,name);mkdirSync(dest,{recursive:true});writeFileSync(join(dest,'deployment.json'),JSON.stringify({root,role:'collector',version:'0.5.0'}));}
 return {folder,root,skills,config,run:(extra=[])=>invoke(folder,['-SkillsDirectory',skills,...extra])};
}

test('Connect-Node real Windows PowerShell 5.1 validates saved bindings without enrollment or writes',{skip:!windows},async t=>{
 const f=fixture();let passed=false;
 t.after(()=>{writeFileSync(join(f.folder,'verification.json'),JSON.stringify({passed,powershell:'Windows PowerShell 5.1',production_access:false,capture_started:false,test_directory:f.folder},null,2));});
 await t.test('Inspect resolves the three installed bindings and is byte-preserving',()=>{
  const before=snapshot(f.folder),r=f.run(['-Inspect']);assert.equal(r.code,0,r.text);const out=JSON.parse(r.stdout.trim());assert.equal(out.status,'inspected');assert.equal(out.root,f.root);assert.equal(out.employee_id,f.config.employee_id);assert.equal(out.bindings_complete,true);assert.equal(out.service_running,false);assert.deepEqual(snapshot(f.folder),before);
 });
 await t.test('offline node is preserved with no service, login startup or network conversion',()=>{
  const before=snapshot(f.folder),r=f.run();assert.equal(r.code,0,r.text);const out=JSON.parse(r.stdout.trim());assert.equal(out.status,'offline');assert.equal(out.logon_startup,'unchanged');assert.equal(out.sync.state,'offline');assert.deepEqual(snapshot(f.folder),before);
 });
 await t.test('missing all bindings asks for an original directory, never a hub URL',()=>{
  const empty=join(f.folder,'empty-skills');mkdirSync(empty);const r=invoke(f.folder,['-SkillsDirectory',empty,'-Inspect']);rejected(r,/-WorkDir/);assert.match(r.text,/不需要总控链接/);const chosen=invoke(f.folder,['-SkillsDirectory',empty,'-WorkDir',f.root,'-Inspect']);assert.equal(chosen.code,0,chosen.text);assert.equal(JSON.parse(chosen.stdout.trim()).bindings_complete,false);
 });
 await t.test('conflicting bindings require explicit path selection; Inspect can inspect the selected root',()=>{
  const file=join(f.skills,names[2],'deployment.json'),original=readFileSync(file);writeFileSync(file,JSON.stringify({root:join(f.folder,'other-root'),role:'collector'}));
  try{rejected(f.run(['-Inspect']),/多个.*-WorkDir/);const selected=f.run(['-WorkDir',f.root,'-Inspect']);assert.equal(selected.code,0,selected.text);assert.equal(JSON.parse(selected.stdout.trim()).bindings_complete,false);}finally{writeFileSync(file,original);}
 });
 await t.test('relative, traversal, drive-relative and UNC paths are rejected before use',()=>{
  for(const path of ['.','D:relative','D:\\unsafe\\..\\target','\\\\localhost\\share','D:\\trailing.'])rejected(f.run(['-WorkDir',path,'-Inspect']),/绝对普通目录/);
 });
 await t.test('engine hash and fixed runtime hash failures are closed and preserve config',()=>{
  const configBefore=readFileSync(join(f.root,'data/config.json')),file=join(f.root,'src/admin-cli.mjs'),original=readFileSync(file);writeFileSync(file,Buffer.concat([original,Buffer.from('\n// tamper fixture\n')]));
  try{rejected(f.run(['-Inspect']),/引擎校验失败/);}finally{writeFileSync(file,original);}
  const node=join(f.root,'runtime/node.exe');writeFileSync(node,'not a verified runtime');try{rejected(f.run(['-Inspect']),/固定 SHA256/);}finally{copyFileSync(process.execPath,node);}
  assert.deepEqual(readFileSync(join(f.root,'data/config.json')),configBefore);
 });
 await t.test('hub, incomplete identity and junction roots cannot be resumed as collectors',()=>{
  const file=join(f.root,'data/config.json'),original=readFileSync(file);
  try{writeFileSync(file,JSON.stringify({...f.config,role:'hub'}));rejected(f.run(['-Inspect']),/不是已登记分控/);writeFileSync(file,JSON.stringify({...f.config,device_id:''}));rejected(f.run(['-Inspect']),/device_id/);}finally{writeFileSync(file,original);}
  const link=join(f.folder,'linked-root');symlinkSync(f.root,link,'junction');try{rejected(f.run(['-WorkDir',link,'-Inspect']),/junction/);}finally{rmSync(link);}
 });
 passed=true;
});
