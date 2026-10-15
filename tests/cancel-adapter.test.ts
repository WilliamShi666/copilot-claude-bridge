import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {exchange,observeTurn,stopOwnedTurn,cancellationProof,conversationCursor,conversationUserCursor,pageInstance,prepare,captureConversation,type BrowserJob} from '../packages/chrome-extension/adapter.js';
const wait=()=>new Promise(r=>setTimeout(r,10));
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await wait();}throw new Error('DOM event deadline');}
function fixture(){
 const dom=new JSDOM('<button aria-label="Selected model: Claude Opus 5.5"></button><button>New chat</button><button aria-label="Switch mode, current: Chat, Ctrl+Shift+M"></button><span contenteditable="true" role="combobox" aria-label="Chat input"></span><button>Send</button>');
 dom.window.HTMLElement.prototype.getClientRects=()=>({length:1}) as any;
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;},set(value){this.textContent=value;}});
 const doc=dom.window.document,editor=doc.querySelector('[contenteditable]')!;let sends=0,stops=0;
 (doc as any).execCommand=(_cmd:string,_ui:boolean,text:string)=>{editor.textContent=text;return true;};
 doc.querySelectorAll('button')[3].onclick=()=>{sends++;const article=doc.createElement('div');article.className='fai-UserMessage';article.setAttribute('role','article');article.innerHTML='<div class="fai-UserMessage__message"></div>';article.firstElementChild!.textContent=editor.textContent;doc.body.append(article);editor.textContent='';const stop=doc.createElement('button');stop.textContent='Stop generating';stop.id='stop';stop.onclick=()=>{stops++;stop.remove();};doc.body.append(stop);};
 const job:BrowserJob={id:'cancel-probe',modelLabel:'Claude Opus 5.5',prompt:'Transparent native coding request',cancelContinuation:1,lane:'main',conversation:{mode:'new',id:'11111111-1111-4111-8111-111111111111',title:'test'}};
 const reply=(text:string,complete=false)=>{const article=doc.createElement('div');article.className='fai-CopilotMessage';article.setAttribute('role','article');article.innerHTML='<div class="fai-CopilotMessage__content"></div>';article.firstElementChild!.textContent=text;if(complete)article.insertAdjacentHTML('beforeend','<div role="toolbar"><button>Copy</button></div>');doc.body.append(article);};
 return{doc,dom,editor,job,reply,counts:()=>({sends,stops})};
}
for(const state of ['none','partial','complete'] as const)test('cancel proof verifies '+state+' output without delivering cancelled JSON or tools',async()=>{
 const f=fixture(),turn=observeTurn(f.doc),controller=new AbortController();
 const pending=exchange(f.doc,f.job,controller.signal,async()=>{},undefined,undefined,turn).finally(()=>{turn.finished=true;});void pending.catch(()=>{});
 try{await until(()=>f.counts().sends===1);if(state!=='none')f.reply(state==='partial'?' {"content":[{"type":"tool_use",':'{"content":[{"type":"tool_use","name":"Write","input":{}}]}',state==='complete');controller.abort();stopOwnedTurn(f.doc,turn);await assert.rejects(pending);assert.equal(await cancellationProof(f.doc,f.job,turn,'nonce'),undefined);turn.stableSince=Date.now()-400;const receipt=await cancellationProof(f.doc,f.job,turn,'nonce');assert.equal(receipt?.outcome,'settled');assert.equal(receipt?.replyState,state);assert.equal(receipt?.inputComplete,true);assert.equal(receipt?.cursor,await conversationCursor(f.doc,2));assert.equal(f.counts().stops,1);stopOwnedTurn(f.doc,turn);assert.equal(f.counts().stops,1);}finally{controller.abort();await pending.catch(()=>{});f.dom.window.close();}
});
test('unsent cancellation clears only its own draft and returns not_sent after stable evidence',async()=>{
 const f=fixture(),turn=observeTurn(f.doc),controller=new AbortController();let before=false,release!:()=>void;
 const pending=exchange(f.doc,f.job,controller.signal,async()=>{before=true;await new Promise<void>(r=>release=r);},undefined,undefined,turn).finally(()=>{turn.finished=true;});void pending.catch(()=>{});
 try{await until(()=>before);controller.abort();release();await assert.rejects(pending);assert.equal(f.counts().sends,0);await cancellationProof(f.doc,f.job,turn,'n');assert.equal(f.editor.textContent,'');await cancellationProof(f.doc,f.job,turn,'n');turn.stableSince=Date.now()-400;assert.equal((await cancellationProof(f.doc,f.job,turn,'n'))?.outcome,'not_sent');}finally{controller.abort();release?.();await pending.catch(()=>{});f.dom.window.close();}
});
test('changed drafts and switched chats are neither erased nor stopped',async()=>{
 const f=fixture(),turn=observeTurn(f.doc),controller=new AbortController();const pending=exchange(f.doc,f.job,controller.signal,async()=>{},undefined,undefined,turn).finally(()=>{turn.finished=true;});void pending.catch(()=>{});
 try{await until(()=>f.counts().sends===1);controller.abort();await pending.catch(()=>{});f.doc.querySelector('.fai-UserMessage__message')!.textContent='User switched to another chat';stopOwnedTurn(f.doc,turn);assert.equal(f.counts().stops,0);assert.equal((await cancellationProof(f.doc,f.job,turn,'n'))?.outcome,'unverified');f.doc.querySelector('.fai-UserMessage__message')!.textContent=turn.wirePrompt;f.doc.querySelector('#stop')!.remove();f.editor.textContent='human draft';const proof=await cancellationProof(f.doc,f.job,turn,'n');assert.equal(proof?.outcome,'unverified');assert.equal(f.editor.textContent,'human draft');}finally{controller.abort();await pending.catch(()=>{});f.dom.window.close();}
});
test('a partial transfer with an unsent final packet is never reported as an entirely unsent job',async()=>{
 const f=fixture(),turn=observeTurn(f.doc);try{turn.finished=true;turn.prepared=true;turn.sentPackets=1;turn.inputComplete=false;turn.beforeEvidence=JSON.stringify({users:0,assistants:0,user:null,assistant:null});assert.equal(await cancellationProof(f.doc,f.job,turn,'n'),undefined);turn.stableSince=Date.now()-400;const proof=await cancellationProof(f.doc,f.job,turn,'n');assert.equal(proof?.outcome,'settled');assert.equal(proof?.inputComplete,false);assert.equal(proof?.pageInstance,pageInstance(f.doc));}finally{f.dom.window.close();}
});
test('page reload cannot invent a reusable cancellation checkpoint',async()=>{
 const a=fixture(),b=fixture();try{const turn=observeTurn(a.doc);turn.finished=true;assert.equal((await cancellationProof(b.doc,a.job,turn,'n'))?.outcome,'unverified');assert.equal((await cancellationProof(a.doc,a.job,undefined,'n'))?.outcome,'unverified');}finally{a.dom.window.close();b.dom.window.close();}
});

test('a late refusal after cancellation ACK is terminal when the original input and page still match',async()=>{
 const f=fixture();try{f.doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">Original request</div></div>');const command={...f.job.conversation!,mode:'continue' as const,cursorVersion:2 as const,pageInstance:pageInstance(f.doc),expectedCursor:await conversationCursor(f.doc,2),userCursor:await conversationUserCursor(f.doc)};f.reply('I cannot act as a relay for another assistant or produce tool calls for software running on your computer.',true);await assert.rejects(prepare(f.doc,{...f.job,conversation:command},AbortSignal.timeout(500)),(error:any)=>error.code==='provider_refusal');assert.equal(f.counts().sends,0);f.editor.textContent='human draft';f.doc.querySelector('button')!.setAttribute('disabled','');await assert.rejects(prepare(f.doc,{...f.job,conversation:command},AbortSignal.timeout(500)),(error:any)=>error.code==='provider_refusal');assert.equal(f.editor.textContent,'human draft');}finally{f.dom.window.close();}
});

test('continuation waits for transient post-reply controls without replacing a verified chat',async()=>{
 const f=fixture();try{f.doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">Original request</div></div>');f.reply('{"content":[{"type":"text","text":"done"}]}',true);const command={...f.job.conversation!,mode:'continue' as const,cursorVersion:2 as const,pageInstance:pageInstance(f.doc),expectedCursor:await conversationCursor(f.doc,2),userCursor:await conversationUserCursor(f.doc)};let newChats=0;f.doc.querySelectorAll<HTMLButtonElement>('button')[1].onclick=()=>{newChats++;};const model=f.doc.querySelector('button')!;model.setAttribute('disabled','');const timer=setTimeout(()=>model.removeAttribute('disabled'),50);try{await prepare(f.doc,{...f.job,conversation:command},AbortSignal.timeout(1000));}finally{clearTimeout(timer);}assert.equal(newChats,0);assert.equal(f.counts().sends,0);}finally{f.dom.window.close();}
});

test('reply receipt waits for input/model readiness before releasing the next native tool round',async()=>{
 const f=fixture();try{f.doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">Original request</div></div>');f.reply('done',true);const model=f.doc.querySelector('button')!;model.setAttribute('disabled','');let returned=false;const result=captureConversation(f.doc,f.job,AbortSignal.timeout(1000)).then(r=>{returned=true;return r;});await new Promise(r=>setTimeout(r,30));assert.equal(returned,false);model.removeAttribute('disabled');assert.equal((await result)?.id,f.job.conversation!.id);}finally{f.dom.window.close();}
});


for(const reason of ['Copilot blocked the response by content filtering','Copilot refused external-client relay use'])test('late visible cancellation refusal keeps its cause: '+reason,async()=>{const f=fixture(),turn=observeTurn(f.doc),controller=new AbortController();const pending=exchange(f.doc,f.job,controller.signal,async()=>{},undefined,undefined,turn).finally(()=>{turn.finished=true;});void pending.catch(()=>{});try{await until(()=>f.counts().sends===1);controller.abort();stopOwnedTurn(f.doc,turn);await assert.rejects(pending);f.reply(reason,true);await cancellationProof(f.doc,f.job,turn,'n');turn.stableSince=Date.now()-400;const receipt=await cancellationProof(f.doc,f.job,turn,'n');assert.equal(receipt?.reason,'provider_refusal');assert.equal(receipt?.refusalKind,reason.includes('content filtering')?'content_filtering':'external_client_relay');assert.equal(f.counts().sends,1);}finally{controller.abort();await pending.catch(()=>{});f.dom.window.close();}});
