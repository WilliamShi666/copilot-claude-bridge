import type {MessagesRequest} from '../protocol/index.js';
import {BridgeError,MODEL_LABELS} from '../protocol/index.js';
import type {ContextPlan,ContextSnapshot,FeedbackCheckpoint} from '../protocol/context.js';
import {planContext,feedbackCheckpoint,appendedUserFeedback,resumeContext,requestIdentity} from '../protocol/context.js';
import {refusalMessage,type CancelReceipt} from '../protocol/cancellation.js';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';
export interface DirectFrame {key:string;sessionId:string;agentId?:string;workspaceKey:string;model:string;jobId:string;epoch:number;conversationId?:string;plan:ContextPlan;compactSequence:number;feedback:FeedbackCheckpoint;recoveryCheckpoint?:FeedbackCheckpoint;identity:string;isolatedRecovery?:boolean;recoveryReason?:string;resumeBackup?:ResumeState}
interface ResumeState {snapshot:ContextSnapshot;conversationId:string;cancelledJobId:string}
interface DirectRecord {key:string;sessionId:string;agentId?:string;workspaceKey:string;model:string;epoch:number;state:'ready'|'busy'|'cancelling'|'uncertain';jobId?:string;lastJobId?:string;conversationId?:string;snapshot?:ContextSnapshot;compactSequence:number;resetReason?:string;interruption?:FeedbackCheckpoint;resume?:ResumeState;fallbackReason?:string;rebuildIdentity?:string;deliveryFailure?:string;failure?:{identity:string;code:'provider_refusal';message:string};updated:string}
interface CompactState {sessionId:string;agentId?:string;workspaceKey?:string;phase:'running'|'ready';sequence:number;trigger:string}
export function validSession(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value);}
export function validAgent(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9._:@-]{1,200}$/.test(value);}
const scopeKey=(sessionId:string,agentId?:string)=>agentId===undefined?sessionId:sessionId+'\0'+agentId;
export class DirectSessions {
 private records=new Map<string,DirectRecord>();private compactions=new Map<string,CompactState>();private persistence=Promise.resolve();private cancellationWaiters=new Map<string,{promise:Promise<void>;resolve:()=>void}>();
 constructor(private stateDir:string){}
 async load(){
  await mkdir(this.stateDir,{recursive:true,mode:0o700});let saved:any;
  try{saved=JSON.parse(await readFile(join(this.stateDir,'direct-contexts.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('Direct context metadata is unreadable; no browser context was resumed.');}
  // Retain long-lived context/refusal/compaction evidence regardless of lifetime session count.
  if(!Array.isArray(saved.records)||!Array.isArray(saved.compactions))throw new Error('Invalid direct context registry');
  for(const record of saved.records){
   if(!validSession(record.sessionId)||(record.agentId!==undefined&&!validAgent(record.agentId))||typeof record.key!=='string'||! /^[a-f0-9]{64}$/.test(record.workspaceKey)||!Number.isInteger(record.epoch)||!['ready','busy','cancelling','uncertain'].includes(record.state))throw new Error('Invalid direct context record');
   if(record.snapshot&&(!Array.isArray(record.snapshot.messageHashes)||record.snapshot.messageHashes.length>10000||!record.snapshot.messageHashes.every((h:any)=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||!record.snapshot.controlHashes||!Object.values(record.snapshot.controlHashes).every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))))throw new Error('Invalid direct context fingerprints');
   if(record.interruption){const value=record.interruption;if(!value.snapshot||!Array.isArray(value.snapshot.messageHashes)||value.snapshot.messageHashes.length>10000||!value.snapshot.messageHashes.every((h:any)=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||!value.snapshot.controlHashes||!Object.values(value.snapshot.controlHashes).every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||(value.tailUserBlockHashes!==undefined&&(!Array.isArray(value.tailUserBlockHashes)||value.tailUserBlockHashes.length>10000||!value.tailUserBlockHashes.every((h:any)=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)))))throw new Error('Invalid interruption fingerprints');}
   if(record.interruption?.tailUserTextOnly!==undefined&&typeof record.interruption.tailUserTextOnly!=='boolean')throw new Error('Invalid interrupted text-tail proof');
   if(record.resume&&(!record.resume.snapshot||!Array.isArray(record.resume.snapshot.messageHashes)||record.resume.snapshot.messageHashes.length>10000||!record.resume.snapshot.messageHashes.every((h:any)=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||!record.resume.snapshot.controlHashes||!Object.values(record.resume.snapshot.controlHashes).every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||typeof record.resume.conversationId!=='string'||typeof record.resume.cancelledJobId!=='string'))throw new Error('Invalid resumable cancellation');
   if(record.deliveryFailure!==undefined&&(typeof record.deliveryFailure!=='string'||record.deliveryFailure.length>1000))throw new Error('Invalid delivery failure');
   if(record.failure&&(!/^[a-f0-9]{64}$/.test(record.failure.identity)||record.failure.code!=='provider_refusal'||typeof record.failure.message!=='string'||record.failure.message.length>1000))throw new Error('Invalid terminal failure');
   if(record.state==='busy'||record.state==='cancelling'){record.state='uncertain';record.fallbackReason='gateway-restarted-before-confirmation';delete record.resume;delete record.jobId;}
   this.records.set(record.key,record);
  }
  for(const compact of saved.compactions){if(!validSession(compact.sessionId)||(compact.agentId!==undefined&&!validAgent(compact.agentId))||!Number.isInteger(compact.sequence)||!['running','ready'].includes(compact.phase))throw new Error('Invalid compaction metadata');this.compactions.set(scopeKey(compact.sessionId,compact.agentId),compact);}
 }
 private persist(){
  const snapshot=JSON.stringify({records:[...this.records.values()],compactions:[...this.compactions.values()]});const file=join(this.stateDir,'direct-contexts.json');
  this.persistence=this.persistence.then(async()=>{await writeFile(file+'.tmp',snapshot,{mode:0o600});await rename(file+'.tmp',file);});return this.persistence;
 }
 async prepare(sessionId:string,workspaceKey:string,request:MessagesRequest,jobId:string,contextCompacted=false,agentId?:string,cancelContinuation=false):Promise<DirectFrame>{
  if(!validSession(sessionId)||(agentId!==undefined&&!validAgent(agentId))||!/^[a-f0-9]{64}$/.test(workspaceKey))throw new BridgeError('Invalid native session/workspace identity');
  const key=createHash('sha256').update(sessionId+'\0'+request.model+(agentId===undefined?'':'\0'+agentId)).digest('hex');let record=this.records.get(key);
  if(record?.state==='cancelling'){const waiter=this.cancellationWaiters.get(key);if(!waiter)throw new BridgeError('Cancellation confirmation is unavailable; no new request was submitted',503,'api_error');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([waiter.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BridgeError('Cancellation confirmation is still pending; no new request was submitted',503,'api_error')),16000);})]);}finally{clearTimeout(timer);}record=this.records.get(key);}
  if(record?.failure)throw new BridgeError(record.failure.message,400,'invalid_request_error');
  if(record&&record.workspaceKey!==workspaceKey){if(record.resetReason==='manual-resync')record.workspaceKey=workspaceKey;else throw new BridgeError('Native session workspace changed; explicit resynchronization is required',409);}
  if(record?.state==='busy')throw new BridgeError('Native context is busy; overlapping main requests are not mixed',409);
  const interruptedFeedback=record?.state==='uncertain'&&record.interruption&&appendedUserFeedback(request,record.interruption);
  if(record?.state==='uncertain'&&!interruptedFeedback)throw new BridgeError('Native context delivery is uncertain. Use context-reset --session '+sessionId+(agentId?' --agent '+agentId:'')+' before resynchronizing.'+(record.deliveryFailure?' Last failure: '+record.deliveryFailure:''),409);
  if(record?.rebuildIdentity===requestIdentity(request))throw new BridgeError('Automatic recovery was already attempted for this feedback; no additional chat was created',400,'invalid_request_error');
  if(!record){record={key,sessionId,agentId,workspaceKey,model:request.model,epoch:0,state:'ready',compactSequence:0,updated:new Date().toISOString()};this.records.set(key,record);}
  const compact=this.compactions.get(scopeKey(sessionId,agentId));const sequence=compact?.sequence??0;
  const resume=cancelContinuation&&interruptedFeedback&&!contextCompacted&&sequence===record.compactSequence?record.resume:undefined;
  const force=record.resetReason??(interruptedFeedback?'client-interrupted-feedback':contextCompacted||sequence>record.compactSequence?'native-compaction':undefined);
  const plan=resume?resumeContext(request,resume.snapshot,resume.cancelledJobId):planContext(request,record.snapshot,force);
  if(plan.snapshot.messageHashes.length>10000)throw new BridgeError('Native history fingerprint limit exceeded',413);
  const feedback=feedbackCheckpoint(request,plan.snapshot);if((feedback.tailUserBlockHashes?.length??0)>10000)throw new BridgeError('Native feedback fingerprint limit exceeded',413);
  const recoveryCheckpoint=interruptedFeedback?record.interruption:undefined;
  if(interruptedFeedback&&!resume)record.resetReason='client-interrupted-feedback';
  const isolatedRecovery=!!cancelContinuation&&(!!interruptedFeedback&&!resume||force==='original-chat-unavailable');
  const recoveryReason=isolatedRecovery?(force==='original-chat-unavailable'?force:record.fallbackReason??'original-chat-unverified'):undefined;
  record.state='busy';record.jobId=jobId;delete record.interruption;delete record.resume;record.updated=new Date().toISOString();await this.persist();
  return {key,sessionId,agentId,workspaceKey,model:request.model,jobId,epoch:record.epoch+(plan.kind==='bootstrap'?1:0),conversationId:resume?.conversationId??(plan.kind==='delta'?record.conversationId:undefined),plan,compactSequence:sequence,feedback,recoveryCheckpoint,identity:requestIdentity(request),isolatedRecovery,recoveryReason,resumeBackup:resume};
 }
 async commit(frame:DirectFrame,conversationId:string){
  const record=this.records.get(frame.key);if(!record||record.state!=='busy'||record.jobId!==frame.jobId)throw new BridgeError('Native context lease changed',409);
  record.epoch=frame.epoch;record.conversationId=conversationId;record.snapshot=frame.plan.snapshot;record.compactSequence=frame.compactSequence;record.state='ready';record.lastJobId=frame.jobId;delete record.jobId;delete record.resetReason;delete record.fallbackReason;delete record.failure;delete record.deliveryFailure;delete record.rebuildIdentity;record.updated=new Date().toISOString();await this.persist();
 }
 async fail(frame:DirectFrame,uncertain:boolean,clientInterrupted=false,deliveryFailure?:string){const record=this.records.get(frame.key);if(!record||record.jobId!==frame.jobId)return;const checkpoint=uncertain?(clientInterrupted?frame.feedback:undefined):frame.recoveryCheckpoint;record.state=uncertain||checkpoint?'uncertain':'ready';if(uncertain&&!clientInterrupted&&deliveryFailure)record.deliveryFailure=deliveryFailure.slice(0,1000);else if(!uncertain)delete record.deliveryFailure;if(!uncertain&&frame.isolatedRecovery&&record.rebuildIdentity===frame.identity)delete record.rebuildIdentity;if(checkpoint)record.interruption=checkpoint;else delete record.interruption;if(!uncertain&&frame.resumeBackup)record.resume=frame.resumeBackup;else delete record.resume;delete record.jobId;record.updated=new Date().toISOString();await this.persist();}
 async beginCancellation(frame:DirectFrame){
  const record=this.records.get(frame.key);if(!record||!(record.jobId===frame.jobId||record.state==='ready'&&record.lastJobId===frame.jobId))return false;
  record.state='cancelling';record.jobId=frame.jobId;record.interruption=frame.feedback;delete record.resume;record.updated=new Date().toISOString();
  let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);this.cancellationWaiters.set(frame.key,{promise,resolve});await this.persist();return true;
 }
 async settleCancellation(frame:DirectFrame,receipt:CancelReceipt){
  const record=this.records.get(frame.key);if(!record||record.state!=='cancelling'||record.jobId!==frame.jobId)return false;
  record.state='uncertain';record.interruption=frame.feedback;delete record.jobId;delete record.resume;
  if(receipt.reason==='provider_refusal'){
   record.failure={identity:frame.identity,code:'provider_refusal',message:refusalMessage(receipt.refusalKind)};delete record.interruption;
  }else if(receipt.outcome==='not_sent'){
   if(frame.isolatedRecovery&&record.rebuildIdentity===frame.identity)delete record.rebuildIdentity;
   const prior=frame.recoveryCheckpoint;record.state=prior?'uncertain':'ready';if(prior){record.interruption=prior;record.resume=frame.resumeBackup;}else delete record.interruption;
  }else if(receipt.outcome==='settled'){
   const snapshot=receipt.inputComplete?frame.plan.snapshot:frame.plan.kind==='bootstrap'?undefined:record.snapshot;record.epoch=frame.epoch;
   if(snapshot){record.resume={snapshot,conversationId:receipt.conversationId,cancelledJobId:frame.jobId};record.epoch=frame.epoch;delete record.resetReason;}
   else record.fallbackReason='initial-context-not-delivered';
  }else record.fallbackReason=receipt.reason??'cancel-not-confirmed';
  record.updated=new Date().toISOString();await this.persist();this.cancellationWaiters.get(frame.key)?.resolve();this.cancellationWaiters.delete(frame.key);return true;
 }
 async terminalFailure(frame:DirectFrame,message:string){const record=this.records.get(frame.key);if(!record||record.jobId!==frame.jobId)return;record.state='uncertain';record.failure={identity:frame.identity,code:'provider_refusal',message:message.slice(0,1000)};delete record.interruption;delete record.resume;delete record.jobId;await this.persist();}
 async markRebuild(frame:DirectFrame){const record=this.records.get(frame.key);if(!record||record.state!=='busy'||record.jobId!==frame.jobId)throw new BridgeError('Recovery lease changed',409);if(record.rebuildIdentity===frame.identity)throw new BridgeError('Automatic recovery was already attempted for this feedback',400,'invalid_request_error');record.rebuildIdentity=frame.identity;await this.persist();}
 async correctFormat(frame:DirectFrame,jobId:string,conversationId:string):Promise<DirectFrame>{
  const record=this.records.get(frame.key);if(!record||record.state!=='busy'||record.jobId!==frame.jobId)throw new BridgeError('Reply correction lease changed',409);
  record.jobId=jobId;record.epoch=frame.epoch;await this.persist();
  // Original input reached this verified chat; malformed tools never reached
  // the client. An unsent correction can still retain that input on cancel.
  return{...frame,jobId,recoveryCheckpoint:frame.feedback,resumeBackup:{snapshot:frame.plan.snapshot,conversationId,cancelledJobId:frame.jobId}};
 }
 async restoreLegacyFailure(sessionId:string,model:string,agentId:string|undefined,message:string){for(const record of this.records.values())if(record.sessionId===sessionId&&record.model===model&&record.agentId===agentId&&record.state==='uncertain'&&!record.failure){record.failure={identity:'0'.repeat(64),code:'provider_refusal',message};delete record.interruption;delete record.resume;}await this.persist();}
 async fallback(frame:DirectFrame,request:MessagesRequest,jobId:string):Promise<DirectFrame>{const record=this.records.get(frame.key);if(!record||record.jobId!==frame.jobId)throw new BridgeError('Recovery lease changed',409);record.jobId=jobId;record.resetReason='original-chat-unavailable';await this.persist();return{...frame,jobId,plan:planContext(request,record.snapshot,'original-chat-unavailable'),epoch:record.epoch+1,conversationId:undefined,isolatedRecovery:true,recoveryReason:'original-chat-unavailable',resumeBackup:undefined};}
 async compact(sessionId:string,workspaceKey:string|undefined,event:'PreCompact'|'PostCompact',trigger:string,agentId?:string){
  if(!validSession(sessionId)||(agentId!==undefined&&!validAgent(agentId))||(workspaceKey!==undefined&&!/^[a-f0-9]{64}$/.test(workspaceKey)))throw new BridgeError('Invalid compaction identity');
  for(const record of this.records.values())if(record.sessionId===sessionId&&record.agentId===agentId&&workspaceKey&&workspaceKey!==record.workspaceKey)throw new BridgeError('Compaction workspace does not match',409);
  let state=this.compactions.get(scopeKey(sessionId,agentId));if(state?.workspaceKey&&workspaceKey&&state.workspaceKey!==workspaceKey)throw new BridgeError('Compaction workspace changed',409);
  if(!state){state={sessionId,agentId,workspaceKey,phase:'ready',sequence:0,trigger};}
  state.trigger=trigger;state.phase=event==='PreCompact'?'running':'ready';if(event==='PostCompact')state.sequence++;this.compactions.set(scopeKey(sessionId,agentId),state);await this.persist();
 }
 compacting(sessionId:string,agentId?:string){return this.compactions.get(scopeKey(sessionId,agentId))?.phase==='running';}
 async abortCompact(sessionId:string,agentId?:string){const compact=this.compactions.get(scopeKey(sessionId,agentId));if(compact){compact.phase='ready';await this.persist();}}
 async reset(sessionId:string,agentId?:string,model?:string){
  if(!validSession(sessionId)||(agentId!==undefined&&!validAgent(agentId)))throw new BridgeError('Invalid session identity');
  if(model!==undefined&&(typeof model!=='string'||!Object.hasOwn(MODEL_LABELS,model)))throw new BridgeError('Invalid reset model');
  const records=[...this.records.values()].filter(record=>record.sessionId===sessionId&&record.agentId===agentId&&(model===undefined||record.model===model));
  if(records.some(record=>record.state==='busy'||record.state==='cancelling'))throw new BridgeError('Cannot reset an active native context',409);
  for(const record of records){record.state='ready';record.resetReason='manual-resync';delete record.rebuildIdentity;delete record.failure;delete record.deliveryFailure;delete record.resume;delete record.interruption;delete record.conversationId;record.updated=new Date().toISOString();}
  const compact=this.compactions.get(scopeKey(sessionId,agentId));if(compact&&model===undefined){compact.phase='ready';delete compact.workspaceKey;}
  await this.persist();
 }
 list(sessionId?:string){return [...this.records.values()].filter(r=>!sessionId||r.sessionId===sessionId).map(r=>({sessionId:r.sessionId,agentId:r.agentId,workspaceKey:r.workspaceKey,model:r.model,epoch:r.epoch,state:r.state,conversationId:r.conversationId,messageCount:r.snapshot?.messageHashes.length??0,estimatedTokens:r.snapshot?.estimatedTokens??0,updated:r.updated}));}
 async flush(){await this.persistence;}
}
