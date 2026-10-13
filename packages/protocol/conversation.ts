export type BrowserLane='main'|'auxiliary';
export interface ConversationCommand { mode:'new'|'continue'; id:string; title:string; expectedCursor?:string;lane?:BrowserLane }
export interface ConversationReceipt { id:string; title:string; cursor:string;resumability:'active-chat-only' }
export interface ConversationSelection { mode:'new'|'continue'; id?:string; workspaceKey:string;lane?:BrowserLane }
