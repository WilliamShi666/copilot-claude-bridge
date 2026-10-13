import test from 'node:test';import assert from 'node:assert/strict';
import {compactionPrompt,summaryPackets,assertCompactionSummary,COMPACTION_TASK} from '../packages/gateway/summary-prompt.js';
import {contextPackets} from '../packages/protocol/transfer.js';
test('summary instruction remains explicit after full segmented source replay without changing the source',()=>{
 const source='EXACT_NATIVE_SOURCE\n'.repeat(40000),prompt=compactionPrompt(source,2000000),packets=contextPackets(prompt,'summary-task')!,final=summaryPackets(packets)!;
 assert.ok(prompt.endsWith(source));assert.ok(final.at(-1)!.prompt.startsWith(COMPACTION_TASK));assert.deepEqual(final.slice(0,-1),packets.slice(0,-1));assert.ok(final.every(p=>p.prompt.length<=350000));assert.throws(()=>compactionPrompt(source,180000),/not truncated/);
});
test('an answer to a historical memory probe is not accepted as a compaction summary',()=>{
 assert.throws(()=>assertCompactionSummary(JSON.stringify({content:[{type:'text',text:'C01R089=43c92889a0c4bb02a2cd42df\nC02R207=bd46e601e1076de846ec704e'}]})),/historical answers were not accepted/);
 assertCompactionSummary(JSON.stringify({content:[{type:'text',text:'<analysis>Checked actual history.</analysis><summary>User requested a test file. Write and Read succeeded. Keep the path and current state.</summary>'}]}));
});
