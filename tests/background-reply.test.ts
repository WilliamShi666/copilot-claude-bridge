import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {exchange,captureConversation} from '../packages/chrome-extension/adapter.js';
function fixture(){
 const dom=new JSDOM('<button aria-label="所选模型: Claude Opus 5.5"></button><button>新建聊天</button><button aria-label="切换模式，当前: 聊天，Ctrl+Shift+M"></button><span contenteditable="true" role="combobox" aria-label="聊天输入"></span><button>发送</button>');
 dom.window.HTMLElement.prototype.getClientRects=()=>({length:1}) as any;
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 const doc=dom.window.document;(doc as any).execCommand=(_command:string,_ui:boolean,text:string)=>{doc.querySelector('[contenteditable]')!.textContent=text;return true;};
 return {doc,dom};
}
async function flush(){for(let i=0;i<80;i++)await new Promise(resolve=>setImmediate(resolve));}
// WebCrypto completes outside the JS microtask queue. Keep page timers frozen,
// but capture a real watchdog before mocking to bound the asynchronous wait.
const realSetTimeout=setTimeout,realClearTimeout=clearTimeout;
async function withoutPageTimers<T>(pending:Promise<T>):Promise<T>{
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([pending,new Promise<never>((_resolve,reject)=>{watchdog=realSetTimeout(()=>reject(new Error('A matching receipt must finish without advancing page timers')),2000);})]);}
 finally{if(watchdog!==undefined)realClearTimeout(watchdog);}
}
test('completed reply mutations are delivered even when page timeout callbacks are suspended',async t=>{
 const {doc,dom}=fixture();const controller=new AbortController();let sent=0,completed=false;
 t.mock.timers.enable({apis:['setTimeout']});
 doc.querySelectorAll<HTMLButtonElement>('button')[3].onclick=()=>{sent++;doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">request</div></div><div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">partial</div></div><button id="stop">停止生成 Esc</button>');};
 const expected='{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"probe.md","content":"synthetic"}}]}';
 const pending=exchange(doc,{id:'background-write',modelLabel:'Claude Opus 5.5',prompt:'request'},controller.signal,async()=>{});
 pending.then(()=>{completed=true;},()=>{});
 try{
  await flush();assert.equal(sent,1);assert.equal(completed,false);
  doc.querySelector('#stop')!.remove();doc.querySelector('.fai-CopilotMessage__content')!.textContent=expected;
  doc.querySelector('.fai-CopilotMessage')!.insertAdjacentHTML('beforeend','<div role="toolbar"><button aria-label="复制"></button></div>');
  await flush();assert.equal(completed,true,'a finished DOM reply must not depend on another throttled timer tick');assert.equal(await pending,expected);
 }finally{controller.abort();t.mock.timers.tick(1000);await pending.catch(()=>{});t.mock.timers.reset();dom.window.close();}
});
test('verified conversation receipt does not wait for an unnecessary background stability timer',async t=>{
 const {doc,dom}=fixture();const controller=new AbortController();
 doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">known request</div></div><div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">completed reply</div><div role="toolbar"><button>复制</button></div></div>');
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=captureConversation(doc,{id:'receipt',modelLabel:'Claude Opus 5.5',prompt:'known request',conversation:{mode:'new',id:'11111111-1111-4111-8111-111111111111',title:'test'}},controller.signal);
 try{const receipt=await withoutPageTimers(pending);assert.match(receipt!.cursor,/^[a-f0-9]{64}$/);}
 finally{controller.abort();t.mock.timers.tick(1000);await pending.catch(()=>{});t.mock.timers.reset();dom.window.close();}
});
