import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import WebSocket from 'ws';
import {startGateway} from '../packages/gateway/index.js';
test('a later uncertain-context retry cannot erase the original browser failure diagnostic',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-failure-')),g=await startGateway({stateDir:dir,port:0,timeoutMs:5000});
 const origin='chrome-extension://'+'f'.repeat(32);let ws:WebSocket|undefined;let count=0;
 try{
  const {token}=await(await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:g.pairCode})})).json() as any;
  ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/socket',{origin});await new Promise<void>(r=>ws!.once('open',r));
  ws.on('message',data=>{const value=JSON.parse(String(data));if(value.type==='job'){count++;ws!.send(JSON.stringify({type:'failure',id:value.id,error:'Browser did not accept the chat input '+g.clientKey}));ws!.send(JSON.stringify({type:'ready',ready:true}));}});
  ws.send(JSON.stringify({type:'hello',token,workerId:'failure-test',ready:true,conversationControl:true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,auxiliaryBootstrap:1}));
  await new Promise<void>(r=>ws!.once('message',()=>r()));
  const headers={'x-api-key':g.clientKey,'x-claude-code-session-id':'failure-native','x-bridge-workspace-key':'a'.repeat(64),'x-claude-code-request-class':'main'};
  const body=JSON.stringify({model:'copilot-opus-5.5',max_tokens:1000,messages:[{role:'user',content:'PRIVATE_SOURCE_NOT_PERSISTED'}]});
  const first=await fetch(g.url+'/v1/messages',{method:'POST',headers,body});assert.equal(first.status,502);await first.text();
  const retry=await fetch(g.url+'/v1/messages',{method:'POST',headers,body});assert.equal(retry.status,409);await retry.text();assert.equal(count,1);
  ws.terminate();await g.close();
  const saved=await readFile(join(dir,'dispatch-ledger.json'),'utf8'),ledger=JSON.parse(saved),failed=ledger.jobs.find((j:any)=>j.phase==='failed');
  assert.match(failed.error,/Browser did not accept the chat input/);assert.equal(failed.lane,'main');assert.ok(Date.parse(failed.finished));
  assert.ok(!saved.includes(g.clientKey));assert.ok(!saved.includes('PRIVATE_SOURCE_NOT_PERSISTED'));
 }finally{ws?.terminate();await g.close();await rm(dir,{recursive:true,force:true});}
});

test('an authenticated failure known to precede submission leaves the native context retryable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-unsent-')),g=await startGateway({stateDir:dir,port:0,timeoutMs:5000});
 const origin='chrome-extension://'+'e'.repeat(32);let ws:WebSocket|undefined;let count=0;
 try{
  const {token}=await(await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:g.pairCode})})).json() as any;
  ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/socket',{origin});await new Promise<void>(r=>ws!.once('open',r));
  ws.on('message',data=>{const value=JSON.parse(String(data));if(value.type!=='job')return;count++;
   ws!.send(JSON.stringify(count===1?{type:'failure',id:value.id,error:'Input was not ready',submitted:false}:{type:'result',id:value.id,text:'{"content":[{"type":"text","text":"recovered"}]}',conversation:{id:value.conversation.id,title:value.conversation.title,cursor:'c'.repeat(64),resumability:'active-chat-only'}}));
   ws!.send(JSON.stringify({type:'ready',ready:true}));
  });
  ws.send(JSON.stringify({type:'hello',token,workerId:'unsent-test',ready:true,conversationControl:true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,auxiliaryBootstrap:1}));await new Promise<void>(r=>ws!.once('message',()=>r()));
  const headers={'x-api-key':g.clientKey,'x-claude-code-session-id':'unsent-native','x-bridge-workspace-key':'b'.repeat(64),'x-claude-code-request-class':'main'};
  const body=JSON.stringify({model:'copilot-opus-5.5',max_tokens:1000,messages:[{role:'user',content:'test'}]});
  const first=await fetch(g.url+'/v1/messages',{method:'POST',headers,body});assert.equal(first.status,502);await first.text();
  const retry=await fetch(g.url+'/v1/messages',{method:'POST',headers,body});assert.equal(retry.status,200);assert.match(await retry.text(),/recovered/);assert.equal(count,2);
 }finally{ws?.terminate();await g.close();await rm(dir,{recursive:true,force:true});}
});
