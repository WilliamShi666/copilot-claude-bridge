import test from 'node:test';import assert from 'node:assert/strict';import {notifyCompact,workspaceFingerprint} from '../packages/cli/compact-hook.js';import {sessionSettings} from '../packages/cli/index.js';
test('compact hook sends authenticated event metadata, never the summary/transcript or credential in the body',async()=>{
 let packet:any,headers:any;
 const send=(async(url:any,options:any)=>{assert.equal(url,'http://127.0.0.1:59173/bridge/context/compact');packet=JSON.parse(options.body);headers=options.headers;return new Response('{}',{status:200});}) as typeof fetch;
 const env={ANTHROPIC_BASE_URL:'http://127.0.0.1:59173',ANTHROPIC_AUTH_TOKEN:'private-local-key'};
 await notifyCompact({hook_event_name:'PostCompact',trigger:'manual',session_id:'native-A',cwd:'D:/fixture',compact_summary:'PRIVATE_SUMMARY',transcript_path:'PRIVATE_TRANSCRIPT'},env,send);
 assert.equal(packet.session_id,'native-A');assert.equal(packet.workspaceKey,workspaceFingerprint('D:/fixture'));assert.equal(headers['x-api-key'],'private-local-key');
 assert.ok(!JSON.stringify(packet).includes('PRIVATE_'));assert.ok(!JSON.stringify(packet).includes('private-local-key'));
 await assert.rejects(notifyCompact({hook_event_name:'PostCompact',trigger:'manual',session_id:'A',cwd:'D:/fixture'},{...env,ANTHROPIC_BASE_URL:'https://external.example/'},send),/localhost/);
});
test('direct launch registers session-only native compact hooks and budget settings without overwriting normal files',()=>{
 const settings=(sessionSettings as any)('http://127.0.0.1:59173','local-key','copilot-opus-5.5','D:/fixture');
 assert.ok(settings.hooks?.PreCompact?.length);assert.ok(settings.hooks?.PostCompact?.length);
 assert.ok(settings.env.ANTHROPIC_CUSTOM_HEADERS.includes(workspaceFingerprint('D:/fixture')));assert.equal(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,'');
 assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,'533000');
 assert.deepEqual(settings.modelOverrides,{'claude-opus-5-5':'copilot-opus-5.5','claude-sonnet-5-5':'copilot-sonnet-5.5'});
 assert.ok(!settings.hooks.PreCompact[0].hooks[0].command.includes('local-key'));
});

test('an agent compaction hook forwards only the native agent identity alongside session metadata',async()=>{
 let packet:any;const send=(async(_url:any,options:any)=>{packet=JSON.parse(options.body);return new Response('{}');}) as typeof fetch;
 await notifyCompact({hook_event_name:'PostCompact',trigger:'auto',session_id:'native-A',agent_id:'writer@team',cwd:'D:/fixture',compact_summary:'PRIVATE_SUMMARY'},{ANTHROPIC_BASE_URL:'http://127.0.0.1:59173',ANTHROPIC_AUTH_TOKEN:'local-key'},send);
 assert.equal(packet.agent_id,'writer@team');assert.ok(!JSON.stringify(packet).includes('PRIVATE_SUMMARY'));
});
