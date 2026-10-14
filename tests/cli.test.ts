import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnvironment, sessionSettings } from '../packages/cli/index.js';
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
