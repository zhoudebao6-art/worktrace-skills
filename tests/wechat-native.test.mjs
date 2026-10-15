import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,createHmac,pbkdf2Sync,createDecipheriv} from 'node:crypto';

const binaries=process.env.WORKTRACE_WECHAT_NATIVE_DIR;
const enabled=process.platform==='win32'&&Boolean(binaries);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function processLines(executable,args,env=process.env){
 const child=spawn(executable,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env});let stderr='';child.stderr.on('data',b=>stderr+=b.toString());
 const queue=[],waiters=[];let closed=false;
 createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{value={invalid_json:true};}if(waiters.length)waiters.shift().resolve(value);else queue.push(value);});
 child.on('error',error=>{closed=true;for(const w of waiters.splice(0))w.reject(error);});
 child.on('close',()=>{closed=true;for(const w of waiters.splice(0))w.reject(new Error('native closed: '+stderr.slice(0,400)));});
 const next=()=>queue.length?Promise.resolve(queue.shift()):closed?Promise.reject(new Error('native closed')):new Promise((resolve,reject)=>{const w={resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};const timer=setTimeout(()=>{const i=waiters.indexOf(w);if(i>=0)waiters.splice(i,1);reject(new Error('native response timeout'));},30000);waiters.push(w);});
 return {child,next,request:async value=>{child.stdin.write(typeof value==='string'?value+'\n':JSON.stringify(value)+'\n');return next();},close:async()=>{if(closed)return;child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},3000);child.once('close',()=>{clearTimeout(timer);resolve();});});}};
}
test('Windows native reader: encrypted WAL, bounded rowid, DPAPI and isolated process preparation', {skip:!enabled,timeout:120000},async t=>{
 const temp=fs.mkdtempSync(path.join(process.env.TEMP||os.tmpdir(),'worktrace-native-test-'));
 const account=path.join(temp,'account'),profile=path.join(temp,'profile.json'),dll=path.join(binaries,'worktrace-wcdb.dll');
 const fixture=processLines(path.join(binaries,'worktrace-native-fixture.exe'),[account,profile]);let reader;
 try {
  const ready=await fixture.next();assert.equal(ready.ok,true);const database=ready.database_path,table=ready.table_id;
  const request=(query,extra={})=>({id:'synthetic',query,database_path:database,shard_id:'message/message_0.db',table_id:table,timeout_ms:3000,...extra});
  reader=processLines(path.join(binaries,'worktrace-wechat-reader.exe'),['--dll',dll,'--profile',profile]);
  await t.test('independent Node crypto verifies Tencent SQLCipher v4 AES-CBC and HMAC page',()=>{
   const page=fs.readFileSync(database).subarray(0,4096),salt=page.subarray(0,16),key=createHash('sha256').update('worktrace native synthetic fixture key').digest();
   assert.notEqual(page.subarray(0,16).toString(),'SQLite format 3\0');
   const hmacKey=pbkdf2Sync(key,Buffer.from(salt.map(v=>v^0x3a)),2,32,'sha512'),number=Buffer.alloc(4);number.writeUInt32LE(1);
   assert.deepEqual(createHmac('sha512',hmacKey).update(page.subarray(16,4032)).update(number).digest(),page.subarray(4032));
   const decipher=createDecipheriv('aes-256-cbc',key,page.subarray(4016,4032));decipher.setAutoPadding(false);
   const body=Buffer.concat([decipher.update(page.subarray(16,4016)),decipher.final()]);assert.equal(body.readUInt16BE(0),4096);assert.equal(body[4],80);assert.ok(body.includes(Buffer.from(table)));
  });
  await t.test('readonly reader sees committed WAL, preserves duplicate local IDs and 64-bit IDs',async()=>{
   assert.ok(fs.statSync(database+'-wal').size>0);const before=[database,database+'-wal'].map(p=>sha(fs.readFileSync(p)));
   const head=await reader.request(request('head'));assert.equal(head.high_watermark,'2');assert.equal(head.readonly,true);assert.equal(head.complete,true);
   const a=await reader.request(request('messages',{after:'0',through:'2',limit:1}));assert.equal(a.has_more,true);assert.equal(a.rows[0].cursor,'1');assert.equal(a.rows[0].server_id,'9007199254740993');assert.equal(a.rows[0].sender_username,'fixture-other');
   const b=await reader.request(request('messages',{after:a.next_cursor,through:'2',limit:1,expected_generation:head.db_generation}));assert.equal(b.has_more,false);assert.equal(b.rows[0].cursor,'2');assert.equal(a.rows[0].local_id,b.rows[0].local_id);assert.equal(b.rows[0].sender_username,null);assert.equal(b.rows[0].WCDB_CT_message_content,'4');assert.deepEqual(b.rows[0].message_content,{encoding:'base64',data:'KLUv/Q=='});
   assert.deepEqual([database,database+'-wal'].map(p=>sha(fs.readFileSync(p))),before);
  });
  await t.test('schema and Name2Id support bounded rowid pages',async()=>{
   const a=await reader.request(request('schema',{limit:1,after:'0'}));assert.equal(a.rows[0].name,'Name2Id');assert.equal(a.has_more,true);
   const b=await reader.request(request('schema',{limit:1,after:a.next_cursor}));assert.equal(b.rows[0].name,table);assert.equal(b.has_more,false);
   const n=await reader.request(request('name2id',{after:'1',limit:1}));assert.equal(n.rows[0].user_name,'fixture-other');assert.equal(n.rows[0].cursor,'2');
  });
  await t.test('snapshot through bound does not swallow concurrent inserts or uncommitted WAL',async()=>{
   await fixture.request('append');const bounded=await reader.request(request('messages',{after:'0',through:'2'}));assert.equal(bounded.rows.length,2);assert.equal(bounded.has_more,false);
   const next=await reader.request(request('messages',{after:'2',through:'3'}));assert.equal(next.rows[0].message_content,'third');
   await fixture.request('uncommitted');assert.equal((await reader.request(request('head'))).high_watermark,'3');await fixture.request('rollback');
  });
  await t.test('SQL injection, raw keys, root escape, stale generation and invalid cursor are rejected',async()=>{
   for(const extra of [{query:'DELETE'},{key_hex:'disallowed'},{table_id:'Msg_x;DELETE FROM Name2Id'},{after:1},{after:'-1'},{expected_generation:'stale'},{database_path:path.join(temp,'outside.db')}]){
    const result=await reader.request(request('messages',extra));assert.equal(result.ok,false);assert.equal(result.complete,false);assert.equal(result.rows,undefined);
   }
   assert.equal((await reader.request(request('head'))).ok,true);
  });
  await t.test('DPAPI has no plaintext key and tampered protected profile fails closed',async()=>{
   const data=JSON.parse(fs.readFileSync(profile,'utf8').replace(/^\uFEFF/,''));assert.equal(data.format,'worktrace.wechat-native-profile/1.0');assert.ok(data.encrypted_keymap_base64);assert.equal(data.keys,undefined);
   data.account_id='different-account';const bad=path.join(temp,'bad-profile.json');fs.writeFileSync(bad,JSON.stringify(data));const other=processLines(path.join(binaries,'worktrace-wechat-reader.exe'),['--dll',dll,'--profile',bad]);try{assert.equal((await other.next()).ok,false);}finally{await other.close();}
  });
  await t.test('preparation scans only owned synthetic process and writes verified DPAPI profile',async()=>{
   const prepared=path.join(temp,'prepared-profile.json');const setupArgs=['--dll',dll,'--profile',prepared,'--account-root',account,'--account-id','fixture-self','--pid',String(ready.pid),'--timeout-seconds','20'];
   const denied=processLines(path.join(binaries,'worktrace-wechat-setup.exe'),setupArgs);try{const result=await denied.next();assert.equal(result.error,'process_name_not_allowed');assert.equal(fs.existsSync(prepared),false);}finally{await denied.close();}
   const active=processLines(path.join(binaries,'worktrace-native-fixture-setup.exe'),setupArgs,{...process.env,WORKTRACE_TEST_IDLE_SECONDS:'0'});try{assert.equal((await active.next()).error,'employee_active');assert.equal(fs.existsSync(prepared),false);}finally{await active.close();}
   const setup=processLines(path.join(binaries,'worktrace-native-fixture-setup.exe'),setupArgs);try{const result=await setup.next();assert.equal(result.ok,true);assert.equal(result.complete,true);assert.equal(result.verified_salts,1);assert.equal(result.keys,undefined);}finally{await setup.close();}
   const check=processLines(path.join(binaries,'worktrace-wechat-reader.exe'),['--dll',dll,'--profile',prepared]);try{assert.equal((await check.request(request('head'))).high_watermark,'3');}finally{await check.close();}
  });
  await t.test('oversized content fails the page without partial success',async()=>{
   await fixture.request('oversize');const result=await reader.request(request('messages',{after:'0',through:'9'}));assert.equal(result.ok,false);assert.equal(result.complete,false);assert.equal(result.rows,undefined);
  });
 } finally {if(reader)await reader.close();await fixture.close();fs.rmSync(temp,{recursive:true,force:true});}
});
