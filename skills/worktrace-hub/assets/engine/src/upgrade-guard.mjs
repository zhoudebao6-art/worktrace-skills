// Maintenance ownership only. This process never opens the evidence database,
// configures collection, calls a model, or launches the application.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
let releaseDirectory,releaseIdentity,timer,closing=false;
async function close(){
 if(closing)return;closing=true;clearInterval(timer);
 try{await releaseIdentity?.();}finally{try{releaseDirectory?.();}finally{process.stdin.destroy();}}
}
try{
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=='--deployment'||args[2]!=='--parent-pid'||!isAbsolute(args[1]))throw Error('Invalid upgrade guard arguments');
 const root=resolve(args[1]),dir=join(root,'data'),parent=Number(args[3]);
 if(!Number.isSafeInteger(parent)||parent<1||parent!==process.ppid)throw Error('Upgrade guard parent mismatch');
 if(existsSync(join(dir,'REVIEW-ONLY.json')))throw Error('Cannot guard a review-only copy');
 const config=JSON.parse(readFileSync(join(dir,'config.json'),'utf8').replace(/^\uFEFF/,''));
 if(config.role!=='collector')throw Error('Upgrade guard requires an existing collector');
 const old=await import(pathToFileURL(join(root,'src/runtime-lifecycle.mjs')));
 if(typeof old.acquireRuntimeLock!=='function'||typeof old.acquireIdentityLock!=='function')throw Error('Existing engine lacks safe maintenance locks; automatic upgrade is unsupported');
 releaseDirectory=old.acquireRuntimeLock(dir);releaseIdentity=await old.acquireIdentityLock(config);
 // A lost parent closes stdin; a secondary PID check also bounds orphan life.
 process.stdin.on('data',()=>close().catch(()=>{process.exitCode=1;}));
 process.stdin.once('end',()=>close().catch(()=>{process.exitCode=1;}));
 process.stdin.once('error',()=>close().catch(()=>{process.exitCode=1;}));
 process.stdin.resume();
 timer=setInterval(()=>{try{process.kill(parent,0);}catch{close().catch(()=>{process.exitCode=1;});}},1000);
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>close().catch(()=>{process.exitCode=1;}));
 process.stdout.write('WORKTRACE_UPGRADE_GUARD_READY\n');
}catch(error){
 process.stderr.write('upgrade_guard_failed: '+String(error.message).slice(0,500)+'\n');
 await close();process.exitCode=1;
}
