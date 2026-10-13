import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startGateway } from '../packages/gateway/index.js';
const request = { model: 'copilot-opus-5.5', max_tokens: 1024, messages: [{ role: 'user', content: 'Hi' }] };
test('auth, extension pairing, real transport reply, SSE and duplicate safety', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-bridge-test-'));
  const g = await startGateway({ stateDir: dir, port: 0, timeoutMs: 5000 });
  let ws: WebSocket | undefined;
  try {
    assert.equal((await fetch(g.url + '/bridge/status')).status, 401);
    assert.equal((await fetch(g.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': g.clientKey }, body: JSON.stringify(request) })).status, 503);
    const origin = 'chrome-extension://' + 'a'.repeat(32);
    assert.equal((await fetch(g.url + '/bridge/pair', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: g.pairCode }) })).status, 403);
    const pair = await fetch(g.url + '/bridge/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: g.pairCode }) });
    const { token } = await pair.json() as { token: string };
    ws = new WebSocket(g.url.replace('http:', 'ws:') + '/bridge/socket', { origin });
    await new Promise<void>(resolve => ws!.once('open', resolve));
    ws.on('message', data => {
      const value = JSON.parse(String(data));
      if (value.type === 'job') {
        ws!.send(JSON.stringify({ type: 'result', id: value.id, text: value.prompt.includes('ADVISOR_TEST') ? 'Plain advice: inspect the actual source before editing.' : '{"content":[{"type":"text","text":"real test transport"}]}' }));
        // Duplicate delivery must not affect a later job or create a second inference.
        ws!.send(JSON.stringify({ type: 'result', id: value.id, text: '{"content":[{"type":"text","text":"duplicate"}]}' }));
        ws!.send(JSON.stringify({ type: 'ready', ready: true }));
      }
    });
    ws.send(JSON.stringify({ type: 'hello', token, workerId: 'test-worker', ready: true }));
    await new Promise<void>(resolve => ws!.once('message', () => resolve()));
    const response = await fetch(g.url + '/v1/messages?beta=true', { method: 'POST', headers: { 'x-api-key': g.clientKey }, body: JSON.stringify({ ...request, stream: true }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-bridge-usage'), 'unavailable');
    const body = await response.text();
    assert.ok(body.includes('real test transport')); assert.ok(!body.includes('duplicate'));
    assert.ok(body.includes('event: message_stop'));
    const status = await (await fetch(g.url + '/bridge/status', { headers: { 'x-api-key': g.clientKey } })).json() as any;
    assert.equal(status.completed, 1);
    const advisory = await fetch(g.url + '/bridge/advice', { method: 'POST', headers: { 'x-api-key': g.clientKey }, body: JSON.stringify({ model: 'copilot-opus-5.5', prompt: 'ADVISOR_TEST: review the supplied source' }) });
    assert.equal(advisory.status, 200); const advice = await advisory.json() as any;
    assert.equal(advice.advice, 'Plain advice: inspect the actual source before editing.'); assert.equal(advice.usage, 'unavailable');
  } finally { ws?.terminate(); await g.close(); await rm(dir, { recursive: true, force: true }); }
});
test('disconnect/cancellation do not dispatch pending request a second time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-bridge-test-'));
  const g = await startGateway({ stateDir: dir, port: 0, timeoutMs: 1000 });
  const origin = 'chrome-extension://' + 'b'.repeat(32);
  let ws: WebSocket | undefined;
  try {
    const { token } = await (await fetch(g.url + '/bridge/pair', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ code: g.pairCode }) })).json() as any;
    ws = new WebSocket(g.url.replace('http:', 'ws:') + '/bridge/socket', { origin });
    await new Promise<void>(r => ws!.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', token, workerId: 'test', ready: true }));
    await new Promise<void>(r => ws!.once('message', () => r()));
    const controller = new AbortController();
    const future = fetch(g.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': g.clientKey }, body: JSON.stringify(request), signal: controller.signal }).catch(() => undefined);
    const job = await new Promise<any>(resolve => ws!.once('message', d => resolve(JSON.parse(String(d)))));
    assert.equal(job.type, 'job');
    controller.abort(); await future;
    const cancel = await new Promise<any>(resolve => ws!.once('message', d => resolve(JSON.parse(String(d)))));
    assert.equal(cancel.type, 'cancel');
  } finally { ws?.terminate(); await g.close(); await rm(dir, { recursive: true, force: true }); }
});
test('gateway propagates verified conversation selection and lists scoped handles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m365-gateway-conversation-')),g=await startGateway({stateDir:dir,port:0,timeoutMs:5000});
 const origin='chrome-extension://'+'c'.repeat(32);let ws:WebSocket|undefined;
 try {
  const {token}=await(await fetch(g.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:g.pairCode})})).json() as any;
  ws=new WebSocket(g.url.replace('http:','ws:')+'/bridge/socket',{origin});await new Promise<void>(r=>ws!.once('open',r));
  let count=0,firstId='';
  ws.on('message',data=>{
   const value=JSON.parse(String(data));if(value.type!=='job')return;
   count++;assert.equal(value.conversation.mode,count===1?'new':'continue');
   if(count===1)firstId=value.conversation.id;else {assert.equal(value.conversation.id,firstId);assert.equal(value.conversation.expectedCursor,'1'.repeat(64));}
   ws!.send(JSON.stringify({type:'result',id:value.id,text:'observed advice '+count,conversation:{id:value.conversation.id,title:value.conversation.title,cursor:String(count).repeat(64),resumability:'active-chat-only'}}));
   ws!.send(JSON.stringify({type:'ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'}));
  });
  ws.send(JSON.stringify({type:'hello',token,workerId:'conversation-test',ready:true,conversationControl:true,conversationResumability:'active-chat-only'}));await new Promise<void>(r=>ws!.once('message',()=>r()));
  const workspaceKey='a'.repeat(64),headers={'x-api-key':g.clientKey};
  const send=(conversation:unknown)=>fetch(g.url+'/bridge/advice',{method:'POST',headers,body:JSON.stringify({model:'copilot-opus-5.5',prompt:'source-grounded conversation test',conversation})});
  const first=await(await send({mode:'new',workspaceKey})).json() as any;assert.equal(first.contextContinuity,'same-browser-chat');
  const second=await(await send({mode:'continue',id:first.conversation.id,workspaceKey})).json() as any;assert.equal(second.conversation.id,first.conversation.id);assert.equal(second.contextMode,'continue');assert.equal(second.conversationVerification.beforeCursor,'1'.repeat(64));assert.equal(second.conversationVerification.afterCursor,'2'.repeat(64));
  const other=await send({mode:'continue',id:first.conversation.id,workspaceKey:'b'.repeat(64)});assert.equal(other.status,409);
  const listed=await(await fetch(g.url+'/bridge/conversations?workspaceKey='+workspaceKey,{headers})).json() as any;assert.equal(listed.conversations[0].conversationId,first.conversation.id);assert.equal(listed.conversations[0].state,'ready');
 }finally{ws?.terminate();await g.close();await rm(dir,{recursive:true,force:true});}
});
