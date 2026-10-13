import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForBrowserReady} from '../packages/cli/readiness.js';

function clock(){let time=0;return{now:()=>time,sleep:async(ms:number)=>{time+=ms;}};}
const ready={paired:true,workerConnected:true,browserReady:true,active:null,queued:0};
test('startup waits through cancellation cleanup without resubmitting browser jobs',async()=>{
  const time=clock();let checks=0,notices=0;
  const data=await waitForBrowserReady(async()=>({status:++checks<3?{...ready,browserReady:false}:ready,runtime:{url:'local'}}),{...time,timeoutMs:1000,onWait:()=>notices++});
  assert.equal(checks,3);assert.equal(notices,1);assert.equal(data.status.browserReady,true);assert.equal(data.runtime.url,'local');
});
test('startup returns immediately when the adapter is already ready',async()=>{
  const time=clock();let checks=0;
  await waitForBrowserReady(async()=>{checks++;return{status:ready};},{...time,onWait:()=>assert.fail('no wait needed')});
  assert.equal(checks,1);assert.equal(time.now(),0);
});
test('startup reports a busy lane after a bounded wait instead of asking to open Copilot',async()=>{
  const time=clock();
  await assert.rejects(waitForBrowserReady(async()=>({status:{...ready,browserReady:false,active:{lane:'auxiliary'},queued:1}}),{...time,timeoutMs:500}),/busy.*auxiliary/i);
  assert.equal(time.now(),500);
});
test('startup distinguishes disconnected, unpaired and unavailable workbook states',async()=>{
  for(const [state,pattern] of [
    [{...ready,browserReady:false,workerConnected:false},/not connected/i],
    [{...ready,paired:false,browserReady:false},/not paired/i],
    [{...ready,browserReady:false},/connected.*Copilot.*not ready/i],
  ] as const){
    const time=clock();await assert.rejects(waitForBrowserReady(async()=>({status:state}),{...time,timeoutMs:500}),pattern);
  }
});
test('startup does not hide gateway authentication or connectivity errors',async()=>{
  const time=clock();
  await assert.rejects(waitForBrowserReady(async()=>{throw new Error('Gateway is stale or not authenticated');},{...time}),/not authenticated/);
  assert.equal(time.now(),0);
});
