import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseArguments,validateRuntime,inspectGateway,ensureGateway,waitForChrome} from './run-copilot.mjs';

const runtime={url:'http://127.0.0.1:59173',clientKey:'synthetic-launcher-key',pid:123};
const ready={runtime,status:{workerConnected:true,browserReady:true}};
async function withState(fn){const state=await mkdtemp(join(tmpdir(),'copilot-launcher-'));try{await fn(state);}finally{await rm(state,{recursive:true,force:true});}}

test('launcher preserves workspace paths and caller permission/team overrides',()=>{
 const value=parseArguments(['a project','--model','sonnet','--compact-window','200k','--','--permission-mode','default','--teammate-mode=tmux'],tmpdir());
 assert.equal(value.workspace,resolve('a project'));
 assert.deepEqual(value.bridgeArgs,['--model','sonnet','--compact-window','200k']);
 assert.deepEqual(value.nativeArgs,['--permission-mode','default','--teammate-mode=tmux']);
 const defaults=parseArguments(['--check'],tmpdir());assert.equal(defaults.workspace,resolve(tmpdir()));assert.equal(defaults.checkOnly,true);
 assert.deepEqual(defaults.nativeArgs,['--teammate-mode','in-process','--permission-mode','auto']);
 assert.throws(()=>parseArguments(['--model']),/Value required/);
 assert.throws(()=>parseArguments(['--model','other']),/gpt61/);
 assert.throws(()=>parseArguments(['--check','--gateway-only']),/Choose/);
});

test('normal launchers preserve both explicit GPT aliases and deployment IDs across native resume',()=>{
 for(const model of ['gpt61','gpt6','copilot-gpt-6.1-sol','copilot-gpt-6-sol']){
  const value=parseArguments(['a project','--model',model,'--resume','existing-session']);
  assert.deepEqual(value.bridgeArgs,['--model',model]);assert.ok(value.nativeArgs.includes('--resume'));assert.ok(value.nativeArgs.includes('existing-session'));
 }
});

test('launcher rejects external URLs, URL credentials and invalid runtime keys',()=>{
 for(const url of ['http://localhost:59173','https://127.0.0.1:59173','http://192.168.1.2:59173','http://127.0.0.1:59173/other','http://127.0.0.1:59173/?x=1','http://user:pass@127.0.0.1:59173'])assert.throws(()=>validateRuntime({...runtime,url}));
 assert.throws(()=>validateRuntime({...runtime,clientKey:''}));
 assert.equal(validateRuntime(runtime),runtime);
});

test('only missing state or refused connection triggers startup; auth, timeout and corrupt state remain visible',async()=>withState(async state=>{
 assert.equal(await inspectGateway(state),null);
 await writeFile(join(state,'runtime.json'),JSON.stringify(runtime));
 assert.equal(await inspectGateway(state,async()=>{throw Object.assign(new Error('refused'),{cause:{code:'ECONNREFUSED'}});}),null);
 await assert.rejects(inspectGateway(state,async()=>({ok:false,status:401})),/authentication/);
 await assert.rejects(inspectGateway(state,async()=>{throw new Error('timeout');}),/Could not reach/);
 await assert.rejects(inspectGateway(state,async()=>({ok:true,json:async()=>({})})),/Unexpected/);
 await writeFile(join(state,'runtime.json'),'{broken');await assert.rejects(inspectGateway(state));
}));

test('stopped gateway restarts on its saved port and an existing gateway is reused',async()=>withState(async state=>{
 await writeFile(join(state,'runtime.json'),JSON.stringify({...runtime,url:'http://127.0.0.1:61473'}));
 let calls=0,started=0,unref=false;
 const current=await ensureGateway({state,inspect:async()=>++calls<3?null:ready,sleep:async()=>{},launch:(target,port)=>{assert.equal(target,state);assert.equal(port,61473);started++;return{once(){},unref(){unref=true;}};}});
 assert.equal(current,ready);assert.equal(started,1);assert.equal(unref,true);
 assert.equal(await ensureGateway({state,inspect:async()=>ready,launch:()=>assert.fail('must reuse')}),ready);
}));

test('fresh state uses distinct Windows/Linux ports and startup failure is bounded',async()=>withState(async state=>{
 for(const [platform,expected] of [['win32',59173],['linux',59175]]){
  let calls=0;
  await ensureGateway({state,platform,inspect:async()=>++calls<2?null:ready,sleep:async()=>{},launch:(_,port)=>{assert.equal(port,expected);return{once(){},unref(){}};}});
 }
 let waits=0;
 await assert.rejects(ensureGateway({state,inspect:async()=>null,sleep:async()=>{waits++;},launch:()=>({once(){},unref(){}})}),/Gateway did not start/);
 assert.equal(waits,30);
 await assert.rejects(ensureGateway({state,inspect:async()=>null,sleep:async()=>{},launch:()=>({once(_,fn){fn(new Error('spawn failed'));},unref(){}})}),/spawn failed/);
}));

test('readiness waits for Chrome, reports pairing steps and never treats disconnection as ready',async()=>{
 let calls=0;const notReady={runtime,status:{workerConnected:false,browserReady:false}};
 assert.equal(await waitForChrome(notReady,{sleep:async()=>{},inspect:async()=>++calls<2?notReady:ready}),ready);
 await assert.rejects(waitForChrome(notReady,{attempts:2,sleep:async()=>{},inspect:async()=>notReady}),/Use selected Excel tab/);
 await assert.rejects(waitForChrome(notReady,{attempts:1,sleep:async()=>{},inspect:async()=>null}),/Gateway stopped/);
 assert.equal(await waitForChrome(ready,{inspect:()=>assert.fail('already ready')}),ready);
});
