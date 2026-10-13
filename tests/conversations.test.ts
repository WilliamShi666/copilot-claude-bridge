import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
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
