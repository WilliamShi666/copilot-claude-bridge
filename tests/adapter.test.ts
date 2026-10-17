import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inspect, replyText, exchange, prepare, modelSubmenu, fill, button, conversationCursor } from '../packages/chrome-extension/adapter.js';
function fixture() {
  const dom = new JSDOM('<button aria-label="所选模型: Claude Opus 5.5"></button><button>新建聊天</button><button aria-label="切换模式，当前: 聊天，Ctrl+Shift+M"></button><span contenteditable="true" role="combobox" aria-label="聊天输入"></span><button>发送 ↵</button>');
  dom.window.HTMLElement.prototype.getClientRects = () => ({ length: 1 }) as any;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
  (dom.window.document as any).execCommand = (_cmd: string, _ui: boolean, text: string) => { dom.window.document.querySelector('[contenteditable]')!.textContent = text; return true; };
  return dom.window.document;
}
test('Chinese DOM detects selected model/chat-only and ignores toolbar text', () => {
  const doc = fixture(); assert.deepEqual(inspect(doc), { ready: true, model: '所选模型: Claude Opus 5.5', chatOnly: true,conversationControl:true,conversationResumability:'active-chat-only' });
  doc.body.insertAdjacentHTML('beforeend', '<div class="fai-CopilotMessage" role="article"><h6>Copilot said:</h6><div class="fai-CopilotMessage__content">{"content":[{"type":"text","text":"ok"}]}</div><button>复制</button></div>');
  assert.deepEqual(replyText(doc), ['{"content":[{"type":"text","text":"ok"}]}']);
});
test('summary fallback starts a fresh chat and selects GPT from its own provider accordion',async()=>{
 const doc=fixture(),selected=doc.querySelector<HTMLButtonElement>('button')!;let chats=0,sends=0,journals=0,gptOpened=0;
 doc.querySelectorAll<HTMLButtonElement>('button')[1].onclick=()=>{chats++;doc.querySelectorAll('.fai-CopilotMessage').forEach(el=>el.remove());};
 selected.onclick=()=>{selected.setAttribute('aria-expanded','true');
  const gpt=doc.createElement('div');gpt.id='gpt-provider';gpt.setAttribute('role','menuitem');gpt.setAttribute('aria-haspopup','menu');gpt.setAttribute('aria-expanded','false');gpt.textContent='GPT 常规使用 OpenAI';gpt.onclick=()=>{gptOpened++;gpt.setAttribute('aria-expanded','true');for(const name of ['GPT-6.1 Sol','GPT-6 Sol']){const model=doc.createElement('div');model.setAttribute('role','menuitemradio');model.textContent=name;model.onclick=()=>{selected.setAttribute('aria-label','所选模型: '+name);selected.setAttribute('aria-expanded','false');doc.querySelectorAll('[role="menuitemradio"],#gpt-provider').forEach(el=>el.remove());};doc.body.append(model);}};doc.body.append(gpt);
 };
 doc.querySelectorAll<HTMLButtonElement>('button')[3].onclick=()=>{sends++;doc.querySelector('[contenteditable]')!.textContent='';const article=doc.createElement('div');article.className='fai-CopilotMessage';article.setAttribute('role','article');article.innerHTML='<div class="fai-CopilotMessage__content"></div><div role="toolbar"><button>复制</button></div>';article.querySelector('.fai-CopilotMessage__content')!.textContent=sends===1?'malformed response':'{"content":[{"type":"text","text":"summary complete"}]}';doc.body.append(article);};
 let actual='';const attempts:any[]=[];
 const result=await exchange(doc,{id:'summary-fallback',modelLabel:'Claude Opus 5.5',prompt:'summarize',summary:true},AbortSignal.timeout(2000),async()=>{journals++;},model=>{actual=model;},attempt=>attempts.push(attempt));
 assert.match(result,/summary complete/);assert.equal(actual,'GPT-6 Sol');assert.equal(chats,2);assert.equal(sends,2);assert.equal(journals,1);assert.equal(gptOpened,2);assert.equal(attempts.length,2);
});
test('new isolated chat, write-ahead submission, exact input and real reply', async () => {
  const doc = fixture(); let journalled = false, sent = 0;
  doc.querySelectorAll('button')[3].onclick = () => { assert.equal(journalled, true); sent++; doc.body.insertAdjacentHTML('beforeend', '<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">{"content":[{"type":"text","text":"done"}]}</div><div role="toolbar"><button>复制</button></div></div>'); };
  const text = await exchange(doc, { id: 'a', modelLabel: 'Claude Opus 5.5', prompt: 'complete\nprompt' }, new AbortController().signal, async () => { journalled = true; });
  assert.ok(text.includes('done')); assert.equal(sent, 1);
});
test('send uses committed editor state even when the submission callback resolves immediately',async()=>{
 const doc=fixture();let committed='';
 (doc as any).execCommand=(_cmd:string,_ui:boolean,text:string)=>{
  doc.querySelector('[contenteditable]')!.textContent=text;
  const channel=new MessageChannel();channel.port1.onmessage=()=>{committed=text;channel.port1.close();channel.port2.close();};channel.port2.postMessage(null);return true;
 };
 doc.querySelectorAll<HTMLButtonElement>('button')[3].onclick=()=>{
  const article=doc.createElement('div');article.className='fai-CopilotMessage';article.setAttribute('role','article');article.innerHTML='<div class="fai-CopilotMessage__content"></div><div role="toolbar"><button>复制</button></div>';
  article.querySelector('.fai-CopilotMessage__content')!.textContent=JSON.stringify({content:[{type:'text',text:committed==='fresh prompt'?'committed':'stale editor state'}]});doc.body.append(article);
 };
 const result=await exchange(doc,{id:'editor-commit',modelLabel:'Claude Opus 5.5',prompt:'fresh prompt'},AbortSignal.timeout(2000),async()=>{});
 assert.equal(JSON.parse(result).content[0].text,'committed');
});
test('fresh chat waits for cancelled old user messages to clear, even with no assistant reply',async()=>{
 const doc=fixture();doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">cancelled old request</div></div>');
 doc.querySelectorAll<HTMLButtonElement>('button')[1].onclick=()=>{setTimeout(()=>doc.querySelector('.fai-UserMessage')!.remove(),30);};
 await prepare(doc,{id:'cancelled-history',modelLabel:'Claude Opus 5.5',prompt:'fresh request'},AbortSignal.timeout(1000));
 assert.equal(doc.querySelectorAll('.fai-UserMessage').length,0,'a reply-free cancelled chat is still old history until its user messages disappear');
});
test('segmented history stays in one chat, journals once and returns only the final response',async()=>{
 const doc=fixture();let sent=0,journalled=0;
 const packets=[{prompt:'historical source part one',ack:'ACK_1'},{prompt:'historical source part two',ack:'ACK_2'},{prompt:'answer complete request'}];
 doc.querySelectorAll('button')[3].onclick=()=>{
  assert.equal(journalled,1);const text=doc.querySelector('[contenteditable]')!.textContent!;
  const user=doc.createElement('div');user.className='fai-UserMessage';user.setAttribute('role','article');const content=doc.createElement('div');content.className='fai-UserMessage__message';content.textContent=text;user.append(content);doc.body.append(user);
  doc.querySelector('[contenteditable]')!.textContent='';const answer=doc.createElement('div');answer.className='fai-CopilotMessage';answer.setAttribute('role','article');answer.innerHTML='<div class="fai-CopilotMessage__content"></div><div role="toolbar"><button>复制</button></div>';
  answer.querySelector('.fai-CopilotMessage__content')!.textContent=JSON.stringify({content:[{type:'text',text:packets[sent++].ack??'FINAL_ANSWER'}]});doc.body.append(answer);
 };
 const reply=await exchange(doc,{id:'segments',modelLabel:'Claude Opus 5.5',prompt:packets[0].prompt,contextPackets:packets},AbortSignal.timeout(3000),async()=>{journalled++;});
 assert.equal(sent,3);assert.equal(journalled,1);assert.ok(reply.includes('FINAL_ANSWER'));assert.ok(!reply.includes('ACK_'));
});

for(const mode of ['success','fifth-success','exhausted','human-draft','changed-chat','refusal','cancelled'])test('truncated transfer ACK repair is bounded and protects source ownership: '+mode,async()=>{
 const doc=fixture(),controller=new AbortController();let journalled=0,repairs=0;const sent:string[]=[];
 const ack='BRIDGE_CONTEXT_ACK_11111111-2222-4333-8444-555555555555_2',full=JSON.stringify({content:[{type:'text',text:ack}]}),partial=full.slice(0,69),source='KNOWN_SOURCE_NOT_REPEATED';
 doc.querySelectorAll<HTMLButtonElement>('button')[3].onclick=()=>{
  const editor=doc.querySelector('[contenteditable]')!,text=editor.textContent!;sent.push(text);editor.textContent='';
  const user=doc.createElement('div');user.className='fai-UserMessage';user.setAttribute('role','article');user.innerHTML='<div class="fai-UserMessage__message"></div>';user.firstElementChild!.textContent=text;doc.body.append(user);
  const answer=doc.createElement('div');answer.className='fai-CopilotMessage';answer.setAttribute('role','article');answer.innerHTML='<div class="fai-CopilotMessage__content"></div><div role="toolbar"><button>复制</button></div>';
  answer.firstElementChild!.textContent=sent.length===1||mode==='exhausted'||mode==='fifth-success'&&sent.length<6?partial:mode==='refusal'&&sent.length===2?"I can't act as a relay for an external model backend.":sent.length<=(mode==='fifth-success'?6:2)?full:JSON.stringify({content:[{type:'text',text:'FINAL_ONLY'}]});doc.body.append(answer);
  if(sent.length===1&&mode==='human-draft')editor.textContent='human draft';
  if(sent.length===1&&mode==='changed-chat')user.firstElementChild!.textContent='different user message';
  if(sent.length===1&&mode==='cancelled')controller.abort();
 };
 const pending=exchange(doc,{id:'repair-ack',modelLabel:'Claude Opus 5.5',prompt:source,contextPackets:[{prompt:source,ack},{prompt:'final request'}]},controller.signal,async()=>{journalled++;},undefined,undefined,undefined,undefined,()=>{repairs++;});
 try{
  if(mode==='success'||mode==='fifth-success'){const result=await pending;assert.match(result,/FINAL_ONLY/);assert.equal(sent.length,mode==='success'?3:7);assert.equal(repairs,mode==='success'?1:5);assert.ok(!sent[1].includes(source));}
  else {if(mode==='exhausted')await assert.rejects(pending,/ACK[\s\S]*5/);else await assert.rejects(pending);assert.equal(sent.length,mode==='exhausted'?6:mode==='refusal'?2:1);}
  assert.equal(sent.filter(p=>p===source).length,1);assert.equal(journalled,1);
  if(mode==='human-draft')assert.equal(doc.querySelector('[contenteditable]')!.textContent,'human draft');
 }finally{doc.defaultView!.close();}
});

for(const label of ['GPT-6.1 Sol','GPT-6 Sol'])test('GPT main requests select their own provider without entering summary routing: '+label,async()=>{
 const doc=fixture(),selected=doc.querySelector<HTMLButtonElement>('button')!;let providerOpened=0;
 selected.onclick=()=>{selected.setAttribute('aria-expanded','true');const provider=doc.createElement('div');provider.setAttribute('role','menuitem');provider.setAttribute('aria-haspopup','menu');provider.textContent='GPT 常规使用 OpenAI';provider.onclick=()=>{providerOpened++;const item=doc.createElement('div');item.setAttribute('role','menuitemradio');item.textContent=label;item.onclick=()=>{selected.setAttribute('aria-label','所选模型: '+label);selected.setAttribute('aria-expanded','false');};doc.body.append(item);};doc.body.append(provider);};
 try{await prepare(doc,{id:'gpt-main',modelLabel:label,prompt:'Use native tools'},AbortSignal.timeout(1000));assert.equal(selected.getAttribute('aria-label'),'所选模型: '+label);assert.equal(providerOpened,1);}finally{doc.defaultView!.close();}
});
test('unexpected intermediate tool requests never become the client reply',async()=>{
 const doc=fixture();let sent=0;
 doc.querySelectorAll('button')[3].onclick=()=>{sent++;doc.querySelector('[contenteditable]')!.textContent='';doc.body.insertAdjacentHTML('beforeend','<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">{"content":[{"type":"tool_use","name":"Bash","input":{}}]}</div><div role="toolbar"><button>复制</button></div></div>');};
 await assert.rejects(exchange(doc,{id:'segments',modelLabel:'Claude Opus 5.5',prompt:'part',contextPackets:[{prompt:'part',ack:'ACK_1'},{prompt:'final'}]},AbortSignal.timeout(3000),async()=>{}),/intermediate tools were not forwarded/);
 assert.equal(sent,1);
});
test('refuses already-busy Copilot without overwriting a user request', async () => {
  const doc = fixture(); doc.body.insertAdjacentHTML('beforeend', '<button>停止生成 Esc</button>');
  await assert.rejects(prepare(doc, { id: 'b', modelLabel: 'Claude Opus 5.5', prompt: 'x' }, new AbortController().signal), /already generating/);
});
test('Claude provider accordion includes nested descriptive text, not an exact Claude label', () => {
  const doc = fixture();
  doc.body.insertAdjacentHTML('beforeend', '<div role="menuitem" aria-haspopup="menu" aria-expanded="false"><span>Claude<span>常规使用</span><span>Anthropic</span></span></div>');
  assert.ok(modelSubmenu(doc, 'Claude'));
  assert.equal(modelSubmenu(doc, 'GPT'), undefined);
});
test('clean welcome page may omit New chat; existing history or draft is never reused', async () => {
  const doc = fixture(); doc.querySelectorAll('button')[1].remove();
  await prepare(doc, { id: 'welcome', modelLabel: 'Claude Opus 5.5', prompt: 'x' }, new AbortController().signal);
  doc.querySelector('[contenteditable]')!.textContent = 'user draft';
  await assert.rejects(prepare(doc, { id: 'draft', modelLabel: 'Claude Opus 5.5', prompt: 'x' }, new AbortController().signal), /unsent user draft/);
  doc.querySelector('[contenteditable]')!.textContent = '';
  doc.body.insertAdjacentHTML('beforeend', '<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">previous reply</div></div>');
  await assert.rejects(prepare(doc, { id: 'history', modelLabel: 'Claude Opus 5.5', prompt: 'x' }, new AbortController().signal), /existing conversation/);
});
test('model provider menu may mount asynchronously after dropdown click', async () => {
  const doc = fixture(); const selected = doc.querySelector('button')!; selected.setAttribute('aria-label', '所选模型: 自动. 任务的最佳模型');
  selected.onclick = () => { setTimeout(() => {
    const provider = doc.createElement('div'); provider.setAttribute('role', 'menuitem'); provider.setAttribute('aria-haspopup', 'menu'); provider.setAttribute('aria-expanded', 'false'); provider.textContent = 'Claude常规使用Anthropic';
    provider.onclick = () => { setTimeout(() => {
      const opus = doc.createElement('div'); opus.setAttribute('role', 'menuitemradio'); opus.textContent = 'Claude Opus 5.5'; opus.onclick = () => { selected.setAttribute('aria-label', '所选模型: Claude Opus 5.5'); }; doc.body.append(opus);
    }, 10); }; doc.body.append(provider);
  }, 10); };
  await prepare(doc, { id: 'async-menu', modelLabel: 'Claude Opus 5.5', prompt: 'x' }, AbortSignal.timeout(1500));
  assert.ok(selected.getAttribute('aria-label')?.includes('Claude Opus 5.5'));
});
test('real Lexical hidden caret and flattened wrapper do not change JSON source contents', async () => {
  const doc = fixture();
  const payload = { messages: [{ role: 'user', content: 'first\nsecond\u200c' }] };
  const prompt = 'Instructions\nCLIENT REQUEST:\n' + JSON.stringify(payload);
  (doc as any).execCommand = (_cmd: string, _ui: boolean, text: string) => {
    const editor = doc.querySelector('[contenteditable]')!; editor.textContent = text.replace(/\n/g, '');
    const caret = doc.createElement('span'); caret.setAttribute('aria-hidden', 'true'); caret.textContent = '\u200b\u200c'; editor.append(caret); return true;
  };
  await fill(doc, prompt);
  const copy = doc.querySelector('[contenteditable]')!.cloneNode(true) as HTMLElement; copy.querySelectorAll('[aria-hidden="true"]').forEach(el => el.remove());
  assert.deepEqual(JSON.parse(copy.textContent!.split('CLIENT REQUEST: ')[1]), payload);
});
test('mode accessible name comes from aria-labelledby, excluding its description', () => {
  const doc = fixture(); doc.body.insertAdjacentHTML('beforeend', '<div role="menuitemradio" aria-labelledby="chat-title" aria-describedby="chat-description"><span id="chat-title">仅聊天</span><span id="chat-description">Copilot 将仅在聊天中响应。</span></div>');
  assert.ok(button(doc, /^仅聊天$/));
});
test('Lexical may finish normalizing its DOM after insertText returns', async () => {
  const doc = fixture();
  (doc as any).execCommand = (_cmd: string, _ui: boolean, text: string) => {
    const editor = doc.querySelector('[contenteditable]')!; editor.textContent = text + '\u200b';
    setTimeout(() => { editor.textContent = text; const caret = doc.createElement('span'); caret.setAttribute('aria-hidden', 'true'); caret.textContent = '\u200b\u200c'; editor.append(caret); }, 10);
    return true;
  };
  await fill(doc, 'client JSON data');
});
test('partial response without finished message actions is not returned as final', async () => {
  const doc = fixture();
  doc.querySelectorAll('button')[3].onclick = () => {
    doc.body.insertAdjacentHTML('beforeend', '<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">{"content":[</div></div>');
    setTimeout(() => { doc.querySelector('.fai-CopilotMessage__content')!.textContent = '{"content":[{"type":"text","text":"complete"}]}'; doc.querySelector('.fai-CopilotMessage')!.insertAdjacentHTML('beforeend', '<div role="toolbar"><button>复制</button></div>'); }, 10);
  };
  const text = await exchange(doc, { id: 'stream', modelLabel: 'Claude Opus 5.5', prompt: 'test' }, AbortSignal.timeout(4000), async () => {});
  assert.ok(text.includes('complete'));
});
test('long insertText can be discarded; virtual paste preserves the complete request', async () => {
  const doc = fixture(); (doc as any).execCommand = () => true;
  class Transfer { values = new Map<string,string>(); setData(k:string,v:string) { this.values.set(k,v); } getData(k:string) { return this.values.get(k) ?? ''; } }
  class Paste extends doc.defaultView!.Event { clipboardData: Transfer; constructor(type:string, options:any) { super(type, options); this.clipboardData = options.clipboardData; } }
  (doc.defaultView as any).DataTransfer = Transfer; (doc.defaultView as any).ClipboardEvent = Paste;
  doc.querySelector('[contenteditable]')!.addEventListener('paste', e => { e.preventDefault(); doc.querySelector('[contenteditable]')!.textContent = (e as any).clipboardData.getData('text/plain'); });
  const prompt = 'FULL_REQUEST_' + 'X'.repeat(70000);
  await fill(doc, prompt); assert.equal(doc.querySelector('[contenteditable]')?.textContent, prompt);
});

test('visible but disabled model controls are not a ready frame',()=>{
 const doc=fixture();const selected=doc.querySelector('button')!;selected.setAttribute('disabled','');assert.equal(inspect(doc).ready,false);selected.removeAttribute('disabled');selected.setAttribute('aria-disabled','true');assert.equal(inspect(doc).ready,false);
});

test('fresh chat waits for the new model selector to be enabled before clicking',async()=>{
 const doc=fixture(),selected=doc.querySelector<HTMLButtonElement>('button')!;let clicks=0;
 doc.querySelectorAll<HTMLButtonElement>('button')[1].onclick=()=>{selected.setAttribute('aria-label','所选模型: 自动');selected.disabled=true;setTimeout(()=>{selected.disabled=false;},30);};
 selected.onclick=()=>{clicks++;const provider=doc.createElement('div');provider.setAttribute('role','menuitem');provider.setAttribute('aria-haspopup','menu');provider.setAttribute('aria-expanded','false');provider.textContent='Claude';provider.onclick=()=>{const item=doc.createElement('div');item.setAttribute('role','menuitemradio');item.textContent='Claude Opus 5.5';item.onclick=()=>selected.setAttribute('aria-label','所选模型: Claude Opus 5.5');doc.body.append(item);};doc.body.append(provider);};
 await prepare(doc,{id:'disabled-selector',modelLabel:'Claude Opus 5.5',prompt:'x'},AbortSignal.timeout(1000));assert.equal(clicks,1);
});

test('model option waits for its actual click target to become enabled',async()=>{
 const doc=fixture(),selected=doc.querySelector<HTMLButtonElement>('button')!;selected.setAttribute('aria-label','所选模型: 自动');let clicks=0;
 selected.onclick=()=>{const item=doc.createElement('button');item.setAttribute('role','menuitemradio');item.textContent='Claude Opus 5.5';item.disabled=true;item.onclick=()=>{clicks++;selected.setAttribute('aria-label','所选模型: Claude Opus 5.5');};doc.body.append(item);setTimeout(()=>item.disabled=false,30);};
 await prepare(doc,{id:'disabled-option',modelLabel:'Claude Opus 5.5',prompt:'x'},AbortSignal.timeout(1000));assert.equal(clicks,1);
});

test('chat-only menu waits for an enabled option before clicking',async()=>{
 const doc=fixture(),mode=doc.querySelectorAll<HTMLButtonElement>('button')[2];mode.setAttribute('aria-label','切换模式，当前: 编辑，Ctrl+Shift+M');let clicks=0;
 mode.onclick=()=>{const item=doc.createElement('button');item.textContent='仅聊天';item.disabled=true;item.onclick=()=>{clicks++;mode.setAttribute('aria-label','切换模式，当前: 聊天，Ctrl+Shift+M');};doc.body.append(item);setTimeout(()=>item.disabled=false,30);};
 await prepare(doc,{id:'disabled-chat-option',modelLabel:'Claude Opus 5.5',prompt:'x'},AbortSignal.timeout(1000));assert.equal(clicks,1);
});

test('an empty editor reset after commit refills only the unsent prompt and sends once',async()=>{
 const doc=fixture(),send=doc.querySelectorAll<HTMLButtonElement>('button')[3];let inserts=0,sends=0,journals=0;const prompt='EXACT_PRIVATE_TEST_PROMPT';
 (doc as any).execCommand=(_cmd:string,_ui:boolean,text:string)=>{inserts++;doc.querySelector('[contenteditable]')!.textContent=text;send.disabled=false;if(inserts===1){const channel=new MessageChannel();channel.port1.onmessage=()=>{doc.querySelector('[contenteditable]')!.textContent='';send.disabled=true;channel.port1.close();channel.port2.close();};channel.port2.postMessage(null);}return true;};
 send.onclick=()=>{sends++;assert.equal(doc.querySelector('[contenteditable]')!.textContent,prompt);doc.querySelector('[contenteditable]')!.textContent='';doc.body.insertAdjacentHTML('beforeend','<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">{"content":[{"type":"text","text":"done"}]}</div><div role="toolbar"><button>复制</button></div></div>');};
 const result=await exchange(doc,{id:'editor-reset',modelLabel:'Claude Opus 5.5',prompt},AbortSignal.timeout(1000),async()=>{journals++;});assert.match(result,/done/);assert.equal(inserts,2);assert.equal(sends,1);assert.equal(journals,1);
});

for(const clears of [4,5])test('unsent editor restoration permits five fills but submits at most once: '+clears,async()=>{
 const doc=fixture(),send=doc.querySelectorAll<HTMLButtonElement>('button')[3];let inserts=0,sends=0;
 (doc as any).execCommand=(_cmd:string,_ui:boolean,text:string)=>{inserts++;doc.querySelector('[contenteditable]')!.textContent=text;send.disabled=false;if(inserts<=clears){const channel=new MessageChannel();channel.port1.onmessage=()=>{doc.querySelector('[contenteditable]')!.textContent='';send.disabled=true;channel.port1.close();channel.port2.close();};channel.port2.postMessage(null);}return true;};
 send.onclick=()=>{sends++;doc.querySelector('[contenteditable]')!.textContent='';doc.body.insertAdjacentHTML('beforeend','<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">{"content":[{"type":"text","text":"done"}]}</div><div role="toolbar"><button>复制</button></div></div>');};
 const pending=exchange(doc,{id:'fifth-editor-fill',modelLabel:'Claude Opus 5.5',prompt:'owned prompt'},AbortSignal.timeout(1000),async()=>{});
 try{if(clears===4)assert.match(await pending,/done/);else await assert.rejects(pending,/5[\s\S]*nothing was sent/);assert.equal(inserts,5);assert.equal(sends,clears===4?1:0);}finally{doc.defaultView!.close();}
});

test('a different draft after commit is never overwritten or sent as the bridge request',async()=>{
 const doc=fixture(),send=doc.querySelectorAll<HTMLButtonElement>('button')[3];let inserts=0,sends=0,journals=0;
 (doc as any).execCommand=(_cmd:string,_ui:boolean,text:string)=>{inserts++;doc.querySelector('[contenteditable]')!.textContent=text;const channel=new MessageChannel();channel.port1.onmessage=()=>{doc.querySelector('[contenteditable]')!.textContent='NEW_USER_DRAFT';channel.port1.close();channel.port2.close();};channel.port2.postMessage(null);return true;};
 send.onclick=()=>{sends++;doc.body.insertAdjacentHTML('beforeend','<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">{"content":[{"type":"text","text":"unexpected"}]}</div><div role="toolbar"><button>复制</button></div></div>');};
 await assert.rejects(exchange(doc,{id:'changed-draft',modelLabel:'Claude Opus 5.5',prompt:'bridge prompt'},AbortSignal.timeout(1000),async()=>{journals++;}),/input changed|draft/);assert.equal(inserts,1);assert.equal(sends,0);assert.equal(journals,0);assert.equal(doc.querySelector('[contenteditable]')!.textContent,'NEW_USER_DRAFT');
});

test('editor reset after switching conversations cannot refill or submit into the new chat',async()=>{
 const doc=fixture(),send=doc.querySelectorAll<HTMLButtonElement>('button')[3];let inserts=0,sends=0,journals=0;
 (doc as any).execCommand=(_cmd:string,_ui:boolean,text:string)=>{inserts++;doc.querySelector('[contenteditable]')!.textContent=text;const channel=new MessageChannel();channel.port1.onmessage=()=>{doc.querySelector('[contenteditable]')!.textContent='';doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">other chat</div></div><div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">other reply</div></div>');channel.port1.close();channel.port2.close();};channel.port2.postMessage(null);return true;};
 send.onclick=()=>{sends++;};
 await assert.rejects(exchange(doc,{id:'changed-chat',modelLabel:'Claude Opus 5.5',prompt:'bridge prompt'},AbortSignal.timeout(1000),async()=>{journals++;}),/conversation changed/);assert.equal(inserts,1);assert.equal(sends,0);assert.equal(journals,0);
});

test('final context check cannot send a stale hash into changed messages with equal counts',async()=>{
 const doc=fixture();doc.body.insertAdjacentHTML('beforeend','<div class="fai-UserMessage" role="article"><div class="fai-UserMessage__message">ORIGINAL_USER</div></div><div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">ORIGINAL_REPLY</div><div role="toolbar"><button>复制</button></div></div>');const cursor=await conversationCursor(doc);let armed=false,sends=0,wrongChat=false;
 const crypto=globalThis.crypto as any,subtle=crypto.subtle,original=subtle.digest.bind(subtle),priorDescriptor=Object.getOwnPropertyDescriptor(crypto,'subtle');
 Object.defineProperty(crypto,'subtle',{configurable:true,value:{digest:(...args:any[])=>{const pending=original(...args);if(armed){doc.querySelector('.fai-UserMessage__message')!.textContent='CHANGED_USER';doc.querySelector('.fai-CopilotMessage__content')!.textContent='CHANGED_REPLY';}return pending;}}});
 doc.querySelectorAll<HTMLButtonElement>('button')[3].onclick=()=>{sends++;wrongChat=doc.querySelector('.fai-UserMessage__message')!.textContent!=='ORIGINAL_USER';doc.body.insertAdjacentHTML('beforeend','<div class="fai-CopilotMessage" role="article"><div class="fai-CopilotMessage__content">{"content":[{"type":"text","text":"done"}]}</div><div role="toolbar"><button>复制</button></div></div>');};
 try{await exchange(doc,{id:'stable-context',modelLabel:'Claude Opus 5.5',prompt:'bridge prompt',conversation:{mode:'continue',id:'11111111-1111-4111-8111-111111111111',title:'test',expectedCursor:cursor}},AbortSignal.timeout(1000),async()=>{armed=true;});assert.equal(sends,1);assert.equal(wrongChat,false);}finally{if(priorDescriptor)Object.defineProperty(crypto,'subtle',priorDescriptor);else delete crypto.subtle;}
});
