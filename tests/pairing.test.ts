import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { pairingCoordinator, validateIntent, type PairIntent } from '../packages/chrome-extension/pairing.js';
function fixture() {
  let intent: PairIntent | undefined, granted = false, calls = 0, now = 1;
  const states: string[] = [];
  const deps = {
    read: async () => intent, write: async (value: PairIntent) => { intent = value; }, clear: async () => { intent = undefined; },
    hasPermissions: async () => granted, checkTab: async (_id: number) => {}, commit: async (_value: PairIntent) => { calls++; },
    status: async (phase: string) => { states.push(phase); }, now: () => now,
  };
  return { deps, states, intent: () => intent, calls: () => calls, grant: () => { granted = true; }, advance: () => { now += 5 * 60000 + 1; } };
}
const input = { url: 'http://127.0.0.1:59173', code: 'a'.repeat(40), tabId: 7 };
test('popup may disappear before grant; backend resumes persisted intent exactly once', async () => {
  const f = fixture(); const original = pairingCoordinator(f.deps);
  await original.prepare(input); assert.equal(f.calls(), 0); assert.ok(f.intent());
  // Popup and original worker gone; a new worker sees only durable storage.
  const restarted = pairingCoordinator(f.deps); f.grant();
  await Promise.all([restarted.resume(), restarted.resume()]);
  assert.equal(f.calls(), 1); assert.equal(f.intent(), undefined); assert.ok(f.states.includes('paired'));
});
test('permission arrives before intent storage; prepare rechecks and completes', async () => {
  const f = fixture(); f.grant(); const worker = pairingCoordinator(f.deps);
  await worker.resume(); await worker.prepare(input); assert.equal(f.calls(), 1);
});
test('stale intent expires; failed gateway is visible and never retried implicitly', async () => {
  const f = fixture(); const worker = pairingCoordinator(f.deps); await worker.prepare(input); f.advance(); f.grant(); await worker.resume();
  assert.equal(f.calls(), 0); assert.equal(f.intent(), undefined); assert.equal(f.states.at(-1), 'failed');
  f.deps.commit = async () => { throw new Error('Gateway rejected code'); }; await worker.prepare(input);
  assert.equal(f.intent(), undefined); assert.equal(f.states.at(-1), 'failed');
});
test('rejects non-loopback, bad pairing code and invalid tab', () => {
  assert.throws(() => validateIntent({ ...input, url: 'https://outside.example' }, 1));
  assert.throws(() => validateIntent({ ...input, code: 'wrong' }, 1));
  assert.throws(() => validateIntent({ ...input, tabId: undefined }, 1));
});
test('actual bundled popup transfers intent before permissions can close it', async () => {
  const doc = new JSDOM('<input id="url" value="http://127.0.0.1:59173"><input id="code"><button id="pair"></button><button id="unpair"></button><pre id="status"></pre>').window.document;
  (doc.getElementById('code') as HTMLInputElement).value = 'a'.repeat(40);
  let closed = false, gesture = false; const messages: any[] = [];
  const chromeMock = {
    tabs: { query: async () => [{ id: 7, url: 'https://excel.cloud.microsoft/open/onedrive/' }] },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
    runtime: { sendMessage: (value: any) => { if (closed) return Promise.reject(new Error('Popup context destroyed')); messages.push(value); return Promise.resolve({ ok: true }); } },
    permissions: { request: () => { assert.equal(gesture, true, 'Permission request must start inside click, before awaiting tab query'); closed = true; return new Promise<boolean>(() => {}); }, remove: async () => true },
  };
  vm.runInNewContext(await readFile('dist/extension/popup.js', 'utf8'), { document: doc, chrome: chromeMock, URL, setTimeout, clearTimeout });
  await new Promise(r => setImmediate(r));
  gesture = true; (doc.getElementById('pair') as HTMLButtonElement).click(); gesture = false;
  await new Promise(r => setImmediate(r));
  assert.equal(messages[0]?.type, 'prepare-pair');
  assert.equal(messages[0]?.tabId, 7);
});
test('paired popup can select a replacement Excel tab without reusing one-time code', async () => {
  const doc = new JSDOM('<input id="url" value="http://127.0.0.1:59173"><input id="code"><button id="pair"></button><button id="unpair"></button><pre id="status"></pre>').window.document;
  const messages: any[] = [];
  const chromeMock = {
    tabs: { query: async () => [{ id: 99, url: 'https://excel.cloud.microsoft/open/onedrive/' }] },
    storage: { local: { get: async () => ({ config: { url: 'http://127.0.0.1:59173' } }) }, onChanged: { addListener: () => {} } },
    runtime: { sendMessage: async (value: any) => { messages.push(value); return { ok: true }; } },
    permissions: { request: () => { throw new Error('Existing tab selection must not request extra permissions'); } },
  };
  vm.runInNewContext(await readFile('dist/extension/popup.js', 'utf8'), { document: doc, chrome: chromeMock, URL, setTimeout, clearTimeout });
  await new Promise(r => setImmediate(r)); (doc.getElementById('pair') as HTMLButtonElement).click(); await new Promise(r => setImmediate(r));
  assert.equal(messages[0]?.type, 'rebind-tab'); assert.equal(messages[0]?.tabId, 99);
  assert.equal(doc.getElementById('pair')?.textContent, 'Use selected Excel tab');
});
test('content script re-announces readiness after its Copilot UI mounts', async () => {
  const dom = new JSDOM('<body></body>'); const messages: any[] = [], intervals: (() => void)[] = [];
  dom.window.HTMLElement.prototype.getClientRects = () => ({ length: 1 }) as any;
  const chromeMock = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { onMessage: { addListener: () => {} }, sendMessage: async (value: any) => { messages.push(value); } } };
  vm.runInNewContext(await readFile('dist/extension/content.js', 'utf8'), { document: dom.window.document, location: { href: 'https://fa000000124.officeapps.live.com/taskpane.html' }, chrome: chromeMock, setInterval: (callback: () => void) => { intervals.push(callback); return 1; }, clearInterval: () => {}, addEventListener: () => {}, AbortController, setTimeout });
  assert.equal(messages[0].ready, false);
  dom.window.document.body.innerHTML = '<button aria-label="所选模型: Claude Opus 5.5"></button><span role="combobox" contenteditable="true" aria-label="聊天输入"></span>';
  intervals[0](); assert.equal(messages.at(-1).ready, true);
});
test('old content heartbeat stops without throwing when extension context is invalidated', async () => {
  const dom = new JSDOM('<body></body>'); const intervals: (() => void)[] = []; let invalid = false, stopped = false;
  const chromeMock = { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => { if (invalid) throw new Error('Extension context invalidated.'); return Promise.resolve({}); } } };
  vm.runInNewContext(await readFile('dist/extension/content.js', 'utf8'), { document: dom.window.document, location: { href: 'https://fa000000124.officeapps.live.com/taskpane.html' }, chrome: chromeMock, setInterval: (callback: () => void) => { intervals.push(callback); return 1; }, clearInterval: () => { stopped = true; }, addEventListener: () => {}, AbortController, setTimeout });
  invalid = true; assert.doesNotThrow(() => intervals[0]()); assert.equal(stopped, true);
  assert.doesNotThrow(() => intervals[0]());
});
test('an idempotent cancel acknowledges an obsolete job without leaving an idle frame blocked',async()=>{
 const dom=new JSDOM('<button aria-label="所选模型: Claude Opus 5.5"></button><span role="combobox" contenteditable="true" aria-label="聊天输入"></span>');let listener:any,reply:any;
 dom.window.HTMLElement.prototype.getClientRects=()=>({length:1}) as any;
 const chromeMock={runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}},sendMessage:async()=>({})}};
 vm.runInNewContext(await readFile('dist/extension/content.js','utf8'),{document:dom.window.document,location:{href:'https://fa000000124.officeapps.live.com/taskpane.html'},chrome:chromeMock,setInterval:()=>1,clearInterval:()=>{},addEventListener:()=>{},AbortController,setTimeout});
 listener({type:'cancel',id:'old-document-job'}, {},(value:any)=>{reply=value;});assert.equal(reply.cancelled,true);assert.equal(reply.ready,true);dom.window.close();
});

test('a preparation failure reports no submission and does not stop an unrelated Copilot generation',async()=>{
 const dom=new JSDOM('<button aria-label="所选模型: Claude Opus 5.5"></button><span role="combobox" contenteditable="true" aria-label="聊天输入"></span><button id="stop">停止生成 Esc</button>');
 dom.window.HTMLElement.prototype.getClientRects=()=>({length:1}) as any;let listener:any,stops=0;const messages:any[]=[];
 dom.window.document.querySelector<HTMLButtonElement>('#stop')!.onclick=()=>{stops++;};
 const chromeMock={storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}},sendMessage:async(value:any)=>{messages.push(value);return{};}}};
 vm.runInNewContext(await readFile('dist/extension/content.js','utf8'),{document:dom.window.document,location:{href:'https://fa000000124.officeapps.live.com/taskpane.html'},chrome:chromeMock,setInterval:()=>1,clearInterval:()=>{},addEventListener:()=>{},AbortController,setTimeout});
 listener({type:'job',id:'unsent',modelLabel:'Claude Opus 5.5',prompt:'test'}, {},()=>{});
 for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 const failure=messages.find(m=>m.type==='failure');assert.equal(failure?.submitted,false);assert.equal(stops,0);dom.window.close();
});
