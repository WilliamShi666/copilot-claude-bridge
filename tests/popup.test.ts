import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function flush(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
test('connection status updates preserve gateway edits and submit the selected new pairing',async()=>{
 const elements:any=Object.fromEntries(['status','pair','url','code','unpair'].map(id=>[id,{value:'',textContent:'',disabled:false,listeners:new Map(),addEventListener(type:string,fn:any){this.listeners.set(type,fn);}}]));
 let change:any;const sent:any[]=[];
 const state:any={config:{url:'http://127.0.0.1:59175'},status:{connected:false,ready:true},pairingStatus:{phase:'paired'}};
 const chrome:any={tabs:{query:async()=>[{id:7,url:'https://excel.cloud.microsoft/open/onedrive/?docId=approved'}]},storage:{local:{get:async()=>structuredClone(state)},onChanged:{addListener:(fn:any)=>{change=fn;}}},runtime:{sendMessage:async(value:any)=>{sent.push(value);return{ok:true};}},permissions:{request:async()=>true}};
 vm.runInNewContext(await readFile('dist/extension/popup.js','utf8'),{document:{getElementById:(id:string)=>elements[id]},chrome,URL,Date,Error,Promise,JSON,Number});
 await flush();assert.equal(elements.url.value,state.config.url);
 elements.url.value='http://127.0.0.1:59173';elements.url.listeners.get('input')?.();
 elements.code.value='b'.repeat(40);elements.code.listeners.get('input')?.();
 state.status.ready=false;change();await flush();
 assert.equal(elements.url.value,'http://127.0.0.1:59173');
 assert.equal(elements.code.value,'b'.repeat(40));
 assert.match(elements.status.textContent,/"ready": false/);
 await elements.pair.onclick();await flush();
 assert.equal(sent[0].type,'prepare-pair');assert.equal(sent[0].url,'http://127.0.0.1:59173');assert.equal(sent[0].tabId,7);
 assert.ok(sent.some(value=>value.type==='permission-decision'&&value.granted===true));
});

test('saved gateway selection switches without requesting a new code or permissions',async()=>{
 const elements:any=Object.fromEntries(['status','pair','url','code','unpair'].map(id=>[id,{value:'',textContent:'',disabled:false,addEventListener(){}}]));const sent:any[]=[];
 const chrome:any={tabs:{query:async()=>[{id:7,url:'https://excel.cloud.microsoft/open/onedrive/?docId=approved'}]},storage:{local:{get:async()=>({config:{url:'http://127.0.0.1:59173'},savedPairings:{'http://127.0.0.1:59175':{}}})},onChanged:{addListener(){}}},runtime:{sendMessage:async(value:any)=>{sent.push(value);return{ok:true};}},permissions:{request(){assert.fail('saved pairing needs no permissions prompt');}}};
 vm.runInNewContext(await readFile('dist/extension/popup.js','utf8'),{document:{getElementById:(id:string)=>elements[id]},chrome,URL,Date,Error,Promise,JSON,Number});await flush();
 elements.url.value='http://127.0.0.1:59175';await elements.pair.onclick();
 assert.equal(sent.length,1);assert.equal(sent[0].type,'rebind-tab');assert.equal(sent[0].url,'http://127.0.0.1:59175');assert.equal(sent[0].tabId,7);
});
