import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startGateway } from '../packages/gateway/index.js';
const origin = 'chrome-extension://' + 'd'.repeat(32);
async function connect(url: string, token: string) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/bridge/socket', { origin });
  await new Promise<void>(r => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', token, workerId: 'recovery-test', ready: true }));
  const hello = await new Promise<any>(r => ws.once('message', d => r(JSON.parse(String(d)))));
  assert.equal(hello.type, 'connected'); return ws;
}
test('gateway restart retains pairing credentials and does not replay old jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-recovery-test-')); let ws: WebSocket | undefined;
  let g = await startGateway({ stateDir: dir, port: 0 });
  try {
    const { token } = await (await fetch(g.url + '/bridge/pair', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ code: g.pairCode }) })).json() as any;
    ws = await connect(g.url, token); const key = g.clientKey;
    ws.terminate(); await g.close();
    g = await startGateway({ stateDir: dir, port: 0 });
    assert.equal(g.clientKey, key); ws = await connect(g.url, token);
    assert.equal(g.status().active, null); assert.equal(g.status().paired, true);
  } finally { ws?.terminate(); await g.close(); await rm(dir, { recursive: true, force: true }); }
});
test('socket reconnect recovers the same request id rather than a second job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-recovery-test-')); let ws: WebSocket | undefined;
  const g = await startGateway({ stateDir: dir, port: 0, timeoutMs: 5000 });
  try {
    const { token } = await (await fetch(g.url + '/bridge/pair', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ code: g.pairCode }) })).json() as any;
    ws = await connect(g.url, token);
    const future = fetch(g.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': g.clientKey }, body: JSON.stringify({ model: 'copilot-opus-5.5', max_tokens: 100, messages: [{ role: 'user', content: 'test' }] }) });
    const job = await new Promise<any>(r => ws!.once('message', d => r(JSON.parse(String(d)))));
    const closed = new Promise<void>(r => ws!.once('close', () => r())); ws.terminate(); await closed;
    const reconnected = new WebSocket(g.url.replace('http:', 'ws:') + '/bridge/socket', { origin }); ws = reconnected;
    const messages: any[] = []; let received!: () => void; const recovery = new Promise<void>(r => received = r);
    ws.on('message', d => { const value = JSON.parse(String(d)); messages.push(value); if (value.type === 'recover') received(); });
    await new Promise<void>(r => ws!.once('open', r)); ws.send(JSON.stringify({ type: 'hello', token, workerId: 'recovery-test', ready: true }));
    await recovery; assert.equal(messages.find(x => x.type === 'recover')?.id, job.id); assert.ok(!messages.some(x => x.type === 'job'));
    ws.send(JSON.stringify({ type: 'result', id: job.id, text: '{"content":[{"type":"text","text":"recovered reply"}]}' }));
    const response = await future; assert.equal(response.status, 200); assert.ok((await response.text()).includes('recovered reply'));
  } finally { ws?.terminate(); await g.close(); await rm(dir, { recursive: true, force: true }); }
});
