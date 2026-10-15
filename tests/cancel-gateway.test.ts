import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {startGateway} from '../packages/gateway/index.js';

const base={model:'copilot-opus-5.5',max_tokens:1000,system:'SYSTEM_ONLY_ONCE',tools:[{name:'Read',input_schema:{type:'object',description:'SCHEMA_ONLY_ONCE'}}],messages:[{role:'user',content:'INITIAL_SOURCE_ONCE'}]};
const pause=(ms=10)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>any){const end=Date.now()+5000;while(Date.now()<end){const value=check();if(value)return value;await pause();}throw new Error('Test event deadline');}
async function fixture(cancelTimeoutMs=1500,maxPromptChars=180000,imageInput=0){
 const dir=await mkdtemp(join(tmpdir(),'cancel-gateway-'));let g=await startGateway({stateDir:dir,port:0,timeoutMs:5000,cancelTimeoutMs,maxPromptChars});
 const origin='chrome-extension://'+'d'.repeat(32);
 const {token}=await(await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:g.pairCode})})).json() as any;
 let ws:WebSocket;const events:any[]=[];
 async function connect(){ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/socket',{origin});ws.on('message',raw=>events.push(JSON.parse(String(raw))));await new Promise<void>(r=>ws.once('open',r));ws.send(JSON.stringify({type:'hello',token,workerId:'cancel-test',ready:true,conversationControl:true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,agentContexts:1,cancelContinuation:1,imageInput}));await until(()=>events.find(e=>e.type==='connected'));}
 await connect();
 const send=(body:any,signal?:AbortSignal,agent?:string)=>fetch(g.url+'/v1/messages',{method:'POST',headers:{'x-api-key':g.clientKey,'x-claude-code-session-id':'cancel-session','x-claude-code-request-class':'main',...(agent?{'x-claude-code-agent-id':agent}:{})},body:JSON.stringify(body),signal});
 const emit=(value:any)=>ws.send(JSON.stringify(value));
 const next=async(type:string,id?:string)=>until(()=>{const index=events.findIndex(e=>e.type===type&&(!id||e.id===id));if(index<0)return;return events.splice(index,1)[0];});
 const ready=()=>emit({type:'ready',ready:true});
 const reply=(job:any,text='verified reply')=>{emit({type:'result',id:job.id,imageIds:job.images?.map((image:any)=>image.id),text:JSON.stringify({content:[{type:'text',text}]}),conversation:{id:job.conversation.id,title:job.conversation.title,cursor:'a'.repeat(64),cursorVersion:2,pageInstance:'page-1',resumability:'active-chat-only'}});ready();};
 const receipt=(cancel:any,overrides:any={})=>({version:1,jobId:cancel.id,nonce:cancel.nonce,conversationId:cancel.conversationId,lane:cancel.lane,outcome:'settled',inputComplete:true,replyState:'partial',pageInstance:'page-1',cursor:'b'.repeat(64),...overrides});
 const confirm=(cancel:any,overrides:any={})=>{emit({type:'cancel_receipt',id:cancel.id,receipt:receipt(cancel,overrides)});ready();};
 async function start(){const pending=send(base),job=await next('job');reply(job);await pending;await next('ack',job.id);return job;}
 async function interrupt(input:any,agent?:string){const controller=new AbortController(),pending=send(input,controller.signal,agent).catch(e=>e);const job=await next('job');controller.abort();await pending;const cancel=await next('cancel',job.id);assert.equal(cancel.cancelContinuation,1);return{job,cancel};}
 return{dir,get g(){return g;},events,send,emit,next,ready,reply,receipt,confirm,start,interrupt,
  reconnect:async()=>{ws.terminate();await pause(30);events.length=0;await connect();},
  restart:async()=>{ws.terminate();await g.close();events.length=0;g=await startGateway({stateDir:dir,port:0,timeoutMs:5000,cancelTimeoutMs,maxPromptChars});await connect();},
  close:async()=>{ws.terminate();await g.close();await rm(dir,{recursive:true,force:true});}
 };
}
const requestAfterTool={...base,messages:[...base.messages,{role:'assistant',content:[{type:'tool_use',id:'bash-once',name:'Bash',input:{command:'increment-once'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'bash-once',content:'count=1'}]},{role:'system',content:'old environment'}]};
const feedback={...requestAfterTool,messages:[...requestAfterTool.messages.slice(0,-2),{role:'user',content:[...requestAfterTool.messages[2].content as any[],{type:'text',text:'[Request interrupted by user]'},{type:'text',text:'Please continue, read the existing counter without incrementing it'}]},{role:'system',content:'new environment'}]};

test('feedback waits for correlated cancellation; resumes same chat and epoch with authoritative tool tail',async()=>{
 const s=await fixture();try{
  const first=await s.start(),{job,cancel}=await s.interrupt(requestAfterTool);
  let done=false;const following=s.send(feedback).then(r=>{done=true;return r;});
  s.confirm(cancel,{nonce:'wrong-nonce'});await pause(80);assert.equal(done,false);assert.ok(!s.events.some(e=>e.type==='job'));
  s.confirm(cancel);await s.next('ack',job.id);const resumed=await s.next('job');
  assert.equal(resumed.conversation.id,first.conversation.id);assert.equal(resumed.conversation.mode,'continue');assert.equal(resumed.isolatedRecovery,false);
  assert.match(resumed.prompt,/NATIVE RESUME DELTA/);assert.match(resumed.prompt,/count=1/);assert.match(resumed.prompt,/new environment/);assert.doesNotMatch(resumed.prompt,/SYSTEM_ONLY_ONCE|SCHEMA_ONLY_ONCE|INITIAL_SOURCE_ONCE/);
  s.emit({type:'result',id:job.id,text:'{"content":[{"type":"tool_use","name":"Write","input":{}}]}'});
  s.confirm(cancel);s.reply(resumed,'read count=1');const response=await following;assert.equal(response.status,200);assert.equal(response.headers.get('x-bridge-context-kind'),'resume');assert.equal(response.headers.get('x-bridge-context-epoch'),'1');assert.match(await response.text(),/read count=1/);
  const nextInput={...feedback,messages:[...feedback.messages,{role:'assistant',content:'read count=1'},{role:'user',content:'One more ordinary feedback'}]};const normal=s.send(nextInput),normalJob=await s.next('job');assert.equal(normalJob.conversation.id,first.conversation.id);assert.match(normalJob.prompt,/CLIENT DELTA/);s.reply(normalJob);assert.equal((await normal).status,200);
 }finally{await s.close();}
});

test('reconnection asks for the same cancellation proof and never resubmits the old request',async()=>{
 const s=await fixture();try{await s.start();const {cancel}=await s.interrupt(requestAfterTool);await s.reconnect();const repeated=await s.next('cancel',cancel.id);assert.equal(repeated.nonce,cancel.nonce);assert.ok(!s.events.some(e=>e.type==='job'));s.confirm(repeated);await s.next('ack',cancel.id);const response=s.send(feedback),job=await s.next('job');assert.equal(job.conversation.id,cancel.conversationId);s.reply(job);assert.equal((await response).status,200);}finally{await s.close();}
});

for(const mismatch of ['timeout','page'])test('unverified cancellation ('+mismatch+') rebuilds at most once across max_tokens retries',async()=>{
 const s=await fixture(200);try{await s.start();const {cancel}=await s.interrupt(requestAfterTool);const response=s.send(feedback);if(mismatch==='page')s.confirm(cancel,{pageInstance:'different-page'});
  const job=await s.next('job');assert.equal(job.conversation.mode,'new');assert.equal(job.isolatedRecovery,true);assert.notEqual(job.conversation.id,cancel.conversationId);assert.match(job.prompt,/SYSTEM_ONLY_ONCE/);
  s.emit({type:'failure',id:job.id,code:'conversation_unavailable',submitted:false,error:'Recovery tab unavailable'});s.ready();assert.equal((await response).status,502);await s.next('ack',job.id);
  const retried=await s.send({...feedback,max_tokens:500});assert.equal(retried.status,400);assert.match(await retried.text(),/already attempted/);assert.ok(!s.events.some(e=>e.type==='job'));
 }finally{await s.close();}
});

test('missing original chat creates one isolated rebuild and visibly reports full synchronization',async()=>{
 const s=await fixture();try{const first=await s.start();const input={...base,messages:[...base.messages,{role:'user',content:'Follow-up after tab closed'}]},response=s.send(input),old=await s.next('job');s.emit({type:'failure',id:old.id,code:'conversation_unavailable',submitted:false,error:'Original page closed'});const job=await s.next('job');assert.equal(job.isolatedRecovery,true);assert.notEqual(job.conversation.id,first.conversation.id);s.reply(job);const text=await(await response).text();assert.match(text,/完整同步上下文/);assert.equal(s.g.status().nativeContexts[0].epoch,2);}finally{await s.close();}
});

test('a closed original tab with ready=false does not strand confirmed feedback in the queue',async()=>{
 const s=await fixture();try{await s.start();const{cancel}=await s.interrupt(requestAfterTool);s.confirm(cancel);await s.next('ack',cancel.id);s.emit({type:'ready',ready:false});await pause(30);const pending=s.send(feedback),probe=await s.next('job');assert.equal(probe.conversation.mode,'continue');s.emit({type:'failure',id:probe.id,code:'conversation_unavailable',submitted:false,error:'Original tab closed'});const recovery=await s.next('job');assert.equal(recovery.isolatedRecovery,true);s.reply(recovery);assert.equal((await pending).status,200);}finally{await s.close();}
});

test('provider refusal remains the original nonretryable error after max_tokens retry and gateway restart',async()=>{
 const s=await fixture();try{const pending=s.send(base),job=await s.next('job');s.emit({type:'failure',id:job.id,code:'provider_refusal',error:'Copilot refused external-client relay use',submitted:true});const response=await pending;assert.equal(response.status,400);assert.equal(response.headers.get('x-should-retry'),'false');const original=await response.text();await s.next('ack',job.id);await s.restart();const retried=await s.send({...base,max_tokens:32});assert.equal(retried.status,400);assert.equal(await retried.text(),original);assert.ok(!s.events.some(e=>e.type==='job'));}finally{await s.close();}
});

test('cancelled agent and late receipts cannot change its parent or sibling context',async()=>{
 const s=await fixture();try{const main=await s.start();const {job,cancel}=await s.interrupt(base,'writer-a');s.confirm(cancel);await s.next('ack',job.id);const sibling=s.send(base,undefined,'writer-b'),b=await s.next('job');s.confirm(cancel);s.reply(b);assert.equal((await sibling).status,200);const parent=s.send({...base,messages:[...base.messages,{role:'user',content:'Parent feedback'}]}),p=await s.next('job');assert.equal(p.conversation.id,main.conversation.id);s.reply(p);assert.equal((await parent).status,200);assert.notEqual(b.conversation.id,p.conversation.id);}finally{await s.close();}
});

test('cancellation acknowledgement is emitted only after source-free recovery evidence is durable',async()=>{
 const s=await fixture();try{await s.start();const{job,cancel}=await s.interrupt(requestAfterTool);s.confirm(cancel);await s.next('ack',job.id);const persisted=await readFile(join(s.dir,'direct-contexts.json'),'utf8'),ledger=JSON.parse(await readFile(join(s.dir,'dispatch-ledger.json'),'utf8'));assert.doesNotMatch(persisted,/count=1|INITIAL_SOURCE_ONCE/);assert.equal(JSON.parse(persisted).records[0].resume.cancelledJobId,job.id);const row=ledger.jobs.find((j:any)=>j.id===job.id);assert.equal(row.contextEpoch,1);assert.equal(row.cancelOutcome,'settled');assert.ok(row.cancelMs>=0);}finally{await s.close();}
});

test('a valid delta whose full recovery exceeds the limit returns 413 without a stuck lease or new chat',async()=>{
 const s=await fixture(1500,6000);try{
  let input={...base,messages:[{role:'user',content:'INITIAL '.repeat(260)}]};let pending=s.send(input),job=await s.next('job');s.reply(job);assert.equal((await pending).status,200);await s.next('ack',job.id);
  input={...input,messages:[...input.messages,{role:'user',content:'SECOND '.repeat(300)}]};pending=s.send(input);job=await s.next('job');s.reply(job);assert.equal((await pending).status,200);await s.next('ack',job.id);
  input={...input,messages:[...input.messages,{role:'user',content:'THIRD '.repeat(350)}]};pending=s.send(input);job=await s.next('job');assert.equal(job.conversation.mode,'continue');s.emit({type:'failure',id:job.id,code:'conversation_unavailable',submitted:false,error:'Original page closed'});const response=await pending;assert.equal(response.status,413);assert.match(await response.text(),/limit|characters/);await s.next('ack',job.id);assert.equal(s.g.status().active,null);assert.equal(s.g.status().queued,0);assert.equal(s.g.status().nativeContexts[0].state,'ready');assert.ok(!s.events.some(e=>e.type==='job'));
 }finally{await s.close();}
});

test('a dispatched recovery does not inherit the original unsent flag on an unknown failure',async()=>{
 const s=await fixture();try{await s.start();const pending=s.send({...base,messages:[...base.messages,{role:'user',content:'Follow-up'}]}),old=await s.next('job');s.emit({type:'failure',id:old.id,code:'conversation_unavailable',submitted:false,error:'Original page no longer active'});const recovery=await s.next('job');s.emit({type:'failure',id:recovery.id,error:'Connection lost after dispatch'});assert.equal((await pending).status,502);await s.next('ack',recovery.id);assert.equal(s.g.status().nativeContexts[0].state,'uncertain');const ledger=JSON.parse(await readFile(join(s.dir,'dispatch-ledger.json'),'utf8'));const row=ledger.jobs.find((j:any)=>j.id===recovery.id);assert.equal(row.recoveryCause,'Original page no longer active');assert.notEqual(row.submitted,false);}finally{await s.close();}
});

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';
const picture={type:'image',source:{type:'base64',media_type:'image/png',data:png}};
const withPicture={...base,messages:[...base.messages,{role:'assistant',content:[{type:'tool_use',id:'read-picture',name:'Read',input:{file_path:'picture.png'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'read-picture',content:[picture]}]}]};
test('a nested native Read image is delivered as pixels, and subsequent feedback reuses the chat without image replay',async()=>{
 const s=await fixture(1500,180000,1);try{await s.start();const response=s.send(withPicture),job=await s.next('job');assert.equal(job.images.length,1);assert.equal(job.images[0].data,png);assert.ok(!job.prompt.includes(png));assert.match(job.prompt,/Bridge image attachment/);s.reply(job,'Vision result from actual pixels');assert.equal((await response).status,200);await s.next('ack',job.id);const next=s.send({...withPicture,messages:[...withPicture.messages,{role:'assistant',content:'Vision result from actual pixels'},{role:'user',content:'Continue without reading the image again'}]}),follow=await s.next('job');assert.equal(follow.conversation.id,job.conversation.id);assert.equal(follow.images.length,0);assert.ok(!follow.prompt.includes(png));s.reply(follow);assert.equal((await next).status,200);}finally{await s.close();}
});
test('old image-incapable extensions fail before leasing, and an updated extension can recover the same native history',async()=>{
 const s=await fixture();try{assert.equal((await s.send(withPicture)).status,503);assert.equal(s.g.status().nativeContexts.length,0);assert.ok(!s.events.some(e=>e.type==='job'));s.emit({type:'ready',ready:true,imageInput:1});await pause(20);const next=s.send(withPicture),job=await s.next('job');s.reply(job);assert.equal((await next).status,200);}finally{await s.close();}
});
test('a browser response without verified image IDs cannot be returned as a vision answer',async()=>{
 const s=await fixture(1500,180000,1);try{const response=s.send(withPicture),job=await s.next('job');s.emit({type:'result',id:job.id,text:'{"content":[{"type":"text","text":"unverified visual guess"}]}',conversation:{id:job.conversation.id,title:job.conversation.title,cursor:'a'.repeat(64),resumability:'active-chat-only'}});const result=await response;assert.equal(result.status,502);assert.match(await result.text(),/did not verify actual image/);}finally{await s.close();}
});


for(const channel of ['failure','receipt'])for(const reason of ['Copilot blocked the response by content filtering','Copilot refused external-client relay use'])test('cancelling preserves canonical refusal via '+channel+' across retry and restart: '+reason,async()=>{const s=await fixture();try{await s.start();const{job,cancel}=await s.interrupt(requestAfterTool);if(channel==='failure')s.emit({type:'failure',id:job.id,code:'provider_refusal',error:reason,submitted:true});else s.confirm(cancel,{outcome:'unverified',inputComplete:false,reason:'provider_refusal',refusalKind:reason.includes('content filtering')?'content_filtering':'external_client_relay'});await s.next('ack',job.id);const response=await s.send({...requestAfterTool,max_tokens:32});assert.equal(response.status,400);assert.equal(response.headers.get('x-should-retry'),'false');const original=await response.text();assert.match(original,new RegExp(reason));const ledger=JSON.parse(await readFile(join(s.dir,'dispatch-ledger.json'),'utf8'));assert.equal(ledger.jobs.find((row:any)=>row.id===job.id).error,reason);await s.restart();const retry=await s.send({...requestAfterTool,max_tokens:64});assert.equal(retry.status,400);assert.equal(await retry.text(),original);assert.ok(!s.events.some(e=>e.type==='job'));}finally{await s.close();}});
