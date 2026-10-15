import {validBrowserLane,type BrowserLane} from './conversation.js';
import {providerRestriction} from './summary.js';
export type RefusalKind='content_filtering'|'external_client_relay';
export function refusalKind(message:unknown):RefusalKind{return providerRestriction(typeof message==='string'?message:'')==='Copilot blocked the response by content filtering'?'content_filtering':'external_client_relay';}
export function refusalMessage(kind?:RefusalKind){return kind==='content_filtering'?'Copilot blocked the response by content filtering':'Copilot refused external-client relay use';}

export interface CancelReceipt {
 version:1;jobId:string;nonce:string;conversationId:string;lane:BrowserLane;
 outcome:'not_sent'|'settled'|'unverified';inputComplete:boolean;
 replyState:'none'|'partial'|'complete';pageInstance?:string;userCursor?:string;cursor?:string;reason?:string;refusalKind?:RefusalKind;
}
export function parseCancelReceipt(value:any):CancelReceipt {
 if(!value||value.version!==1||typeof value.jobId!=='string'||typeof value.nonce!=='string'||typeof value.conversationId!=='string'||!validBrowserLane(value.lane)||!['not_sent','settled','unverified'].includes(value.outcome)||typeof value.inputComplete!=='boolean'||!['none','partial','complete'].includes(value.replyState))throw new Error('Invalid cancellation receipt');
 if(value.outcome==='settled'&&(!/^[a-f0-9]{64}$/.test(value.cursor??'')||!/^[-a-zA-Z0-9]{1,100}$/.test(value.pageInstance??'')))throw new Error('Cancellation receipt has no verified page/cursor');
 if(value.userCursor!==undefined&&!/^[a-f0-9]{64}$/.test(value.userCursor))throw new Error('Invalid cancellation input fingerprint');
 if(value.refusalKind!==undefined&&!['content_filtering','external_client_relay'].includes(value.refusalKind))throw new Error('Invalid cancellation refusal kind');
 return{version:1,jobId:value.jobId,nonce:value.nonce,conversationId:value.conversationId,lane:value.lane,outcome:value.outcome,inputComplete:value.inputComplete,replyState:value.replyState,...(typeof value.pageInstance==='string'?{pageInstance:value.pageInstance}:{}),...(typeof value.userCursor==='string'?{userCursor:value.userCursor}:{}),...(typeof value.cursor==='string'?{cursor:value.cursor}:{}),...(typeof value.reason==='string'?{reason:value.reason.slice(0,300)}:{}),...(value.reason==='provider_refusal'&&value.refusalKind?{refusalKind:value.refusalKind}:{})};
}
export type FailureCode='provider_refusal'|'conversation_unavailable';
export class TransportFailure extends Error {constructor(message:string,public code:FailureCode){super(message);}}
