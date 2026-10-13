import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export async function localApi(dir,path,body,{binary=false,timeout=45000}={}){
 const run=JSON.parse(readFileSync(join(dir,'running.json'),'utf8'));
 const u=new URL(run.url);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('本机服务地址无效');
 const key=new URLSearchParams(u.hash.slice(1)).get('key');
 const r=await fetch(u.origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
 if(!r.ok){const b=await r.json();throw Error(b.error||'本机请求失败');}
 if(binary)return {mime:r.headers.get('content-type'),bytes:Buffer.from(await r.arrayBuffer())};
 return r.json();
}
