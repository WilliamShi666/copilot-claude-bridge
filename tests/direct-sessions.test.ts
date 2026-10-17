import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DirectSessions} from '../packages/gateway/direct-sessions.js';
import type {CancelReceipt} from '../packages/protocol/cancellation.js';
const request={model:'copilot-opus-5.5',max_tokens:1000,tools:[],messages:[{role:'user',content:'PRIVATE_SOURCE_SHOULD_NOT_BE_PERSISTED'}]};
const cancellation=(frame:any,conversationId:string,overrides:Partial<CancelReceipt>={}):CancelReceipt=>({version:1,jobId:frame.jobId,nonce:'nonce',conversationId,lane:'main',outcome:'settled',inputComplete:true,replyState:'partial',cursor:'a'.repeat(64),pageInstance:'page-1',...overrides});

test('native withdrawn text prompt accepts replacement feedback after restart for settled and unverified cancellations',async()=>{
 for(const outcome of ['settled','unverified'] as const){const dir=await mkdtemp(join(tmpdir(),'direct-withdrawn-'));try{
  let store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'first');await store.commit(first,'original');
  const prefix=[...request.messages,{role:'assistant',content:'Committed answer'}],interrupted={...request,messages:[...prefix,{role:'user',content:'Explain at length'}]};
  const frame=await store.prepare('native-A','a'.repeat(64),interrupted,'cancelled',false,undefined,true);await store.beginCancellation(frame);await store.settleCancellation(frame,cancellation(frame,'original',{outcome}));
  store=new DirectSessions(dir);await store.load();
  await assert.rejects(store.prepare('native-A','a'.repeat(64),interrupted,'same'),/uncertain/);
  const feedback={...request,messages:[...prefix,{role:'user',content:'Instead read the existing file'},{role:'system',content:'Updated runtime details'}]};
  const resumed=await store.prepare('native-A','a'.repeat(64),feedback,'new-feedback',false,undefined,true);
  assert.equal(resumed.plan.kind,outcome==='settled'?'resume':'bootstrap');assert.equal(resumed.isolatedRecovery,outcome==='unverified');assert.equal(resumed.epoch,outcome==='settled'?1:2);
  if(outcome==='settled'){assert.equal(resumed.conversationId,'original');assert.equal(resumed.plan.retainedMessageCount,prefix.length);}
  await store.commit(resumed,outcome==='settled'?'original':'recovered');
 }finally{await rm(dir,{recursive:true,force:true});}}
});

test('proven unsent rebuild failures do not consume a lifetime feedback retry and remain isolated after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-unsent-rebuild-'));try{
  let store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'first');await store.commit(first,'original');
  const input={...request,messages:[...request.messages,{role:'user',content:'Continue actual work'}]},next=await store.prepare('native-A','a'.repeat(64),input,'delta',false,undefined,true);
  const recovery=await store.fallback(next,input,'recovery');await store.markRebuild(recovery);await store.fail(recovery,false,false,'Open Copilot in the bridge-owned auxiliary workbook tab');
  assert.equal(store.list()[0].state,'ready');store=new DirectSessions(dir);await store.load();
  for(let i=0;i<3;i++){const retry=await store.prepare('native-A','a'.repeat(64),{...input,max_tokens:100+i},'retry-'+i,false,undefined,true);assert.equal(retry.isolatedRecovery,true);assert.equal(retry.epoch,2);assert.equal(retry.plan.kind,'bootstrap');await store.markRebuild(retry);await store.fail(retry,false,false,'Pane still preparing');}
  const final=await store.prepare('native-A','a'.repeat(64),input,'final',false,undefined,true);await store.markRebuild(final);await store.commit(final,'recovered');assert.equal(store.list()[0].state,'ready');assert.equal(store.list()[0].epoch,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unknown rebuild delivery retains its actual failure instead of an exhausted-attempt error',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-unknown-rebuild-'));try{
  const store=new DirectSessions(dir);await store.load();const frame=await store.prepare('native-A','a'.repeat(64),request,'first',false,undefined,true),recovery=await store.fallback(frame,request,'recovery');await store.markRebuild(recovery);await store.fail(recovery,true,false,'Connection dropped after possible submission');
  await assert.rejects(store.prepare('native-A','a'.repeat(64),{...request,max_tokens:32},'retry',false,undefined,true),/uncertain[\s\S]*Connection dropped after possible submission/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a correlated not-sent cancellation releases an isolated rebuild attempt without losing its committed history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-cancel-unsent-rebuild-'));try{
  const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'first');await store.commit(first,'original');const input={...request,messages:[...request.messages,{role:'user',content:'Continue'}]},delta=await store.prepare('native-A','a'.repeat(64),input,'delta',false,undefined,true),recovery=await store.fallback(delta,input,'recovery');await store.markRebuild(recovery);await store.beginCancellation(recovery);await store.settleCancellation(recovery,cancellation(recovery,'unused',{outcome:'not_sent',inputComplete:false}));
  assert.equal(store.list()[0].epoch,1);const retry=await store.prepare('native-A','a'.repeat(64),input,'retry',false,undefined,true);assert.equal(retry.isolatedRecovery,true);assert.equal(retry.plan.kind,'bootstrap');assert.equal(retry.epoch,2);await store.fail(retry,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('explicit GPT selection isolates refused Claude history and model-scoped reset preserves other model leases',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-gpt-selection-'));try{
  const store=new DirectSessions(dir);await store.load();
  const refused=await store.prepare('multi-model','a'.repeat(64),request,'opus-refused');await store.terminalFailure(refused,'Copilot refused external-client relay use');
  const sonnet=await store.prepare('multi-model','a'.repeat(64),{...request,model:'copilot-sonnet-5.5'},'sonnet-incomplete');await store.fail(sonnet,true,false,'Copilot context transfer acknowledgment is malformed');
  const gpt=await store.prepare('multi-model','a'.repeat(64),{...request,model:'copilot-gpt-6.1-sol'},'gpt-start');assert.equal(gpt.plan.kind,'bootstrap');assert.equal(gpt.epoch,1);
  await store.reset('multi-model',undefined,'copilot-sonnet-5.5');
  await assert.rejects(store.prepare('multi-model','a'.repeat(64),request,'opus-again'),/refused external-client/);
  await assert.rejects(store.prepare('multi-model','a'.repeat(64),{...request,model:'copilot-gpt-6.1-sol'},'gpt-overlap'),/busy/);
  await store.commit(gpt,'gpt-chat');
  const resumed=await store.prepare('multi-model','a'.repeat(64),{...request,model:'copilot-gpt-6.1-sol',messages:[...request.messages,{role:'user',content:'Continue after actual local tools'}]},'gpt-next');assert.equal(resumed.plan.kind,'delta');assert.equal(resumed.conversationId,'gpt-chat');assert.equal(resumed.epoch,1);
  assert.equal(store.list().find(r=>r.model==='copilot-sonnet-5.5')!.state,'ready');
  await assert.rejects(store.reset('multi-model',undefined,'unknown'),/Invalid reset model/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('an incomplete bootstrap never borrows the previous chat history to resume a new chat',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-partial-bootstrap-'));try{
  const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'first');await store.commit(first,'chat-one');
  const compacted={...request,messages:[{role:'user',content:'Actual new compacted history'}]};const frame=await store.prepare('native-A','a'.repeat(64),compacted,'compact',true,undefined,true);assert.equal(frame.plan.kind,'bootstrap');await store.beginCancellation(frame);await store.settleCancellation(frame,cancellation(frame,'chat-two',{inputComplete:false}));
  const feedback={...compacted,messages:[...compacted.messages,{role:'user',content:'Continue'}]},next=await store.prepare('native-A','a'.repeat(64),feedback,'recovery',false,undefined,true);assert.equal(next.plan.kind,'bootstrap');assert.equal(next.isolatedRecovery,true);assert.equal(next.conversationId,undefined);assert.equal(next.epoch,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('not_sent restores committed context; three confirmed interruptions keep one chat and epoch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'direct-three-cancels-'));try{
  const store=new DirectSessions(dir);await store.load();const first=await store.prepare('native-A','a'.repeat(64),request,'first');await store.commit(first,'chat-one');
  const unsent=await store.prepare('native-A','a'.repeat(64),request,'unsent',false,undefined,true);await store.beginCancellation(unsent);await store.settleCancellation(unsent,cancellation(unsent,'chat-one',{outcome:'not_sent',inputComplete:false}));
  let input={...request};for(let i=0;i<3;i++){const cancelled=await store.prepare('native-A','a'.repeat(64),input,'cancel-'+i,false,undefined,true);await store.beginCancellation(cancelled);await store.settleCancellation(cancelled,cancellation(cancelled,'chat-one'));input={...input,messages:[...input.messages,{role:'user',content:'Continue '+i}]};const resumed=await store.prepare('native-A','a'.repeat(64),input,'resume-'+i,false,undefined,true);assert.equal(resumed.conversationId,'chat-one');assert.equal(resumed.epoch,1);assert.equal(resumed.plan.kind,'resume');await store.commit(resumed,'chat-one');}
 }finally{await rm(dir,{recursive:true,force:true});}
});

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


test('uncertain SDK retries retain the original operational failure across restart',async()=>{const dir=await mkdtemp(join(tmpdir(),'direct-delivery-cause-'));try{const store=new DirectSessions(dir);await store.load();const frame=await store.prepare('native-A','a'.repeat(64),request,'image-submit');await store.fail(frame,true,false,'Image submission acknowledgement timed out');const loaded=new DirectSessions(dir);await loaded.load();for(const max_tokens of [1000,32000])await assert.rejects(loaded.prepare('native-A','a'.repeat(64),{...request,max_tokens},'retry'),/uncertain[\s\S]*Last failure: Image submission acknowledgement timed out/);await loaded.reset('native-A');const next=await loaded.prepare('native-A','a'.repeat(64),request,'reset');await loaded.commit(next,'new-chat');const saved=await readFile(join(dir,'direct-contexts.json'),'utf8');assert.ok(!saved.includes('acknowledgement timed out'));}finally{await rm(dir,{recursive:true,force:true});}});


test('native context registry has no lifetime ceiling and old sessions continue after restart',async()=>{const dir=await mkdtemp(join(tmpdir(),'direct-lifetime-'));try{const store=new DirectSessions(dir);await store.load();for(let i=0;i<150;i++){const frame=await store.prepare('native-'+i,'a'.repeat(64),request,'job-'+i);await store.commit(frame,'chat-'+i);}assert.equal(store.list().length,150);const loaded=new DirectSessions(dir);await loaded.load();assert.equal(loaded.list().length,150);const next=await loaded.prepare('native-0','a'.repeat(64),{...request,messages:[...request.messages,{role:'user',content:'Continue original work'}]},'next');assert.equal(next.conversationId,'chat-0');assert.equal(next.epoch,1);assert.equal(next.plan.kind,'delta');await loaded.commit(next,'chat-0');assert.equal(loaded.list().length,150);}finally{await rm(dir,{recursive:true,force:true});}});

test('compaction registry has no lifetime ceiling and keeps running compactions across restart',async()=>{const dir=await mkdtemp(join(tmpdir(),'compaction-lifetime-'));try{const store=new DirectSessions(dir);await store.load();for(let i=0;i<150;i++)await store.compact('compact-'+i,'a'.repeat(64),'PostCompact','auto');await store.compact('compact-0','a'.repeat(64),'PreCompact','manual');const loaded=new DirectSessions(dir);await loaded.load();assert.equal(loaded.compacting('compact-0'),true);await loaded.compact('compact-150','a'.repeat(64),'PostCompact','auto');const saved=JSON.parse(await readFile(join(dir,'direct-contexts.json'),'utf8'));assert.equal(saved.compactions.length,151);assert.equal(saved.compactions.find((c:any)=>c.sessionId==='compact-0').phase,'running');}finally{await rm(dir,{recursive:true,force:true});}});

test('large native registries retain terminal refusals and compaction state instead of dropping history',async()=>{const dir=await mkdtemp(join(tmpdir(),'direct-large-load-'));try{const seed=new DirectSessions(dir);await seed.load();const frame=await seed.prepare('native-seed','a'.repeat(64),request,'seed');await seed.commit(frame,'seed-chat');await seed.flush();const template=JSON.parse(await readFile(join(dir,'direct-contexts.json'),'utf8')).records[0];const records=Array.from({length:1200},(_,i)=>({...template,key:createHash('sha256').update('native-'+i+'\0'+request.model).digest('hex'),sessionId:'native-'+i,conversationId:'chat-'+i,...(i===1199?{state:'uncertain',failure:{identity:'b'.repeat(64),code:'provider_refusal',message:'Copilot blocked the response by content filtering'}}:{})}));const compactions=Array.from({length:1200},(_,i)=>({sessionId:'compact-'+i,workspaceKey:'a'.repeat(64),phase:i===1199?'running':'ready',sequence:1,trigger:'auto'}));await writeFile(join(dir,'direct-contexts.json'),JSON.stringify({records,compactions}));const loaded=new DirectSessions(dir);await loaded.load();assert.equal(loaded.list().length,1200);assert.equal(loaded.compacting('compact-1199'),true);await assert.rejects(loaded.prepare('native-1199','a'.repeat(64),request,'retry'),/content filtering/);const added=await loaded.prepare('native-new','a'.repeat(64),request,'new');await loaded.commit(added,'new-chat');await loaded.compact('compact-new','a'.repeat(64),'PostCompact','auto');const saved=JSON.parse(await readFile(join(dir,'direct-contexts.json'),'utf8'));assert.equal(saved.records.length,1201);assert.equal(saved.compactions.length,1201);assert.ok(saved.records.some((r:any)=>r.sessionId==='native-1199'&&r.failure?.message==='Copilot blocked the response by content filtering'));assert.ok(!JSON.stringify(saved).includes('PRIVATE_SOURCE_SHOULD_NOT_BE_PERSISTED'));}finally{await rm(dir,{recursive:true,force:true});}});
