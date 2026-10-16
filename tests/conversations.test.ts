import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../packages/gateway/conversations.js';
test('conversation leases retain identity, bound workspace/model, and survive restart without replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m365-conversations-'));
 try {
  const store=new ConversationStore(dir);await store.load();const workspaceKey='a'.repeat(64),model='copilot-opus-5.5';
  const first=await store.reserve({mode:'new',workspaceKey},model,'one');
  await assert.rejects(store.reserve({mode:'continue',id:first.id,workspaceKey},model,'two'),/busy/);
  await store.complete(first,{id:first.id,title:first.title,cursor:'1'.repeat(64),resumability:'active-chat-only'},'one');
  await assert.rejects(store.reserve({mode:'continue',id:first.id,workspaceKey:'b'.repeat(64)},model,'two'),/workspace/);
  await assert.rejects(store.reserve({mode:'continue',id:first.id,workspaceKey},'copilot-sonnet-5.5','two'),/model/);
  const resumed=new ConversationStore(dir);await resumed.load();
  const continuation=await resumed.reserve({mode:'continue',id:first.id,workspaceKey},model,'two');
  assert.equal(continuation.id,first.id);assert.equal(continuation.expectedCursor,'1'.repeat(64));
  await assert.rejects(resumed.complete(continuation,{id:first.id,title:'wrong',cursor:'2'.repeat(64),resumability:'active-chat-only'},'two'),/did not verify/);
  await resumed.flush();const interrupted=new ConversationStore(dir);await interrupted.load();
  await assert.rejects(interrupted.reserve({mode:'continue',id:first.id,workspaceKey},model,'three'),/uncertain/);
  assert.equal(interrupted.list(workspaceKey)[0].state,'uncertain');assert.deepEqual(interrupted.list('b'.repeat(64)),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('conversation registry has no lifetime ceiling and retains earlier records across restart',async()=>{const dir=await mkdtemp(join(tmpdir(),'conversation-lifetime-'));try{const store=new ConversationStore(dir);await store.load();const workspaceKey='a'.repeat(64),model='copilot-opus-5.5';let last:any;for(let i=0;i<150;i++){last=await store.reserve({mode:'new',workspaceKey},model,'job-'+i);await store.complete(last,{id:last.id,title:last.title,cursor:'a'.repeat(64),resumability:'active-chat-only'},'job-'+i);}assert.equal(store.list(workspaceKey).length,150);const prior=JSON.parse(await readFile(join(dir,'conversations.json'),'utf8'));const loaded=new ConversationStore(dir);await loaded.load();assert.equal(loaded.list(workspaceKey).length,150);const continued=await loaded.reserve({mode:'continue',id:last.id,workspaceKey},model,'continue');assert.equal(continued.id,last.id);assert.equal(continued.expectedCursor,'a'.repeat(64));await assert.rejects(loaded.reserve({mode:'continue',id:last.id,workspaceKey},model,'duplicate'),/busy/);await loaded.flush();const after=JSON.parse(await readFile(join(dir,'conversations.json'),'utf8'));assert.deepEqual(after.map((r:any)=>r.id),prior.map((r:any)=>r.id));}finally{await rm(dir,{recursive:true,force:true});}});

test('large conversation registries load every record while preserving ready and uncertain identities',async()=>{const dir=await mkdtemp(join(tmpdir(),'conversation-large-load-'));try{const workspaceKey='a'.repeat(64),records=Array.from({length:1200},(_,i)=>({id:'00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'),title:'Retained '+i,workspaceKey,model:'copilot-opus-5.5',lane:'main',state:i===1199?'uncertain':i===1198?'ready':'inactive',cursor:'a'.repeat(64),updated:new Date(1700000000000+i).toISOString()}));await writeFile(join(dir,'conversations.json'),JSON.stringify(records));const store=new ConversationStore(dir);await store.load();assert.equal(store.list(workspaceKey).length,1200);await assert.rejects(store.reserve({mode:'continue',id:records[1199].id,workspaceKey},'copilot-opus-5.5','uncertain'),/uncertain/);const next=await store.reserve({mode:'new',workspaceKey},'copilot-opus-5.5','next');assert.equal(store.list(workspaceKey).length,1201);assert.ok(store.list(workspaceKey).some(r=>r.conversationId===records[1198].id&&r.state==='ready'));await store.cancelBeforeDispatch(next.id,'next');const loaded=new ConversationStore(dir);await loaded.load();assert.equal(loaded.list(workspaceKey).length,1201);assert.ok(loaded.list(workspaceKey).some(r=>r.conversationId===records[1199].id&&r.state==='uncertain'));}finally{await rm(dir,{recursive:true,force:true});}});
