import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
test('reloaded worker restores missing content registration and attaches existing paired tab', async () => {
  const registered:any[]=[];let injected = 0;
  const chromeMock = {
    storage: { local: { get: async () => ({ config: { url: 'http://127.0.0.1:59173', token: 'a'.repeat(64), workerId: 'test', tabId: 7 } }), set: async () => {}, remove: async () => {} } },
    permissions: { contains: async () => true, onAdded: { addListener: () => {} } },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async (scripts:any[]) => { registered.push(...scripts); }, executeScript: async ({ target }: any) => { assert.equal(target.tabId, 7); injected++; return []; } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    runtime: { onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} } },
    tabs: { get: async () => ({ id: 7, url: 'https://excel.cloud.microsoft/open/onedrive/' }), onRemoved: { addListener: () => {} } },
  };
  class Socket { static OPEN = 1; static CONNECTING = 0; readyState = 0; }
  vm.runInNewContext(await readFile('dist/extension/background.js', 'utf8'), { chrome: chromeMock, WebSocket: Socket, URL, setInterval: () => 1, setTimeout, clearTimeout });
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.equal(registered.length, 2);assert.equal(registered[0].matches[0],'https://fa000000124.officeapps.live.com/*');assert.equal(registered[1].matches[0],'https://excel.officeapps.live.com/*');assert.equal(injected, 1);
});
