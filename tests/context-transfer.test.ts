import test from 'node:test';import assert from 'node:assert/strict';
import {contextPackets,UI_PACKET_CHARS} from '../packages/protocol/transfer.js';
test('large context transfer preserves exact source, escaping and Unicode within bounded UI packets',()=>{
 const prompt='BEGIN🦊'+JSON.stringify({source:'line\nquote"backslash\\汉🦊'.repeat(24000)})+'END';
 const packets=contextPackets(prompt,'native-job')!;assert.ok(packets.length>2);
 const data=packets.slice(0,-1).map((p,i)=>{assert.ok(p.prompt.length<=UI_PACKET_CHARS);const payload=JSON.parse(p.prompt.split('CONTEXT TRANSFER DATA:\n')[1].split('\nRequired response:')[0]);assert.equal(payload.index,i+1);assert.equal(payload.total,packets.length-1);assert.ok(p.ack);assert.ok(!/[\uD800-\uDBFF]$/.test(payload.data));return payload.data;});
 assert.equal(data.join(''),prompt);assert.equal(packets.at(-1)!.ack,undefined);
});
test('ordinary requests retain their single-message flow and invalid plans fail closed',()=>{
 assert.equal(contextPackets('small','job'),undefined);
 assert.throws(()=>contextPackets('a'.repeat(5000),'bad\nid',2000),/identity/);
 assert.throws(()=>contextPackets('a'.repeat(100000),'job',2000),/too many/);
});
