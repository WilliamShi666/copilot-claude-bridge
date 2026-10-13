import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, buildPrompt, parseReply, toMessage, sseEvents } from '../packages/protocol/index.js';

const request = { model: 'copilot-opus-5.5', max_tokens: 4096, system: [{ type: 'text', text: 'Complete native instructions stay intact.' }], messages: [{ role: 'user', content: 'Find and fix the defect.' }], tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }, { name: 'Edit', input_schema: { type: 'object', properties: { old_string: { type: 'string' } }, required: ['old_string'] } }] };
test('optional upstream tool IDs are discarded and authoritative unique IDs are generated locally',()=>{
 const value=parseRequest(request),block={type:'tool_use',id:'toolu_upstream_duplicate',name:'Read',input:{file_path:'src.ts'}};
 const reply=parseReply(JSON.stringify({content:[block,block]}),value);
 assert.ok(reply.content.every(b=>!('id' in b)));
 const message=toMessage(value,reply,'native-request');assert.equal(new Set(message.content.map(b=>b.id)).size,2);
 assert.throws(()=>parseReply(JSON.stringify({content:[{...block,id:42}]}),value));
 assert.throws(()=>parseReply(JSON.stringify({content:[{...block,unknown:true}]}),value));
});
test('preserves complete system, schemas, metadata and tool results', () => {
  const value = parseRequest({ ...request, thinking: { type: 'adaptive' }, messages: [...request.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src.ts' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'actual contents' }] }] });
  const prompt = buildPrompt(value);
  assert.ok(prompt.includes('Complete native instructions stay intact.'));
  assert.ok(prompt.includes('actual contents'));
  assert.ok(prompt.includes('additionalProperties'));
  assert.ok(prompt.includes('adaptive'));
});
test('accepts multiple tools only when arguments match request schemas', () => {
  const value = parseRequest(request);
  const reply = parseReply('```json\n{"content":[{"type":"text","text":"Reading"},{"type":"tool_use","name":"Read","input":{"file_path":"src.ts"}},{"type":"tool_use","name":"Edit","input":{"old_string":"wrong"}}]}\n```', value);
  const msg = toMessage(value, reply, 'req1');
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(new Set(msg.content.filter(x => x.type === 'tool_use').map(x => x.id)).size, 2);
  assert.throws(() => parseReply('{"content":[{"type":"tool_use","name":"Read","input":{"file_path":1}}]}', value));
  assert.throws(() => parseReply('{"content":[{"type":"tool_use","name":"Unknown","input":{}}]}', value));
});
test('fails closed on text refusal, media, malformed JSON and unknown models', () => {
  assert.throws(() => parseReply('Sorry, I cannot answer', parseRequest(request)));
  assert.throws(() => parseRequest({ ...request, model: 'gpt-unknown' }));
  assert.throws(() => parseRequest({ ...request, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }] }));
  assert.throws(() => parseRequest({ ...request, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }] }));
});
test('SSE is ordered, tools use input_json_delta and complete message_delta', () => {
  const value = parseRequest(request);
  const msg = toMessage(value, parseReply('{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"x"}}]}', value), 'req');
  const events = sseEvents(msg);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events.at(-2)?.event, 'message_delta');
  assert.equal(events.at(-1)?.event, 'message_stop');
  assert.ok(events.some(x => (x.data.delta as any)?.type === 'input_json_delta'));
});
test('native draft 2020-12 schemas are supported without stripping metadata', () => {
  const value = parseRequest({ ...request, tools: [{ name: 'Agent', input_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }] });
  assert.ok(buildPrompt(value).includes('2020-12/schema'));
  assert.equal(parseReply('{"content":[{"type":"tool_use","name":"Agent","input":{"prompt":"inspect"}}]}', value).content[0].name, 'Agent');
});
