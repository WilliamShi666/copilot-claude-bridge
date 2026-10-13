import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inspect, replyText, exchange, prepare, modelSubmenu, fill, button } from '../packages/chrome-extension/adapter.js';
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
