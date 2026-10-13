import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifySource} from '../scripts/verify-source.mjs';

const tempRoot=resolve(process.env.TEMP||tmpdir(),'worktrace-source-gate-tests');mkdirSync(tempRoot,{recursive:true});
const mirror='skills/worktrace-hub/assets/engine';
function fixture(t){
  const root=mkdtempSync(join(tempRoot,'repo-'));
  t.after(()=>{assert(resolve(root).startsWith(tempRoot+sep));rmSync(root,{recursive:true,force:true});});
  const git=(...args)=>execFileSync(process.env.WORKTRACE_GIT||'git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const put=(path,text)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);};
  const skills=['hub','collector','evidence','personal'].map(role=>`skills/worktrace-${role}/SKILL.md`);
  for(const path of skills)put(path,`---\nname: ${path.split('/')[1]}\ndescription: Synthetic fixture only.\n---\n`);
  const source=['src/server.mjs','bridge/observe.ps1','public/index.html','Start.ps1','Tray.ps1','Install-Skills.ps1','连接Codex.ps1','设置登录启动.ps1','runtime/NODE-LICENSE.txt','scripts/provision-common.ps1','scripts/Ensure-Runtime.ps1','scripts/Configure-Learning.ps1','scripts/Join-Node.ps1','scripts/Join-WithInvite.ps1','scripts/Join-Lan.ps1','scripts/Initialize-OfflineNode.ps1','scripts/Offline-Handoff.ps1','scripts/Measure-CollectorPerformance.ps1','scripts/skill-control.ps1'];
  for(const path of source)put(path,'synthetic source\n');
  source.push(...skills.filter(path=>!path.includes('worktrace-hub')));
  const files=source.map(path=>{const bytes=readFileSync(join(root,path));put(mirror+'/'+path,bytes);return {path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
  put(mirror+'/engine-manifest.json',JSON.stringify({format:'worktrace.source/1.0',version:'0.2.0',files}));
  git('init','--quiet');git('add','.');return {root,put,git};
}

test('源码检查按 Git 清单读取，忽略本地未跟踪测试数据，追踪后拒绝发布',t=>{
  const {root,put,git}=fixture(t);assert.equal(verifySource(root).ok,true);
  put('data/worktrace.sqlite','test only');put('runtime/node.exe','test only');assert.equal(verifySource(root).ok,true);
  git('add','data/worktrace.sqlite','runtime/node.exe');const result=verifySource(root);assert.equal(result.ok,false);assert(result.errors.some(message=>message.includes('data/worktrace.sqlite')));assert(result.errors.some(message=>message.includes('runtime/node.exe')));
});

test('源码检查发现遗漏镜像、清单哈希漂移、超大文件及失效技能引用',t=>{
  const {root,put,git}=fixture(t);put('src/new.mjs','new source');put('src/server.mjs','modified source');put('skills/worktrace-hub/assets/engine/stale.txt','orphan mirror');
  put('large.txt',Buffer.alloc(5*1024*1024+1));put('skills/worktrace-hub/SKILL.md','---\nname: wrong-name\ndescription: Fixture.\n---\n[missing](references/no-such-file.md)\n');git('add','.');
  const result=verifySource(root);assert.equal(result.ok,false);for(const phrase of ['omitted from engine manifest','differs from manifest','differs from maintenance source','Unlisted engine mirror','exceeds','name must match','Missing or unsafe relative skill link'])assert(result.errors.some(message=>message.includes(phrase)),phrase);
});

test('源码检查发现伪装 SQLite 与密钥内容但不在错误中回显值',t=>{
  const {root,put,git}=fixture(t);const fakeSecret='gh'+'p_'+'X'.repeat(40);put('accident.txt',fakeSecret);put('backup.txt',Buffer.from('SQLite format 3\0synthetic'));git('add','.');
  const result=verifySource(root);assert.equal(result.ok,false);assert(result.errors.some(message=>message.includes('Possible credential')));assert(result.errors.some(message=>message.includes('SQLite content')));assert(!JSON.stringify(result).includes(fakeSecret));
});

test('源码检查拒绝私有邀请码、接入状态、临时凭据和改名 JSON，不误判代码字段示例',t=>{
  const {root,put,git}=fixture(t);
  put('examples/invitations.mjs',"export const fields = ['invite_token', 'request_secret', 'device_token'];\n");
  put('docs/invitation-example.md','Example: `{"invite_token":"<private code goes here>"}`\n');
  put('examples/safe-document.json',JSON.stringify({invite_token:'<placeholder>',request_secret:'<placeholder>'}));
  git('add','.');assert.equal(verifySource(root).ok,true);
  const forbidden=['invite.json','employee.invitation.json','employee.invite.json','request.json','employee.request.json','join-state.json','setup/self-enrollment/note.txt','setup/lan-enrollment/note.txt','setup/self-lan-enrollment/note.txt','request.json.uuid.tmp'];
  for(const path of forbidden)put(path,'synthetic only');
  const token='Q'.repeat(43);put('renamed-notes.txt',JSON.stringify({records:[{invite_token:token},{request_secret:token},{device_token:token}]}));
  put('escaped-state.json','{"request_\\u0073ecret":"'+token+'"}');
  git('add','.');const result=verifySource(root);assert.equal(result.ok,false);
  for(const path of forbidden)assert(result.errors.some(message=>message.includes(path)),path);
  assert(result.errors.some(message=>message.includes('Private invitation')&&message.includes('renamed-notes.txt')));
  assert(result.errors.some(message=>message.includes('Private invitation')&&message.includes('escaped-state.json')));
  assert(!JSON.stringify(result).includes(token));assert(!result.errors.some(message=>/examples\/|invitation-example/.test(message)));
});
