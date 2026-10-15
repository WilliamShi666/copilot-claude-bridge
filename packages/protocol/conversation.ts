export type BrowserLane='main'|'auxiliary'|`agent:${string}`;
export function validBrowserLane(value:unknown):value is BrowserLane{return value==='main'||value==='auxiliary'||typeof value==='string'&&/^agent:[a-f0-9]{64}$/.test(value);}
export interface ConversationCommand { mode:'new'|'continue'; id:string; title:string; expectedCursor?:string;lane?:BrowserLane;userCursor?:string;cursorVersion?:2;pageInstance?:string }
export interface ConversationReceipt { id:string; title:string; cursor:string;resumability:'active-chat-only';userCursor?:string;cursorVersion?:2;pageInstance?:string }
export interface ConversationSelection { mode:'new'|'continue'; id?:string; workspaceKey:string;lane?:BrowserLane }
