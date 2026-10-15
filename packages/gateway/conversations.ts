import {validBrowserLane} from '../protocol/conversation.js';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BridgeError } from '../protocol/index.js';
import type {BrowserLane, ConversationCommand, ConversationReceipt, ConversationSelection } from '../protocol/conversation.js';
import type {CancelReceipt} from '../protocol/cancellation.js';
const selectionSchema=z.object({mode:z.enum(['new','continue']),id:z.string().uuid().optional(),workspaceKey:z.string().regex(/^[a-f0-9]{64}$/),lane:z.custom<BrowserLane>(validBrowserLane).optional()}).strict();
const recordSchema=z.object({id:z.string().uuid(),title:z.string().max(60),workspaceKey:z.string().regex(/^[a-f0-9]{64}$/),model:z.string(),lane:z.custom<BrowserLane>(validBrowserLane).default('main'),cursor:z.string().regex(/^[a-f0-9]{64}$/).optional(),userCursor:z.string().regex(/^[a-f0-9]{64}$/).optional(),cursorVersion:z.literal(2).optional(),pageInstance:z.string().optional(),state:z.enum(['ready','inactive','busy','cancelling','uncertain']),jobId:z.string().optional(),lastJobId:z.string().optional(),updated:z.string()});
type Record=z.infer<typeof recordSchema>;
export class ConversationStore {
  private records=new Map<string,Record>(); private persistence=Promise.resolve();
  constructor(private stateDir:string) {}
  async load() {
    try {
      const saved=z.array(recordSchema).max(100).parse(JSON.parse(await readFile(join(this.stateDir,'conversations.json'),'utf8')));
      for(const record of saved) { if(record.state==='busy'||record.state==='cancelling')record.state='uncertain'; delete record.jobId; this.records.set(record.id,record); }
    } catch { /* Missing/corrupt metadata never invents resumable chats. */ }
  }
  private persist() {
    const file=join(this.stateDir,'conversations.json'),snapshot=JSON.stringify([...this.records.values()]);
    this.persistence=this.persistence.then(async()=>{await writeFile(file+'.tmp',snapshot,{mode:0o600});await rename(file+'.tmp',file);});
    return this.persistence;
  }
  async reserve(raw:unknown,model:string,jobId:string):Promise<ConversationCommand> {
    const parsed=selectionSchema.safeParse(raw);
    if(!parsed.success)throw new BridgeError('Invalid conversation selection',400);
    const input:ConversationSelection=parsed.data;
    let record:Record;
    if(input.mode==='new') {
      if(input.id)throw new BridgeError('New conversations must not supply an existing id',400);
      if(this.records.size>=100)throw new BridgeError('Conversation registry limit reached',429);
      const id=randomUUID(); record={id,title:'M365 Bridge '+id,workspaceKey:input.workspaceKey,model,lane:input.lane??'main',state:'busy',jobId,updated:new Date().toISOString()};
      this.records.set(id,record);
    } else {
      const existing=input.id ? this.records.get(input.id) : undefined;
      if(!existing)throw new BridgeError('Conversation not found; start a new conversation explicitly',409);
      if(existing.workspaceKey!==input.workspaceKey || existing.model!==model||existing.lane!==(input.lane??'main'))throw new BridgeError('Conversation workspace, model or lane does not match',409);
      if(existing.state==='inactive')throw new BridgeError('Conversation is no longer the active browser chat; automatic history restoration is unavailable',409);
      if(existing.state!=='ready'||!existing.cursor)throw new BridgeError('Conversation is busy or uncertain; it cannot be silently resumed',409);
      record=existing; record.state='busy';record.jobId=jobId;record.updated=new Date().toISOString();
    }
    await this.persist();
    return {mode:input.mode,id:record.id,title:record.title,lane:record.lane,...(input.mode==='continue'?{expectedCursor:record.cursor,userCursor:record.userCursor,cursorVersion:record.cursorVersion,pageInstance:record.pageInstance}:{})};
  }
  async complete(command:ConversationCommand,raw:unknown,jobId:string):Promise<ConversationReceipt> {
    const parsed=z.object({id:z.string().uuid(),title:z.string(),cursor:z.string().regex(/^[a-f0-9]{64}$/),resumability:z.literal('active-chat-only'),userCursor:z.string().regex(/^[a-f0-9]{64}$/).optional(),cursorVersion:z.literal(2).optional(),pageInstance:z.string().optional()}).strict().safeParse(raw);
    const record=this.records.get(command.id);
    if(!parsed.success||!record||parsed.data.id!==record.id||parsed.data.title!==record.title||record.state!=='busy'||record.jobId!==jobId)throw new BridgeError('Browser did not verify the requested Copilot conversation',502,'api_error');
    for(const other of this.records.values())if(other.id!==record.id&&other.lane===record.lane&&other.state==='ready')other.state='inactive';
    record.cursor=parsed.data.cursor;record.userCursor=parsed.data.userCursor;record.cursorVersion=parsed.data.cursorVersion;record.pageInstance=parsed.data.pageInstance;record.lastJobId=jobId;record.state='ready';delete record.jobId;record.updated=new Date().toISOString();await this.persist();return parsed.data;
  }
  async beginCancellation(command:ConversationCommand,jobId:string){const record=this.records.get(command.id);if(!record||!(record.jobId===jobId||record.state==='ready'&&record.lastJobId===jobId))throw new BridgeError('Cancellation conversation lease changed',409);record.state='cancelling';record.jobId=jobId;await this.persist();}
  async settleCancellation(receipt:CancelReceipt,jobId:string){
    const record=this.records.get(receipt.conversationId);if(!record||record.jobId!==jobId||record.state!=='cancelling'||record.lane!==receipt.lane)throw new BridgeError('Cancellation conversation identity changed',409);
    if(receipt.outcome==='settled'){
      if(record.pageInstance&&record.pageInstance!==receipt.pageInstance)throw new BridgeError('Cancellation page instance changed',409);
      record.cursor=receipt.cursor;record.userCursor=receipt.userCursor;record.cursorVersion=2;record.pageInstance=receipt.pageInstance;record.state='ready';
    }else record.state=receipt.outcome==='not_sent'?(record.cursor?'ready':'inactive'):'uncertain';
    delete record.jobId;record.updated=new Date().toISOString();await this.persist();
  }
  async fail(id:string,jobId:string) {
    const record=this.records.get(id);if(!record||record.jobId!==jobId)return;
    record.state='uncertain';delete record.jobId;record.updated=new Date().toISOString();await this.persist();
  }
  async cancelBeforeDispatch(id:string,jobId:string){const record=this.records.get(id);if(!record||record.jobId!==jobId)return;record.state=record.cursor?'ready':'inactive';delete record.jobId;record.updated=new Date().toISOString();await this.persist();}
  async invalidateLane(lane:BrowserLane){for(const record of this.records.values())if(record.lane===lane&&record.state==='ready')record.state='inactive';await this.persist();}
  list(workspaceKey:string) {
    if(!/^[a-f0-9]{64}$/.test(workspaceKey))throw new BridgeError('Workspace key required',400);
    return [...this.records.values()].filter(r=>r.workspaceKey===workspaceKey).sort((a,b)=>b.updated.localeCompare(a.updated)).map(({id,title,model,state,updated})=>({conversationId:id,label:title,model,state,updated,resumability:'active-chat-only'}));
  }
  async flush(){await this.persistence;}
}
