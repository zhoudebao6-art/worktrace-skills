import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';

// The owner transaction lives in a separate, disposable database. Holding it
// must never lock the evidence database. SQLite/OS releases it after a crash;
// no PID reuse check or deletion of another process's lock is required.
export function acquireRuntimeLock(dir){
 const db=new DatabaseSync(join(dir,'runtime-lock.sqlite'));
 try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
 catch(error){db.close();if(error.errcode===5||error.errcode===6||/database is locked|database table is locked/.test(error.message))throw Error('runtime_already_owned: 此数据目录已有服务运行；请检查原部署，不要启动同身份副本');throw error;}
 let released=false;
 return ()=>{if(released)return;released=true;try{db.exec('ROLLBACK');}finally{db.close();}};
}

// A copied data directory must not create another active collector identity on
// this Windows host. The OS-owned pipe also lets Recover reject a live source.
export async function acquireIdentityLock(identity){
 if(!identity?.org_id||!identity?.device_id)throw Error('runtime_identity_missing');
 const key=createHash('sha256').update(identity.org_id+':'+identity.device_id).digest('hex');
 if(process.platform!=='win32'){
  const dir=join(process.env.TEMP||tmpdir(),'worktrace-identity-locks',key);mkdirSync(dir,{recursive:true});
  return acquireRuntimeLock(dir);
 }
 const owner=createServer(socket=>socket.destroy());
 try{await new Promise((resolve,reject)=>{owner.once('error',reject);owner.listen('\\\\.\\pipe\\worktrace-identity-'+key,resolve);});}
 catch(error){if(error.code==='EADDRINUSE'||error.code==='EACCES')throw Error('runtime_identity_active: 本机已有此员工设备身份运行；请先关闭原分控，不要并行恢复或克隆');throw error;}
 owner.unref();let released=false;
 return async()=>{if(released)return;released=true;await new Promise(resolve=>owner.close(()=>resolve()));};
}

// All entry points (timer, HTTP and internal callers) share the same slot.
// A skipped second request cannot replace the promise of an in-flight scan.
export class RuntimeTasks{
 constructor(){this.active=new Map();this.records=new Map();this.stopping=false;}
 run(name,operation){
  if(this.stopping)return Promise.resolve({skipped:true,reason:'service_stopping'});
  if(this.active.has(name))return this.active.get(name);
  const record=this.records.get(name)||{last_started:null,last_finished:null,last_error:null};
  record.last_started=new Date().toISOString();this.records.set(name,record);
  const pending=Promise.resolve().then(operation).then(value=>{record.last_error=null;return value;},error=>{record.last_error=String(error.message||error).slice(0,1000);throw error;}).finally(()=>{record.last_finished=new Date().toISOString();this.active.delete(name);});
  this.active.set(name,pending);return pending;
 }
 launch(name,operation){this.run(name,operation).catch(()=>{});}
 stop(){this.stopping=true;}
 async drain(){await Promise.allSettled([...this.active.values()]);}
 snapshot(){return {stopping:this.stopping,tasks:Object.fromEntries([...this.records].map(([name,value])=>[name,{...value,running:this.active.has(name)}]))};}
}
