import {readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),target=join(root,'skills/worktrace-hub/assets/engine');
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):[join(p,e.name)]);}
const files=['src','bridge','public','skills/worktrace-collector','skills/worktrace-evidence','skills/worktrace-personal'].flatMap(p=>walk(join(root,p))).concat(['Start.ps1','Tray.ps1','Install-Skills.ps1','连接Codex.ps1','设置登录启动.ps1','runtime/NODE-LICENSE.txt','scripts/provision-common.ps1','scripts/Ensure-Runtime.ps1','scripts/Configure-Learning.ps1','scripts/Join-Node.ps1','scripts/skill-control.ps1'].map(p=>join(root,p)));
const entries=[];for(const f of files.sort()){const rel=relative(root,f).replaceAll('\\','/'),dest=join(target,rel),bytes=readFileSync(f);mkdirSync(dirname(dest),{recursive:true});copyFileSync(f,dest);entries.push({path:rel,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});}
writeFileSync(join(target,'engine-manifest.json'),JSON.stringify({format:'worktrace.source/1.0',version:'0.2.0',files:entries},null,2)+'\n');
console.log(JSON.stringify({files:entries.length,runtime_binary:'downloaded and verified at deployment; not in Git',company_data:false}));
