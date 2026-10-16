import AjvModule from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import Ajv2019Module from 'ajv/dist/2019.js';
import { randomUUID } from 'node:crypto';
import {validateImage} from './images.js';
const Ajv = AjvModule.default;
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const ajv2020 = new Ajv2020Module.default({ strict: false, allErrors: true, validateFormats: false });
const ajv2019 = new Ajv2019Module.default({ strict: false, allErrors: true, validateFormats: false });
const compileSchema = (schema: ObjectValue) => (schema.$schema?.includes('2020-12') ? ajv2020 : schema.$schema?.includes('2019-09') ? ajv2019 : ajv).compile(schema);

export class BridgeError extends Error {
  constructor(message: string, public status = 400, public type = 'invalid_request_error') { super(message); }
}
export type ObjectValue = Record<string, any>;
export interface MessagesRequest extends ObjectValue { model: string; max_tokens: number; messages: ObjectValue[]; tools?: ObjectValue[]; stream?: boolean }
export interface Reply { content: ObjectValue[] }
export interface Message { id: string; type: 'message'; role: 'assistant'; model: string; content: ObjectValue[]; stop_reason: string; stop_sequence: null; usage: { input_tokens: number; output_tokens: number } }
export const MODEL_LABELS: Record<string, string> = { 'copilot-opus-5.5': 'Claude Opus 5.5', 'copilot-sonnet-5.5': 'Claude Sonnet 5.5' };
export function object(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }

function validateContent(content: unknown, ids: Set<string>, results: Set<string>, role: string): void {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) throw new BridgeError('Message content must be text or blocks');
  for (const block of content) {
    if (!object(block)) throw new BridgeError('Invalid content block');
    if (block.type === 'text' && typeof block.text === 'string') continue;
    if(block.type==='image'&&(role==='user'||role==='tool-result')){validateImage(block);continue;}
    if (block.type === 'tool_use' && role === 'assistant' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
      if (ids.has(block.id)) throw new BridgeError('Duplicate tool use identifier');
      ids.add(block.id); continue;
    }
    if (block.type === 'tool_result' && role === 'user' && typeof block.tool_use_id === 'string') {
      if (!ids.has(block.tool_use_id) || results.has(block.tool_use_id)) throw new BridgeError('Unmatched or duplicate tool result');
      results.add(block.tool_use_id); validateContent(block.content ?? '', ids, results, 'tool-result'); continue;
    }
    throw new BridgeError(`Unsupported content block: ${String(block.type)}. Text, native tool blocks and base64 images are supported; other media and signed reasoning are not.`);
  }
}
export function parseRequest(value: unknown): MessagesRequest {
  if (!object(value) || !MODEL_LABELS[value.model]) throw new BridgeError('Choose copilot-opus-5.5 or copilot-sonnet-5.5');
  if (!Number.isInteger(value.max_tokens) || value.max_tokens < 1 || !Array.isArray(value.messages) || value.messages.length === 0) throw new BridgeError('Invalid Messages request');
  if (value.stream !== undefined && typeof value.stream !== 'boolean') throw new BridgeError('stream must be boolean');
  if (value.system !== undefined) validateContent(value.system, new Set(), new Set(), 'system');
  const ids = new Set<string>(), results = new Set<string>();
  for (const message of value.messages) {
    if (!object(message) || !['user', 'assistant', 'system'].includes(message.role)) throw new BridgeError('Invalid message role');
    validateContent(message.content, ids, results, message.role);
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) throw new BridgeError('tools must be an array');
    const names = new Set<string>();
    for (const tool of value.tools) {
      if (!object(tool) || typeof tool.name !== 'string' || !object(tool.input_schema) || names.has(tool.name)) throw new BridgeError('Only uniquely named client tools with input_schema are supported');
      names.add(tool.name);
      try { compileSchema(tool.input_schema); } catch (error) { throw new BridgeError(`Unsupported JSON schema for ${tool.name}: ${error instanceof Error ? error.message : 'invalid schema'}`); }
    }
  }
  return value as MessagesRequest;
}
export const REPLY_CONTRACT='Return exactly ONE fenced json code block, with no prose outside it. The code block is required because ordinary Markdown paragraphs remove JSON escape characters in the chat renderer. Preserve valid JSON escaping for backslashes, double quotes, tabs and newlines. Use this shape:\n'
  +'```json\n{"content":[{"type":"text","text":"your answer"},{"type":"tool_use","name":"an available tool name","input":{}}]}\n```\n'
  +'Include tool_use only when requesting a currently available tool, with arguments satisfying its input_schema. When finished return text blocks only. Do not invent tool results.\n';
export function buildPrompt(request: MessagesRequest, limit = 180000): string {
  // No system instructions, schemas or prior tool results are silently removed.
  const prompt = 'Answer the following coding conversation in chat only. The client runs local tools and returns their results; do not edit the Excel workbook.\n'
    + 'The client instructions, complete available tool schemas, and conversation are included below. '+REPLY_CONTRACT
    + 'CLIENT REQUEST:\n' + JSON.stringify(request);
  if (prompt.length > limit) throw new BridgeError(`Request is ${prompt.length} characters; configured Copilot UI limit is ${limit}. Nothing was truncated.`, 413);
  return prompt;
}
export class ReplyFormatError extends BridgeError {
  constructor(){super('Copilot did not return the required JSON. Its response was not converted into fabricated tool calls.',502,'api_error');}
}
export function parseReply(text: string, request: MessagesRequest): Reply {
  const clean = text.trim().replace(/^Copilot said:\s*/, '').trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  if (clean.length > 500000) throw new BridgeError('Copilot response exceeds size limit', 502, 'api_error');
  let value: unknown;
  try { value = JSON.parse(clean); } catch { throw new ReplyFormatError(); }
  if (!object(value) || Object.keys(value).join(',') !== 'content' || !Array.isArray(value.content) || !value.content.length || value.content.length > 64) throw new BridgeError('Invalid Copilot response envelope', 502, 'api_error');
  const schemas = new Map((request.tools ?? []).map(t => [t.name, t.input_schema]));
  const content = value.content.map(block => {
    if (!object(block)) throw new BridgeError('Invalid response block', 502, 'api_error');
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length && Object.keys(block).sort().join(',') === 'text,type') return { type: 'text', text: block.text };
    if (block.type === 'tool_use' && typeof block.name === 'string' && object(block.input) && (Object.keys(block).sort().join(',') === 'input,name,type' || (Object.keys(block).sort().join(',') === 'id,input,name,type' && typeof block.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(block.id)))) {
      const schema = schemas.get(block.name);
      if (!schema || !compileSchema(schema)(block.input)) throw new BridgeError(`Unknown tool or invalid arguments: ${block.name}`, 502, 'api_error');
      if (request.tool_choice?.type === 'none' || (request.tool_choice?.type === 'tool' && request.tool_choice.name !== block.name)) throw new BridgeError('Reply violates tool_choice', 502, 'api_error');
      return { type: 'tool_use', name: block.name, input: block.input };
    }
    throw new BridgeError('Unsupported response block', 502, 'api_error');
  });
  if (['any', 'tool'].includes(request.tool_choice?.type) && !content.some(b => b.type === 'tool_use')) throw new BridgeError('Required tool call missing', 502, 'api_error');
  if (request.tool_choice?.disable_parallel_tool_use && content.filter(b => b.type === 'tool_use').length > 1) throw new BridgeError('Parallel tools disabled by client', 502, 'api_error');
  return { content };
}
export function toMessage(request: MessagesRequest, reply: Reply, id: string = randomUUID(),usage?:Message['usage']): Message {
  return { id: 'msg_' + id, type: 'message', role: 'assistant', model: request.model,
    content: reply.content.map((block, i) => block.type === 'tool_use' ? { ...block, id: `toolu_${id}_${i}` } : block),
    stop_reason: reply.content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    // Required API fields. Copilot UI exposes no measured token usage. Headers/doctor/CLI report this.
    usage: usage??{ input_tokens: 0, output_tokens: 0 } };
}
export function sseEvents(message: Message): { event: string; data: ObjectValue }[] {
  const events: { event: string; data: ObjectValue }[] = [{ event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null } } }];
  message.content.forEach((block, index) => {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } } });
    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } } });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}
