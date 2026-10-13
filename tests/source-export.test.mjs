import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {exportSource,downloadRepository} from '../scripts/export-source.mjs';

const temp=resolve(process.env.TEMP||tmpdir(),'worktrace-source-export-tests');mkdirSync(temp,{recursive:true});
const mirror='skills/worktrace-hub/assets/engine';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const workspace=mkdtempSync(join(temp,'fixture-')),root=join(workspace,'source'),output=join(workspace,'download');mkdirSync(root);
  t.after(()=>{assert(resolve(workspace).startsWith(temp+sep));rmSync(workspace,{recursive:true,force:true});});
  const git=(...args)=>execFileSync(process.env.WORKTRACE_GIT||'git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const put=(path,bytes)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);};
  const source=['src/server.mjs','bridge/observe.ps1','public/index.html','Start.ps1','Tray.ps1','Install-Skills.ps1','连接Codex.ps1','设置登录启动.ps1','runtime/NODE-LICENSE.txt','scripts/provision-common.ps1','scripts/Ensure-Runtime.ps1','scripts/Configure-Learning.ps1','scripts/Join-Node.ps1','scripts/Initialize-OfflineNode.ps1','scripts/Offline-Handoff.ps1','scripts/skill-control.ps1'];
  for(const path of source)put(path,'synthetic source\n');
  for(const role of ['hub','collector','evidence','personal']){const path=`skills/worktrace-${role}/SKILL.md`;put(path,`---\nname: worktrace-${role}\ndescription: Synthetic export test.\n---\n`);if(role!=='hub')source.push(path);}
  const files=source.map(path=>{const bytes=readFileSync(join(root,path));put(mirror+'/'+path,bytes);return {path,sha256:sha(bytes),size:bytes.length};});
  put(mirror+'/engine-manifest.json',JSON.stringify({format:'worktrace.source/1.0',version:'0.2.1',files}));put('package.json',JSON.stringify({name:'worktrace',version:'0.2.1'}));put('.gitattributes','* -text\n');put('.gitignore','data/\n');
  git('init','--quiet');git('remote','add','origin',downloadRepository+'.git');
  const commit=()=>{git('add','.');git('-c','user.name=WorkTrace Test','-c','user.email=test@example.invalid','commit','--quiet','-m','Synthetic source fixture');};commit();return {workspace,root,output,put,git,commit};
}

test('下载源码导出精确覆盖干净 HEAD，清单可离线逐字节核验，忽略本地数据和 .git',t=>{
  const f=fixture(t);f.put('data/private.sqlite','ignored local fixture');const result=exportSource(f);assert.equal(result.ok,true);
  const manifest=JSON.parse(readFileSync(join(f.output,'.worktrace-source.json'),'utf8'));assert.equal(manifest.format,'worktrace.download/1.0');assert.equal(manifest.repository,downloadRepository);assert.equal(manifest.commit,f.git('rev-parse','HEAD').trim());assert.equal(manifest.version,'0.2.1');
  const tracked=f.git('ls-files','-z').split('\0').filter(Boolean).sort();assert.deepEqual(manifest.files.map(entry=>entry.path),tracked);
  for(const entry of manifest.files){const bytes=readFileSync(join(f.output,entry.path));assert.equal(bytes.length,entry.size);assert.equal(sha(bytes),entry.sha256);assert.deepEqual(bytes,readFileSync(join(f.root,entry.path)));}
  assert(!existsSync(join(f.output,'.git')));assert(!existsSync(join(f.output,'data')));assert(!manifest.files.some(entry=>entry.path==='.worktrace-source.json'));
});

test('未提交、未跟踪和暂存改动均在创建导出目录前拒绝',t=>{
  for(const kind of ['modified','untracked','staged']){const f=fixture(t);if(kind==='modified')f.put('package.json','{}');else f.put('pending.txt','synthetic unfinished work');if(kind==='staged')f.git('add','pending.txt');assert.throws(()=>exportSource(f),/clean committed HEAD/);assert(!existsSync(f.output));}
});

test('Git 忽略检查标记不能掩盖 HEAD 字节差异，已提交的错误镜像也拒绝',t=>{
  const hidden=fixture(t);hidden.git('update-index','--assume-unchanged','src/server.mjs');hidden.put('src/server.mjs','hidden local change');assert.equal(hidden.git('status','--porcelain=v1'),'');assert.throws(()=>exportSource(hidden),/do not match HEAD/);assert(!existsSync(hidden.output));
  const drift=fixture(t);drift.put('src/server.mjs','committed but mirror not refreshed');drift.commit();assert.throws(()=>exportSource(drift),/Source verification failed/);assert(!existsSync(drift.output));
});

test('拒绝已有输出、源码内输出、链接路径和 Git 符号链接条目',t=>{
  const f=fixture(t);mkdirSync(f.output);writeFileSync(join(f.output,'keep.txt'),'preserve');assert.throws(()=>exportSource(f),/already exists/);assert.equal(readFileSync(join(f.output,'keep.txt'),'utf8'),'preserve');assert.throws(()=>exportSource({...f,output:join(f.root,'download')}),/overlap/);
  const link=join(f.workspace,'linked-parent');symlinkSync(f.output,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>exportSource({...f,output:join(link,'new-download')}),/links or junctions/);
  const linked=fixture(t);linked.git('config','core.symlinks','false');linked.put('unsafe-link','src/server.mjs');linked.git('add','unsafe-link');const oid=linked.git('hash-object','unsafe-link').trim();linked.git('update-index','--cacheinfo',`120000,${oid},unsafe-link`);linked.git('-c','user.name=WorkTrace Test','-c','user.email=test@example.invalid','commit','--quiet','-m','Synthetic link fixture');assert.throws(()=>exportSource(linked),/links and submodules/);assert(!existsSync(linked.output));
});
