import test from 'node:test';
import assert from 'node:assert/strict';
import {planContext,estimateTokens,renderContextPrompt} from '../packages/protocol/context.js';
const initial={model:'copilot-opus-5.5',max_tokens:1024,system:[{type:'text',text:'Native system rules'}],tools:[{name:'Read',input_schema:{type:'object'}}],messages:[{role:'user',content:'Read a file'}]};
test('bootstrap preserves the full current request; later rounds contain only appended native messages',()=>{
 const first=planContext(initial);assert.equal(first.kind,'bootstrap');assert.deepEqual(first.messages,initial.messages);
 const appended=[{role:'assistant',content:[{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'file.txt'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'REAL_FILE_CONTENT'}]}];
 const next=planContext({...initial,messages:[...initial.messages,...appended]},first.snapshot);
 assert.equal(next.kind,'delta');assert.deepEqual(next.messages,appended);assert.deepEqual(next.updates,{});
 assert.equal((next.messages[1].content[0] as any).tool_use_id,'tool-1');
});
test('changed tools and effort are delivered without replaying unchanged instructions/history',()=>{
 const first=planContext(initial);
 const tools=[...initial.tools,{name:'Edit',input_schema:{type:'object'}}];
 const next=planContext({...initial,tools,output_config:{effort:'high'},messages:[...initial.messages,{role:'user',content:'Now edit'}]},first.snapshot);
 assert.equal(next.kind,'delta');assert.deepEqual(next.updates,{tools,output_config:{effort:'high'}});assert.equal(next.messages.length,1);
});
test('cache-marker movement is nonsemantic; rewritten or shortened history starts a new browser context',()=>{
 const cached={...initial,messages:[{role:'user',content:[{type:'text',text:'A',cache_control:{type:'ephemeral'}}]}]};
 const first=planContext(cached);
 const moved=planContext({...initial,messages:[{role:'user',content:[{type:'text',text:'A'}]},{role:'assistant',content:[{type:'text',text:'B',cache_control:{type:'ephemeral'}}]}]},first.snapshot);
 assert.equal(moved.kind,'delta');assert.equal(moved.messages.length,1);
 const compacted=planContext({...initial,messages:[{role:'user',content:'COMPACTED_SUMMARY'}]},moved.snapshot);
 assert.equal(compacted.kind,'bootstrap');assert.equal(compacted.reason,'history-rewrite');
 const cleared=planContext({...initial,messages:[]},moved.snapshot);assert.equal(cleared.kind,'bootstrap');
});
test('native string and single text-block representations are the same message, without hiding actual edits',()=>{
 const first=planContext({...initial,messages:[{role:'user',content:[{type:'text',text:'Read a file',cache_control:{type:'ephemeral'}}]}]});
 const next=planContext({...initial,messages:[...initial.messages,{role:'assistant',content:'READY'},{role:'user',content:'Continue'}]},first.snapshot);
 assert.equal(next.kind,'delta');assert.equal(next.messages.length,2);
 const rewritten=planContext({...initial,messages:[{role:'user',content:'Actually changed'}]},first.snapshot);
 assert.equal(rewritten.reason,'history-rewrite');
});
test('an authenticated compact/reset signal rebases even if the next history has a matching prefix',()=>{
 const first=planContext(initial);const next=planContext(initial,first.snapshot,'native-compaction');
 assert.equal(next.kind,'bootstrap');assert.equal(next.reason,'native-compaction');assert.deepEqual(next.messages,initial.messages);
});
test('local token estimates increase with context and account for non-ASCII; no measured usage is asserted',()=>{
 assert.ok(estimateTokens(initial)>0);assert.ok(estimateTokens('X'.repeat(6000))>estimateTokens('X'.repeat(60)));
 assert.ok(estimateTokens('汉'.repeat(600))>estimateTokens('X'.repeat(600)));
});

test('omitted per-request controls are explicitly removed without replacing the active conversation',()=>{
 const first=planContext({...initial,thinking:{type:'adaptive'},context_management:{edits:[]}});
 const request={...initial,messages:[...initial.messages,{role:'assistant',content:'Read requested'},{role:'user',content:'Tool result'}]};
 const next=planContext(request,first.snapshot);
 assert.equal(next.kind,'delta');assert.deepEqual(next.removedFields,['thinking','context_management']);
 const prompt=renderContextPrompt(request,next,1);assert.ok(prompt.includes('"removedFields":["thinking","context_management"]'));
 assert.equal(next.messages.length,2);assert.ok(!prompt.includes('Native system rules'));
});

test('omitted tools clear old tool availability while changed system instructions still rebase',()=>{
 const first=planContext(initial);const {tools,...withoutTools}=initial;
 const next=planContext({...withoutTools,messages:[...initial.messages,{role:'user',content:'Answer without tools'}]},first.snapshot);
 assert.equal(next.kind,'delta');assert.deepEqual(next.removedFields,['tools']);
 assert.match(renderContextPrompt(withoutTools,next,1),/tools.*no client tools/i);
 const {system,...withoutSystem}=initial;
 assert.equal(planContext(withoutSystem,first.snapshot).kind,'bootstrap');
});
