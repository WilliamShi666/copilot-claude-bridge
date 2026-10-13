import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {startGateway} from '../packages/gateway/index.js';
import {messages,cursor,assertIdle,chatMode} from '../packages/excel-desktop/transcript.js';
import type {Snapshot,UiNode} from '../packages/excel-desktop/client.js';
import {backendStateDir} from '../packages/cli/index.js';
const node=(name:string,type:number,depth:number,id='',value:string|null=null):UiNode=>({name,type,depth,id,value,enabled:true,offscreen:false});
function snapshot():Snapshot{return {window:123,pid:456,nodes:[node('Select model Claude Opus 5.5',50000,3),node('You said: hello',50026,4),node('You said:',50020,5,'eae-user-message-a-title'),node('hello',50020,5),node('Copilot said: reply',50026,4),node('Copilot said:',50020,5,'eae-copilot-message-b-title'),node('Copilot',50020,5),node('reply',50020,5),node('Message actions',50021,5),node('Copy',50000,6),node('Switch mode, current: Chat, Ctrl+Shift+M',50000,6),node('Chat input',50003,5,'','\n')]};}
test('desktop accessibility transcript rejects incomplete/changed context and drafts',()=>{
 const s=snapshot();assert.deepEqual(messages(s).map(m=>m.text),['hello','reply']);assert.ok(chatMode(s));assertIdle(s);const original=cursor(s);
 const changed=structuredClone(s);changed.nodes[7].name='edited reply';assert.notEqual(cursor(changed),original);
 changed.nodes[11].value='user draft';assert.throws(()=>assertIdle(changed),/draft/);
 const partial=structuredClone(s);partial.nodes=partial.nodes.filter(n=>n.name!=='Copy');assert.throws(()=>cursor(partial),/completed/);
 const busy=structuredClone(s);busy.nodes.push(node('Stop generating',50000,5));assert.throws(()=>cursor(busy),/completed/);
 const switched=structuredClone(s);switched.window++;assert.notEqual(cursor(switched),original);
});
test('desktop and browser have separate default state directories',()=>{assert.notEqual(backendStateDir('chrome'),backendStateDir('excel-desktop'));assert.equal(backendStateDir('excel-desktop','chosen'),'chosen');assert.throws(()=>backendStateDir('outlook'));});
test('an explicit desktop restart rotates the worker credential and can select a new Office handle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m365-desktop-rebind-'));const first=await startGateway({stateDir:dir,port:0,backend:'excel-desktop',selectedWindow:123});
 const oldToken=first.desktopWorkerToken,key=first.clientKey;await first.close();
 const second=await startGateway({stateDir:dir,port:0,backend:'excel-desktop',selectedWindow:456});
 try{assert.notEqual(second.desktopWorkerToken,oldToken);assert.equal(second.clientKey,key);assert.equal(second.status().selectedWindow,456);}finally{await second.close();await rm(dir,{recursive:true,force:true});}
});
test('desktop gateway authenticates an origin-free worker, rejects Chrome and direct-model requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m365-desktop-')),g=await startGateway({stateDir:dir,port:0,backend:'excel-desktop',timeoutMs:5000});let ws:WebSocket|undefined;
 try{
  const headers={'x-api-key':g.clientKey};assert.equal(g.status().backend,'excel-desktop');
  assert.equal((await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:'chrome-extension://'+'a'.repeat(32)},body:JSON.stringify({code:g.pairCode})})).status,403);
  assert.equal((await fetch(g.url+'/v1/messages',{method:'POST',headers,body:'{}'})).status,400);
  const wrong=new WebSocket(g.url.replace('http:','ws:')+'/bridge/desktop/socket',{origin:'chrome-extension://'+'a'.repeat(32)});
  await new Promise<void>(resolve=>{wrong.on('error',()=>resolve());wrong.on('open',()=>{wrong.terminate();assert.fail('Chrome must not connect to desktop transport');});});
  const bad=new WebSocket(g.url.replace('http:','ws:')+'/bridge/desktop/socket');await new Promise<void>(r=>bad.once('open',r));bad.send(JSON.stringify({type:'hello',token:'',workerId:'bad'}));await new Promise<void>(r=>bad.once('close',r));assert.equal(g.status().workerConnected,false);
  ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/desktop/socket');await new Promise<void>(r=>ws!.once('open',r));
  ws.on('message',data=>{const job=JSON.parse(String(data));if(job.type==='job'){ws!.send(JSON.stringify({type:'result',id:job.id,text:'actual transport fixture',conversation:{id:job.conversation.id,title:job.conversation.title,cursor:'a'.repeat(64),resumability:'active-chat-only'}}));ws!.send(JSON.stringify({type:'ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'}));}});
  ws.send(JSON.stringify({type:'hello',token:g.desktopWorkerToken,workerId:'fixture',ready:true,conversationControl:true,conversationResumability:'active-chat-only'}));await new Promise<void>(r=>ws!.once('message',()=>r()));
  const response=await fetch(g.url+'/bridge/advice',{method:'POST',headers,body:JSON.stringify({model:'copilot-opus-5.5',prompt:'planner test',conversation:{mode:'new',workspaceKey:'b'.repeat(64)}})});const reply=await response.json() as any;
  assert.equal(response.status,200);assert.equal(reply.contextContinuity,'same-excel-desktop-chat');assert.equal(reply.conversationVerification.source,'authenticated local Excel desktop adapter');assert.equal(reply.backend,'excel-desktop');assert.equal(g.status().completed,1);
 }finally{ws?.terminate();await g.close();await rm(dir,{recursive:true,force:true});}
});
