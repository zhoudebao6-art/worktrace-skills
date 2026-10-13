import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {startApp} from '../src/server.mjs';
import {admin} from '../src/admin-cli.mjs';
const root=resolve('.'),tempRoot=resolve(process.env.TEMP||'../../work','worktrace-tests');mkdirSync(tempRoot,{recursive:true});
const freePort=()=>new Promise(ok=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
function runPS(args){return new Promise((ok,no)=>{const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass',...args],{windowsHide:true,cwd:root,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',no);p.on('close',code=>ok({code,out,err}));});}
test('总控/分控技能安装及部署脚本：独立绑定、角色隔离、无密钥输出',async t=>{
 const dir=mkdtempSync(join(tempRoot,'roles-')),apps=[];t.after(async()=>{for(const a of apps.reverse())await a.close();if(resolve(dir).startsWith(tempRoot+'\\'))rmSync(dir,{recursive:true,force:true});});
 const sourceVersion=JSON.parse(readFileSync(join(root,'skills','worktrace-hub','assets','engine','engine-manifest.json'),'utf8')).version;
 const skills=join(dir,'skills');const installed=await runPS(['-File','Install-Skills.ps1','-Role','hub','-SkillsDirectory',skills,'-SkipMcp']);assert.equal(installed.code,0,installed.err);
 const bindingFile=join(skills,'worktrace-hub','deployment.json'),binding=JSON.parse(readFileSync(bindingFile,'utf8').replace(/^\uFEFF/,''));assert.equal(binding.root,root);assert.equal(binding.version,sourceVersion);
 // An existing deployment using the same source content must refresh its
 // legacy version metadata without requiring an unrelated source upgrade.
 writeFileSync(bindingFile,JSON.stringify({...binding,version:'0.0.0'}));
 const repeated=await runPS(['-File','Install-Skills.ps1','-Role','hub','-SkillsDirectory',skills,'-SkipMcp']);assert.equal(repeated.code,0,repeated.err);
 assert.deepEqual(JSON.parse(readFileSync(bindingFile,'utf8').replace(/^\uFEFF/,'')),binding);
 const clientSkills=await runPS(['-File','Install-Skills.ps1','-Role','collector','-SkillsDirectory',join(dir,'client-skills'),'-SkipMcp']);assert.equal(clientSkills.code,0,clientSkills.err);
 for(const name of ['worktrace-collector','worktrace-evidence','worktrace-personal'])assert.equal(JSON.parse(readFileSync(join(dir,'client-skills',name,'deployment.json'),'utf8').replace(/^\uFEFF/,'')).version,sourceVersion);
 const blank=await startApp({dir:join(dir,'blank'),port:0});apps.push(blank);assert.equal((await admin({command:'shutdown',role:'hub',dir:blank.dir})).ok,true);
 const hub=await startApp({dir:join(dir,'hub'),port:0});apps.push(hub);const cfg=join(dir,'hub-input.json');writeFileSync(cfg,JSON.stringify({org_name:'SKILL TEST ONLY',address:'127.0.0.1',hub_port:await freePort()}));
 const setup=await admin({command:'init',role:'hub',dir:hub.dir,input:cfg});assert.equal(setup.role,'hub');assert.equal((await admin({command:'init',role:'hub',dir:hub.dir,input:cfg})).already_configured,true);
 const person=join(dir,'employee.json');writeFileSync(person,JSON.stringify({employee_id:'CS001',employee_name:'TEST',label:'TEST PC'}));const enroll=join(dir,'employee.enroll.json');const registered=await admin({command:'enroll',role:'hub',dir:hub.dir,input:person,output:enroll});assert(!JSON.stringify(registered).includes('device_token'));assert(readFileSync(enroll,'utf8').includes('device_token'));
 await assert.rejects(()=>admin({command:'enroll',role:'hub',dir:hub.dir,input:person,output:enroll}),/已存在/);
 const c=await startApp({dir:join(dir,'client'),port:0});apps.push(c);const init=await admin({command:'init',role:'collector',dir:c.dir,input:enroll});assert.equal(init.employee_id,'CS001');assert.equal(init.collection.enabled,false);assert.equal((await admin({command:'sync',role:'collector',dir:c.dir})).sent,0);assert(hub.store.devices()[0].last_seen);
 await assert.rejects(()=>admin({command:'init',role:'hub',dir:c.dir,input:cfg}),/角色不一致/);await assert.rejects(()=>admin({command:'enroll',role:'collector',dir:c.dir,input:person,output:join(dir,'bad.json')}),/只有总控/);
 // Run the delivered skill wrapper against an isolated server using its supported deployment binding.
 const helperRoot=join(dir,'helper');mkdirSync(join(helperRoot,'data'),{recursive:true});mkdirSync(join(helperRoot,'src'));mkdirSync(join(helperRoot,'runtime'));
 const {copyFileSync}=await import('node:fs');for(const name of ['admin-cli.mjs','local-api.mjs'])copyFileSync(join(root,'src',name),join(helperRoot,'src',name));copyFileSync(process.execPath,join(helperRoot,'runtime','node.exe'));copyFileSync(join(hub.dir,'running.json'),join(helperRoot,'data','running.json'));
 writeFileSync(join(skills,'worktrace-hub','deployment.json'),JSON.stringify({root:helperRoot,role:'hub'}));const checked=await runPS(['-File',join(skills,'worktrace-hub','scripts','control.ps1'),'-Action','status']);assert.equal(checked.code,0,checked.err);assert.equal(JSON.parse(checked.out.trim()).role,'hub');assert(!checked.out.includes('device_token'));
});
