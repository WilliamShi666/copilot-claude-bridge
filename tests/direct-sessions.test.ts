import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DirectSessions} from '../packages/gateway/direct-sessions.js';
const request={model:'copilot-opus-5.5',max_tokens:1000,tools:[],messages:[{role:'user',content:'PRIVATE_SOURCE_SHOULD_NOT_BE_PERSISTED'}]};

test('a client-interrupted request can rebase only after explicit appended user feedback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-feedback-'));try{
 const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'first');await store.commit(first,'original-chat');
 const input={...request,messages:[...request.messages,{role:'assistant',content:'Working'},{role:'user',content:'Do the next step'}]};
 const interrupted=await store.prepare('native-A','a'.repeat(64),input,'cancelled');await (store.fail as any)(interrupted,true,true);
 await assert.rejects(store.prepare('native-A','a'.repeat(64),input,'retry'),/uncertain/);
 const fresh={...input,messages:[...input.messages,{role:'user',content:'Instead use the revised instructions'}]};
 const next=await store.prepare('native-A','a'.repeat(64),fresh,'feedback');assert.equal(next.plan.kind,'bootstrap');assert.equal(next.plan.reason,'client-interrupted-feedback');assert.equal(next.conversationId,undefined);assert.equal(next.epoch,2);
 await store.fail(next,false);await assert.rejects(store.prepare('native-A','a'.repeat(64),input,'retry-original'),/uncertain/);
 const retried=await store.prepare('native-A','a'.repeat(64),fresh,'feedback-retry');assert.equal(retried.plan.kind,'bootstrap');
 await store.commit(retried,'new-chat');const after=await store.prepare('native-A','a'.repeat(64),{...fresh,messages:[...fresh.messages,{role:'assistant',content:'Done'},{role:'user',content:'One more revision'}]},'after');assert.equal(after.plan.kind,'delta');assert.equal(after.conversationId,'new-chat');
 const persisted=await readFile(join(dir,'direct-contexts.json'),'utf8');assert.ok(!persisted.includes('revised instructions'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('merged tool-result feedback survives restart, but tool-only changes and unknown delivery stay blocked',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-feedback-merged-'));try{
 const store=new DirectSessions(dir);await store.load();const input={...request,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'question',content:'answer'}]}]};
 const frame=await store.prepare('native-A','a'.repeat(64),input,'cancelled');await (store.fail as any)(frame,true,true);
 const loaded=new DirectSessions(dir);await loaded.load();
 await assert.rejects(loaded.prepare('native-A','a'.repeat(64),{...input,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'question',content:'changed answer'}]}]},'tool-only'),/uncertain/);
 const next=await loaded.prepare('native-A','a'.repeat(64),{...input,messages:[{role:'user',content:[...input.messages[0].content,{type:'text',text:'Fresh user feedback'}]}]},'merged');assert.equal(next.plan.reason,'client-interrupted-feedback');
 await loaded.fail(next,true);await assert.rejects(loaded.prepare('native-A','a'.repeat(64),{...request,messages:[...request.messages,{role:'user',content:'New instruction'}]},'timeout-followup'),/uncertain/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('parallel native agents have independent leases and continue only their own snapshots',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-agents-'));try{
 const store=new DirectSessions(dir);await store.load();
 const main=await store.prepare('native-A','a'.repeat(64),request,'main');
 const a=await (store.prepare as any)('native-A','a'.repeat(64),request,'a',false,'writer-a@team');
 const b=await (store.prepare as any)('native-A','a'.repeat(64),request,'b',false,'writer-b@team');
 assert.notEqual(main.key,a.key);assert.notEqual(a.key,b.key);
 await assert.rejects((store.prepare as any)('native-A','a'.repeat(64),request,'duplicate',false,'writer-a@team'),/busy/);
 await store.commit(main,'chat-main');await store.commit(a,'chat-a');await store.commit(b,'chat-b');
 const next=await (store.prepare as any)('native-A','a'.repeat(64),{...request,messages:[...request.messages,{role:'user',content:'Agent A follow-up'}]},'next',false,'writer-a@team');
 assert.equal(next.plan.kind,'delta');assert.equal(next.conversationId,'chat-a');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('agent compaction and explicit recovery do not reset the parent or a sibling',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-agent-compact-'));try{
 const store=new DirectSessions(dir);await store.load();
 const main=await store.prepare('native-A','a'.repeat(64),request,'main');await store.commit(main,'chat-main');
 const a=await (store.prepare as any)('native-A','a'.repeat(64),request,'a',false,'writer-a');await store.commit(a,'chat-a');
 const b=await (store.prepare as any)('native-A','a'.repeat(64),request,'b',false,'writer-b');await store.commit(b,'chat-b');
 await (store.compact as any)('native-A','a'.repeat(64),'PostCompact','auto','writer-a');
 const after=await (store.prepare as any)('native-A','a'.repeat(64),request,'after',false,'writer-a');assert.equal(after.epoch,2);await store.fail(after,true);
 await (store.reset as any)('native-A','writer-a');
 const parent=await store.prepare('native-A','a'.repeat(64),request,'parent');assert.equal(parent.conversationId,'chat-main');assert.equal(parent.epoch,1);
 const sibling=await (store.prepare as any)('native-A','a'.repeat(64),request,'sibling',false,'writer-b');assert.equal(sibling.conversationId,'chat-b');assert.equal(sibling.epoch,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('direct snapshots advance only on verified commit; idle restart resumes hashes without persisting source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-context-'));try{
 const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'job-A');
 assert.equal(first.epoch,1);assert.equal(first.plan.kind,'bootstrap');assert.equal(first.conversationId,undefined);
 await assert.rejects(store.prepare('native-A','a'.repeat(64),request,'duplicate'),/busy/);
 await store.commit(first,'conversation-A');const second=await store.prepare('native-A','a'.repeat(64),{...request,messages:[...request.messages,{role:'user',content:'Next'}]},'job-B');
 assert.equal(second.conversationId,'conversation-A');assert.equal(second.epoch,1);assert.equal(second.plan.kind,'delta');await store.commit(second,'conversation-A');
 const persisted=await readFile(join(dir,'direct-contexts.json'),'utf8');assert.ok(!persisted.includes('PRIVATE_SOURCE'));assert.ok(!persisted.includes('Next'));
 const loaded=new DirectSessions(dir);await loaded.load();const resumed=await loaded.prepare('native-A','a'.repeat(64),{...request,messages:[...request.messages,{role:'user',content:'Next'},{role:'user',content:'Resume'}]},'job-C');assert.equal(resumed.plan.kind,'delta');assert.equal(resumed.conversationId,'conversation-A');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('native compaction changes browser generation once while preserving native session identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-compact-'));try{
 const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'job-A');await store.commit(first,'conversation-A');
 await store.compact('native-A','a'.repeat(64),'PreCompact','manual');assert.equal(store.compacting('native-A'),true);
 await store.compact('native-A','a'.repeat(64),'PostCompact','manual');assert.equal(store.compacting('native-A'),false);
 const after=await store.prepare('native-A','a'.repeat(64),request,'job-B');assert.equal(after.epoch,2);assert.equal(after.sessionId,'native-A');assert.equal(after.plan.reason,'native-compaction');assert.equal(after.conversationId,undefined);await store.commit(after,'conversation-B');
 const next=await store.prepare('native-A','a'.repeat(64),{...request,messages:[...request.messages,{role:'user',content:'After compact'}]},'job-C');assert.equal(next.epoch,2);assert.equal(next.plan.kind,'delta');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('uncertain delivery/restart requires explicit reset; an unsent cancellation can keep the committed snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-uncertain-'));try{
 const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'job-A');await store.commit(first,'conversation-A');
 const unsent=await store.prepare('native-A','a'.repeat(64),request,'job-B');await store.fail(unsent,false);
 const active=await store.prepare('native-A','a'.repeat(64),request,'job-C');await store.fail(active,true);await assert.rejects(store.prepare('native-A','a'.repeat(64),request,'job-D'),/uncertain/);
 await store.reset('native-A');const reset=await store.prepare('native-A','a'.repeat(64),request,'job-E');assert.equal(reset.epoch,2);assert.equal(reset.plan.reason,'manual-resync');
 const loaded=new DirectSessions(dir);await loaded.load();await assert.rejects(loaded.prepare('native-A','a'.repeat(64),request,'job-F'),/uncertain/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('session workspace ownership and compact events cannot be reassigned',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-scope-'));try{
 const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'job-A');await store.commit(first,'conversation-A');
 await assert.rejects(store.prepare('native-A','b'.repeat(64),request,'job-B'),/workspace/);await assert.rejects(store.compact('native-A','b'.repeat(64),'PostCompact','auto'),/workspace/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('rejected reset leaves every model for an agent unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-reset-atomic-'));try{
 const store=new DirectSessions(dir);await store.load();const sonnet={...request,model:'copilot-sonnet-5.5'};
 const prior=await store.prepare('native-A','a'.repeat(64),sonnet,'sonnet',false,'writer-a');await store.commit(prior,'chat-sonnet');
 const active=await store.prepare('native-A','a'.repeat(64),request,'opus',false,'writer-a');
 const before=store.list();await assert.rejects(store.reset('native-A','writer-a'),/active native context/);assert.deepEqual(store.list(),before);
 const next=await store.prepare('native-A','a'.repeat(64),sonnet,'next',false,'writer-a');assert.equal(next.plan.kind,'delta');assert.equal(next.conversationId,'chat-sonnet');
 await store.fail(next,false);await store.fail(active,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
