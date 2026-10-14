import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
async function flush(){for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));}
async function boot(){
 const win='http://127.0.0.1:59173',linux='http://127.0.0.1:59175',storage:any={config:{url:win,token:'a'.repeat(64),workerId:'windows',tabId:7,frameId:2,ready:true},savedPairings:{[linux]:{url:linux,token:'b'.repeat(64),workerId:'linux'}}};
 let listener:any;const sockets:any[]=[],jobs:any[]=[];
 const chrome:any={
 storage:{local:{get:async()=>structuredClone(storage),set:async(value:any)=>Object.assign(storage,structuredClone(value)),remove:async()=>{}}},
 permissions:{contains:async()=>true,onAdded:{addListener:()=>{}}},
 scripting:{getRegisteredContentScripts:async()=>[{id:'copilot-frame'},{id:'bridge-office-host'}],registerContentScripts:async()=>{},executeScript:async()=>[]},
 alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
 runtime:{id:'extension',onStartup:{addListener:()=>{}},onMessage:{addListener:(fn:any)=>listener=fn}},
 tabs:{get:async(id:number)=>({id,url:'https://excel.cloud.microsoft/open/onedrive/?docId=approved'}),update:async()=>({}),sendMessage:async(_:number,message:any)=>{if(message.type==='job'){jobs.push(message);return{accepted:true};}return{ready:true};},onRemoved:{addListener:()=>{}}},
 };
 class Socket{static OPEN=1;static CONNECTING=0;readyState=1;sent:any[]=[];onopen:any;onmessage:any;onclose:any;constructor(public url:string){sockets.push(this);}send(text:string){this.sent.push(JSON.parse(text));}close(){this.readyState=3;}}
 vm.runInNewContext(await readFile('dist/extension/background.js','utf8'),{chrome,WebSocket:Socket,URL,Date,Error,Promise,JSON,Map,Set,Number,setInterval:()=>1,setTimeout,clearTimeout});await flush();await sockets[0].onopen();
 const request=(message:any)=>new Promise<any>(resolve=>listener(message,{id:'extension'},resolve));
 return{storage,sockets,request,jobs,win,linux,chrome};
}
test('Windows to WSL and back restores separate credentials, ignores retired sockets and requires no pairing request',async()=>{
 const f=await boot(),old=f.sockets[0];
 assert.equal(f.storage.savedPairings[f.win].workerId,'windows');
 assert.equal((await f.request({type:'rebind-tab',url:f.linux,tabId:8})).ok,true);await flush();
 const linux=f.sockets[1];assert.equal(linux.url,'ws://127.0.0.1:59175/bridge/socket');await linux.onopen();
 assert.equal(linux.sent.find((m:any)=>m.type==='hello').workerId,'linux');assert.equal(f.storage.config.tabId,8);
 assert.equal(f.storage.savedPairings[f.win].token,'a'.repeat(64));
 old.onmessage({data:JSON.stringify({type:'job',id:'late',lane:'main'})});old.onclose();await flush();assert.equal(f.jobs.length,0);assert.notEqual(f.storage.status.error,'Gateway disconnected; reconnecting without resubmitting uncertain jobs');
 assert.equal((await f.request({type:'rebind-tab',url:f.win,tabId:7})).ok,true);await flush();await f.sockets[2].onopen();
 assert.equal(f.sockets[2].sent.find((m:any)=>m.type==='hello').workerId,'windows');
 assert.equal(f.storage.config.url,f.win);
});
test('a recovery racing with a switch retains uncertain delivery while a new job is explicitly unsent',async()=>{
 const f=await boot(),old=f.sockets[0];let release:any,blocked=false;
 const get=f.chrome.tabs.get;f.chrome.tabs.get=async(id:number)=>{if(id===8&&!blocked){blocked=true;await new Promise(resolve=>{release=resolve;});}return get(id);};
 const switched=f.request({type:'rebind-tab',url:f.linux,tabId:8});await flush();assert.equal(typeof release,'function');
 assert.match((await f.request({type:'unpair'})).error,/Finish or cancel/);
 assert.equal(f.storage.config.url,f.win);
 old.onmessage({data:JSON.stringify({type:'recover',id:'already-submitted-job',lane:'main'})});
 old.onmessage({data:JSON.stringify({type:'job',id:'new-job',lane:'main'})});await flush();
 const recovered=old.sent.find((m:any)=>m.id==='already-submitted-job');assert.equal(recovered.type,'failure');assert.equal('submitted' in recovered,false);
 assert.equal(old.sent.find((m:any)=>m.id==='new-job').submitted,false);
 release();assert.equal((await switched).ok,true);
});
test('switching rejects unpaired destinations, non-loopback URLs and a busy native request',async()=>{
 const f=await boot();
 assert.match((await f.request({type:'rebind-tab',url:'http://127.0.0.1:61473',tabId:8})).error,/no saved pairing/);
 assert.match((await f.request({type:'rebind-tab',url:'http://192.168.1.1:59175',tabId:8})).error,/Gateway must/);
 f.sockets[0].onmessage({data:JSON.stringify({type:'job',id:'busy',lane:'main'})});await flush();assert.equal(f.jobs.length,1);
 assert.match((await f.request({type:'rebind-tab',url:f.linux,tabId:8})).error,/Finish or cancel/);
 assert.equal(f.storage.config.url,f.win);assert.equal(f.sockets.length,1);
});
