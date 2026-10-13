import {readFileSync,lstatSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,parse,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifySource,trackedFiles} from './verify-source.mjs';

export const downloadRepository='https://github.com/zhoudebao6-art/worktrace-skills';
const manifestName='.worktrace-source.json';
const digest=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
const gitBlobId=bytes=>digest('sha1',Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]));
const inside=(parent,child)=>{const rel=relative(parent,child);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
const validPath=path=>typeof path==='string'&&path.length>0&&!path.startsWith('/')&&!/[\\\x00-\x1f<>:"|?*]/.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part.toLowerCase()!=='.git'&&!/[. ]$/.test(part)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

function requirePlainPath(path){
  const absolute=resolve(path),base=parse(absolute).root;let cursor=base;
  for(const part of absolute.slice(base.length).split(sep).filter(Boolean)){
    cursor=join(cursor,part);const stat=lstatSync(cursor);
    if(stat.isSymbolicLink())throw Error(`Symbolic links or junctions are not allowed: ${cursor}`);
  }
  return absolute;
}

export function exportSource({root,output}){
  if(typeof output!=='string'||!output.trim())throw Error('Provide a new output directory with --output');
  root=requirePlainPath(root);output=resolve(output);
  const parent=requirePlainPath(dirname(output));
  if(!lstatSync(parent).isDirectory())throw Error('Output parent must be an existing directory');
  if(inside(root,output)||inside(output,root))throw Error('Source and output directories must not overlap');
  try{lstatSync(output);throw Error('Output directory already exists; choose a new path');}catch(error){if(error.code!=='ENOENT')throw error;}
  const git=(...args)=>execFileSync(process.env.WORKTRACE_GIT||'git',['-C',root,...args],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
  const repositoryRoot=realpathSync(git('rev-parse','--show-toplevel').trim());
  if(relative(realpathSync(root),repositoryRoot))throw Error('Source must be the Git repository root');
  const commit=git('rev-parse','--verify','HEAD^{commit}').trim();
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('A complete SHA-1 Git HEAD commit is required');
  const origin=git('remote','get-url','origin').trim();
  if(![downloadRepository,downloadRepository+'.git','git@github.com:zhoudebao6-art/worktrace-skills.git','ssh://git@github.com/zhoudebao6-art/worktrace-skills.git'].includes(origin))throw Error('Origin must identify the private WorkTrace source repository');
  const requireClean=()=>{if(git('status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'))throw Error('Source has modified, staged or untracked files; export a clean committed HEAD');};
  requireClean();
  const tree=git('ls-tree','-rz','--full-tree','HEAD').split('\0').filter(Boolean).map(row=>{
    const match=row.match(/^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/);
    if(!match)throw Error('Invalid or incomplete HEAD tree');
    const [,mode,type,oid,path]=match;
    if(!['100644','100755'].includes(mode)||type!=='blob')throw Error('HEAD must contain regular files only; links and submodules are not exportable');
    if(!validPath(path)||path.toLowerCase()===manifestName)throw Error(`Unsafe or reserved HEAD path: ${path}`);
    return {path,oid};
  });
  if(!tree.length)throw Error('HEAD has no source files');
  const tracked=trackedFiles(root),paths=tree.map(entry=>entry.path).sort(),seen=new Set();
  if(JSON.stringify([...tracked].sort())!==JSON.stringify(paths))throw Error('Git index does not match the complete HEAD tree');
  const bytesByPath=new Map();
  for(const entry of tree){
    const normalized=entry.path.toLowerCase();if(seen.has(normalized))throw Error(`Case-colliding HEAD paths: ${entry.path}`);seen.add(normalized);
    const path=requirePlainPath(join(root,entry.path)),stat=lstatSync(path);
    if(!stat.isFile()||stat.size>5*1024*1024)throw Error(`HEAD file is not a regular source file within 5 MiB: ${entry.path}`);
    const bytes=readFileSync(path);
    // Also catch skip-worktree / assume-unchanged flags and local filters hiding byte changes.
    if(gitBlobId(bytes)!==entry.oid)throw Error(`Working bytes do not match HEAD: ${entry.path}`);
    bytesByPath.set(entry.path,bytes);
  }
  const verification=verifySource(root,{files:paths});
  if(!verification.ok)throw Error(`Source verification failed:\n${verification.errors.join('\n')}`);
  let version;try{version=JSON.parse(bytesByPath.get('package.json')?.toString('utf8')||'').version;}catch{throw Error('package.json must contain the release version');}
  if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)*$/.test(version))throw Error('package.json has no valid release version');
  requireClean();if(git('rev-parse','HEAD').trim()!==commit)throw Error('HEAD changed during export; retry from a stable checkout');
  const manifest={format:'worktrace.download/1.0',repository:downloadRepository,commit,version,files:paths.map(path=>{const bytes=bytesByPath.get(path);return {path,sha256:digest('sha256',bytes),size:bytes.length};})};
  // All validation happens before creating output; never overwrite or remove an existing directory.
  // The manifest is written last, so an interrupted export cannot appear complete to the installer.
  requirePlainPath(parent);mkdirSync(output);requirePlainPath(output);
  for(const path of paths){const destination=join(output,path);mkdirSync(dirname(destination),{recursive:true});requirePlainPath(dirname(destination));writeFileSync(destination,bytesByPath.get(path),{flag:'wx'});}
  writeFileSync(join(output,manifestName),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {ok:true,output,commit,version,files:paths.length,manifest:manifestName};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==4||process.argv[2]!=='--output')throw Error('Usage: node scripts/export-source.mjs --output <new-directory>');const result=exportSource({root:resolve(dirname(fileURLToPath(import.meta.url)),'..'),output:process.argv[3]});console.log(JSON.stringify(result,null,2));}
  catch(error){console.error(`Source export failed: ${error.message}`);process.exitCode=1;}
}
