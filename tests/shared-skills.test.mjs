import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const tempRoot=process.platform==='win32'&&existsSync('D:/')?'D:/codex+/temp/worktrace-shared-skills':join(process.env.TEMP||process.env.TMPDIR||root,'worktrace-shared-skills');
mkdirSync(tempRoot,{recursive:true});
const git=process.env.WORKTRACE_GIT||'git';
const env={...process.env,TEMP:tempRoot,TMP:tempRoot,TMPDIR:tempRoot,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(tempRoot,'no-global-gitconfig')};
const psOptions={skip:process.platform!=='win32'};
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
function snapshot(dir){
 if(!existsSync(dir))return {};
 const result={};
 function walk(at,prefix=''){for(const e of readdirSync(at,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())walk(join(at,e.name),rel+'/');else result[rel]=hash(join(at,e.name));}}
 walk(dir);return result;
}
function command(exe,args,cwd,extraEnv={}){const result=spawnSync(exe,args,{cwd,env:{...env,...extraEnv},encoding:'utf8',windowsHide:true,timeout:60_000,maxBuffer:4*1024*1024});if(result.error)throw result.error;return {code:result.status,text:result.stdout+result.stderr,stdout:result.stdout};}
function rejected(result,reason){assert.notEqual(result.code,0,result.text);assert.match(result.text,reason);}
function g(repo,...args){const r=command(git,['-C',repo,...args],repo);assert.equal(r.code,0,r.text);return r.stdout.trim();}
function fixture(t){
 const dir=mkdtempSync(join(tempRoot,'install-'));t.after(()=>{if(resolve(dir).startsWith(resolve(tempRoot)+'\\'))rmSync(dir,{recursive:true,force:true});});
 const repo=join(dir,'clone'),skills=join(dir,'installed');mkdirSync(join(repo,'scripts'),{recursive:true});
 cpSync(join(root,'scripts','Install-SharedSkills.ps1'),join(repo,'scripts','Install-SharedSkills.ps1'));
 cpSync(join(root,'Install-Skills.ps1'),join(repo,'Install-Skills.ps1'));
 cpSync(join(root,'skills'),join(repo,'skills'),{recursive:true});
 writeFileSync(join(repo,'.gitattributes'),'* -text\n');
 g(repo,'init','-b','main');g(repo,'config','user.name','WorkTrace isolated fixture');g(repo,'config','user.email','test@example.invalid');g(repo,'remote','add','origin','https://github.com/zhoudebao6-art/worktrace-skills.git');
 const commit=()=>{g(repo,'add','--all');g(repo,'commit','-m','isolated skill source fixture');return g(repo,'rev-parse','HEAD');};
 const initial=commit();
 const run=(role='hub',extra=[])=>command('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(repo,'scripts','Install-SharedSkills.ps1'),'-Role',role,...(extra.includes('-SkillsDirectory')?[]:['-SkillsDirectory',skills]),...extra],repo);
 return {dir,repo,skills,commit,initial,run};
}
function downloadFixture(f){
 const folder=join(f.dir,'download');mkdirSync(folder);
 const paths=g(f.repo,'-c','core.quotepath=false','ls-files').split(/\r?\n/);
 const files=[];
 for(const path of paths){const source=join(f.repo,path),target=join(folder,path);mkdirSync(dirname(target),{recursive:true});cpSync(source,target);files.push({path,sha256:hash(source),size:readFileSync(source).length});}
 const manifest={format:'worktrace.download/1.0',repository:'https://github.com/zhoudebao6-art/worktrace-skills',commit:f.initial,version:'0.2.1',files};
 const manifestPath=join(folder,'.worktrace-source.json');writeFileSync(manifestPath,JSON.stringify(manifest));
 const run=(role='hub',extra=[])=>command('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(folder,'scripts','Install-SharedSkills.ps1'),'-Role',role,'-SkillsDirectory',f.skills,...extra],folder,{WORKTRACE_GIT:'Z:\\not-installed\\git.exe'});
 return {folder,manifest,manifestPath,run};
}

test('共享技能：纯源码安装、同版幂等、三分控技能和显式更新备份保留绑定',psOptions,t=>{
 const f=fixture(t);
 let r=f.run();assert.equal(r.code,0,r.text);
 const installed=join(f.skills,'worktrace-hub'),receipt=join(installed,'.worktrace-install.json');
 assert.equal(json(receipt).commit,f.initial);assert.equal(json(receipt).repository,'https://github.com/zhoudebao6-art/worktrace-skills');
 assert(!existsSync(join(installed,'deployment.json')));assert(!existsSync(join(installed,'assets','engine','data')));assert(!existsSync(join(installed,'assets','engine','runtime','node.exe')));
 const first=snapshot(f.skills);r=f.run();assert.equal(r.code,0,r.text);assert.match(r.stdout,/unchanged/);assert.deepEqual(snapshot(f.skills),first);
 r=f.run('collector');assert.equal(r.code,0,r.text);
 for(const name of ['worktrace-collector','worktrace-evidence','worktrace-personal']){assert.equal(json(join(f.skills,name,'.worktrace-install.json')).commit,f.initial);assert(!existsSync(join(f.skills,name,'deployment.json')));}
 const binding='{"root":"Z:\\\\production-do-not-touch","role":"hub"}\r\n';
 writeFileSync(join(installed,'deployment.json'),binding);writeFileSync(join(installed,'local.config.json'),'keep local config bytes\n');
 const previous=snapshot(installed);
 writeFileSync(join(f.repo,'skills','worktrace-hub','references','coauthor-example.md'),'reviewed contributor change\n');const next=f.commit();
 r=f.run();rejected(r,/显式使用 -Update/);assert.deepEqual(snapshot(installed),previous);
 r=f.run('hub',['-Update']);assert.equal(r.code,0,r.text);
 const result=r.stdout.split(/\r?\n/).filter(x=>x.startsWith('{')).map(x=>JSON.parse(x))[0];
 assert.equal(result.action,'update');assert.deepEqual(snapshot(result.backup),previous);assert.equal(json(receipt).commit,next);
 assert.equal(readFileSync(join(installed,'deployment.json'),'utf8'),binding);assert.equal(readFileSync(join(installed,'local.config.json'),'utf8'),'keep local config bytes\n');
 assert.equal(readFileSync(join(installed,'references','coauthor-example.md'),'utf8'),'reviewed contributor change\n');
 assert(!existsSync(join(f.repo,'data')));assert(!existsSync(join(installed,'assets','engine','data')));
});

test('共享技能：本地编辑拒绝覆盖且 collector 整组预检后才写入',psOptions,t=>{
 const f=fixture(t);let r=f.run('collector');assert.equal(r.code,0,r.text);
 const personal=join(f.skills,'worktrace-personal','SKILL.md');writeFileSync(personal,readFileSync(personal,'utf8')+'\nlocal uncommitted knowledge\n');
 const before=snapshot(f.skills);r=f.run('collector');rejected(r,/存在本地修改/);assert.deepEqual(snapshot(f.skills),before);
 const collector=join(f.repo,'skills','worktrace-collector','SKILL.md');writeFileSync(collector,readFileSync(collector,'utf8')+'\nreviewed upstream update\n');f.commit();
 r=f.run('collector',['-Update']);rejected(r,/存在本地修改/);assert.deepEqual(snapshot(f.skills),before);
 assert(!existsSync(join(f.skills,'.worktrace-backups')));
});

test('共享技能：未提交源码、未知同名技能、来源变更与本地新增文件冲突均拒绝',psOptions,t=>{
 const f=fixture(t),source=join(f.repo,'skills','worktrace-hub','SKILL.md'),original=readFileSync(source);
 writeFileSync(source,Buffer.concat([original,Buffer.from('\nnot committed\n')]));let r=f.run();rejected(r,/尚未提交的修改/);assert(!existsSync(f.skills));writeFileSync(source,original);
 mkdirSync(join(f.skills,'worktrace-hub'),{recursive:true});writeFileSync(join(f.skills,'worktrace-hub','SKILL.md'),'unknown installation');
 const unknown=snapshot(f.skills);r=f.run('hub',['-Update']);rejected(r,/无共享安装收据/);assert.deepEqual(snapshot(f.skills),unknown);
 rmSync(join(f.skills,'worktrace-hub'),{recursive:true});r=f.run();assert.equal(r.code,0,r.text);
 g(f.repo,'remote','set-url','origin','https://github.com/another/different-source.git');const before=snapshot(f.skills);r=f.run('hub',['-Update']);rejected(r,/来源或角色不同/);assert.deepEqual(snapshot(f.skills),before);
 g(f.repo,'remote','set-url','origin','https://github.com/zhoudebao6-art/worktrace-skills.git');
 writeFileSync(join(f.skills,'worktrace-hub','local-note.md'),'local extra file');writeFileSync(join(f.repo,'skills','worktrace-hub','local-note.md'),'upstream file with same path');f.commit();
 const collision=snapshot(f.skills);r=f.run('hub',['-Update']);rejected(r,/本地附加文件冲突/);assert.deepEqual(snapshot(f.skills),collision);
});

test('共享技能：污染源码与引擎哈希失配拒绝复制',psOptions,t=>{
 const f=fixture(t),engine=join(f.repo,'skills','worktrace-hub','assets','engine');
 const binary=join(engine,'runtime','node.exe');writeFileSync(binary,'stale excluded runtime');let r=f.run();rejected(r,/运行数据、凭据或运行时二进制/);assert(!existsSync(f.skills));rmSync(binary);
 const secret=join(f.repo,'skills','worktrace-hub','deployment.json');writeFileSync(secret,'{"root":"private"}');r=f.run();rejected(r,/运行数据、凭据或运行时二进制/);assert(!existsSync(f.skills));rmSync(secret);
 const file=join(engine,'src','protocol.mjs');writeFileSync(file,readFileSync(file,'utf8')+'\n// invalid mirrored file\n');f.commit();r=f.run();rejected(r,/引擎清单校验/);assert(!existsSync(f.skills));
});

test('共享技能：重叠路径、目标 junction 和来源链接均拒绝且不触碰指向目录',psOptions,t=>{
 const f=fixture(t);let r=f.run('hub',['-SkillsDirectory',join(f.repo,'nested-skills')]);rejected(r,/不能重叠/);assert(!existsSync(join(f.repo,'nested-skills')));
 const outside=join(f.dir,'existing-work');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'untouched');
 symlinkSync(outside,f.skills,'junction');r=f.run();rejected(r,/拒绝链接或 junction/);assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'untouched');assert(!existsSync(join(outside,'worktrace-hub')));rmSync(f.skills);
 symlinkSync(outside,join(f.repo,'skills','worktrace-hub','external'),'junction');r=f.run();rejected(r,/技能内含链接或 junction/);assert(!existsSync(f.skills));
});

test('共享技能：旧版删除文件已备份，篡改收据相对路径不能越界',psOptions,t=>{
 const f=fixture(t),obsolete=join(f.repo,'skills','worktrace-personal','obsolete-note.md');writeFileSync(obsolete,'obsolete source content');f.commit();let r=f.run('collector');assert.equal(r.code,0,r.text);
 rmSync(obsolete);f.commit();r=f.run('collector',['-Update']);assert.equal(r.code,0,r.text);
 const results=r.stdout.split(/\r?\n/).filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
 const personal=results.find(x=>x.skill==='worktrace-personal');assert(!existsSync(join(f.skills,'worktrace-personal','obsolete-note.md')));assert.equal(readFileSync(join(personal.backup,'obsolete-note.md'),'utf8'),'obsolete source content');
 const receipt=join(f.skills,'worktrace-personal','.worktrace-install.json'),record=json(receipt);record.files[0].path='../outside.txt';writeFileSync(receipt,JSON.stringify(record));const before=snapshot(f.skills);r=f.run('collector',['-Update']);rejected(r,/不安全相对路径/);assert.deepEqual(snapshot(f.skills),before);
});

test('共享技能：分控先拉取技能后接入部署，更新保留三项真实绑定',psOptions,t=>{
 const f=fixture(t);let r=f.run('collector');assert.equal(r.code,0,r.text);
 const sourceVersion=json(join(f.repo,'skills','worktrace-hub','assets','engine','engine-manifest.json')).version;
 const bind=()=>command('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(f.repo,'Install-Skills.ps1'),'-Role','collector','-SkillsDirectory',f.skills,'-SkipMcp'],f.repo);
 r=bind();assert.equal(r.code,0,r.text);
 for(const name of ['worktrace-collector','worktrace-evidence','worktrace-personal'])assert.equal(json(join(f.skills,name,'deployment.json')).version,sourceVersion);
 // Both stale and absent legacy versions must be repaired for matching
 // bindings, while the source receipt and installed skill content stay valid.
 const stalePath=join(f.skills,'worktrace-collector','deployment.json'),stale=json(stalePath);writeFileSync(stalePath,JSON.stringify({...stale,version:'0.0.0'}));
 const missingPath=join(f.skills,'worktrace-evidence','deployment.json'),missing=json(missingPath);delete missing.version;writeFileSync(missingPath,JSON.stringify(missing));
 r=bind();assert.equal(r.code,0,r.text);
 const bindings={};
 for(const name of ['worktrace-collector','worktrace-evidence','worktrace-personal']){
  const path=join(f.skills,name,'deployment.json');assert.equal(json(path).root,f.repo);assert.equal(json(path).role,'collector');assert.equal(json(path).version,sourceVersion);bindings[name]=readFileSync(path,'utf8');
 }
 const personal=join(f.repo,'skills','worktrace-personal','SKILL.md');writeFileSync(personal,readFileSync(personal,'utf8')+'\nreviewed new version\n');f.commit();r=f.run('collector',['-Update']);assert.equal(r.code,0,r.text);
 for(const [name,binding]of Object.entries(bindings))assert.equal(readFileSync(join(f.skills,name,'deployment.json'),'utf8'),binding);
 assert(!existsSync(join(f.repo,'data')));
});

test('下载源码包：没有 Git 也能校验整包并安装总控和三项分控技能',psOptions,t=>{
 const f=fixture(t),d=downloadFixture(f);assert(!existsSync(join(d.folder,'.git')));
 for(const role of ['hub','collector']){const r=d.run(role);assert.equal(r.code,0,r.text);}
 for(const name of ['worktrace-hub','worktrace-collector','worktrace-evidence','worktrace-personal']){
  assert.equal(json(join(f.skills,name,'.worktrace-install.json')).commit,f.initial);assert(!existsSync(join(f.skills,name,'deployment.json')));
 }
 const before=snapshot(f.skills),r=d.run('hub');assert.equal(r.code,0,r.text);assert.deepEqual(snapshot(f.skills),before);
 assert(!existsSync(join(d.folder,'data')));
});

test('下载源码包：篡改、额外文件、重复或越界清单在写入技能前拒绝',psOptions,t=>{
 const f=fixture(t),d=downloadFixture(f),file=join(d.folder,'skills','worktrace-hub','SKILL.md'),original=readFileSync(file);
 writeFileSync(file,Buffer.concat([original,Buffer.from('\ntampered\n')]));let r=d.run();rejected(r,/完整下载包校验/);assert(!existsSync(f.skills));writeFileSync(file,original);
 const extra=join(d.folder,'not-listed.txt');writeFileSync(extra,'extra');r=d.run();rejected(r,/完整下载包校验/);assert(!existsSync(f.skills));rmSync(extra);
 const duplicate=structuredClone(d.manifest);duplicate.files.push(duplicate.files[0]);writeFileSync(d.manifestPath,JSON.stringify(duplicate));r=d.run();rejected(r,/来源清单内容无效/);assert(!existsSync(f.skills));
 const traversal=structuredClone(d.manifest);traversal.files[0].path='../outside.txt';writeFileSync(d.manifestPath,JSON.stringify(traversal));r=d.run();rejected(r,/不安全相对路径/);assert(!existsSync(f.skills));
});
