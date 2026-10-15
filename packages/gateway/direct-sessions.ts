import type {MessagesRequest} from '../protocol/index.js';
import {BridgeError} from '../protocol/index.js';
import type {ContextPlan,ContextSnapshot,FeedbackCheckpoint} from '../protocol/context.js';
import {planContext,feedbackCheckpoint,appendedUserFeedback} from '../protocol/context.js';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';
export interface DirectFrame {key:string;sessionId:string;agentId?:string;workspaceKey:string;model:string;jobId:string;epoch:number;conversationId?:string;plan:ContextPlan;compactSequence:number;feedback:FeedbackCheckpoint;recoveryCheckpoint?:FeedbackCheckpoint}
interface DirectRecord {key:string;sessionId:string;agentId?:string;workspaceKey:string;model:string;epoch:number;state:'ready'|'busy'|'uncertain';jobId?:string;conversationId?:string;snapshot?:ContextSnapshot;compactSequence:number;resetReason?:string;interruption?:FeedbackCheckpoint;updated:string}
interface CompactState {sessionId:string;agentId?:string;workspaceKey?:string;phase:'running'|'ready';sequence:number;trigger:string}
export function validSession(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value);}
export function validAgent(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9._:@-]{1,200}$/.test(value);}
const scopeKey=(sessionId:string,agentId?:string)=>agentId===undefined?sessionId:sessionId+'\0'+agentId;
export class DirectSessions {
 private records=new Map<string,DirectRecord>();private compactions=new Map<string,CompactState>();private persistence=Promise.resolve();
 constructor(private stateDir:string){}
 async load(){
  await mkdir(this.stateDir,{recursive:true,mode:0o700});let saved:any;
  try{saved=JSON.parse(await readFile(join(this.stateDir,'direct-contexts.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('Direct context metadata is unreadable; no browser context was resumed.');}
  if(!Array.isArray(saved.records)||saved.records.length>100||!Array.isArray(saved.compactions)||saved.compactions.length>100)throw new Error('Invalid direct context registry');
  for(const record of saved.records){
   if(!validSession(record.sessionId)||(record.agentId!==undefined&&!validAgent(record.agentId))||typeof record.key!=='string'||! /^[a-f0-9]{64}$/.test(record.workspaceKey)||!Number.isInteger(record.epoch)||!['ready','busy','uncertain'].includes(record.state))throw new Error('Invalid direct context record');
   if(record.snapshot&&(!Array.isArray(record.snapshot.messageHashes)||record.snapshot.messageHashes.length>10000||!record.snapshot.messageHashes.every((h:any)=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||!record.snapshot.controlHashes||!Object.values(record.snapshot.controlHashes).every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))))throw new Error('Invalid direct context fingerprints');
   if(record.interruption){const value=record.interruption;if(!value.snapshot||!Array.isArray(value.snapshot.messageHashes)||value.snapshot.messageHashes.length>10000||!value.snapshot.messageHashes.every((h:any)=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||!value.snapshot.controlHashes||!Object.values(value.snapshot.controlHashes).every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||(value.tailUserBlockHashes!==undefined&&(!Array.isArray(value.tailUserBlockHashes)||value.tailUserBlockHashes.length>10000||!value.tailUserBlockHashes.every((h:any)=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)))))throw new Error('Invalid interruption fingerprints');}
   if(record.state==='busy'){record.state='uncertain';delete record.jobId;}
   this.records.set(record.key,record);
  }
  for(const compact of saved.compactions){if(!validSession(compact.sessionId)||(compact.agentId!==undefined&&!validAgent(compact.agentId))||!Number.isInteger(compact.sequence)||!['running','ready'].includes(compact.phase))throw new Error('Invalid compaction metadata');this.compactions.set(scopeKey(compact.sessionId,compact.agentId),compact);}
 }
 private persist(){
  const snapshot=JSON.stringify({records:[...this.records.values()],compactions:[...this.compactions.values()]});const file=join(this.stateDir,'direct-contexts.json');
  this.persistence=this.persistence.then(async()=>{await writeFile(file+'.tmp',snapshot,{mode:0o600});await rename(file+'.tmp',file);});return this.persistence;
 }
 async prepare(sessionId:string,workspaceKey:string,request:MessagesRequest,jobId:string,contextCompacted=false,agentId?:string):Promise<DirectFrame>{
  if(!validSession(sessionId)||(agentId!==undefined&&!validAgent(agentId))||!/^[a-f0-9]{64}$/.test(workspaceKey))throw new BridgeError('Invalid native session/workspace identity');
  const key=createHash('sha256').update(sessionId+'\0'+request.model+(agentId===undefined?'':'\0'+agentId)).digest('hex');let record=this.records.get(key);
  if(record&&record.workspaceKey!==workspaceKey){if(record.resetReason==='manual-resync')record.workspaceKey=workspaceKey;else throw new BridgeError('Native session workspace changed; explicit resynchronization is required',409);}
  if(record?.state==='busy')throw new BridgeError('Native context is busy; overlapping main requests are not mixed',409);
  const interruptedFeedback=record?.state==='uncertain'&&record.interruption&&appendedUserFeedback(request,record.interruption);
  if(record?.state==='uncertain'&&!interruptedFeedback)throw new BridgeError('Native context delivery is uncertain. Use context-reset --session '+sessionId+(agentId?' --agent '+agentId:'')+' before resynchronizing.',409);
  if(!record){if(this.records.size>=100)throw new BridgeError('Native context registry is full',429);record={key,sessionId,agentId,workspaceKey,model:request.model,epoch:0,state:'ready',compactSequence:0,updated:new Date().toISOString()};this.records.set(key,record);}
  const compact=this.compactions.get(scopeKey(sessionId,agentId));const sequence=compact?.sequence??0;
  const force=record.resetReason??(interruptedFeedback?'client-interrupted-feedback':contextCompacted||sequence>record.compactSequence?'native-compaction':undefined);
  const plan=planContext(request,record.snapshot,force);
  if(plan.snapshot.messageHashes.length>10000)throw new BridgeError('Native history fingerprint limit exceeded',413);
  const feedback=feedbackCheckpoint(request,plan.snapshot);if((feedback.tailUserBlockHashes?.length??0)>10000)throw new BridgeError('Native feedback fingerprint limit exceeded',413);
  const recoveryCheckpoint=interruptedFeedback?record.interruption:undefined;
  if(interruptedFeedback)record.resetReason='client-interrupted-feedback';
  record.state='busy';record.jobId=jobId;delete record.interruption;record.updated=new Date().toISOString();await this.persist();
  return {key,sessionId,agentId,workspaceKey,model:request.model,jobId,epoch:record.epoch+(plan.kind==='bootstrap'?1:0),conversationId:plan.kind==='delta'?record.conversationId:undefined,plan,compactSequence:sequence,feedback,recoveryCheckpoint};
 }
 async commit(frame:DirectFrame,conversationId:string){
  const record=this.records.get(frame.key);if(!record||record.state!=='busy'||record.jobId!==frame.jobId)throw new BridgeError('Native context lease changed',409);
  record.epoch=frame.epoch;record.conversationId=conversationId;record.snapshot=frame.plan.snapshot;record.compactSequence=frame.compactSequence;record.state='ready';delete record.jobId;delete record.resetReason;record.updated=new Date().toISOString();await this.persist();
 }
 async fail(frame:DirectFrame,uncertain:boolean,clientInterrupted=false){const record=this.records.get(frame.key);if(!record||record.jobId!==frame.jobId)return;const checkpoint=uncertain?(clientInterrupted?frame.feedback:undefined):frame.recoveryCheckpoint;record.state=uncertain||checkpoint?'uncertain':'ready';if(checkpoint)record.interruption=checkpoint;else delete record.interruption;delete record.jobId;record.updated=new Date().toISOString();await this.persist();}
 async compact(sessionId:string,workspaceKey:string|undefined,event:'PreCompact'|'PostCompact',trigger:string,agentId?:string){
  if(!validSession(sessionId)||(agentId!==undefined&&!validAgent(agentId))||(workspaceKey!==undefined&&!/^[a-f0-9]{64}$/.test(workspaceKey)))throw new BridgeError('Invalid compaction identity');
  for(const record of this.records.values())if(record.sessionId===sessionId&&record.agentId===agentId&&workspaceKey&&workspaceKey!==record.workspaceKey)throw new BridgeError('Compaction workspace does not match',409);
  let state=this.compactions.get(scopeKey(sessionId,agentId));if(state?.workspaceKey&&workspaceKey&&state.workspaceKey!==workspaceKey)throw new BridgeError('Compaction workspace changed',409);
  if(!state){if(this.compactions.size>=100)throw new BridgeError('Compaction registry is full',429);state={sessionId,agentId,workspaceKey,phase:'ready',sequence:0,trigger};}
  state.trigger=trigger;state.phase=event==='PreCompact'?'running':'ready';if(event==='PostCompact')state.sequence++;this.compactions.set(scopeKey(sessionId,agentId),state);await this.persist();
 }
 compacting(sessionId:string,agentId?:string){return this.compactions.get(scopeKey(sessionId,agentId))?.phase==='running';}
 async abortCompact(sessionId:string,agentId?:string){const compact=this.compactions.get(scopeKey(sessionId,agentId));if(compact){compact.phase='ready';await this.persist();}}
 async reset(sessionId:string,agentId?:string){if(!validSession(sessionId)||(agentId!==undefined&&!validAgent(agentId)))throw new BridgeError('Invalid session identity');const records=[...this.records.values()].filter(record=>record.sessionId===sessionId&&record.agentId===agentId);if(records.some(record=>record.state==='busy'))throw new BridgeError('Cannot reset an active native context',409);for(const record of records){record.state='ready';record.resetReason='manual-resync';delete record.conversationId;record.updated=new Date().toISOString();}const compact=this.compactions.get(scopeKey(sessionId,agentId));if(compact){compact.phase='ready';delete compact.workspaceKey;}await this.persist();}
 list(sessionId?:string){return [...this.records.values()].filter(r=>!sessionId||r.sessionId===sessionId).map(r=>({sessionId:r.sessionId,agentId:r.agentId,workspaceKey:r.workspaceKey,model:r.model,epoch:r.epoch,state:r.state,conversationId:r.conversationId,messageCount:r.snapshot?.messageHashes.length??0,estimatedTokens:r.snapshot?.estimatedTokens??0,updated:r.updated}));}
 async flush(){await this.persistence;}
}
