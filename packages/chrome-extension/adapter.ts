// Only the Copilot add-in DOM is operated. No cookies, tokens or workbook cells are accessed.
import type { ConversationCommand,ConversationReceipt } from '../protocol/conversation.js';
import type {ContextPacket} from '../protocol/transfer.js';
import {runSummaryChain,providerRestriction,type SummaryAttempt} from '../protocol/summary.js';
export interface BrowserJob { id: string; modelLabel: string; prompt: string; conversation?:ConversationCommand;contextPackets?:ContextPacket[];summary?:boolean }
const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
function visible(el: Element): boolean { return !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && (el as HTMLElement).style.display !== 'none' && el.getClientRects().length > 0; }
export function elements(doc: Document, selector: string): HTMLElement[] { return [...doc.querySelectorAll<HTMLElement>(selector)].filter(visible); }
function label(el: HTMLElement): string {
  const explicit = el.getAttribute('aria-label'); if (explicit !== null) return normalize(explicit);
  const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
  return normalize(labelled || el.innerText || el.textContent || '');
}
export function button(doc: Document, name: RegExp): HTMLElement | undefined { return elements(doc, 'button,[role="button"],[role="menuitem"],[role="menuitemradio"],a').find(el => name.test(label(el))); }
function enabled(el:HTMLElement|undefined):el is HTMLElement{return !!el&&!el.hasAttribute('disabled')&&el.getAttribute('aria-disabled')!=='true';}
export function input(doc: Document): HTMLElement | undefined { return elements(doc, '[role="combobox"][contenteditable="true"],[role="textbox"][contenteditable="true"],textarea').find(el => /聊天输入|Chat input|Message Copilot|Ask Copilot/i.test(label(el)) || /聊天输入|Message Copilot/i.test(el.getAttribute('placeholder') ?? '')); }
export function modelButton(doc: Document): HTMLElement | undefined { return button(doc, /^(所选模型:|Selected model:)/i); }
export function modelSubmenu(doc: Document, provider: string): HTMLElement | undefined {
  return elements(doc, '[role="menuitem"][aria-haspopup="menu"]').find(el => label(el).startsWith(provider));
}
export function isChatOnly(doc: Document): boolean { return !!button(doc, /^(切换模式，当前: (聊天|仅聊天)，|Switch mode.*(?:Chat only|Chat)(?:,|$))/i); }
export function replyText(doc: Document): string[] { return elements(doc, '.fai-CopilotMessage[role="article"]').map(el => normalize((el.querySelector('.fai-CopilotMessage__content') as HTMLElement | null)?.innerText ?? el.querySelector('.fai-CopilotMessage__content')?.textContent ?? el.innerText ?? el.textContent ?? '').replace(/^Copilot said:\s*/, '')); }
export function inspect(doc: Document) { return { ready: enabled(input(doc)) && enabled(modelButton(doc)) && !button(doc, /^(停止生成|Stop generating)/i), model: modelButton(doc) ? label(modelButton(doc)!) : null, chatOnly: isChatOnly(doc),conversationControl:true,conversationResumability:'active-chat-only' }; }
function until<T>(doc:Document,fn: () => T | undefined | false | Promise<T|undefined|false>, signal: AbortSignal, timeout = 15000,phase='control'): Promise<T> {
  signal.throwIfAborted();
  // Hidden Chrome tabs can defer chained timers for a minute. DOM mutations
  // provide progress directly; the timer is only a deadline, never a poll tick.
  return new Promise<T>((resolve,reject)=>{
    const deadline=Date.now()+timeout;let ended=false,checking=false,recheck=false,expired=false;
    const events=['visibilitychange','transitionend','animationend'];
    const finish=(value?:T,error?:unknown)=>{
      if(ended)return;ended=true;observer.disconnect();clearTimeout(timer);signal.removeEventListener('abort',abort);
      for(const event of events)doc.removeEventListener(event,check);
      if(error!==undefined)reject(error);else resolve(value!);
    };
    const abort=()=>finish(undefined,signal.reason??new Error('Copilot request aborted'));
    const check=()=>{
      if(ended)return;if(checking){recheck=true;return;}checking=true;
      void(async()=>{
        try{
          do{
            recheck=false;signal.throwIfAborted();const value=await fn();
            if(ended)return;
            // Revalidate if the DOM changed while an asynchronous hash ran.
            if(recheck)continue;
            if(value){finish(value);return;}
            if(expired||Date.now()>=deadline){finish(undefined,new Error('Copilot UI '+phase+' did not become ready '+JSON.stringify({input:!!input(doc),model:modelButton(doc)?label(modelButton(doc)!):null,modelEnabled:enabled(modelButton(doc)),chatOnly:isChatOnly(doc),userMessages:elements(doc,'.fai-UserMessage[role="article"]').length,assistantMessages:replyText(doc).length,draftChars:draftText(doc).length,sendEnabled:enabled(button(doc,/^(发送|Send)(?:\s|$)/i))})));return;}
          }while(recheck&&!ended);
        }catch(error){finish(undefined,error);}
        finally{checking=false;}
      })();
    };
    const observer=new doc.defaultView!.MutationObserver(check);
    observer.observe(doc.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});
    const timer=setTimeout(()=>{expired=true;check();},timeout);
    signal.addEventListener('abort',abort,{once:true});for(const event of events)doc.addEventListener(event,check);
    check();
  });
}
function editorText(doc:Document):string {
 const editor=input(doc);if(!editor)return '';
 if(editor instanceof doc.defaultView!.HTMLTextAreaElement)return editor.value;
 const copy=editor.cloneNode(true) as HTMLElement;copy.querySelectorAll('[aria-hidden="true"]').forEach(n=>n.remove());return copy.textContent??'';
}
function draftText(doc:Document){return normalize(editorText(doc));}
function conversationEvidence(doc:Document):string {
  const user=elements(doc,'.fai-UserMessage[role="article"]').at(-1),assistant=elements(doc,'.fai-CopilotMessage[role="article"]').at(-1);
  if(!user||!assistant)throw new Error('Conversation message evidence is unavailable');
  const text=(element:HTMLElement,selector:string)=>normalize(element.querySelector(selector)?.textContent??element.textContent??'').replace(/\s+/g,' ');
  return JSON.stringify([text(user,'.fai-UserMessage__message'),text(assistant,'.fai-CopilotMessage__content')]);
}
export async function conversationCursor(doc:Document):Promise<string> {
  const bytes=new TextEncoder().encode(conversationEvidence(doc));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function matchesConversation(doc:Document,cursor:string) {
  if(!elements(doc,'.fai-UserMessage[role="article"]').length||!elements(doc,'.fai-CopilotMessage[role="article"]').length)return false;
  return await conversationCursor(doc)===cursor;
}
async function waitForConversation(doc:Document,cursor:string,signal:AbortSignal,previousUser?:HTMLElement) {
  await until(doc,async()=>{
    const user=elements(doc,'.fai-UserMessage[role="article"]').at(-1);
    return !!user&&(!previousUser||user!==previousUser)&&await matchesConversation(doc,cursor);
  },signal);
}
function closeNavigation(doc:Document){button(doc,/^(关闭导航|Close navigation)$/i)?.click();}
async function restoreConversation(doc:Document,command:ConversationCommand,signal:AbortSignal) {
  if(!command.expectedCursor)throw new Error('Continuation requires verified conversation evidence');
  try {await waitForConversation(doc,command.expectedCursor,signal);}
  catch {throw new Error('Original Copilot conversation is no longer active or its messages changed; no new chat or continuation message was submitted');}
}
export async function captureConversation(doc:Document,job:BrowserJob,signal:AbortSignal):Promise<ConversationReceipt|undefined> {
  const command=job.conversation;if(!command)return undefined;
  const expectedCursor=await conversationCursor(doc);
  await waitForConversation(doc,expectedCursor,signal);
  // The label is local bridge metadata, not a claimed Office history title.
  return {id:command.id,title:command.title,cursor:expectedCursor,resumability:'active-chat-only'};
}
async function clickMenuItem(doc: Document, text: string, signal: AbortSignal) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const find = () => {const match=button(doc,new RegExp('^'+escaped+'$'))??elements(doc,'[role="menu"] span,[role="menu"] div').find(el=>normalize(el.textContent??'')===text);const target=match?.closest<HTMLElement>('button,[role="menuitem"],[role="menuitemradio"]')??match;return enabled(target)?target:undefined;};
  const el = await until(doc,find, signal,15000,'model option');
  el.click();
}
export async function prepare(doc: Document, job: BrowserJob, signal: AbortSignal): Promise<void> {
  if (button(doc, /^(停止生成|Stop generating)/i)) throw new Error('Copilot is already generating; no new message was submitted');
  if (!inspect(doc).ready) throw new Error('Open Copilot in the selected Excel tab first');
  if(draftText(doc))throw new Error('Copilot has an unsent user draft; message was not overwritten');
  closeNavigation(doc); // Do not reuse a drawer list fetched before the new message.
  if(job.conversation?.mode==='continue')await restoreConversation(doc,job.conversation,signal);
  else {
  const newChat = button(doc, /^(新建聊天|New chat)$/i);
  if (newChat) { const control=await until(doc,()=>{const current=button(doc,/^(新建聊天|New chat)$/i);return enabled(current)?current:undefined;},signal);control.click(); await until(doc,() => replyText(doc).length === 0 && elements(doc,'.fai-UserMessage[role="article"]').length === 0 && !!input(doc), signal,15000,'fresh chat history'); }
  else if (replyText(doc).length || elements(doc, '.fai-UserMessage[role="article"]').length) throw new Error('New chat control missing from an existing conversation; session isolation cannot be guaranteed');
  // The initial welcome screen has no New chat button and already contains no history.
  else if (normalize(input(doc)?.innerText ?? input(doc)?.textContent ?? '')) throw new Error('Copilot has an unsent user draft; message was not overwritten');
  }
  if(draftText(doc))throw new Error('The restored conversation has an unsent user draft; it was not overwritten');
  let selected = await until(doc,() => {const current=modelButton(doc);return enabled(current)?current:undefined;}, signal,15000,'model selector');
  if (!label(selected).includes(job.modelLabel)) {
    if(selected.getAttribute('aria-expanded')!=='true')selected.click();
    const itemName = new RegExp('^' + job.modelLabel.replaceAll('.', '\\.') + '$');
    const menu = await until(doc,() => {const current=button(doc,itemName)??modelSubmenu(doc,job.modelLabel.startsWith('GPT-')?'GPT':'Claude');return enabled(current)?current:undefined;}, signal,15000,'model provider menu');
    if (menu.getAttribute('aria-haspopup') === 'menu' && menu.getAttribute('aria-expanded') !== 'true') menu.click();
    await clickMenuItem(doc, job.modelLabel, signal);
    await until(doc,() => modelButton(doc) && label(modelButton(doc)!).includes(job.modelLabel), signal,15000,'selected model');
  }
  if (!isChatOnly(doc)) {
    const mode = await until(doc,()=>{const current=button(doc,/^(切换模式|Switch mode)/i);return enabled(current)?current:undefined;},signal);mode.click();
    const chat = await until(doc,() => {const current=button(doc,/^(仅聊天|Chat only)$/i);return enabled(current)?current:undefined;}, signal,15000,'chat mode option'); chat.click();
    await until(doc,() => isChatOnly(doc), signal,15000,'chat mode confirmation');
  }
}
export async function fill(doc: Document, prompt: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const editor = input(doc); if (!editor) throw new Error('Chat input missing');
  // All request data is JSON-stringified: line breaks INSIDE source/system strings
  // are escaped backslash-n. Only presentation line breaks outside JSON are flattened.
  const wirePrompt = prompt.replace(/\r?\n/g, ' ');
  editor.focus();
  if (editor instanceof doc.defaultView!.HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(doc.defaultView!.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(editor, wirePrompt); editor.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
  } else {
    const selection = doc.defaultView!.getSelection(); const range = doc.createRange(); range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range);
    // Native edit operation triggers Lexical's real input path; no remote page script injection.
    if (!doc.execCommand('insertText', false, wirePrompt)) throw new Error('Browser did not accept the chat input');
  }
  const read = () => editorText(doc);
  try { await until(doc,() => read() === wirePrompt, signal, 3000); }
  catch (error) {
    if (signal.aborted) throw error;
    if (read() !== '') throw new Error(`Copilot input was altered or truncated; message was not sent (expected ${wirePrompt.length} characters, read ${read().length})`);
    // Some Lexical paths discard a large native insertText. Supply only this
    // request's known text as a virtual paste; never read the user's clipboard.
    const current = input(doc); if (!current) throw new Error('Copilot input disappeared');
    current.focus(); const range = doc.createRange(); range.selectNodeContents(current);
    const selection = doc.defaultView!.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    const transfer = new doc.defaultView!.DataTransfer(); transfer.setData('text/plain', wirePrompt);
    current.dispatchEvent(new doc.defaultView!.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    try { await until(doc,() => read() === wirePrompt, signal, 3000); }
    catch (failure) { if (signal.aborted) throw failure; throw new Error(`Copilot input was altered or truncated; message was not sent (expected ${wirePrompt.length} characters, read ${read().length})`); }
  }
}
export async function exchange(doc:Document,job:BrowserJob,signal:AbortSignal,beforeSend:()=>Promise<void>,onSummary:(model:string,attempts:SummaryAttempt[])=>void=()=>{},onAttempt:(attempt:SummaryAttempt)=>void=()=>{}):Promise<string>{
 if(!job.summary)return exchangeAttempt(doc,job,signal,beforeSend);
 if(job.conversation)throw new Error('Summary inference requires a fresh auxiliary conversation');
 let lastPrompt:string|undefined,submitted=false,journalled=false;
 const result=await runSummaryChain(async model=>{
  lastPrompt=undefined;submitted=false;
  return exchangeAttempt(doc,{...job,modelLabel:model},signal,async()=>{submitted=true;if(!journalled){await beforeSend();journalled=true;}},prompt=>{lastPrompt=prompt;});
 },async()=>{
  if(submitted)stop(doc);
  await until(doc,()=>!button(doc,/^(停止生成|Stop generating)/i),signal);
  const draft=draftText(doc);
  if(draft){if(lastPrompt===undefined||draft!==normalize(lastPrompt.replace(/\r?\n/g,' ')))throw new Error('A draft changed during summary fallback; it was not overwritten');await fill(doc,'',signal);}
 },signal,onAttempt);
 onSummary(result.model,result.attempts);return result.text;
}
async function exchangeAttempt(doc: Document, job: BrowserJob, signal: AbortSignal, beforeSend: () => Promise<void>,onPrompt:(prompt:string)=>void=()=>{}): Promise<string> {
  await prepare(doc, job, signal);
  if(!job.contextPackets)return exchangeOne(doc,job,job.prompt,signal,beforeSend,onPrompt);
  const packets=job.contextPackets;
  if(packets.length<2||packets.length>32||packets.some((p,i)=>typeof p.prompt!=='string'||p.prompt.length>350000||(i<packets.length-1?typeof p.ack!=='string':p.ack!==undefined)))throw new Error('Invalid segmented context transfer');
  let cursor:string|undefined,journalled=false,reply='';
  for(const packet of packets){
    signal.throwIfAborted();
    if(cursor&&!await matchesConversation(doc,cursor))throw new Error('Copilot conversation changed during context transfer');
    if(draftText(doc))throw new Error('A draft appeared during context transfer; it was not overwritten');
    reply=await exchangeOne(doc,job,packet.prompt,signal,async()=>{if(!journalled){await beforeSend();journalled=true;}},onPrompt);
    if(packet.ack){
      const clean=reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1');let value:any;
      try{value=JSON.parse(clean);}catch{throw new Error('Copilot context transfer acknowledgment is malformed');}
      if(Object.keys(value??{}).join(',')!=='content'||!Array.isArray(value.content)||value.content.length!==1||value.content[0].type!=='text'||value.content[0].text!==packet.ack||Object.keys(value.content[0]).sort().join(',')!=='text,type')throw new Error('Copilot did not acknowledge the exact context fragment; intermediate tools were not forwarded');
      cursor=await conversationCursor(doc);
    }
  }
  return reply;
}
async function exchangeOne(doc:Document,job:BrowserJob,prompt:string,signal:AbortSignal,beforeSend:()=>Promise<void>,onPrompt:(prompt:string)=>void=()=>{}):Promise<string>{
  onPrompt(prompt);
  const wirePrompt=prompt.replace(/\r?\n/g,' ');
  const users=()=>elements(doc,'.fai-UserMessage[role="article"]').length,assistants=()=>replyText(doc).length;
  const baseUsers=users(),baseAssistants=assistants();const baseEvidence=baseUsers&&baseAssistants?conversationEvidence(doc):undefined;
  const assertContext=()=>{if(users()!==baseUsers||assistants()!==baseAssistants||baseEvidence&&conversationEvidence(doc)!==baseEvidence)throw new Error('Copilot conversation changed before submission; nothing was sent');};
  const assertMode=()=>{const model=modelButton(doc);if(!isChatOnly(doc)||!model||!label(model).includes(job.modelLabel))throw new Error('Mode or model changed before submission');};
  let send:HTMLElement|undefined;
  for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();const existing=editorText(doc);if(existing!==''&&existing!==wirePrompt)throw new Error('Copilot input changed after preparation; the draft was not overwritten');
    assertContext();assertMode();const latest=editorText(doc);if(latest!==''&&latest!==wirePrompt)throw new Error('Copilot input changed after preparation; the draft was not overwritten');await fill(doc,prompt,signal);await editorCommit(doc,signal);
    const state=await until<{kind:'cleared'|'changed'|'ready';control?:HTMLElement}>(doc,()=>{
      const current=editorText(doc);if(current!==wirePrompt)return{kind:current===''?'cleared':'changed'};
      const control=button(doc,/^(发送|Send)(?:\s|$)/i);return enabled(control)?{kind:'ready',control}:undefined;
    },signal,15000,'send button');
    if(state.kind==='changed')throw new Error('Copilot input changed after preparation; the draft was not overwritten');
    if(state.kind==='cleared')continue;send=state.control;break;
  }
  if(!send)throw new Error('Copilot repeatedly cleared its editor before submission; nothing was sent');
  assertContext();assertMode();
  const previousReply=elements(doc,'.fai-CopilotMessage[role="article"]').at(-1),previousCount=replyText(doc).length;
  await beforeSend();signal.throwIfAborted();assertContext();assertMode();
  if(editorText(doc)!==wirePrompt)throw new Error('Copilot input changed before the send click; no changed draft was submitted');
  send=button(doc,/^(发送|Send)(?:\s|$)/i);if(!enabled(send))throw new Error('Copilot send control changed before the send click');send.click();
  const text=await until(doc,() => {
    if (button(doc, /^(停止生成|Stop generating)/i)) return undefined;
    const article = elements(doc, '.fai-CopilotMessage[role="article"]').at(-1);
    if (!article) return undefined;
    if(article===previousReply||replyText(doc).length<=previousCount)return undefined;
    // Message actions appear after completion; early thinking/stream chunks are not a reply.
    const actions = [...article.querySelectorAll<HTMLElement>('[role="toolbar"] button')].some(el => /^(复制|Copy)$/i.test(label(el)));
    const text = replyText(doc).at(-1) ?? '';
    return actions && text ? text : undefined;
  }, signal, 210000,'completed reply');
  const policy=providerRestriction(text);if(policy)throw new Error(policy);
  return text;
}
function editorCommit(doc:Document,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();
 // Lexical may update its DOM before committing the input state used by Send.
 // A fresh task lets its queued commit finish even when journaling is already
 // complete. MessageChannel is independent of throttled background timers.
 return new Promise((resolve,reject)=>{
  const Constructor=doc.defaultView?.MessageChannel??globalThis.MessageChannel;
  const channel=new Constructor();let done=false;
  const finish=(error?:unknown)=>{if(done)return;done=true;channel.port1.close();channel.port2.close();signal.removeEventListener('abort',abort);if(error)reject(error);else resolve();};
  const abort=()=>finish(signal.reason??new Error('Copilot request aborted'));
  signal.addEventListener('abort',abort,{once:true});channel.port1.onmessage=()=>finish();channel.port1.start();channel.port2.postMessage(null);
 });
}
export function stop(doc: Document): void { button(doc, /^(停止生成|Stop generating)/i)?.click(); }
