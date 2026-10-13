import type {MessagesRequest,ObjectValue} from './index.js';
import {createHash} from 'node:crypto';
import {BridgeError,buildPrompt,REPLY_CONTRACT} from './index.js';
export interface ContextSnapshot { messageHashes:string[]; controlHashes:Record<string,string>; estimatedTokens:number }
export interface ContextPlan { kind:'bootstrap'|'delta'; reason:string; messages:ObjectValue[]; updates:ObjectValue; removedFields:string[]; snapshot:ContextSnapshot }
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
  const text=typeof value==='string'?value:JSON.stringify(value)??'';let count=0;
  for(const char of text)count+=char.codePointAt(0)!<128?0.34:1.5;
  return Math.max(1,Math.ceil(count));
}
export function renderContextPrompt(request:MessagesRequest,plan:ContextPlan,epoch:number,limit=180000):string {
  if(plan.kind==='bootstrap'){const prompt=buildPrompt(request,limit)+'\nBRIDGE CONTEXT: '+JSON.stringify({epoch,kind:'bootstrap',reason:plan.reason});if(prompt.length>limit)throw new BridgeError('Bootstrap context exceeds the Copilot UI limit; nothing was truncated.',413);return prompt;}
  const prompt='Continue this same native coding conversation in chat only. Do not edit the Excel workbook. Previously initialized client instructions and tools remain active unless replaced below. Updates replace the complete previous value of each named field, including the full tools list. Native assistant records below acknowledge your prior reply and provide actual client-assigned tool IDs; they are not new user requests. Use actual tool results, not guesses.\n'
    +'The removedFields list explicitly cancels previous values of those fields; use the current request defaults instead. If tools is removed, no client tools are available. Do not retain a removed output format or tool choice.\n'
    +REPLY_CONTRACT+'\nCLIENT DELTA:\n'+JSON.stringify({epoch,messages:plan.messages,updates:plan.updates,removedFields:plan.removedFields});
  if(prompt.length>limit)throw new BridgeError(`Incremental request is ${prompt.length} characters; UI limit is ${limit}. Nothing was truncated.`,413);
  return prompt;
}
