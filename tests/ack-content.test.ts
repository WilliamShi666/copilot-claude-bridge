import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

async function fixture(){
 const dom=new JSDOM('<div contenteditable="true">untouched human draft</div>',{url:'https://fa000000124.officeapps.live.com/taskpane.html',runScripts:'outside-only'});
 const entry={id:'cached-ack-failure',phase:'failed',error:'Copilot context transfer acknowledgment is malformed',submitted:true,contextAckRepairs:1,contextAckRepairChars:450,updated:1};
 const storage={'job:cached-ack-failure':entry},messages:any[]=[];
 const waiters:{type:string;id:string;resolve:(value:any)=>void}[]=[];
 let listener:any,writes=0;
 const context=dom.getInternalVMContext();
 Object.defineProperty(context,'crypto',{value:webcrypto,configurable:true});
 Object.assign(context,{TextEncoder,MessageChannel,setInterval:()=>1,clearInterval:()=>{},chrome:{
  storage:{local:{get:async()=>structuredClone(storage),set:async()=>{writes++;throw Error('A cached failure must not rewrite its journal');}}},
  runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}},sendMessage:async(value:any)=>{
   messages.push(value);
   for(const waiter of waiters)if(value.type===waiter.type&&value.id===waiter.id)waiter.resolve(value);
  }}
 }});
 vm.runInContext(await readFile('dist/extension/content.js','utf8'),context);
 return{dom,entry,storage,writes:()=>writes,
  send:(value:any)=>new Promise<any>(resolve=>listener(value,{},resolve)),
  next:(type:string,id:string)=>{const value=messages.find(message=>message.type===type&&message.id===id);return value?Promise.resolve(value):new Promise<any>(resolve=>waiters.push({type,id,resolve}));}
 };
}

for(const route of ['recover','job'] as const)test('bundled content retains ACK repair diagnostics in cached failure '+route,{timeout:3000},async()=>{
 const f=await fixture();try{
  const before=structuredClone(f.storage),draft=f.dom.window.document.body.innerHTML;
  let failure:any;
  if(route==='recover')failure=await f.send({type:'recover',id:f.entry.id});
  else{
   const pending=f.next('failure',f.entry.id);
   assert.equal((await f.send({type:'job',id:f.entry.id,modelLabel:'Claude Opus 5.5',prompt:'must not replay cached source'})).accepted,true);
   failure=await pending;
  }
  assert.equal(failure.type,'failure');
  assert.equal(failure.submitted,true);
  assert.equal(failure.contextAckRepairs,1);
  assert.equal(failure.contextAckRepairChars,450);
  assert.equal(f.writes(),0);
  assert.deepEqual(f.storage,before);
  assert.equal(f.dom.window.document.body.innerHTML,draft);
 }finally{f.dom.window.close();}
});
