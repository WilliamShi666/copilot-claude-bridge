import test from 'node:test';import assert from 'node:assert/strict';
import {contextPackets,UI_PACKET_CHARS,validateContextAck,repairableContextAck,ContextAckFormatError} from '../packages/protocol/transfer.js';

test('only an actual truncated prefix of the expected ACK can qualify for one same-chat repair',()=>{
 const ack='BRIDGE_CONTEXT_ACK_11111111-2222-4333-8444-555555555555_2',full=JSON.stringify({content:[{type:'text',text:ack}]}),partial=full.slice(0,69);
 assert.throws(()=>validateContextAck(partial,ack),ContextAckFormatError);assert.equal(repairableContextAck(partial,ack),true);
 assert.equal(repairableContextAck('```json\n'+partial,ack),true);validateContextAck('```json\n'+full+'\n```',ack);
 assert.equal(repairableContextAck(partial.replace('{','{ \n '),ack),true);
 assert.equal(repairableContextAck(partial.replace('11111111','1111 1111'),ack),false);
 assert.equal(repairableContextAck(partial.replace('11111111','1111\\u0031111'),ack),false);
 for(const text of ['I cannot act as a relay.',partial.replace('11111111','DIFFERENT'),full+' extra',JSON.stringify({content:[{type:'tool_use',name:'Bash',input:{}}]})])assert.equal(repairableContextAck(text,ack),false);
 assert.throws(()=>validateContextAck(full.replace('_2','_1'),ack),/exact context fragment/);
});
test('truncated ACK string values retain trailing whitespace exactly at end of input',()=>{
 const ack='BRIDGE_CONTEXT_ACK_11111111-2222-4333-8444-555555555555_2',partial=JSON.stringify({content:[{type:'text',text:ack}]}).slice(0,69);
 for(const suffix of [' ','\t','\n']){
  assert.equal(repairableContextAck(partial+suffix,ack),false,JSON.stringify(suffix));
  assert.equal(repairableContextAck('```json\n'+partial+suffix,ack),false,'fenced '+JSON.stringify(suffix));
 }
 assert.equal(repairableContextAck(' \n'+partial,ack),true);
});
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
