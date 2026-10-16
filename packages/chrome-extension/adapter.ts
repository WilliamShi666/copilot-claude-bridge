// Only the Copilot add-in DOM is operated. No cookies, tokens or workbook cells are accessed.
import type { ConversationCommand,ConversationReceipt,BrowserLane } from '../protocol/conversation.js';
import {TransportFailure,refusalKind,type CancelReceipt} from '../protocol/cancellation.js';
import type {ContextPacket} from '../protocol/transfer.js';
import type {BrowserImage} from '../protocol/images.js';
import {runSummaryChain,providerRestriction,type SummaryAttempt} from '../protocol/summary.js';
import {ImageInputFailure} from './image-input.js';
export interface BrowserJob { id: string; modelLabel: string; prompt: string; conversation?:ConversationCommand;contextPackets?:ContextPacket[];summary?:boolean;cancelContinuation?:1;lane?:BrowserLane;isolatedRecovery?:boolean;images?:BrowserImage[] }
export interface TurnObservation {pageInstance:string;prepared:boolean;beforeEvidence?:string;baseUsers:number;baseAssistants:number;wirePrompt:string;sendClicked:boolean;sentPackets:number;inputComplete:boolean;stableEvidence?:string;stableSince?:number;finished:boolean;stopRequested?:boolean}
const instances=new WeakMap<Document,string>();
export function pageInstance(doc:Document){let value=instances.get(doc);if(!value){value=globalThis.crypto.randomUUID();instances.set(doc,value);}return value;}
export function observeTurn(doc:Document):TurnObservation{return{pageInstance:pageInstance(doc),prepared:false,baseUsers:0,baseAssistants:0,wirePrompt:'',sendClicked:false,sentPackets:0,inputComplete:false,finished:false};}
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
    const events=['visibilitychange','transitionend','animationend','load'];
    const finish=(value?:T,error?:unknown)=>{
      if(ended)return;ended=true;observer.disconnect();clearTimeout(timer);signal.removeEventListener('abort',abort);
      for(const event of events)doc.removeEventListener(event,check,true);
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
    signal.addEventListener('abort',abort,{once:true});for(const event of events)doc.addEventListener(event,check,true);
    check();
  });
}
function editorText(doc:Document):string {
 const editor=input(doc);if(!editor)return '';
 if(editor instanceof doc.defaultView!.HTMLTextAreaElement)return editor.value;
 const copy=editor.cloneNode(true) as HTMLElement;copy.querySelectorAll('[aria-hidden="true"]').forEach(n=>n.remove());return copy.textContent??'';
}
export function imageDraftNames(doc:Document){return elements(doc,'button[aria-label]').map(el=>label(el).match(/^(?:移除|Remove)\s+(bridge-image-[a-f0-9]{64}\.(?:png|jpg|gif|webp)|.+\.(?:png|jpe?g|gif|webp))$/i)?.[1]).filter((name):name is string=>!!name);}
export function imageDraftPreviewsReady(doc:Document,images:BrowserImage[]){
 const editor=input(doc),composer=editor?.closest('.fai-BebopLiteChatInput');
 // The image-only attachment can show its thumbnail while the upload spinner
 // is still mounted with role=presentation (not progressbar or aria-busy).
 const rendered=(el:Element)=>!el.hasAttribute('hidden')&&(el as HTMLElement).style.display!=='none'&&el.getClientRects().length>0;
 // Decorative upload indicators can be aria-hidden while visibly loading.
 if(!composer||composer.getAttribute('aria-busy')==='true'||[...composer.querySelectorAll('[aria-busy="true"],[role="progressbar"],.fai-BebopLiteAttachment__progress')].some(rendered))return false;
 // Upload previews can settle before Lexical appends the inline File entity.
 // Freeze the submitted draft only after every owned reference is present;
 // otherwise that delayed filename looks like a human edit at input proof.
 const references=[...editor!.querySelectorAll('[data-lexical-decorator="true"][contenteditable="false"] [data-entity-type="File"]')].map(reference=>reference.textContent??'');
 // Office can append File entities in upload-completion order. Filenames bind
 // the pixel identity, so require the exact unique set, not a visual ordering.
 if(references.length!==images.length||new Set(references).size!==images.length||images.some(image=>!references.includes(image.name)))return false;
 const names=imageDraftNames(doc),previews=[...composer.querySelectorAll<HTMLImageElement>('button img[alt]')];
 return images.every(image=>names.includes(image.name)&&previews.some(preview=>preview.alt===image.name&&preview.complete&&preview.naturalWidth>0&&!!preview.getAttribute('src')));
}
function draftText(doc:Document){return normalize(editorText(doc))||(imageDraftNames(doc).length?'[image attachment draft]':'');}
function editorTextWithoutFiles(doc:Document){const editor=input(doc);if(!editor)return '';const copy=editor.cloneNode(true) as HTMLElement;copy.querySelectorAll('[aria-hidden="true"]').forEach(el=>el.remove());copy.querySelectorAll('[data-lexical-decorator="true"]').forEach(el=>{if(el.querySelector('[data-entity-type="File"]'))el.remove();});return normalize(copy.textContent??'');}
export async function attachImages(doc:Document,images:BrowserImage[],signal:AbortSignal){
 if(!images.length)return;if(images.length>5||new Set(images.map(image=>image.id)).size!==images.length)throw new Error('Invalid image attachment batch');
 if(imageDraftNames(doc).length)throw new Error('An existing image attachment draft was not overwritten');
 for(const image of images){
  signal.throwIfAborted();const editor=input(doc);if(!editor)throw new Error('Chat input missing before image upload');
  if(!/^[a-f0-9]{64}$/.test(image.id)||image.name!==`bridge-image-${image.id}.${({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'} as Record<string,string>)[image.mediaType]}`)throw new Error('Invalid image attachment identity');
  const data=Uint8Array.from(atob(image.data),char=>char.charCodeAt(0));if(data.length!==image.bytes||data.length>5000000)throw new Error('Invalid image attachment bytes');
  const transfer=new doc.defaultView!.DataTransfer();transfer.items.add(new doc.defaultView!.File([data],image.name,{type:image.mediaType}));
  editor.focus();const range=doc.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=doc.defaultView!.getSelection();selection?.removeAllRanges();selection?.addRange(range);
  editor.dispatchEvent(new doc.defaultView!.ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
  await until(doc,()=>imageDraftNames(doc).includes(image.name),signal,30000,'image attachment upload');
 }
 await until(doc,()=>{const names=imageDraftNames(doc);if(names.length!==images.length||images.some(image=>!names.includes(image.name)))throw new Error('Image attachments changed before submission');return imageDraftPreviewsReady(doc,images)&&!!imageSendTarget(doc);},signal,30000,'loaded image draft and send readiness');
}
export function imageSubmissionReady(doc:Document,job:BrowserJob,turn:TurnObservation|undefined){
 if(!turn?.prepared||turn.finished||pageInstance(doc)!==turn.pageInstance||!job.images?.length)return false;
 if(elements(doc,'.fai-UserMessage[role="article"]').length!==turn.baseUsers||elements(doc,'.fai-CopilotMessage[role="article"]').length!==turn.baseAssistants||evidenceV2(doc,turn.baseUsers,turn.baseAssistants)!==turn.beforeEvidence)return false;
 const names=imageDraftNames(doc),model=modelButton(doc);return enabled(input(doc))&&editorText(doc)===turn.wirePrompt&&names.length===job.images.length&&imageDraftPreviewsReady(doc,job.images)&&isChatOnly(doc)&&!!model&&label(model).includes(job.modelLabel)&&!button(doc,/^(停止生成|Stop generating)/i)&&!!imageSendTarget(doc);
}
export function imageSendTarget(doc:Document){
 const matches=elements(doc,'button').filter(target=>/^(?:发送|Send)(?:\s*[↵↩⏎])?$/i.test(label(target)));
 // Native activation must never select Send feedback or an ambiguous Send.
 return matches.length===1&&enabled(matches[0])?matches[0]:undefined;
}
export function imageSubmissionDiagnostics(doc:Document,job:BrowserJob,turn:TurnObservation|undefined,expectedEditor?:HTMLElement,expectedTarget?:HTMLElement){
 const editor=input(doc),target=imageSendTarget(doc),draft=editorText(doc),wire=turn?.wirePrompt??'',names=imageDraftNames(doc);
 const compact=(text:string)=>text.replace(/[\s\u200B\u200C\uFEFF]/g,'');
 return{prepared:!!turn?.prepared,finished:!!turn?.finished,samePage:!!turn&&pageInstance(doc)===turn.pageInstance,historyIntact:!!turn&&evidenceV2(doc,turn.baseUsers,turn.baseAssistants)===turn.beforeEvidence,users:elements(doc,'.fai-UserMessage[role="article"]').length,baseUsers:turn?.baseUsers,assistants:elements(doc,'.fai-CopilotMessage[role="article"]').length,baseAssistants:turn?.baseAssistants,editorEnabled:enabled(editor),sameEditor:!!editor&&editor===expectedEditor,sendPresent:!!target,sameSend:!!target&&target===expectedTarget,draftChars:draft.length,wireChars:wire.length,draftExact:draft===wire,whitespaceEquivalent:compact(draft)===compact(wire),imageNamesExact:names.length===(job.images?.length??0)&&(job.images??[]).every(image=>names.includes(image.name)),previewReady:imageDraftPreviewsReady(doc,job.images??[]),modelMatches:!!modelButton(doc)&&label(modelButton(doc)!).includes(job.modelLabel),chatOnly:isChatOnly(doc),documentFocused:doc.hasFocus(),sendFocused:!!target&&doc.activeElement===target};
}
export function focusImageSubmission(doc:Document,job:BrowserJob,turn:TurnObservation|undefined,requirePageFocus=false,expectedEditor?:HTMLElement,expectedTarget?:HTMLElement){
 const editor=input(doc),target=imageSendTarget(doc);
 if(!editor||!target||expectedEditor&&editor!==expectedEditor||expectedTarget&&target!==expectedTarget||!imageSubmissionReady(doc,job,turn))return false;
 // The attachment editor can consume Enter without submitting. A focused
 // native Send button uses Chromium's keyboard activation, like Tab + Enter.
 // Never use coordinates, a replacement button or a synthetic DOM click.
 target.focus();return doc.activeElement===target&&input(doc)===editor&&imageSendTarget(doc)===target&&(!requirePageFocus||doc.hasFocus())&&imageSubmissionReady(doc,job,turn);
}
function sentImageNames(user:HTMLElement|undefined){return user?[...user.querySelectorAll<HTMLImageElement>('.fai-UserMessage__topContent img[alt]')].filter(image=>image.complete&&image.naturalWidth>0&&!!image.getAttribute('src')).map(image=>image.alt):[];}
function imageDeliveryVerified(doc:Document,images:BrowserImage[]){const names=sentImageNames(elements(doc,'.fai-UserMessage[role="article"]').at(-1));return images.every(image=>names.includes(image.name));}
export function verifyImageDelivery(doc:Document,job:BrowserJob):string[]{
 if(!job.images?.length)return[];
 if(!imageDeliveryVerified(doc,job.images))throw new Error('The sent Copilot message did not verify every image attachment; no image answer was returned');
 return job.images.map(image=>image.id);
}
const messageText=(element:HTMLElement|undefined,selector:string)=>element?normalize(element.querySelector(selector)?.textContent??element.textContent??'').replace(/\s+/g,' '):null;
function evidenceV2(doc:Document,userLimit?:number,assistantLimit?:number){const users=elements(doc,'.fai-UserMessage[role="article"]').slice(0,userLimit),assistants=elements(doc,'.fai-CopilotMessage[role="article"]').slice(0,assistantLimit),images=sentImageNames(users.at(-1));return JSON.stringify({users:users.length,assistants:assistants.length,user:messageText(users.at(-1),'.fai-UserMessage__message'),assistant:messageText(assistants.at(-1),'.fai-CopilotMessage__content'),...(images.length?{images}:{})});}
export async function conversationUserCursor(doc:Document){const users=elements(doc,'.fai-UserMessage[role="article"]');return evidenceHash(JSON.stringify({users:users.length,user:messageText(users.at(-1),'.fai-UserMessage__message')}));}
async function evidenceHash(text:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function ownsTurn(doc:Document,turn:TurnObservation){
 if(pageInstance(doc)!==turn.pageInstance||!turn.prepared||turn.beforeEvidence!==evidenceV2(doc,turn.baseUsers,turn.baseAssistants))return false;
 const users=elements(doc,'.fai-UserMessage[role="article"]');
 return turn.sendClicked?users.length===turn.baseUsers+1&&messageText(users.at(-1),'.fai-UserMessage__message')===normalize(turn.wirePrompt).replace(/\s+/g,' '):users.length===turn.baseUsers;
}
export function imageSubmissionStarted(doc:Document,job:BrowserJob,turn:TurnObservation|undefined){return !!turn&&!!job.images?.length&&turn.sendClicked&&ownsTurn(doc,turn)&&elements(doc,'.fai-UserMessage[role="article"]').length===turn.baseUsers+1;}
export async function confirmImageSubmission(doc:Document,job:BrowserJob,turn:TurnObservation|undefined,signal:AbortSignal){
 if(!turn)throw Error('Image submission observation missing');
 await until(doc,()=>{
  if(turn.finished||pageInstance(doc)!==turn.pageInstance||!turn.sendClicked||evidenceV2(doc,turn.baseUsers,turn.baseAssistants)!==turn.beforeEvidence)throw Error('Original image chat changed before submission acknowledgement');
  if(imageSubmissionStarted(doc,job,turn))return true;
  if(elements(doc,'.fai-UserMessage[role="article"]').length!==turn.baseUsers)throw Error('A different user message appeared during image submission');
  // Submission can transiently clear/normalize the editor. A human can also
  // start a new draft here. This phase only reads the arriving owned message;
  // it must neither interpret a draft mutation as delivery nor touch that draft.
  return undefined;
 },signal,15000,'image submission acknowledgement while input remains connected');
}
// This only prevents a second submit. Actual image delivery still must pass
// verifyImageDelivery before a result, or imageDeliveryVerified for cancellation.
export function stopOwnedTurn(doc:Document,turn:TurnObservation){const control=button(doc,/^(停止生成|Stop generating)/i);if(!turn.stopRequested&&turn.sendClicked&&ownsTurn(doc,turn)&&enabled(control)){control.click();turn.stopRequested=true;}}
export async function cancellationProof(doc:Document,job:BrowserJob,turn:TurnObservation|undefined,nonce:string):Promise<CancelReceipt|undefined>{
 const base={version:1 as const,jobId:job.id,nonce,conversationId:job.conversation?.id??'',lane:job.lane??'main' as BrowserLane,inputComplete:false,replyState:'none' as const};
 const unverified=(reason:string):CancelReceipt=>({...base,outcome:'unverified',reason});
 if(!turn||!job.conversation)return unverified('Original page or submitted message cannot be verified');
 if(!turn.finished)return undefined;
 if(!turn.prepared&&job.conversation.mode==='continue'&&job.conversation.expectedCursor&&await matchesConversation(doc,job.conversation.expectedCursor,job.conversation.cursorVersion))Object.assign(turn,{prepared:true,beforeEvidence:evidenceV2(doc),baseUsers:elements(doc,'.fai-UserMessage[role="article"]').length,baseAssistants:elements(doc,'.fai-CopilotMessage[role="article"]').length});
 if(turn.sendClicked&&elements(doc,'.fai-UserMessage[role="article"]').length===turn.baseUsers&&evidenceV2(doc)===turn.beforeEvidence)return undefined;
 if(!ownsTurn(doc,turn))return unverified('Original page or submitted message cannot be verified');
 if(imageDraftNames(doc).length)return unverified('An image attachment draft is present in the original chat');
 stopOwnedTurn(doc,turn);
 if(button(doc,/^(停止生成|Stop generating)/i)||!inspect(doc).ready)return undefined;
 if(draftText(doc)){
  if(!turn.sendClicked&&editorText(doc)===turn.wirePrompt){await fill(doc,'');await editorCommit(doc,new AbortController().signal);return undefined;}
  return unverified('A draft is present in the original chat');
 }
 const evidence=evidenceV2(doc);if(turn.stableEvidence!==evidence){turn.stableEvidence=evidence;turn.stableSince=Date.now();return undefined;}
 if(Date.now()-(turn.stableSince??Date.now())<350)return undefined;
 const cursor=await evidenceHash(evidence);if(evidence!==evidenceV2(doc))return undefined;
 if(!turn.sentPackets)return{...base,outcome:'not_sent',pageInstance:turn.pageInstance};
 const assistants=elements(doc,'.fai-CopilotMessage[role="article"]');const current=assistants.length>turn.baseAssistants?assistants.at(-1):undefined;
 const restriction=current&&providerRestriction(replyText(doc).at(-1)??'');if(restriction)return{...unverified('provider_refusal'),refusalKind:refusalKind(restriction)};
 const complete=!!current&&[...current.querySelectorAll<HTMLElement>('[role="toolbar"] button')].some(el=>/^(复制|Copy)$/i.test(label(el)));
 return{...base,outcome:'settled',inputComplete:turn.inputComplete&&imageDeliveryVerified(doc,job.images??[]),pageInstance:turn.pageInstance,userCursor:await conversationUserCursor(doc),cursor,replyState:current?(complete?'complete':'partial'):'none'};
}
function conversationEvidence(doc:Document):string {
  const user=elements(doc,'.fai-UserMessage[role="article"]').at(-1),assistant=elements(doc,'.fai-CopilotMessage[role="article"]').at(-1);
  if(!user||!assistant)throw new Error('Conversation message evidence is unavailable');
  const text=(element:HTMLElement,selector:string)=>normalize(element.querySelector(selector)?.textContent??element.textContent??'').replace(/\s+/g,' ');
  return JSON.stringify([text(user,'.fai-UserMessage__message'),text(assistant,'.fai-CopilotMessage__content')]);
}
export async function conversationCursor(doc:Document,version?:2):Promise<string> {
  const bytes=new TextEncoder().encode(version===2?evidenceV2(doc):conversationEvidence(doc));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function matchesConversation(doc:Document,cursor:string,version?:2) {
  if(!elements(doc,'.fai-UserMessage[role="article"]').length||version!==2&&!elements(doc,'.fai-CopilotMessage[role="article"]').length)return false;
  return await conversationCursor(doc,version)===cursor;
}
async function waitForConversation(doc:Document,cursor:string,signal:AbortSignal,previousUser?:HTMLElement,version?:2) {
  await until(doc,async()=>{
    const user=elements(doc,'.fai-UserMessage[role="article"]').at(-1);
    return !!user&&(!previousUser||user!==previousUser)&&await matchesConversation(doc,cursor,version);
  },signal);
}
function closeNavigation(doc:Document){button(doc,/^(关闭导航|Close navigation)$/i)?.click();}
async function refuseLate(doc:Document,command:ConversationCommand){if(command.userCursor&&command.pageInstance===pageInstance(doc)&&await conversationUserCursor(doc)===command.userCursor){const restriction=providerRestriction(replyText(doc).at(-1)??'');if(restriction)throw new TransportFailure(restriction,'provider_refusal');}}
async function restoreConversation(doc:Document,command:ConversationCommand,signal:AbortSignal) {
  await refuseLate(doc,command);
  if(!command.expectedCursor)throw new Error('Continuation requires verified conversation evidence');
  if(command.pageInstance&&command.pageInstance!==pageInstance(doc))throw new TransportFailure('Original Copilot page instance changed','conversation_unavailable');
  try {await waitForConversation(doc,command.expectedCursor,signal,undefined,command.cursorVersion);}
  catch {if(signal.aborted&&signal.reason?.name!=='TimeoutError')throw signal.reason;await refuseLate(doc,command);throw new TransportFailure('Original Copilot conversation is no longer active or its messages changed; no new chat or continuation message was submitted','conversation_unavailable');}
}
export async function captureConversation(doc:Document,job:BrowserJob,signal:AbortSignal):Promise<ConversationReceipt|undefined> {
  const command=job.conversation;if(!command)return undefined;
  await until(doc,()=>inspect(doc).ready,signal,15000,'reply controls');
  const version=job.cancelContinuation===1?2:undefined;
  const expectedCursor=await conversationCursor(doc,version);
  await waitForConversation(doc,expectedCursor,signal,undefined,version);
  // The label is local bridge metadata, not a claimed Office history title.
  return {id:command.id,title:command.title,cursor:expectedCursor,resumability:'active-chat-only',...(version?{cursorVersion:version,pageInstance:pageInstance(doc),userCursor:await conversationUserCursor(doc)}:{})};
}
async function clickMenuItem(doc: Document, text: string, signal: AbortSignal) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const find = () => {const match=button(doc,new RegExp('^'+escaped+'$'))??elements(doc,'[role="menu"] span,[role="menu"] div').find(el=>normalize(el.textContent??'')===text);const target=match?.closest<HTMLElement>('button,[role="menuitem"],[role="menuitemradio"]')??match;return enabled(target)?target:undefined;};
  const el = await until(doc,find, signal,15000,'model option');
  el.click();
}
export async function prepare(doc: Document, job: BrowserJob, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();if(job.conversation?.mode==='continue')await refuseLate(doc,job.conversation);
  const unavailable=(message:string)=>job.conversation?.mode==='continue'?new TransportFailure(message,'conversation_unavailable'):new Error(message);
  if(job.conversation?.mode==='continue'){
    const command=job.conversation;
    try{await until(doc,async()=>{await refuseLate(doc,command);return inspect(doc).ready;},signal,15000,'continuation controls');}
    catch(error){if(error instanceof TransportFailure&&error.code==='provider_refusal')throw error;if(signal.aborted&&signal.reason?.name!=='TimeoutError')throw signal.reason;await refuseLate(doc,command);throw unavailable(error instanceof Error?error.message:'Original Copilot controls did not become ready');}
  }
  if (button(doc, /^(停止生成|Stop generating)/i)) throw unavailable('Copilot is already generating; no new message was submitted');
  if (!inspect(doc).ready) throw unavailable('Open Copilot in the selected Excel tab first');
  if(draftText(doc))throw unavailable('Copilot has an unsent user draft; message was not overwritten');
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
export async function exchange(doc:Document,job:BrowserJob,signal:AbortSignal,beforeSend:()=>Promise<void>,onSummary:(model:string,attempts:SummaryAttempt[])=>void=()=>{},onAttempt:(attempt:SummaryAttempt)=>void=()=>{},turn?:TurnObservation,submitImage?:(modelLabel:string)=>Promise<void>):Promise<string>{
 if(job.images?.length&&!submitImage)throw new Error('Image input requires the optional trusted browser input channel');
 if(!job.summary)return exchangeAttempt(doc,job,signal,beforeSend,()=>{},turn,submitImage);
 if(job.conversation)throw new Error('Summary inference requires a fresh auxiliary conversation');
 let lastPrompt:string|undefined,submitted=false,journalled=false;
 const result=await runSummaryChain(async model=>{
  lastPrompt=undefined;submitted=false;
  return exchangeAttempt(doc,{...job,modelLabel:model},signal,async()=>{submitted=true;if(!journalled){await beforeSend();journalled=true;}},prompt=>{lastPrompt=prompt;},turn,submitImage);
 },async()=>{
  if(submitted)stop(doc);
  await until(doc,()=>!button(doc,/^(停止生成|Stop generating)/i),signal);
  const draft=draftText(doc);
  if(draft){if(lastPrompt===undefined||draft!==normalize(lastPrompt.replace(/\r?\n/g,' ')))throw new Error('A draft changed during summary fallback; it was not overwritten');await fill(doc,'',signal);}
 },signal,onAttempt,error=>!(error instanceof ImageInputFailure));
 onSummary(result.model,result.attempts);return result.text;
}
async function exchangeAttempt(doc: Document, job: BrowserJob, signal: AbortSignal, beforeSend: () => Promise<void>,onPrompt:(prompt:string)=>void=()=>{},turn?:TurnObservation,submitImage?:(modelLabel:string)=>Promise<void>): Promise<string> {
  await prepare(doc, job, signal);
  if(!job.contextPackets)return exchangeOne(doc,job,job.prompt,signal,beforeSend,onPrompt,turn,true,submitImage);
  const packets=job.contextPackets;
  if(packets.length<2||packets.length>32||packets.some((p,i)=>typeof p.prompt!=='string'||p.prompt.length>350000||(i<packets.length-1?typeof p.ack!=='string':p.ack!==undefined)))throw new Error('Invalid segmented context transfer');
  let cursor:string|undefined,journalled=false,reply='';
  for(const packet of packets){
    signal.throwIfAborted();
    if(cursor&&!await matchesConversation(doc,cursor))throw new Error('Copilot conversation changed during context transfer');
    if(draftText(doc))throw new Error('A draft appeared during context transfer; it was not overwritten');
    reply=await exchangeOne(doc,job,packet.prompt,signal,async()=>{if(!journalled){await beforeSend();journalled=true;}},onPrompt,turn,packet.ack===undefined,submitImage);
    if(packet.ack){
      const clean=reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1');let value:any;
      try{value=JSON.parse(clean);}catch{throw new Error('Copilot context transfer acknowledgment is malformed');}
      if(Object.keys(value??{}).join(',')!=='content'||!Array.isArray(value.content)||value.content.length!==1||value.content[0].type!=='text'||value.content[0].text!==packet.ack||Object.keys(value.content[0]).sort().join(',')!=='text,type')throw new Error('Copilot did not acknowledge the exact context fragment; intermediate tools were not forwarded');
      cursor=await conversationCursor(doc);
    }
  }
  return reply;
}
async function exchangeOne(doc:Document,job:BrowserJob,prompt:string,signal:AbortSignal,beforeSend:()=>Promise<void>,onPrompt:(prompt:string)=>void=()=>{},turn?:TurnObservation,lastPacket=true,submitImage?:(modelLabel:string)=>Promise<void>):Promise<string>{
  onPrompt(prompt);
  const wirePrompt=prompt.replace(/\r?\n/g,' ');
  const users=()=>elements(doc,'.fai-UserMessage[role="article"]').length,assistants=()=>replyText(doc).length;
  const baseUsers=users(),baseAssistants=assistants();const baseEvidence=baseUsers&&baseAssistants?conversationEvidence(doc):undefined;
  if(turn)Object.assign(turn,{prepared:true,beforeEvidence:evidenceV2(doc),baseUsers,baseAssistants,wirePrompt,sendClicked:false,inputComplete:false,stableEvidence:undefined,stableSince:undefined});
  const assertContext=()=>{if(users()!==baseUsers||assistants()!==baseAssistants||baseEvidence&&conversationEvidence(doc)!==baseEvidence)throw new Error('Copilot conversation changed before submission; nothing was sent');};
  const assertMode=()=>{const model=modelButton(doc);if(!isChatOnly(doc)||!model||!label(model).includes(job.modelLabel))throw new Error('Mode or model changed before submission');};
  let send:HTMLElement|undefined;
  for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();const existing=editorText(doc);if(existing!==''&&existing!==wirePrompt)throw new Error('Copilot input changed after preparation; the draft was not overwritten');
    assertContext();assertMode();const latest=editorText(doc);if(latest!==''&&latest!==wirePrompt)throw new Error('Copilot input changed after preparation; the draft was not overwritten');await fill(doc,prompt,signal);await editorCommit(doc,signal);
    const state=await until<{kind:'cleared'|'changed'|'ready';control?:HTMLElement}>(doc,()=>{
      const current=editorText(doc);if(current!==wirePrompt)return{kind:current===''?'cleared':'changed'};
      const control=lastPacket&&job.images?.length?imageSendTarget(doc):button(doc,/^(发送|Send)(?:\s|$)/i);return enabled(control)?{kind:'ready',control}:undefined;
    },signal,15000,'send button');
    if(state.kind==='changed')throw new Error('Copilot input changed after preparation; the draft was not overwritten');
    if(state.kind==='cleared')continue;send=state.control;break;
  }
  if(!send)throw new Error('Copilot repeatedly cleared its editor before submission; nothing was sent');
  assertContext();assertMode();
  const images=lastPacket?job.images??[]:[];
  if(images.length){await attachImages(doc,images,signal);await editorCommit(doc,signal);if(editorTextWithoutFiles(doc)!==normalize(wirePrompt))throw new Error('Copilot text changed during image upload; nothing was sent');}
  const submittedDraft=editorText(doc);if(turn)turn.wirePrompt=submittedDraft;
  const previousReply=elements(doc,'.fai-CopilotMessage[role="article"]').at(-1),previousCount=replyText(doc).length;
  await beforeSend();signal.throwIfAborted();assertContext();assertMode();
  if(editorText(doc)!==submittedDraft||images.length&&(imageDraftNames(doc).length!==images.length||images.some(image=>!imageDraftNames(doc).includes(image.name))))throw new Error('Copilot input changed before the send click; no changed draft was submitted');
  send=images.length?imageSendTarget(doc):button(doc,/^(发送|Send)(?:\s|$)/i);if(!enabled(send))throw new Error('Copilot send control changed before submission');
  // Mark possible delivery before awaiting the browser input channel so that
  // a simultaneous cancellation can stop only this owned submitted turn.
  if(turn){turn.sendClicked=true;turn.sentPackets++;turn.inputComplete=lastPacket;}
  if(images.length){await submitImage!(job.modelLabel);signal.throwIfAborted();}
  else send.click();
  // Never click again when delivery is unknown. A visible draft alone does not
  // prove the first submission is safe to repeat.
  if(images.length)await until(doc,()=>users()>baseUsers||!!button(doc,/^(停止生成|Stop generating)/i),signal,15000,'image submission acknowledgement');
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
  const policy=providerRestriction(text);if(policy)throw new TransportFailure(policy,'provider_refusal');
  if(lastPacket&&job.images?.length){await until(doc,()=>imageDeliveryVerified(doc,job.images!),signal,15000,'sent image attachment proof');verifyImageDelivery(doc,job);}
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
