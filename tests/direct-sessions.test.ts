import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DirectSessions} from '../packages/gateway/direct-sessions.js';
const request={model:'copilot-opus-5.5',max_tokens:1000,tools:[],messages:[{role:'user',content:'PRIVATE_SOURCE_SHOULD_NOT_BE_PERSISTED'}]};
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
