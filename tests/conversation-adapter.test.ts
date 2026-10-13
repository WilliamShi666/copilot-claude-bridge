import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { exchange,captureConversation,prepare,conversationCursor } from '../packages/chrome-extension/adapter.js';
function fixture(){
 const dom=new JSDOM('<button aria-label="所选模型: Claude Opus 5.5"></button><button>新建聊天</button><button aria-label="切换模式，当前: 聊天，Ctrl+Shift+M"></button><span contenteditable="true" role="combobox" aria-label="聊天输入"></span><button>发送</button><button aria-label="关闭导航"></button><div role="row" aria-current="true" aria-label="Untitled"><button data-chat-options="">options</button></div>');
 dom.window.HTMLElement.prototype.getClientRects=()=>({length:1}) as any;
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;},set(v){this.textContent=v;}});
 const doc=dom.window.document;
 (doc as any).execCommand=(_cmd:string,_ui:boolean,text:string)=>{doc.querySelector('[contenteditable]')!.textContent=text;return true;};
 const row=doc.querySelector('[role="row"]')!;
 (row as HTMLElement).onclick=()=>{
  row.setAttribute('aria-current','true');
  const user=doc.querySelector('.fai-UserMessage');
  if(user){const restored=user.cloneNode(true);user.remove();setTimeout(()=>doc.body.insertBefore(restored,doc.querySelector('.fai-CopilotMessage')),10);}
 };
 doc.querySelector<HTMLButtonElement>('button[data-chat-options]')!.onclick=()=>{
  const rename=doc.createElement('button');rename.setAttribute('role','menuitem');rename.textContent='重命名';doc.body.append(rename);
  rename.onclick=()=>{
   rename.remove();const dialog=doc.createElement('div');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-label','重命名聊天');dialog.innerHTML='<input type="text"><button>保存</button>';doc.body.append(dialog);
   dialog.querySelector('button')!.onclick=()=>{row.setAttribute('aria-label',dialog.querySelector('input')!.value);dialog.remove();};
  };
 };
 let newChats=0,sends=0;
 doc.querySelectorAll('button')[1].onclick=()=>{newChats++;doc.querySelectorAll('[role="article"]').forEach(n=>n.remove());};
 doc.querySelectorAll('button')[3].onclick=()=>{
  sends++;const text=doc.querySelector('[contenteditable]')!.textContent;
  const user=doc.createElement('div');user.className='fai-UserMessage';user.setAttribute('role','article');user.innerHTML='<div class="fai-UserMessage__message"></div>';user.firstElementChild!.textContent=text;doc.body.append(user);doc.querySelector('[contenteditable]')!.textContent='';
  const number=sends;
  setTimeout(()=>{const reply=doc.createElement('div');reply.className='fai-CopilotMessage';reply.setAttribute('role','article');reply.innerHTML='<div class="fai-CopilotMessage__content">reply '+number+'</div><div role="toolbar"><button>复制</button></div>';doc.body.append(reply);},number===1?5:1300);
 };
 return {doc,counts:()=>({newChats,sends})};
}
test('new chat returns a handle; continuation reuses the same active chat and waits for the new reply',async()=>{
 const {doc,counts}=fixture();const id='11111111-1111-4111-8111-111111111111',title='M365 Bridge '+id;
 const first={id:'first',modelLabel:'Claude Opus 5.5',prompt:'first task',conversation:{mode:'new' as const,id,title}};
 assert.equal(await exchange(doc,first,AbortSignal.timeout(5000),async()=>{}),'reply 1');
 doc.querySelector('[role="row"]')!.removeAttribute('aria-current'); // Real Office fresh-chat behavior.
 const receipt=await captureConversation(doc,first,AbortSignal.timeout(5000));assert.ok(receipt);
 assert.equal(receipt.title,title);assert.match(receipt.cursor,/^[a-f0-9]{64}$/);
 const next={...first,id:'next',prompt:'follow-up without replaying first task',conversation:{mode:'continue' as const,id,title,expectedCursor:receipt.cursor}};
 assert.equal(await exchange(doc,next,AbortSignal.timeout(5000),async()=>{}),'reply 2');
 const second=await captureConversation(doc,next,AbortSignal.timeout(3000));assert.equal(second?.id,id);assert.notEqual(second?.cursor,receipt.cursor);
 assert.deepEqual(counts(),{newChats:1,sends:2});assert.equal(doc.querySelectorAll('.fai-UserMessage').length,2);
});
test('missing/ambiguous conversations and unsent drafts fail before sending or starting a new chat',async()=>{
 const {doc,counts}=fixture(),job={id:'next',modelLabel:'Claude Opus 5.5',prompt:'next',conversation:{mode:'continue' as const,id:'11111111-1111-4111-8111-111111111111',title:'Missing',expectedCursor:'0'.repeat(64)}};
 await assert.rejects(prepare(doc,job,AbortSignal.timeout(1000)),/no longer active/);
 doc.querySelector('[contenteditable]')!.textContent='unsent human draft';
 await assert.rejects(prepare(doc,{...job,conversation:undefined},AbortSignal.timeout(1000)),/unsent/);
 assert.deepEqual(counts(),{newChats:0,sends:0});
});
test('message cursor changes on manual context edits',async()=>{
 const {doc}=fixture();doc.body.insertAdjacentHTML('beforeend','<div role="article" class="fai-UserMessage"><div class="fai-UserMessage__message">known user</div></div><div role="article" class="fai-CopilotMessage"><div class="fai-CopilotMessage__content">known reply</div></div>');
 const before=await conversationCursor(doc);doc.querySelector('.fai-UserMessage__message')!.textContent='different conversation';assert.notEqual(await conversationCursor(doc),before);
});
