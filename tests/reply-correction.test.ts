import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {startGateway} from '../packages/gateway/index.js';
import {DirectSessions} from '../packages/gateway/direct-sessions.js';
import {parseRequest} from '../packages/protocol/index.js';

const base={model:'copilot-opus-5.5',max_tokens:1000,system:'PRIVATE_SYSTEM_ONCE',tools:[{name:'Read',description:'PRIVATE_TOOL_SCHEMA_ONCE',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path'],additionalProperties:false}}],messages:[{role:'user',content:'PRIVATE_TASK_ONCE'}]};
const malformed='```json\n{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"once.txt"}}]}}\n```';
const valid=JSON.stringify({content:[{type:'tool_use',name:'Read',input:{file_path:'once.txt'}}]});
const delay=()=>new Promise(r=>setTimeout(r,10));
async function until<T>(check:()=>T|undefined):Promise<T>{const end=Date.now()+5000;while(Date.now()<end){const value=check();if(value!==undefined)return value;await delay();}throw new Error('Correction event deadline');}
async function fixture(timeoutMs=5000){
 const dir=await mkdtemp(join(tmpdir(),'reply-correction-')),g=await startGateway({stateDir:dir,port:0,timeoutMs,cancelTimeoutMs:1000});
 const origin='chrome-extension://'+'f'.repeat(32),{token}=await(await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:g.pairCode})})).json() as any;
 let ws:WebSocket;const events:any[]=[],jobs:any[]=[];
 async function connect(){ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/socket',{origin});ws.on('message',d=>{const e=JSON.parse(String(d));events.push(e);if(e.type==='job')jobs.push(e);});await new Promise<void>(r=>ws.once('open',r));ws.send(JSON.stringify({type:'hello',token,workerId:'format-test',ready:true,conversationControl:true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,cancelContinuation:1,agentContexts:1,imageInput:1}));await next('connected');}
 async function next(type:string,id?:string){return until(()=>{const i=events.findIndex(e=>e.type===type&&(!id||e.id===id));return i<0?undefined:events.splice(i,1)[0];});}
 await connect();
 const headers={'x-api-key':g.clientKey,'x-claude-code-session-id':'format-native','x-claude-code-request-class':'main'};
 const emit=(value:any)=>ws.send(JSON.stringify(value));
 const proof=(job:any,cursor='b')=>({id:job.conversation.id,title:job.conversation.title,cursor:cursor.repeat(64),cursorVersion:2,pageInstance:'format-page',resumability:'active-chat-only'});
 const reply=(job:any,text:string,extra:any={})=>{emit({type:'result',id:job.id,text,conversation:proof(job),...extra});emit({type:'ready',ready:true});};
 return{dir,g,jobs,next,emit,proof,reply,connect,disconnect:()=>ws.terminate(),send:(body:any=base,signal?:AbortSignal,agent?:string)=>fetch(g.url+'/v1/messages',{method:'POST',headers:{...headers,...(agent?{'x-claude-code-agent-id':agent}:{})},body:JSON.stringify(body),signal}),close:async()=>{ws.terminate();await g.close();await rm(dir,{recursive:true,force:true});}};
}

test('malformed JSON is corrected once in the same chat, preserving epoch and delta history without duplicate tools',async()=>{
 const f=await fixture();try{
  const pending=f.send();void pending.catch(()=>{});const first=await f.next('job');f.reply(first,malformed);f.reply(first,malformed);
  const correction=await f.next('job');assert.notEqual(correction.id,first.id);assert.equal(correction.conversation.id,first.conversation.id);assert.equal(correction.conversation.mode,'continue');assert.equal(correction.conversation.expectedCursor,'b'.repeat(64));assert.equal(correction.modelLabel,first.modelLabel);assert.equal(correction.lane,first.lane);
  assert.ok(!correction.prompt.includes('PRIVATE_SYSTEM_ONCE'));assert.ok(!correction.prompt.includes('PRIVATE_TASK_ONCE'));assert.ok(!correction.prompt.includes('PRIVATE_TOOL_SCHEMA_ONCE'));assert.ok(correction.prompt.length<2000);assert.match(correction.prompt,/None of its proposed tool calls was executed/);
  f.reply(first,'{"content":[{"type":"text","text":"late invalid result"}]}');f.reply(correction,valid);
  const response=await pending;assert.equal(response.status,200);assert.equal(response.headers.get('x-bridge-context-epoch'),'1');const message=await response.json() as any;
  assert.equal(message.content.filter((b:any)=>b.type==='tool_use').length,1);assert.equal(message.content.at(-1).name,'Read');assert.match(message.content[0].text,/原聊天/);
  const second=f.send({...base,messages:[...base.messages,{role:'assistant',content:message.content},{role:'user',content:[{type:'tool_result',tool_use_id:message.content.at(-1).id,content:'actual once.txt contents'}]}]});const delta=await f.next('job');assert.equal(delta.conversation.id,first.conversation.id);assert.match(delta.prompt,/actual once.txt contents/);assert.ok(!delta.prompt.includes('PRIVATE_SYSTEM_ONCE'));f.reply(delta,'{"content":[{"type":"text","text":"done"}]}');const secondResponse=await second;assert.equal(secondResponse.status,200);await secondResponse.text();
  await f.g.close();const ledger=await readFile(join(f.dir,'dispatch-ledger.json'),'utf8');assert.equal(JSON.parse(ledger).jobs.filter((j:any)=>j.formatAttempt===1).length,1);assert.ok(!ledger.includes('PRIVATE_TASK_ONCE'));assert.ok(!ledger.includes('once.txt'));const dc=JSON.parse(await readFile(join(f.dir,'direct-contexts.json'),'utf8'));assert.equal(dc.records[0].state,'ready');assert.equal(dc.records[0].epoch,1);
 }finally{await f.close();}
});

test('duplicate corrected valid results settle the native lease and tool response only once',async()=>{
 const f=await fixture();try{
  const pending=f.send(),first=await f.next('job');f.reply(first,malformed);const correction=await f.next('job');f.reply(correction,valid);f.reply(correction,valid);
  const response=await pending;assert.equal(response.status,200);const value=await response.json() as any;assert.equal(value.content.filter((b:any)=>b.type==='tool_use').length,1);assert.equal(f.g.status().completed,1);assert.equal(f.g.status().nativeContexts[0].state,'ready');assert.equal(f.jobs.length,2);
 }finally{await f.close();}
});

test('leading commentary with one fully valid structured suffix requires explicit model correction before tools are delivered',async()=>{
 const f=await fixture();try{
  let delivered=false;const p=f.send().then(r=>{delivered=true;return r;}),first=await f.next('job');f.reply(first,'User explicitly asked to read it back.\n'+valid);const correction=await f.next('job');assert.equal(delivered,false);assert.equal(correction.conversation.id,first.conversation.id);assert.equal(correction.conversation.mode,'continue');assert.equal(f.jobs.length,2);f.reply(correction,valid);const r=await p;assert.equal(r.status,200);const reply=await r.json() as any;assert.equal(reply.content.filter((b:any)=>b.type==='tool_use').length,1);
 }finally{await f.close();}
});

test('commentary cannot authorize a suffix with an invalid or unavailable tool',async()=>{const f=await fixture();try{const p=f.send(),job=await f.next('job');f.reply(job,'Here is an example:\n{"content":[{"type":"tool_use","name":"Unknown","input":{}}]}');assert.equal((await p).status,502);assert.equal(f.jobs.length,1);}finally{await f.close();}});

test('a canonical refusal delivered as a raw result remains terminal even before a structured suffix',async()=>{const f=await fixture();try{const p=f.send(),job=await f.next('job');f.reply(job,'Copilot refused external-client relay use\n'+valid);assert.equal((await p).status,400);const retry=await f.send({...base,max_tokens:2000});assert.equal(retry.status,400);assert.match(await retry.text(),/refused external-client relay/);assert.equal(f.jobs.length,1);}finally{await f.close();}});

for(const failure of ['invalid-tool','refusal','chat-lost'] as const)test('correction stops without a third inference on '+failure,async()=>{
 const f=await fixture();try{
  const p=f.send(),first=await f.next('job');f.reply(first,malformed);const correction=await f.next('job');
  if(failure==='refusal')f.emit({type:'failure',id:correction.id,code:'provider_refusal',error:'Copilot refused external-client relay use',submitted:true});
  else if(failure==='chat-lost')f.emit({type:'failure',id:correction.id,code:'conversation_unavailable',error:'Chat switched',submitted:false});
  else f.reply(correction,'{"content":[{"type":"tool_use","name":"Read","input":{"file_path":12}}]}');
  const r=await p;assert.equal(r.status,failure==='refusal'?400:502);assert.equal(f.jobs.length,2);const retry=await f.send({...base,max_tokens:2000});assert.equal(retry.status,failure==='refusal'?400:409);assert.equal(f.jobs.length,2);
  if(failure==='refusal')assert.match(await retry.text(),/refused external-client relay/);
 }finally{await f.close();}
});

for(const succeeds of [true,false])test('JSON correction uses its fifth attempt without replaying source or delivering earlier tools: '+succeeds,async()=>{
 const f=await fixture();try{
  let delivered=false;const pending=f.send().then(r=>{delivered=true;return r;}),first=await f.next('job');f.reply(first,malformed);
  for(let i=1;i<=5;i++){const correction=await f.next('job');assert.equal(delivered,false);assert.equal(correction.conversation.id,first.conversation.id);assert.equal(correction.modelLabel,first.modelLabel);assert.ok(!correction.prompt.includes('PRIVATE_TASK_ONCE'));f.reply(correction,succeeds&&i===5?valid:malformed);}
  const response=await pending;assert.equal(response.status,succeeds?200:502);const text=await response.text();assert.match(text,/5/);if(succeeds)assert.equal(JSON.parse(text).content.filter((b:any)=>b.type==='tool_use').length,1);else assert.match(text,/JSON[\s\S]*5[\s\S]*failure/i);assert.equal(f.jobs.length,6);
 }finally{await f.close();}
});

test('a JSON correction keeps the original inference deadline instead of receiving another full timeout',async()=>{
 const f=await fixture(1500);try{
  const pending=f.send();void pending.catch(()=>{});const first=await f.next('job');await new Promise(r=>setTimeout(r,1100));f.reply(first,malformed);await f.next('job');
  const status=await Promise.race([pending.then(r=>r.status),new Promise(r=>setTimeout(()=>r('deadline was renewed'),800))]);assert.equal(status,504);assert.equal(f.jobs.length,2);
 }finally{await f.close();}
});

for(const repairs of [5,6])test('ACK diagnostics match the per-transfer correction budget: '+repairs,async()=>{const f=await fixture();try{const pending=f.send(),job=await f.next('job');f.reply(job,valid,{contextAckRepairs:repairs,contextAckRepairChars:repairs*400});assert.equal((await pending).status,repairs===5?200:502);}finally{await f.close();}});

for(const kind of ['missing-proof','wrong-proof','invalid-schema','plain-refusal'] as const)test('no format inference without verified syntactic-format evidence: '+kind,async()=>{
 const f=await fixture();try{
  const p=f.send(),first=await f.next('job');
  if(kind==='plain-refusal')f.emit({type:'failure',id:first.id,code:'provider_refusal',error:'Copilot refused external-client relay use',submitted:true});
  else f.reply(first,kind==='invalid-schema'?'{"content":[{"type":"tool_use","name":"Unknown","input":{}}]}':malformed,{...(kind==='missing-proof'?{conversation:undefined}:kind==='wrong-proof'?{conversation:{...f.proof(first),id:'11111111-1111-4111-8111-111111111111'}}:{})});
  assert.equal((await p).status,kind==='plain-refusal'?400:502);assert.equal(f.jobs.length,1);
 }finally{await f.close();}
});

test('a completed verified image is not uploaded a second time for text-only correction',async()=>{
 const f=await fixture();try{
  const image={type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII='}};
  const p=f.send({...base,messages:[{role:'user',content:[image,{type:'text',text:'inspect'}]}]}),first=await f.next('job');assert.equal(first.images.length,1);f.reply(first,malformed,{imageIds:first.images.map((i:any)=>i.id)});const correction=await f.next('job');assert.equal(correction.images,undefined);f.reply(correction,valid);assert.equal((await p).status,200);
 }finally{await f.close();}
});

test('proven pre-input image failure keeps committed native history ready for same-chat retry',async()=>{
 const f=await fixture();try{
  const first=f.send(),warmup=await f.next('job');f.reply(warmup,'{"content":[{"type":"text","text":"ready"}]}');assert.equal((await first).status,200);
  const request={...base,messages:[...base.messages,{role:'assistant',content:'ready'},{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII='}},{type:'text',text:'read pixels'}]}]};
  const failure=f.send(request),imageJob=await f.next('job');f.emit({type:'failure',id:imageJob.id,error:'Focus failed before Enter',submitted:false});assert.equal((await failure).status,502);assert.equal(f.g.status().nativeContexts[0].state,'ready');
  const retry=f.send({...request,max_tokens:2000}),retryJob=await f.next('job');assert.equal(retryJob.conversation.id,warmup.conversation.id);assert.equal(retryJob.conversation.mode,'continue');assert.ok(!retryJob.prompt.includes('PRIVATE_SYSTEM_ONCE'));f.reply(retryJob,'{"content":[{"type":"text","text":"verified"}]}',{imageIds:retryJob.images.map((i:any)=>i.id)});assert.equal((await retry).status,200);
 }finally{await f.close();}
});

test('correction reconnect recovers its own ID instead of replaying the original job',async()=>{
 const f=await fixture();try{
  const p=f.send(),first=await f.next('job');f.reply(first,malformed);const correction=await f.next('job');f.disconnect();await f.connect();const recover=await f.next('recover');assert.equal(recover.id,correction.id);assert.equal(f.jobs.length,2);f.reply(correction,valid);assert.equal((await p).status,200);
 }finally{await f.close();}
});

test('cancelling correction discards its proposed tools and feedback resumes the same chat',async()=>{
 const f=await fixture();try{
  const abort=new AbortController(),p=f.send(base,abort.signal).catch(()=>undefined),first=await f.next('job');f.reply(first,malformed);const correction=await f.next('job');abort.abort();await p;const cancel=await f.next('cancel',correction.id);
  f.emit({type:'cancel_receipt',id:correction.id,receipt:{version:1,jobId:correction.id,nonce:cancel.nonce,conversationId:correction.conversation.id,lane:correction.lane,outcome:'settled',inputComplete:true,replyState:'partial',pageInstance:'format-page',cursor:'c'.repeat(64)}});await f.next('ack',correction.id);f.reply(correction,valid);
  const feedback=f.send({...base,messages:[...base.messages,{role:'user',content:'continue after accidental interrupt'}]}),resume=await f.next('job');assert.equal(resume.conversation.id,first.conversation.id);assert.equal(resume.conversation.mode,'continue');f.reply(resume,'{"content":[{"type":"text","text":"continued"}]}');const r=await feedback;assert.equal(r.status,200);assert.equal(r.headers.get('x-bridge-context-epoch'),'1');assert.ok(!(await r.text()).includes('tool_use'));
 }finally{await f.close();}
});

test('unsent correction retains verified original input across cancellation and restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'format-unsent-'));try{
  const s=new DirectSessions(dir);await s.load();const request=parseRequest(base),frame=await s.prepare('format-native','a'.repeat(64),request,'first');const corrected=await s.correctFormat(frame,'second','chat-one');await assert.rejects(s.commit(frame,'chat-one'),/lease changed/);
  await s.beginCancellation(corrected);await s.settleCancellation(corrected,{version:1,jobId:'second',nonce:'n',conversationId:'chat-one',lane:'main',outcome:'not_sent',inputComplete:false,replyState:'none'});
  const loaded=new DirectSessions(dir);await loaded.load();const next=await loaded.prepare('format-native','a'.repeat(64),parseRequest({...base,messages:[...base.messages,{role:'user',content:'continue'}]}),'third',false,undefined,true);assert.equal(next.conversationId,'chat-one');assert.equal(next.epoch,1);assert.equal(next.plan.kind,'resume');assert.ok(!JSON.stringify(next.plan.messages).includes('PRIVATE_TASK_ONCE'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
