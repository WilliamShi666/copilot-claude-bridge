import test from 'node:test';
import assert from 'node:assert/strict';
import {SUMMARY_MODELS,isSummaryRequest,runSummaryChain,validateSummary} from '../packages/protocol/summary.js';
const reply=JSON.stringify({content:[{type:'text',text:'Keep the task, file state and next action.'}]});
test('only compaction requests select the summary policy, leaving main and title inference alone',()=>{
 assert.equal(isSummaryRequest('main',undefined,true),false);
 assert.equal(isSummaryRequest('auxiliary',undefined,true),false);
 assert.equal(isSummaryRequest('compaction',undefined,false),true);
 assert.equal(isSummaryRequest(undefined,'manual',false),true);
 assert.equal(isSummaryRequest(undefined,undefined,true),true);
});
test('summary defaults to GPT 6.1 Sol and falls back to GPT 6 Sol after operational or format errors',async()=>{
 for(const failures of [0,1]){
  const models:string[]=[],attempts:any[]=[];let recovered=0;
  const result=await runSummaryChain(async model=>{models.push(model);return models.length<=failures?'malformed':reply;},async()=>{recovered++;},new AbortController().signal,a=>attempts.push(a));
  assert.deepEqual(models,SUMMARY_MODELS.slice(0,failures+1));assert.equal(result.model,SUMMARY_MODELS[failures]);assert.equal(recovered,failures);assert.deepEqual(result.attempts,attempts);
 }
});
test('provider restriction and user drafts stop the chain without another model submission',async()=>{
 for(const error of ['The model returned no content because the response was blocked by content filtering.','I can\'t act as a relay or model backend for another tool\'s conversation.','A draft changed during summary fallback']){
  let calls=0,recoveries=0;
  await assert.rejects(runSummaryChain(async()=>{calls++;throw new Error(error);},async()=>{recoveries++;},new AbortController().signal));
  assert.equal(calls,1);assert.equal(recoveries,0);
 }
});
test('summary tools cannot reach the client and quoted failure logs do not trigger policy detection',()=>{
 assert.throws(()=>validateSummary('{"content":[{"type":"tool_use","name":"Bash","input":{}}]}'),/text only/);
 validateSummary(JSON.stringify({content:[{type:'text',text:'Previous log: response was blocked by content filtering; no tool ran.'}]}));
});
test('cancellation never advances to the fallback model',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(runSummaryChain(async()=>{calls++;controller.abort();throw new Error('timeout');},async()=>{},controller.signal));assert.equal(calls,1);
});
