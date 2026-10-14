import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
async function flush(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
async function until(condition:()=>boolean){const deadline=Date.now()+1500;while(!condition()){if(Date.now()>deadline)throw new Error('Expected asynchronous browser event did not arrive');await new Promise(resolve=>setTimeout(resolve,10));}}
async function boot(deferred=false,cancelReplyMissing=false){
 const url='https://excel.cloud.microsoft/open/onedrive/?docId=approved';const storage:any={config:{url:'http://127.0.0.1:59173',token:'a'.repeat(64),workerId:'test',tabId:7,frameId:2,ready:true,conversationControl:true}};
 const tabs=new Map([[7,url]]),jobs:any[]=[],activations:number[]=[],openCalls:number[]=[];let listener:any,socket:any,resolveCreate:any,nextTabId=20;
 const source='https://fa000000124.officeapps.live.com/taskpane.html';
 const emit=async(message:any,tabId:number,frameId:number,url=source)=>{listener(message,{tab:{id:tabId},frameId,url},()=>{});await flush();};
 const chromeMock:any={
 storage:{local:{get:async()=>JSON.parse(JSON.stringify(storage)),set:async(value:any)=>Object.assign(storage,structuredClone(value)),remove:async(key:string)=>{delete storage[key];}}},
 permissions:{contains:async()=>true,onAdded:{addListener:()=>{}}},
 scripting:{getRegisteredContentScripts:async()=>[{id:'copilot-frame'}],registerContentScripts:async()=>{},executeScript:async({target,func}:any)=>{if(target.tabId>=20&&target.allFrames)throw new Error('Outer Excel site access is not granted');if(func)return[{frameId:1,result:'a'.repeat(64)}];return[];}},
 alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
 runtime:{id:'extension',onStartup:{addListener:()=>{}},onMessage:{addListener:(fn:any)=>{listener=fn;}}},
 tabs:{get:async(id:number)=>{if(!tabs.has(id))throw new Error('closed');if(id>=20)await emit({type:'office-host-ready',documentKey:'a'.repeat(64)},id,1,'https://excel.officeapps.live.com/x/_layouts/xlviewer.aspx');return{id,url:tabs.get(id)};},create:async({url}:any)=>{const id=nextTabId++;if(deferred)return await new Promise(resolve=>{resolveCreate=()=>{tabs.set(id,url);resolve({id,url});};});tabs.set(id,url);return{id,url};},remove:async(id:number)=>{tabs.delete(id);},sendMessage:async(tabId:number,value:any,{frameId}:any)=>{if(value.type==='inspect')return{ready:true,conversationControl:true,conversationResumability:'active-chat-only'};if(value.type==='office-open-copilot'){openCalls.push(tabId);assert.ok(tabId>=20);assert.equal(frameId,1);await emit({type:'frame-ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'},tabId,4);return{prepared:true};}if(value.type==='job'){jobs.push({tabId,frameId,value});return{accepted:true};}return cancelReplyMissing?undefined:{cancelled:true,ready:true};},onRemoved:{addListener:()=>{}}},
 };
 chromeMock.tabs.update=async(id:number,properties:any)=>{assert.equal(properties.active,true);assert.ok(tabs.has(id));activations.push(id);return{id,url:tabs.get(id)};};
 chromeMock.windows={update:()=>{throw new Error('The browser window must not be focused');}};
 class Socket {static OPEN=1;static CONNECTING=0;readyState=1;sent:any[]=[];onopen:any;onmessage:any;constructor(){socket=this;}send(value:string){this.sent.push(JSON.parse(value));}close(){}}
 vm.runInNewContext(await readFile('dist/extension/background.js','utf8'),{chrome:chromeMock,WebSocket:Socket,URL,Date,Error,Promise,JSON,Map,Set,Number,setInterval:()=>1,setTimeout,clearTimeout});await flush();await socket.onopen();await flush();
 const server=async(value:any)=>{socket.onmessage({data:JSON.stringify(value)});await flush();};
 return {socket,jobs,tabs,server,emit,activations,openCalls,release:async()=>{resolveCreate();await flush();}};
}
test('worker routes main/auxiliary frames separately and becomes ready even when ACK precedes frame completion',async()=>{
 const f=await boot();assert.deepEqual(f.activations,[]);await f.server({type:'job',id:'main-1',lane:'main',prompt:'main'});assert.equal(f.jobs[0].tabId,7);assert.deepEqual(f.activations,[7]);
 await f.emit({type:'result',id:'main-1',text:'real reply'},7,2);await f.server({type:'ack',id:'main-1'});
 await f.emit({type:'frame-ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'},7,2);
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);
 await f.server({type:'job',id:'aux-1',lane:'auxiliary',prompt:'title'});await until(()=>f.jobs.length===2);assert.equal(f.jobs[1].tabId,20);assert.equal(f.jobs[1].frameId,4);assert.deepEqual(f.activations,[7,20]);
 await f.emit({type:'frame-ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'},7,2);assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,false);
 await f.emit({type:'result',id:'aux-1',text:'title reply'},20,4);await f.server({type:'ack',id:'aux-1'});await f.emit({type:'frame-ready',ready:true},20,4);
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);
});
test('cancellation during auxiliary tab creation prevents a delayed model submission after ACK',async()=>{
 const f=await boot(true);await f.server({type:'job',id:'cancel-before-creation',lane:'auxiliary',prompt:'must not be sent'});
 await f.server({type:'cancel',id:'cancel-before-creation',lane:'auxiliary'});await f.server({type:'ack',id:'cancel-before-creation'});await f.release();
 await until(()=>f.socket.sent.some((x:any)=>x.type==='failure'&&x.id==='cancel-before-creation'));assert.equal(f.jobs.length,0);
});
test('canceling an obsolete main-frame job restores readiness even when that frame has no matching controller',async()=>{
 const f=await boot(false,true);await f.server({type:'job',id:'obsolete',lane:'main',prompt:'old'});
 await f.emit({type:'frame-ready',ready:true},7,2);assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,false);
 await f.server({type:'cancel',id:'obsolete'});
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);assert.equal(f.jobs.length,1);
});
test('a late cancellation for an older job cannot clear a newer active lane',async()=>{
 const f=await boot();await f.server({type:'job',id:'current',lane:'main',prompt:'current'});
 await f.emit({type:'frame-ready',ready:true},7,2);await f.server({type:'cancel',id:'older'});
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,false);
});
test('reconnecting to an idle gateway retires an orphaned busy lane without replaying it',async()=>{
 const f=await boot();await f.server({type:'job',id:'orphan',lane:'main',prompt:'old'});
 await f.emit({type:'frame-ready',ready:true},7,2);await f.server({type:'connected',activeId:null});
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);assert.equal(f.jobs.length,1);
});

test('each native agent reuses its own tab and a sibling cannot deliver its response',async()=>{
 const f=await boot(),a='agent:'+'a'.repeat(64),b='agent:'+'b'.repeat(64);
 const finish=async(id:string,tabId:number)=>{await f.emit({type:'result',id,text:'reply'},tabId,4);await f.server({type:'ack',id});await f.emit({type:'frame-ready',ready:true},tabId,4);};
 await f.server({type:'job',id:'a-first',lane:a,prompt:'a'});await until(()=>f.jobs.length===1);assert.equal(f.jobs[0].tabId,20);await finish('a-first',20);
 await f.server({type:'job',id:'b-first',lane:b,prompt:'b'});await until(()=>f.jobs.length===2);assert.equal(f.jobs[1].tabId,21);await finish('b-first',21);
 await f.server({type:'job',id:'a-next',lane:a,prompt:'next a'});await until(()=>f.jobs.length===3);assert.equal(f.jobs[2].tabId,20);
 await f.emit({type:'result',id:'a-next',text:'wrong sibling'},21,4);assert.ok(!f.socket.sent.some((m:any)=>m.type==='result'&&m.id==='a-next'));
 await finish('a-next',20);assert.equal(f.socket.sent.filter((m:any)=>m.type==='result'&&m.id==='a-next').length,1);
 assert.equal(f.socket.sent.filter((m:any)=>m.type==='ready').at(-1).ready,true);
});

test('canceling one agent restores readiness and a late cancellation cannot clear its sibling',async()=>{
 const f=await boot(),a='agent:'+'a'.repeat(64),b='agent:'+'b'.repeat(64);
 await f.server({type:'job',id:'a',lane:a,prompt:'a'});await until(()=>f.jobs.length===1);await f.server({type:'cancel',id:'a',lane:a});
 assert.equal(f.socket.sent.filter((m:any)=>m.type==='ready').at(-1).ready,true);
 await f.server({type:'job',id:'b',lane:b,prompt:'b'});await until(()=>f.jobs.length===2);await f.server({type:'cancel',id:'a',lane:a});
 assert.equal(f.socket.sent.filter((m:any)=>m.type==='ready').at(-1).ready,false);assert.equal(f.jobs[1].tabId,21);
});

test('an agent tab preparation failure reports that no prompt was submitted',async()=>{
 const f=await boot();f.tabs.set(7,'https://example.com/changed');await f.server({type:'job',id:'unsent-agent',lane:'agent:'+'a'.repeat(64),prompt:'unsent'});
 await until(()=>f.socket.sent.some((m:any)=>m.type==='failure'&&m.id==='unsent-agent'));
 assert.equal(f.jobs.length,0);assert.equal(f.socket.sent.find((m:any)=>m.type==='failure'&&m.id==='unsent-agent').submitted,false);
});

test('reusing a ready auxiliary or agent frame never toggles its Copilot pane',async()=>{
 for(const lane of ['auxiliary','agent:'+'a'.repeat(64)]){const f=await boot();
 await f.server({type:'job',id:'first',lane,prompt:'first'});await until(()=>f.jobs.length===1);
 await f.emit({type:'result',id:'first',text:'reply'},20,4);await f.server({type:'ack',id:'first'});await f.emit({type:'frame-ready',ready:true},20,4);
 await f.server({type:'job',id:'second',lane,prompt:'second'});await until(()=>f.jobs.length===2);
 assert.deepEqual(f.openCalls,[20]);assert.equal(f.jobs[1].tabId,20);
 }
});
