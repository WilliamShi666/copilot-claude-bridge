import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {startGateway} from '../packages/gateway/index.js';
const request=(text:string)=>({model:'copilot-opus-5.5',max_tokens:1000,tools:[{name:'Read',input_schema:{type:'object'}}],messages:[{role:'user',content:text}]});
async function until(predicate:()=>boolean){const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('Expected gateway event did not arrive');await new Promise(r=>setTimeout(r,5));}}
async function setup(timeoutMs=4000){
 const dir=await mkdtemp(join(tmpdir(),'agent-gateway-')),g=await startGateway({stateDir:dir,port:0,timeoutMs,queueTimeoutMs:10000,maxPromptChars:2000000});
 const origin='chrome-extension://'+'d'.repeat(32),headers={'x-api-key':g.clientKey,'x-claude-code-session-id':'native-parent','x-bridge-workspace-key':'a'.repeat(64)};
 const {token}=await(await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:g.pairCode})})).json() as any;
 const ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/socket',{origin});await new Promise<void>(r=>ws.once('open',r));
 const jobs:any[]=[],cancelled:string[]=[];
 ws.on('message',raw=>{const value=JSON.parse(String(raw));if(value.type==='job')jobs.push(value);if(value.type==='cancel')cancelled.push(value.id);});
 ws.send(JSON.stringify({type:'hello',token,workerId:'agents',ready:true,conversationControl:true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,agentContexts:1,summaryRouting:1}));
 await new Promise<void>(r=>ws.once('message',()=>r()));
 const send=(body:any,agent?:string,signal?:AbortSignal,kind=agent?'subagent':'main')=>fetch(g.url+'/v1/messages',{method:'POST',headers:{...headers,'x-claude-code-request-class':kind,...(agent?{'x-claude-code-agent-id':agent}:{})},body:JSON.stringify(body),signal});
 const reply=(job:any,text='reply')=>{ws.send(JSON.stringify({type:'result',id:job.id,text:JSON.stringify({content:[{type:'text',text}]}),...(job.summary?{summaryModel:'GPT-6.1 Sol'}:{}),...(job.conversation?{conversation:{id:job.conversation.id,title:job.conversation.title,cursor:'b'.repeat(64),resumability:'active-chat-only'}}:{})}));ws.send(JSON.stringify({type:'ready',ready:true}));};
 return{g,ws,jobs,cancelled,send,reply,close:async()=>{ws.terminate();await g.close();await rm(dir,{recursive:true,force:true});}};
}
test('three native agents queue behind a main request, keep independent chats, and resume their own delta',async()=>{
 const s=await setup();try{
 const main=s.send(request('MAIN_ONLY'));await until(()=>s.jobs.length===1);
 const workers=['writer-a@team','writer-b@team','writer-c@team'].map((id,i)=>s.send(request('AGENT_'+i),id));
 await until(()=>s.g.status().queued===3);assert.equal(s.jobs.length,1);s.reply(s.jobs[0]);assert.equal((await main).status,200);
 for(let i=1;i<=3;i++){await until(()=>s.jobs.length>i);assert.match(s.jobs[i].lane,/^agent:[a-f0-9]{64}$/);assert.ok(s.jobs[i].prompt.includes('AGENT_'+(i-1)));assert.ok(!s.jobs[i].prompt.includes('MAIN_ONLY'));s.reply(s.jobs[i]);}
 assert.deepEqual((await Promise.all(workers)).map(r=>r.status),[200,200,200]);assert.equal(new Set(s.jobs.map(j=>j.lane)).size,4);
 const second=s.send({...request('AGENT_0'),messages:[{role:'user',content:'AGENT_0'},{role:'assistant',content:'reply'},{role:'user',content:'SECOND_A_ONLY'}]},'writer-a@team');
 await until(()=>s.jobs.length===5);assert.equal(s.jobs[4].conversation.id,s.jobs[1].conversation.id);assert.equal(s.jobs[4].conversation.mode,'continue');assert.ok(!s.jobs[4].prompt.includes('AGENT_0'));s.reply(s.jobs[4]);assert.equal((await second).status,200);
 const parent=s.send({...request('MAIN_ONLY'),messages:[{role:'user',content:'MAIN_ONLY'},{role:'assistant',content:'reply'},{role:'user',content:'PARENT_CONTINUES'}]});await until(()=>s.jobs.length===6);assert.equal(s.jobs[5].conversation.id,s.jobs[0].conversation.id);s.reply(s.jobs[5]);assert.equal((await parent).status,200);
 }finally{await s.close();}
});

test('feedback after a dispatched client cancellation starts a fresh chat without replaying the cancelled request',async()=>{
 const s=await setup();try{
 const input={...request('ORIGINAL'),stream:true};const controller=new AbortController();const response=await s.send(input,undefined,controller.signal);const discarded=response.text().catch(()=>undefined);
 await until(()=>s.jobs.length===1);const old=s.jobs[0];controller.abort();await discarded;await until(()=>s.cancelled.includes(old.id));
 await until(()=>s.g.status().nativeContexts.some(c=>c.state==='uncertain'));
 const retry=await s.send(input);assert.equal(retry.status,409);assert.equal(s.jobs.length,1);
 s.ws.send(JSON.stringify({type:'failure',id:old.id,error:'Aborted',submitted:true}));s.ws.send(JSON.stringify({type:'ready',ready:true}));
 const fresh={...request('ORIGINAL'),messages:[{role:'user',content:'ORIGINAL'},{role:'user',content:'REVISED_FEEDBACK'}]};
 const next=s.send(fresh);await until(()=>s.jobs.length===2);assert.equal(s.jobs[1].conversation.mode,'new');assert.notEqual(s.jobs[1].conversation.id,old.conversation.id);assert.ok(s.jobs[1].prompt.includes('client-interrupted-feedback'));assert.ok(s.jobs[1].prompt.includes('REVISED_FEEDBACK'));
 s.reply(s.jobs[1]);assert.equal((await next).status,200);
 const after=s.send({...fresh,messages:[...fresh.messages,{role:'assistant',content:'reply'},{role:'user',content:'FEEDBACK_AFTER_DONE'}]});await until(()=>s.jobs.length===3);assert.equal(s.jobs[2].conversation.id,s.jobs[1].conversation.id);assert.equal(s.jobs[2].conversation.mode,'continue');s.reply(s.jobs[2]);assert.equal((await after).status,200);
 assert.equal(s.jobs.filter(j=>j.id===old.id).length,1);
 }finally{await s.close();}
});
test('canceling a queued agent never cancels the active sibling and leaves its context retryable',async()=>{
 const s=await setup();try{
 const active=s.send(request('ACTIVE'),'writer-a');await until(()=>s.jobs.length===1);
 const controller=new AbortController();const canceled=s.send(request('CANCELED'),'writer-b',controller.signal).catch(()=>undefined);const survivor=s.send(request('SURVIVOR'),'writer-c');
 await until(()=>s.g.status().queued===2);controller.abort();await canceled;await until(()=>s.g.status().queued===1);assert.deepEqual(s.cancelled,[]);
 s.reply(s.jobs[0]);assert.equal((await active).status,200);await until(()=>s.jobs.length===2);assert.ok(s.jobs[1].prompt.includes('SURVIVOR'));s.reply(s.jobs[1]);assert.equal((await survivor).status,200);
 const retry=s.send(request('RETRY'),'writer-b');await until(()=>s.jobs.length===3);s.reply(s.jobs[2]);assert.equal((await retry).status,200);
 }finally{await s.close();}
});
test('time waiting in the browser queue does not consume the inference timeout',async t=>{
 const inferenceLimit=1234,realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;let now=0;const inferenceTimers=new Map<NodeJS.Timeout,{deadline:number;run:()=>void}>();
 // Only the configured inference deadline uses this clock. Network polling,
 // authentication and the separate queue deadline retain their real timers.
 t.mock.method(globalThis,'setTimeout',((callback:any,delay?:number,...args:any[])=>{if(delay!==inferenceLimit)return realSetTimeout(callback,delay,...args);const token={} as NodeJS.Timeout;inferenceTimers.set(token,{deadline:now+delay,run:()=>callback(...args)});return token;}) as typeof setTimeout);
 t.mock.method(globalThis,'clearTimeout',((timer:any)=>{if(!inferenceTimers.delete(timer))realClearTimeout(timer);}) as typeof clearTimeout);
 const advance=(ms:number)=>{now+=ms;for(const [token,timer]of [...inferenceTimers])if(timer.deadline<=now){inferenceTimers.delete(token);timer.run();}};
 const s=await setup(inferenceLimit);try{
 const first=s.send(request('FIRST'),'writer-a');void first.catch(()=>{});await until(()=>s.jobs.length===1);const second=s.send(request('SECOND'),'writer-b');void second.catch(()=>{});await until(()=>s.g.status().queued===1);
 assert.equal(inferenceTimers.size,1,'queued request must not have an inference timer');advance(800);s.reply(s.jobs[0]);assert.equal((await first).status,200);await until(()=>s.jobs.length===2);
 assert.equal(inferenceTimers.size,1);advance(800);s.reply(s.jobs[1]);assert.equal((await second).status,200);assert.equal(inferenceTimers.size,0);assert.ok(now>inferenceLimit,'combined queue and inference time must exceed one inference budget');
 }finally{await s.close();t.mock.restoreAll();}
});

test('in-process teammate headers use an agent chat even when request-class says main',async()=>{
 const s=await setup();try{const pending=s.send(request('TEAMMATE'),'writer@team',undefined,'main');await until(()=>s.jobs.length===1);assert.match(s.jobs[0].lane,/^agent:/);s.reply(s.jobs[0]);assert.equal((await pending).status,200);}finally{await s.close();}
});

test('abort during dispatch persistence never sends a late job and preserves unsent context',async()=>{
 const s=await setup();const original=fsPromises.writeFile;let release!:()=>void;const gate=new Promise<void>(r=>release=r);let blocked=false;
 fsPromises.writeFile=(async(file:any,data:any,...args:any[])=>{
 if(!blocked&&String(file).endsWith('dispatch-ledger.json.tmp')&&String(data).includes('"phase":"dispatched"')){blocked=true;await gate;}
 return (original as any)(file,data,...args);
 }) as typeof original;syncBuiltinESMExports();
 try{
 const controller=new AbortController();const response=await s.send({...request('UNSENT'),stream:true},'writer-b',controller.signal);assert.equal(response.status,200);
 await until(()=>blocked);controller.abort();await until(()=>s.g.status().active===null);release();await until(()=>s.g.status().browserReady);
 assert.deepEqual(s.jobs,[]);assert.deepEqual(s.cancelled,[]);
 const retry=s.send(request('RETRY'),'writer-b');await until(()=>s.jobs.length===1);s.reply(s.jobs[0]);assert.equal((await retry).status,200);
 }finally{release();fsPromises.writeFile=original;syncBuiltinESMExports();await s.close();}
});
