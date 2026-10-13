import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import WebSocket from 'ws';import {startGateway} from '../packages/gateway/index.js';
const base={model:'copilot-opus-5.5',max_tokens:1000,system:[{type:'text',text:'SYSTEM_ONCE'}],tools:[{name:'Read',input_schema:{type:'object',description:'LONG_SCHEMA_ONCE'}}],messages:[{role:'user',content:'INITIAL_MARKER_ONCE'}]};
async function setup(contextPackets=0){
 const dir=await mkdtemp(join(tmpdir(),'direct-gateway-')),g=await startGateway({stateDir:dir,port:0,timeoutMs:4000,maxPromptChars:2000000});const origin='chrome-extension://'+'d'.repeat(32);
 const {token}=await(await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:g.pairCode})})).json() as any;
 const ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/socket',{origin});await new Promise<void>(r=>ws.once('open',r));const jobs:any[]=[];let mainCount=0;
 ws.on('message',data=>{const job=JSON.parse(String(data));if(job.type!=='job')return;jobs.push(job);if(job.lane==='main')mainCount++;
 const text=job.prompt.includes('INVALID_REPLY_TEST')?'malformed reply':JSON.stringify({content:[{type:'text',text:job.summary?'<summary>Preserve task state and verified findings.</summary>':'reply-'+jobs.length}]});
 ws.send(JSON.stringify({type:'result',id:job.id,text,...(job.summary?{summaryModel:'GPT-6 Sol',summaryAttempts:[{model:'GPT-6.1 Sol',error:'invalid JSON'},{model:'GPT-6 Sol'}]}:{}),...(job.conversation?{conversation:{id:job.conversation.id,title:job.conversation.title,cursor:mainCount.toString(16).padStart(64,'0'),resumability:'active-chat-only'}}:{})}));
 ws.send(JSON.stringify({type:'ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true}));});
 ws.send(JSON.stringify({type:'hello',token,workerId:'direct-test',ready:true,conversationControl:true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,contextPackets,summaryRouting:1}));await new Promise<void>(r=>ws.once('message',()=>r()));
 const headers={'x-api-key':g.clientKey,'x-claude-code-session-id':'native-session-A','x-bridge-workspace-key':'a'.repeat(64)};
 return {dir,g,ws,jobs,headers,send:(body:unknown,hints:Record<string,string>={})=>fetch(g.url+'/v1/messages',{method:'POST',headers:{...headers,...hints},body:JSON.stringify(body)}),event:(body:unknown)=>fetch(g.url+'/bridge/context/compact',{method:'POST',headers,body:JSON.stringify(body)}),close:async()=>{ws.terminate();await g.close();await rm(dir,{recursive:true,force:true});}};
}
test('large native contexts require negotiated segmented transport without making unsent sessions uncertain',async()=>{
 const s=await setup();try{
  assert.equal((await s.send({...base,messages:[{role:'user',content:'FULL_SOURCE '.repeat(40000)}]})).status,503);assert.equal(s.jobs.length,0);
  assert.equal((await s.send(base)).status,200);
 }finally{await s.close();}
});
test('negotiated long history dispatches bounded packets and retains source-free diagnostics',async()=>{
 const s=await setup(1);try{
  const marker='PRIVATE_ARCHIVE_SOURCE',content=marker+'record '.repeat(90000)+marker;
  assert.equal((await s.send({...base,messages:[{role:'user',content}]})).status,200);
  const job=s.jobs[0];assert.ok(job.contextPackets.length>2);assert.ok(job.contextPackets.every((p:any)=>p.prompt.length<=350000));
  const ledger=JSON.parse(await readFile(join(s.dir,'dispatch-ledger.json'),'utf8'));assert.equal(ledger.jobs[0].packetCount,job.contextPackets.length);assert.ok(ledger.jobs[0].promptChars>600000);assert.ok(!JSON.stringify(ledger).includes(marker));
 }finally{await s.close();}
});
test('native main requests continue one verified chat with deltas; auxiliary inference does not replace it',async()=>{
 const s=await setup();try{
 const first=await(await s.send(base)).json() as any;assert.equal(s.jobs[0].lane,'main');assert.equal(s.jobs[0].conversation.mode,'new');
 const history=[...base.messages,{role:'assistant',content:first.content},{role:'user',content:'SECOND_MESSAGE_ONLY'}];
 const secondResponse=await s.send({...base,messages:history});assert.equal(secondResponse.headers.get('x-bridge-usage'),'estimated');const second=await secondResponse.json() as any;
 assert.equal(s.jobs[1].conversation.id,s.jobs[0].conversation.id);assert.equal(s.jobs[1].conversation.mode,'continue');assert.ok(!s.jobs[1].prompt.includes('LONG_SCHEMA_ONCE'));assert.ok(!s.jobs[1].prompt.includes('INITIAL_MARKER_ONCE'));assert.ok(s.jobs[1].prompt.includes('SECOND_MESSAGE_ONLY'));
 await s.send({model:base.model,max_tokens:100,messages:[{role:'user',content:'auxiliary title'}]});assert.equal(s.jobs[2].lane,'auxiliary');assert.equal(s.jobs[2].conversation,undefined);
 await s.send({...base,messages:[...history,{role:'assistant',content:second.content},{role:'user',content:'THIRD'}]});assert.equal(s.jobs[3].conversation.id,s.jobs[0].conversation.id);assert.equal(s.jobs[3].conversation.mode,'continue');
 const saved=await readFile(join(s.dir,'direct-contexts.json'),'utf8');assert.ok(!saved.includes('INITIAL_MARKER_ONCE'));
 }finally{await s.close();}
});
test('authenticated native compaction isolates its summary and rebases the next main request in the same native session',async()=>{
 const s=await setup();try{
 await s.send(base);const first=s.jobs[0].conversation.id;
 const event={session_id:'native-session-A',workspaceKey:'a'.repeat(64),trigger:'manual'};
 assert.equal((await fetch(s.g.url+'/bridge/context/compact',{method:'POST',body:JSON.stringify({...event,hook_event_name:'PreCompact'})})).status,401);
 assert.equal((await s.event({...event,hook_event_name:'PreCompact'})).status,200);
 await s.send({model:base.model,max_tokens:100,messages:[{role:'user',content:'summarize this native history'}]});assert.equal(s.jobs[1].lane,'auxiliary');
 assert.equal((await s.event({...event,hook_event_name:'PostCompact'})).status,200);
 await s.send({...base,messages:[{role:'user',content:'AUTHORITATIVE_COMPACT_SUMMARY'}]});assert.equal(s.jobs[2].conversation.mode,'new');assert.notEqual(s.jobs[2].conversation.id,first);assert.ok(!s.jobs[2].prompt.includes('INITIAL_MARKER_ONCE'));
 const contexts=await(await fetch(s.g.url+'/bridge/context/status',{headers:s.headers})).json() as any;assert.equal(contexts.contexts[0].sessionId,'native-session-A');assert.equal(contexts.contexts[0].epoch,2);
 }finally{await s.close();}
});
test('invalid model output leaves an uncertain context; explicit reset is required before any retry',async()=>{
 const s=await setup();try{
 assert.equal((await s.send({...base,messages:[{role:'user',content:'INVALID_REPLY_TEST'}]})).status,502);
 assert.equal((await s.send(base)).status,409);assert.equal(s.jobs.length,1);
 assert.equal((await fetch(s.g.url+'/bridge/context/reset',{method:'POST',headers:s.headers,body:JSON.stringify({session_id:'native-session-A'})})).status,200);
 assert.equal((await s.send(base)).status,200);assert.equal(s.jobs[1].conversation.mode,'new');
 }finally{await s.close();}
});
test('native request-class headers isolate summaries even with tools; compacted header rebases without a hook',async()=>{
 const s=await setup();try{
 const main={'x-claude-code-request-class':'main'};
 await s.send(base,main);const first=s.jobs[0].conversation.id;
 await s.send(base,{'x-claude-code-request-class':'compaction','x-claude-code-compaction':'manual'});
 assert.equal(s.jobs[1].lane,'auxiliary');assert.equal(s.jobs[1].conversation,undefined);
 assert.equal(s.jobs[1].summary,true);assert.equal(s.jobs[1].modelLabel,'GPT-6.1 Sol');assert.equal(s.jobs[1].model,base.model);
 assert.ok(s.jobs[1].prompt.includes('CURRENT TASK: COMPACTION SUMMARY'));assert.ok(!s.jobs[0].prompt.includes('CURRENT TASK: COMPACTION SUMMARY'));
 await s.send(base,{...main,'x-claude-code-context-compacted':'manual'});
 assert.equal(s.jobs[2].lane,'main');assert.notEqual(s.jobs[2].conversation.id,first);assert.ok(s.jobs[2].prompt.includes('native-compaction'));
 await s.send(base,{'x-claude-code-request-class':'auxiliary'});assert.equal(s.jobs[3].lane,'auxiliary');
 assert.equal(s.jobs[3].summary,undefined);assert.equal(s.jobs[3].modelLabel,'Claude Opus 5.5');
 // close() flushes asynchronous ledger writes. Polling the target while it is
 // atomically replaced can cause EPERM rename on Windows and poison persistence.
 s.ws.terminate();await s.g.close();
 const ledger=JSON.parse(await readFile(join(s.dir,'dispatch-ledger.json'),'utf8'));
 assert.equal(ledger.jobs[1].phase,'completed');assert.equal(ledger.jobs[1].summaryModel,'GPT-6 Sol');assert.equal(ledger.jobs[1].summaryAttempts.length,2);
 }finally{await s.close();}
});
