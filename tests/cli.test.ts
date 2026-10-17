import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnvironment, sessionSettings } from '../packages/cli/index.js';
import {nativeModel,MODEL_LABELS,parseRequest} from '../packages/protocol/index.js';

test('GPT main models use explicit deployment IDs and session-local native selection',()=>{
 for(const [alias,id,label] of [['gpt61','copilot-gpt-6.1-sol','GPT-6.1 Sol'],['gpt6','copilot-gpt-6-sol','GPT-6 Sol']]){
  assert.equal(nativeModel(alias),id);assert.equal(nativeModel(id),id);assert.equal(MODEL_LABELS[id],label);
  const settings=sessionSettings('http://127.0.0.1:59175','synthetic-key',alias);
  assert.equal(settings.model,id);assert.equal(settings.env.ANTHROPIC_MODEL,id);assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,id);assert.ok(settings.availableModels.includes(id));
  assert.equal(parseRequest({model:id,max_tokens:100,messages:[{role:'user',content:'Hello'}]}).model,id);
 }
 for(const invalid of ['gpt-unknown','constructor','toString','__proto__'])assert.throws(()=>nativeModel(invalid));
});
test('only child environment changes; stale credentials/providers do not leak to bridge', () => {
  const input = { PATH: 'original', ANTHROPIC_API_KEY: 'user-original-secret', ANTHROPIC_BASE_URL: 'https://original', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'65', CUSTOM: 'keep' };
  const env = childEnvironment(input, 'http://127.0.0.1:59173', 'bridge-key', 'copilot-opus-5.5');
  assert.equal(input.ANTHROPIC_API_KEY, 'user-original-secret'); assert.equal(input.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'bridge-key'); assert.equal(env.CUSTOM, 'keep'); assert.equal(env.PATH, 'original');
  assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,undefined);assert.equal(input.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,'65');
});
test('native model mappings and explicit compact windows are session scoped and validated',()=>{
 const settings=sessionSettings('http://127.0.0.1:59175','local-key','copilot-sonnet-5.5','/tmp/fixture',600000);
 assert.ok(settings.availableModels.includes('claude-opus-5-5'));assert.ok(settings.availableModels.includes('claude-sonnet-5-5'));assert.ok(settings.availableModels.includes('copilot-sonnet-5.5'));assert.ok(!settings.availableModels.includes('claude-sonnet-5'));
 assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,'600000');
 assert.equal(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,'');
 assert.equal(settings.modelOverrides['claude-sonnet-5-5'],'copilot-sonnet-5.5');
 for(const window of [0,99999,1000001,3.5,NaN])assert.throws(()=>sessionSettings('http://127.0.0.1:59175','local-key','copilot-opus-5.5','/tmp/fixture',window),/100000.*1000000/);
});
test('session settings override existing provider env block without touching original file', () => {
  const settings = sessionSettings('http://127.0.0.1:59173', 'local-key', 'copilot-opus-5.5');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:59173');
  assert.equal(settings.env.ANTHROPIC_API_KEY, '');
  assert.equal(settings.env.CLAUDE_CODE_USE_BEDROCK, '0');
});
