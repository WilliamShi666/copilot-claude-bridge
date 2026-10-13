import test from 'node:test';import assert from 'node:assert/strict';import {AuxiliaryTabs,type AuxiliaryBinding} from '../packages/chrome-extension/auxiliary-tabs.js';
function fixture(){let binding:AuxiliaryBinding|undefined,creates=0,removed:number[]=[];const tabs=new Map<number,string>([[7,'https://excel.cloud.microsoft/open/onedrive/?docId=approved']]);let manager:AuxiliaryTabs;
 manager=new AuxiliaryTabs({primary:async()=>({tabId:7,url:tabs.get(7)!}),binding:()=>binding,save:async value=>{binding=value;},create:async url=>{creates++;tabs.set(20,url);return{id:20,url};},get:async id=>{if(!tabs.has(id))throw new Error('closed');return{id,url:tabs.get(id)};},inject:async id=>{await manager.observe(id,3,'https://fa000000124.officeapps.live.com/taskpane.html',true);},remove:async id=>{removed.push(id);tabs.delete(id);}});
 return {manager,tabs,counts:()=>({creates,removed}),binding:()=>binding};}
test('auxiliary requests create/reuse only their own tab and never send through the paired main tab',async()=>{
 const f=fixture();const first=await f.manager.ensure(500);assert.equal(first.tabId,20);assert.equal(first.frameId,3);assert.notEqual(first.tabId,7);
 const next=await f.manager.ensure(500);assert.equal(next.tabId,20);assert.equal(f.counts().creates,1);
 assert.equal(await f.manager.observe(99,4,'https://fa000000124.officeapps.live.com/taskpane.html',true),false);
 assert.equal(await f.manager.observe(20,4,'https://evil.example/',true),false);
});
test('changed auxiliary URLs lose ownership; a user-navigated tab is never commandeered or closed',async()=>{
 const f=fixture();await f.manager.ensure(500);f.tabs.set(20,'https://example.com/user-page');await assert.rejects(f.manager.ensure(500),/changed|ownership/);
 await f.manager.close();assert.deepEqual(f.counts().removed,[]);assert.ok(f.tabs.has(7));assert.ok(f.tabs.has(20));
});
test('disconnect closes only an unchanged bridge-owned auxiliary tab',async()=>{
 const f=fixture();await f.manager.ensure(500);await f.manager.close();assert.deepEqual(f.counts().removed,[20]);assert.ok(f.tabs.has(7));assert.equal(f.binding(),undefined);
});
test('rebinding retires an auxiliary binding without closing a tab that may contain a human draft',async()=>{
 const f=fixture();await f.manager.ensure(500);await f.manager.close(true);assert.deepEqual(f.counts().removed,[]);assert.equal(f.binding(),undefined);assert.ok(f.tabs.has(20));
});
test('without broad tabs permission, Office document fingerprints verify ownership when tab URLs are hidden',async()=>{
 let binding:AuxiliaryBinding|undefined;const approved='https://excel.cloud.microsoft/open/onedrive/?docId=approved';let identity='a'.repeat(64),removed=0;let manager:AuxiliaryTabs;
 manager=new AuxiliaryTabs({primary:async()=>({tabId:7,url:approved}),binding:()=>binding,save:async value=>{binding=value;},create:async()=>({id:20}),get:async id=>({id}),identity:async id=>id===7?'a'.repeat(64):identity,inject:async()=>{await manager.observe(20,3,'https://fa000000124.officeapps.live.com/taskpane.html',true);},remove:async()=>{removed++;}});
 assert.equal((await manager.ensure(500)).tabId,20);identity='b'.repeat(64);await assert.rejects(manager.ensure(500),/ownership/);await manager.close();assert.equal(removed,0);
});
