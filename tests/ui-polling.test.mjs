import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const code=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({hidden=false}={}){
 const elements=new Map(),calls=[],pending=new Map(),listeners={};
 const element=()=>({dataset:{},elements:{},classList:{toggle(){}},replaceChildren(){},append(){},querySelectorAll(){return []}});
 const status={configured:true,role:'collector',org_name:'SYNTHETIC',employee_name:'SYNTHETIC',employee_id:'TEST',connection_mode:'offline',stats:{events:0,assets:0,asset_bytes:0,pending:0},collection:{enabled:false,state:'paused',policy:{}},devices:[],worker:null};
 const document={hidden,querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);},querySelectorAll(){return [];},createElement:element,addEventListener(name,callback){listeners[name]=callback;}};
 const reply=path=>({ok:true,json:async()=>path==='/api/status'?status:path.startsWith('/api/events?')?{count:0,items:[]}:[]});
 const context=vm.createContext({document,location:{hash:'',pathname:'/'},sessionStorage:{getItem(){return 'SYNTHETIC';}},URLSearchParams,setInterval(){},clearInterval(){},setTimeout,fetch:path=>{
  calls.push(path);
  if(path==='/api/status'||path==='/api/tasks'||path.startsWith('/api/events?'))return new Promise(resolve=>{const list=pending.get(path)||[];list.push(()=>resolve(reply(path)));pending.set(path,list);});
  return Promise.resolve(reply(path));
 }});
 vm.runInContext(code,context);
 return {calls,document,context,listeners,run:source=>vm.runInContext(source,context),release(path){const list=pending.get(path)||[];pending.delete(path);for(const done of list)done();}};
}

for(const tab of ['tasks','timeline'])test(tab+': initial refresh and nested request retain the single polling slot',async()=>{
 const f=fixture();f.run('tab='+JSON.stringify(tab));
 assert.deepEqual(f.calls,['/api/status']);
 await f.run('pollVisible()');await f.run('pollVisible()');
 assert.deepEqual(f.calls,['/api/status'],'Initial request must also hold the polling slot');
 f.release('/api/status');await flush();
 const child=f.calls.find(path=>path==='/api/tasks'||path.startsWith('/api/events?'));
 assert(child,'Selected tab must request its data');
 const before=[...f.calls];
 await f.run('pollVisible()');await f.run('pollVisible()');
 assert.deepEqual(f.calls,before,'Slow child request must prevent another status/tab refresh');
 f.release(child);await flush();
 assert.equal(f.run('polling'),false,'The slot must be released after nested data resolves');
 f.document.hidden=true;await f.run('pollVisible()');
 assert.deepEqual(f.calls,before,'Hidden page must not perform periodic queries');
});

test('a hidden initial page waits for visibility before fetching',async()=>{
 const f=fixture({hidden:true});assert.deepEqual(f.calls,[]);
 f.document.hidden=false;f.listeners.visibilitychange();await flush();
 assert.deepEqual(f.calls,['/api/status']);
 f.release('/api/status');await flush();
 assert.equal(f.run('polling'),false);
});
