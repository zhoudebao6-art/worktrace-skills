import {readFileSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const mirror='skills/worktrace-hub/assets/engine';
const manifestPath=mirror+'/engine-manifest.json';
const sourceDirectories=['src','bridge','public','skills/worktrace-collector','skills/worktrace-evidence','skills/worktrace-personal'];
const sourceFiles=['Start.ps1','Tray.ps1','Install-Skills.ps1','连接Codex.ps1','设置登录启动.ps1','runtime/NODE-LICENSE.txt','scripts/provision-common.ps1','scripts/Ensure-Runtime.ps1','scripts/Configure-Learning.ps1','scripts/Join-Node.ps1','scripts/Initialize-OfflineNode.ps1','scripts/Offline-Handoff.ps1','scripts/skill-control.ps1'];
const requiredFiles=['src/server.mjs','bridge/observe.ps1','public/index.html',...sourceFiles,...['hub','collector','evidence','personal'].map(role=>`skills/worktrace-${role}/SKILL.md`)];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePath=path=>sourceFiles.includes(path)||sourceDirectories.some(dir=>path.startsWith(dir+'/'));
const validPath=path=>typeof path==='string'&&path.length>0&&!path.includes('\\')&&!path.includes('\0')&&!path.startsWith('/')&&!/^[A-Za-z]:/.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');

export function trackedFiles(root){
  const output=execFileSync(process.env.WORKTRACE_GIT||'git',['-C',root,'ls-files','-z'],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  return output.split('\0').filter(Boolean);
}

// Scan tracked working-tree files only: local databases, tests and build caches are not a publish manifest.
// Run after git add so newly proposed files are included. This is a baseline gate, not a full secret scanner.
export function verifySource(root,{files=trackedFiles(root),maxFileBytes=5*1024*1024}={}){
  root=resolve(root);const errors=[],contents=new Map(),paths=new Set(files);
  const fail=message=>errors.push(message);
  if(!files.length)fail('Git tracked tree is empty');
  if(paths.size!==files.length)fail('Duplicate tracked paths');
  for(const path of paths){
    if(!validPath(path)){fail(`Unsafe tracked path: ${path}`);continue;}
    const name=posix.basename(path).toLowerCase(),parts=path.toLowerCase().split('/');
    const forbidden=parts.some(part=>['data','node_modules','__pycache__','runtime-cache','runtime-temp','.codex','.ssh'].includes(part))||
      ['node.exe','deployment.json','enrollment.json','running.json','config.json','join.json','roster.json','hub.json','offline-identity.json','handoff-manifest.json','auth.json','.env','.git-credentials'].includes(name)||
      /\.(?:sqlite(?:3)?(?:-wal|-shm)?|db|pfx|p12|pem|key|wpack|wthandoff|enroll\.json)$/i.test(name)||/^\.env\./.test(name)&&!name.endsWith('.example');
    if(forbidden)fail(`Production data, credential or generated file must not be tracked: ${path}`);
    let bytes;try{const stat=lstatSync(join(root,path));if(!stat.isFile()||stat.isSymbolicLink()){fail(`Tracked entry must be a regular file: ${path}`);continue;}if(stat.size>maxFileBytes){fail(`Tracked file exceeds ${maxFileBytes} bytes: ${path}`);continue;}bytes=readFileSync(join(root,path));contents.set(path,bytes);}catch{fail(`Cannot read tracked file: ${path}`);continue;}
    if(bytes.subarray(0,16).toString('binary')==='SQLite format 3\0')fail(`SQLite content must not be tracked: ${path}`);
    const text=bytes.toString('utf8');
    if(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)||/\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text)||/\bgithub_pat_[A-Za-z0-9_]{40,}\b/.test(text)||/\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/.test(text))fail(`Possible credential found (value omitted): ${path}`);
  }
  for(const path of requiredFiles)if(!paths.has(path))fail(`Required maintenance source is not tracked: ${path}`);
  let manifest;try{manifest=JSON.parse(contents.get(manifestPath)?.toString('utf8')||'');}catch{fail('Engine manifest is missing or invalid JSON');}
  if(manifest?.format!=='worktrace.source/1.0'||!Array.isArray(manifest?.files))fail('Engine manifest format must be worktrace.source/1.0');
  const entries=Array.isArray(manifest?.files)?manifest.files:[],listed=new Set();
  for(const entry of entries){
    if(!entry||!validPath(entry.path)||!sourcePath(entry.path)||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256||'')){fail('Invalid engine manifest entry (path, size or SHA256)');continue;}
    if(listed.has(entry.path)){fail(`Duplicate engine manifest entry: ${entry.path}`);continue;}listed.add(entry.path);
    const source=contents.get(entry.path),copy=contents.get(mirror+'/'+entry.path);
    if(!source){fail(`Manifest source is missing or untracked: ${entry.path}`);continue;}
    if(!copy){fail(`Manifest mirror is missing or untracked: ${entry.path}`);continue;}
    if(source.length!==entry.size||sha256(source)!==entry.sha256)fail(`Maintenance source differs from manifest; run refresh-engine: ${entry.path}`);
    if(copy.length!==entry.size||sha256(copy)!==entry.sha256||!source.equals(copy))fail(`Engine mirror differs from maintenance source: ${entry.path}`);
  }
  for(const path of paths){
    if(sourcePath(path)&&!listed.has(path))fail(`Maintenance source omitted from engine manifest: ${path}`);
    if(path.startsWith(mirror+'/')&&path!==manifestPath&&!listed.has(path.slice(mirror.length+1)))fail(`Unlisted engine mirror file: ${path}`);
  }
  let skillCount=0;
  for(const [path,bytes] of contents){
    if(!path.endsWith('/SKILL.md'))continue;skillCount++;
    const text=bytes.toString('utf8').replace(/^\uFEFF/,''),front=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if(!front){fail(`Skill must start with YAML frontmatter: ${path}`);continue;}
    const values={};for(const match of front[1].matchAll(/^(name|description):\s*(.+)$/gm)){if(values[match[1]])fail(`Duplicate skill ${match[1]}: ${path}`);values[match[1]]=match[2].trim().replace(/^(['"])(.*)\1$/,'$2');}
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.name||'')||values.name!==posix.basename(posix.dirname(path)))fail(`Skill name must match its directory: ${path}`);
    if(!values.description||['|','>','|-','>-'].includes(values.description)||values.description.length>1024)fail(`Skill needs a nonempty single-line description (max 1024 chars): ${path}`);
    for(const match of text.matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)){
      let target=match[1].trim().replace(/^<([^>]+)>$/,'$1');
      if(/^[a-z][a-z0-9+.-]*:/i.test(target)||target.startsWith('#'))continue;
      target=target.split(/[?#]/,1)[0];try{target=decodeURIComponent(target);}catch{fail(`Invalid relative skill link: ${path}`);continue;}
      const resolved=posix.normalize(posix.join(posix.dirname(path),target));
      if(!target||target.startsWith('/')||!validPath(resolved)||!paths.has(resolved))fail(`Missing or unsafe relative skill link: ${path} -> ${target}`);
    }
  }
  return {ok:errors.length===0,tracked_files:paths.size,engine_files:listed.size,skills:skillCount,errors};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),result=verifySource(root);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
  catch(error){console.error(`Source verification failed: ${error.message}`);process.exitCode=1;}
}
