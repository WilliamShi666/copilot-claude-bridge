import type {MessagesRequest,ObjectValue} from './index.js';
import {createHash} from 'node:crypto';
import {BridgeError,buildPrompt,REPLY_CONTRACT} from './index.js';
export interface ContextSnapshot { messageHashes:string[]; controlHashes:Record<string,string>; estimatedTokens:number }
export interface FeedbackCheckpoint {snapshot:ContextSnapshot;tailUserBlockHashes?:string[];tailUserTextOnly?:boolean}
const messageBlocks=(message:any):any[]=>typeof message?.content==='string'?[{type:'text',text:message.content}]:Array.isArray(message?.content)?message.content:[];
function feedbackEnd(request:MessagesRequest):number|undefined {let index=request.messages.length-1;while(index>=0&&request.messages[index].role==='system')index--;return request.messages[index]?.role==='user'?index+1:undefined;}
export function feedbackCheckpoint(request:MessagesRequest,snapshot:ContextSnapshot):FeedbackCheckpoint {
 const end=feedbackEnd(request);if(end===undefined)return{snapshot};const blocks=messageBlocks(request.messages[end-1]);return{snapshot:{...snapshot,messageHashes:snapshot.messageHashes.slice(0,end)},tailUserBlockHashes:blocks.map(fingerprint),...(blocks.length===1&&blocks[0].type==='text'?{tailUserTextOnly:true}:{})};
}
export function appendedUserFeedback(request:MessagesRequest,previous:FeedbackCheckpoint):boolean {
 const end=feedbackEnd(request);if(end===undefined)return false;
 const hashes=planContext(request).snapshot.messageHashes.slice(0,end),old=previous.snapshot.messageHashes,last=request.messages[end-1];
 if(last?.role!=='user'||!old.length)return false;
 const blocks=messageBlocks(last),newText=(b:any)=>b?.type==='text'&&typeof b.text==='string'&&b.text.trim()&&!/^\s*(?:<system-reminder>|\[Request interrupted by user)/i.test(b.text);
 if(hashes.length>old.length&&old.every((h,i)=>hashes[i]===h))return blocks.some(newText);
 const tail=previous.tailUserBlockHashes;
 // Native Esc can withdraw the interrupted standalone prompt from the next
 // request. Only that text tail may be replaced; all earlier messages and
 // every actual tool result must remain intact. Legacy proofs do not infer it.
 if(previous.tailUserTextOnly===true&&tail?.length===1&&hashes.length===old.length&&old.slice(0,-1).every((h,i)=>hashes[i]===h)&&!blocks.some(b=>fingerprint(b)===tail[0])&&blocks.every(b=>b.type==='text')&&blocks.some(newText))return true;
 return !!tail&&hashes.length===old.length&&old.slice(0,-1).every((h,i)=>hashes[i]===h)&&blocks.length>tail.length&&tail.every((h,i)=>fingerprint(blocks[i])===h)&&blocks.slice(tail.length).some(newText);
}
export interface ContextPlan { kind:'bootstrap'|'delta'|'resume'; reason:string; messages:ObjectValue[]; updates:ObjectValue; removedFields:string[]; snapshot:ContextSnapshot;retainedMessageCount?:number;cancelledJobId?:string }
export function requestIdentity(request:MessagesRequest):string {const {max_tokens,stream,metadata,...stable}=request;return fingerprint(stable);}
export function resumeContext(request:MessagesRequest,previous:ContextSnapshot,cancelledJobId:string):ContextPlan {
 const next=planContext(request,previous);let retained=0;while(retained<previous.messageHashes.length&&retained<next.snapshot.messageHashes.length&&previous.messageHashes[retained]===next.snapshot.messageHashes[retained])retained++;
 const updates=Object.fromEntries(Object.entries(request).filter(([key])=>key!=='messages'&&next.snapshot.controlHashes[key]!==previous.controlHashes[key]));
 return{kind:'resume',reason:'cancelled-turn-continuation',messages:request.messages.slice(retained),updates,removedFields:next.removedFields,snapshot:next.snapshot,retainedMessageCount:retained,cancelledJobId};
}
export function planContext(request:MessagesRequest,previous?:ContextSnapshot,forceReason?:string):ContextPlan {
  const controls=Object.fromEntries(Object.entries(request).filter(([key])=>key!=='messages'));
  // Claude Code alternates between string content and a single cached text block.
  // Normalize only that wire representation, retaining every actual text change.
  const snapshot={messageHashes:request.messages.map(message=>fingerprint({...message,content:typeof message.content==='string'?[{type:'text',text:message.content}]:message.content})),controlHashes:Object.fromEntries(Object.entries(controls).map(([key,value])=>[key,fingerprint(value)])),estimatedTokens:estimateTokens(request)};
  const removedFields=previous?Object.keys(previous.controlHashes).filter(key=>!(key in controls)):[];
  const prefix=previous&&previous.messageHashes.length<=snapshot.messageHashes.length&&previous.messageHashes.every((hash,index)=>hash===snapshot.messageHashes[index]);
  const reason=forceReason??(!previous?'first-request':!prefix?'history-rewrite':previous.controlHashes.system!==snapshot.controlHashes.system?'system-changed':'append');
  const bootstrap=reason!=='append';
  const updates=bootstrap?controls:Object.fromEntries(Object.entries(controls).filter(([key])=>snapshot.controlHashes[key]!==previous!.controlHashes[key]));
  return {kind:bootstrap?'bootstrap':'delta',reason,messages:bootstrap?request.messages:request.messages.slice(previous!.messageHashes.length),updates,removedFields,snapshot};
}
function canonical(value:any):any {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(key=>key!=='cache_control').sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function fingerprint(value:unknown):string{return createHash('sha256').update(JSON.stringify(canonical(value))??'null').digest('hex');}
// Conservative local heuristic, never a measured upstream usage/billing value.
export function estimateTokens(value:unknown):number {
  let images=0;
  const text=typeof value==='string'?value:JSON.stringify(value,(_key,entry)=>{
   if(entry?.type==='image'&&entry.source?.type==='base64'){images++;return{type:'image',media_type:entry.source.media_type};}
   if(entry?.type==='text'&&typeof entry.text==='string'&&/^\[Bridge image attachment: bridge-image-[a-f0-9]{64}\./.test(entry.text))images++;
   return entry;
  })??'';let count=images*2048;
  for(const char of text)count+=char.codePointAt(0)!<128?0.34:1.5;
  return Math.max(1,Math.ceil(count));
}
export function renderContextPrompt(request:MessagesRequest,plan:ContextPlan,epoch:number,limit=180000):string {
  if(plan.kind==='bootstrap'){const prompt=buildPrompt(request,limit)+'\nBRIDGE CONTEXT: '+JSON.stringify({epoch,kind:'bootstrap',reason:plan.reason});if(prompt.length>limit)throw new BridgeError('Bootstrap context exceeds the Copilot UI limit; nothing was truncated.',413);return prompt;}
  if(plan.kind==='resume'){
   const prompt='Continue this same native coding conversation in chat only. The previous browser response was interrupted and discarded. Its proposed tools were NOT executed unless actual tool results appear in the native history below. Abandon any unfinished context transfer from that turn. The native history is authoritative: retain its first retainedMessageCount messages and replace the entire later native tail with replacementMessages. Repeated tool results in this replacement are history, not new requests to execute. Apply the newest user feedback. Changed control fields replace their previous values; removedFields cancel old values. Do not edit the Excel workbook.\n'+REPLY_CONTRACT+'\nNATIVE RESUME DELTA:\n'+JSON.stringify({epoch,cancelledJobId:plan.cancelledJobId,retainedMessageCount:plan.retainedMessageCount,replacementMessages:plan.messages,updates:plan.updates,removedFields:plan.removedFields});
   if(prompt.length>limit)throw new BridgeError('Resume delta exceeds the Copilot UI limit; nothing was truncated.',413);return prompt;
  }
  const prompt='Continue this same native coding conversation in chat only. Do not edit the Excel workbook. Previously initialized client instructions and tools remain active unless replaced below. Updates replace the complete previous value of each named field, including the full tools list. Native assistant records below acknowledge your prior reply and provide actual client-assigned tool IDs; they are not new user requests. Use actual tool results, not guesses.\n'
    +'The removedFields list explicitly cancels previous values of those fields; use the current request defaults instead. If tools is removed, no client tools are available. Do not retain a removed output format or tool choice.\n'
    +REPLY_CONTRACT+'\nCLIENT DELTA:\n'+JSON.stringify({epoch,messages:plan.messages,updates:plan.updates,removedFields:plan.removedFields});
  if(prompt.length>limit)throw new BridgeError(`Incremental request is ${prompt.length} characters; UI limit is ${limit}. Nothing was truncated.`,413);
  return prompt;
}
