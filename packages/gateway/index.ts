import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual,createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { BridgeError, ReplyFormatError, REPLY_CONTRACT, parseRequest, buildPrompt, parseReply, toMessage, sseEvents, MODEL_LABELS, type MessagesRequest } from '../protocol/index.js';
import { ConversationStore } from './conversations.js';
import type { ConversationCommand,ConversationReceipt,BrowserLane } from '../protocol/conversation.js';
import {parseCancelReceipt,refusalKind,refusalMessage,type CancelReceipt} from '../protocol/cancellation.js';
import {projectImages,imagesForMessages,type BrowserImage} from '../protocol/images.js';
import {DirectSessions,validSession,validAgent,type DirectFrame} from './direct-sessions.js';
import {renderContextPrompt,estimateTokens,planContext} from '../protocol/context.js';
import {AUTOMATIC_RETRY_LIMIT,contextAckRepairPrompt,contextPackets as segmentContext,type ContextPacket} from '../protocol/transfer.js';

import {SUMMARY_MODELS,isSummaryRequest,validateSummary,providerRestriction,type SummaryAttempt} from '../protocol/summary.js';
import {compactionPrompt,summaryPackets,assertCompactionSummary} from './summary-prompt.js';

interface Options { stateDir: string; port?: number; timeoutMs?: number; queueTimeoutMs?:number;cancelTimeoutMs?:number; maxPromptChars?: number; backend?:'chrome'|'excel-desktop';selectedWindow?:number;onClose?:()=>void }
interface Job { contextAckRepairs?:number;contextAckRepairChars?:number;resultSettling?:boolean;formatAttempt?:number;formatFailure?:string;runDeadline?:number;workerDispatched?:boolean;dispatchWorker?:WebSocket;readinessRevision?:number; id: string; kind: 'messages' | 'advice'; phase: 'queued' | 'dispatched' | 'cancelling'|'completed' | 'cancelled' | 'failed'; request: MessagesRequest; prompt: string;summary?:boolean;summaryModel?:string;summaryAttempts?:SummaryAttempt[];contextPackets?:ContextPacket[];promptChars?:number;packetCount?:number;agentId?:string;agentType?:string;requestClass?:string;runTimeoutMs:number; session: string; created: string;finished?:string;error?:string;submitted?:boolean;contextEpoch?:number;transition?:boolean;cancelRequested?:boolean;contextKind?:string;contextReason?:string;contextRemovedFields?:string[]; resolve: (text: string) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout; conversation?:ConversationCommand; conversationReceipt?:ConversationReceipt;lane:BrowserLane;directFrame?:DirectFrame;deliveryFrame?:DirectFrame;cancelNonce?:string;cancelStarted?:number;cancelOutcome?:string;cancelMs?:number;settling?:boolean;cancelContinuation?:1;isolatedRecovery?:boolean;fallbackCount?:number;recoveryNotice?:string;recoveryCause?:string;images?:BrowserImage[];imagePayloads?:Map<string,BrowserImage>;imageCount?:number;imageBytes?:number }
function nativeSession(req:IncomingMessage,request:MessagesRequest):string|undefined {
 const header=req.headers['x-claude-code-session-id']??req.headers['x-bridge-session'];if(validSession(header))return header;
 try{const metadata=typeof request.metadata?.user_id==='string'?JSON.parse(request.metadata.user_id):request.metadata;if(validSession(metadata?.session_id))return metadata.session_id;}catch{}
 return undefined;
}
const extensionOrigin = (value = '') => /^chrome-extension:\/\/[a-p]{32}$/.test(value);
export function sameSecret(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
async function body(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 20_000_000) throw new BridgeError('Request too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError('Invalid JSON'); }
}
export async function startGateway(options: Options) {
  const desktop=options.backend==='excel-desktop',backend=desktop?'excel-desktop':'chrome';
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  let priorBackend:string|undefined;
  try{const saved=JSON.parse(await readFile(join(options.stateDir,'credentials.json'),'utf8'));priorBackend=saved.backend??(extensionOrigin(saved.pairedOrigin)?'chrome':undefined);}catch{}
  if(priorBackend&&priorBackend!==backend)throw new Error('State directory belongs to another backend; choose a separate state directory');
  const conversations=new ConversationStore(options.stateDir);await conversations.load();
  const direct=new DirectSessions(options.stateDir);await direct.load();
  const pairCode = randomBytes(20).toString('hex');
  let clientKey = randomBytes(32).toString('hex');
  const credentialsPath = join(options.stateDir, 'credentials.json');
  let pairUsed = false, workerToken = '', pairedOrigin = '', workerId = '', worker: WebSocket | undefined, ready = false;
  try {
    const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
    if (typeof saved.clientKey === 'string' && /^[a-f0-9]{64}$/.test(saved.clientKey)) clientKey = saved.clientKey;
    if (typeof saved.workerToken === 'string' && /^[a-f0-9]{64}$/.test(saved.workerToken) && (desktop?saved.backend==='excel-desktop':extensionOrigin(saved.pairedOrigin))) {
      workerToken = saved.workerToken; pairedOrigin = saved.pairedOrigin; workerId = typeof saved.workerId === 'string' ? saved.workerId : '';
    }
  } catch {}
  // Desktop start explicitly selects a window. Rebind independently of an old
  // Office process/handle; a stale worker must not authenticate to the new service.
  if(desktop){workerToken=randomBytes(32).toString('hex');workerId='';}
  const saveCredentials = () => writeFile(credentialsPath, JSON.stringify({ clientKey, workerToken, pairedOrigin, workerId,backend }), { mode: 0o600 });
  let readinessRevision=0;
  let active: Job | undefined, completed = 0, lastError: string | null = null, closing = false, conversationControl=false,sessionSyncVersion=0,auxiliaryLanes=false,auxiliaryBootstrap=0,contextPacketSupport=0,summaryRouting=0,agentContexts=0,cancelContinuation=0,imageInput=0,everReady=false;
  const jobs = new Map<string, Job>();
  let persistence = Promise.resolve();
  const ledger = join(options.stateDir, 'dispatch-ledger.json');
  let previousInterrupted = 0;
  try { const previous = JSON.parse(await readFile(ledger, 'utf8')); previousInterrupted = previous.jobs.filter((j: any) => ['queued', 'dispatched','cancelling'].includes(j.phase)).length; const latest=new Map<string,any>();for(const job of previous.jobs)if(job.lane!=='auxiliary')latest.set(JSON.stringify([job.session,job.model,job.agentId]),job);for(const job of latest.values())if(job.phase==='failed'&&job.error==='Copilot refused external-client relay use')await direct.restoreLegacyFailure(job.session,job.model,job.agentId,job.error); } catch {}
  function persist() {
    const snapshot = JSON.stringify({ updated: new Date().toISOString(), jobs: [...jobs.values()].map(({ id, phase, created, finished, error, submitted, session, request,lane,contextKind,contextReason,contextRemovedFields,promptChars,packetCount,summary,summaryModel,summaryAttempts,agentId,agentType,requestClass,cancelOutcome,cancelMs,fallbackCount,recoveryCause,formatAttempt,contextAckRepairs,contextAckRepairChars,imageCount,imageBytes,conversation,contextEpoch }) => ({ id, phase, created, finished, error, submitted, session,lane,contextKind,contextReason,contextRemovedFields,promptChars,packetCount,summary,summaryModel,summaryAttempts,agentId,agentType,requestClass,cancelOutcome,cancelMs,fallbackCount,recoveryCause,formatAttempt,contextAckRepairs,contextAckRepairChars,imageCount,imageBytes,conversationId:conversation?.id,contextEpoch, model: request.model })) });
    persistence = persistence.then(async () => { const temp = ledger + '.tmp'; await writeFile(temp, snapshot, { mode: 0o600 }); await rename(temp, ledger); });
    return persistence;
  }
  const status = () => ({ pid: process.pid,backend,selectedWindow:desktop?options.selectedWindow:undefined, paired: !!workerToken, workerConnected: !!worker && worker.readyState === WebSocket.OPEN, browserReady: ready, active: active ? { id: active.id, phase: active.phase, model: active.request.model,lane:active.lane,agentId:active.agentId,promptChars:active.promptChars,packetCount:active.packetCount } : null, queued: [...jobs.values()].filter(j => j.phase === 'queued').length, completed, previousInterrupted, lastError, usage: sessionSyncVersion===1?'estimated':'unavailable',billing:'unavailable', transport: desktop?'excel-desktop-uia':'copilot-ui-json', capabilities: { text: true, clientTools: true, media: imageInput===1?{images:true,audio:false,video:false}:false, promptCache: false, apiReasoningControls: false, conversationControl,sessionSyncVersion,auxiliaryLanes,auxiliaryBootstrap,contextPackets:contextPacketSupport,summaryRouting,summaryModels:SUMMARY_MODELS,agentContexts,cancelContinuation,imageInput,foregroundInput:desktop },nativeContexts:direct.list() });
  function send(message: unknown) { if (worker?.readyState === WebSocket.OPEN) worker.send(JSON.stringify(message)); }
  // A title may finish after the paired main tab has closed. Let the worker
  // verify a fresh native main request instead of waiting for that tab forever.
  function freshNativeMain(job:Job){return job.lane==='main'&&job.cancelContinuation===1&&job.directFrame?.plan.reason==='first-request'&&job.conversation?.mode==='new';}
  async function dispatch() {
    if (closing || active || worker?.readyState !== WebSocket.OPEN) return;
    const job = [...jobs.values()].find(j => j.phase === 'queued'&&!j.transition&&!j.cancelRequested&&(ready||j.isolatedRecovery||freshNativeMain(j)||j.cancelContinuation===1&&j.conversation?.mode==='continue')); if (!job) return;
    active = job; job.phase = 'dispatched'; job.dispatchWorker=worker;job.readinessRevision=readinessRevision;ready = false;clearTimeout(job.timer);job.runDeadline??=Date.now()+job.runTimeoutMs;if(job.runDeadline<=Date.now()){expire(job);return;}job.timer=setTimeout(()=>expire(job),job.runDeadline-Date.now());
    try { if(job.isolatedRecovery&&job.directFrame)await direct.markRebuild(job.directFrame);await persist(); if(closing||job.phase!=='dispatched'||active?.id!==job.id)return;if(worker!==job.dispatchWorker||worker?.readyState!==WebSocket.OPEN)throw new Error('Worker changed before submission');job.workerDispatched=true;send({ type: 'job', id: job.id, model: job.request.model, modelLabel: job.summary?SUMMARY_MODELS[0]:MODEL_LABELS[job.request.model],...(job.summary?{summary:true}:{}), prompt: job.contextPackets?.[0].prompt??job.prompt,...(job.contextPackets?{contextPackets:job.contextPackets}:{}),lane:job.lane,cancelContinuation:job.cancelContinuation,isolatedRecovery:job.isolatedRecovery,images:job.images, ...(job.conversation?{conversation:job.conversation}:{}) }); }
    catch (error) { finish(job, new BridgeError(error instanceof Error?error.message:'Could not persist dispatch state', 500, 'api_error')); }
  }
  function expire(job:Job){if(!['queued','dispatched'].includes(job.phase))return;const dispatched=job.phase==='dispatched';if(job.workerDispatched)send({type:'cancel',id:job.id,lane:job.lane});finish(job,new BridgeError(job.formatAttempt?'Copilot JSON correction timed out after '+job.formatAttempt+' attempts. Last failure: '+(job.formatFailure??'malformed reply'):dispatched?'Copilot request timed out; it was not automatically resubmitted':'Browser queue wait timed out before submission',504,'api_error'));}
  function finish(job: Job, error?: Error, text?: string) {
    if (!['queued', 'dispatched'].includes(job.phase)) return;
    clearTimeout(job.timer);
    const dispatched=job.phase==='dispatched';job.phase = error ? (error.name === 'AbortError' ? 'cancelled' : 'failed') : 'completed';job.finished=new Date().toISOString();
    if(error){let diagnostic=error.message;for(const secret of [clientKey,workerToken,pairCode])if(secret)diagnostic=diagnostic.replaceAll(secret,'[local credential]');job.error=diagnostic.slice(0,2000);}
    const uncertain=!!job.workerDispatched&&job.submitted!==false;
    if(dispatched&&!job.workerDispatched&&job.dispatchWorker===worker&&job.readinessRevision===readinessRevision&&worker?.readyState===WebSocket.OPEN&&!closing)ready=true;
    if(error&&job.directFrame)void direct.fail(job.directFrame,uncertain,error.name==='AbortError',job.error).catch(()=>{lastError='Native context persistence failed';});
    if (error) { lastError = error.message; if(job.conversation)void (uncertain?conversations.fail(job.conversation.id,job.id):conversations.cancelBeforeDispatch(job.conversation.id,job.id)).catch(()=>{lastError='Conversation metadata persistence failed';});if(job.lane==='auxiliary'&&validSession(job.session)&&direct.compacting(job.session,job.agentId))void direct.abortCompact(job.session,job.agentId).catch(()=>{});job.reject(error); } else { lastError = null; completed++; job.resolve(text!); }
    if (active?.id === job.id) active = undefined;
    // Do not retain source text/history in completed job objects or persisted metadata.
    job.prompt = ''; job.images=undefined;job.imagePayloads=undefined;job.contextPackets=undefined; job.request = { model: job.request.model, max_tokens: 1, messages: [] };
    if(!error)job.deliveryFrame=job.directFrame;
    job.directFrame=undefined;job.dispatchWorker=undefined;
    void persist().then(dispatch).catch(() => { lastError = 'Ledger persistence failed'; });
    const done = [...jobs.values()].filter(j => !['queued', 'dispatched','cancelling'].includes(j.phase));
    for (const old of done.slice(0, Math.max(0, done.length - 100))) jobs.delete(old.id);
  }
  function cancelMessage(job:Job){return{type:'cancel',id:job.id,lane:job.lane,cancelContinuation:1,nonce:job.cancelNonce,conversationId:job.conversation!.id};}
  async function settleCancelled(job:Job,receipt:CancelReceipt){
    if(job.phase!=='cancelling'||job.settling||!job.directFrame||!job.conversation)return;job.settling=true;clearTimeout(job.timer);
    try{
      try{await conversations.settleCancellation(receipt,job.id);}catch(error){if(!(error instanceof BridgeError))throw error;receipt={...receipt,outcome:'unverified',inputComplete:false,cursor:undefined,pageInstance:undefined,reason:receipt.reason==='provider_refusal'?'provider_refusal':'Cancellation evidence did not match the original page'};await conversations.fail(job.conversation.id,job.id);}
      await direct.settleCancellation(job.directFrame,receipt);
      job.phase='cancelled';job.finished=new Date().toISOString();job.cancelOutcome=receipt.outcome;job.cancelMs=Date.now()-(job.cancelStarted??Date.now());job.error=receipt.reason==='provider_refusal'?refusalMessage(receipt.refusalKind):'Client interrupted; '+receipt.outcome;
      if(active?.id===job.id)active=undefined;job.prompt='';job.images=undefined;job.imagePayloads=undefined;job.contextPackets=undefined;job.request={model:job.request.model,max_tokens:1,messages:[]};job.directFrame=undefined;job.deliveryFrame=undefined;job.dispatchWorker=undefined;
      await persist();send({type:'ack',id:job.id,cancelReceipt:true});void dispatch();
    }catch(error){job.settling=false;lastError=error instanceof Error?error.message:'Cancellation persistence failed';throw error;}
  }
  function beginClientCancel(job:Job){
    if(job.transition){job.cancelRequested=true;return;}const frame=job.directFrame??job.deliveryFrame;if(job.phase==='cancelling')return;
    if(job.cancelContinuation===1&&job.workerDispatched&&frame&&job.conversation){
      if(job.phase==='completed')completed=Math.max(0,completed-1);job.directFrame=frame;job.phase='cancelling';job.cancelNonce=randomUUID();job.cancelStarted=Date.now();job.error='Client disconnected; confirming cancellation';clearTimeout(job.timer);if(!active)active=job;
      const pending=direct.beginCancellation(frame);const error=new Error('Client disconnected; browser cancellation pending');error.name='AbortError';job.reject(error);
      void pending.then(async accepted=>{if(!accepted)throw new Error('Cancellation lease changed');await conversations.beginCancellation(job.conversation!,job.id);await persist();send(cancelMessage(job));}).catch(error=>{lastError=String(error.message);});
      job.timer=setTimeout(()=>{void settleCancelled(job,{version:1,jobId:job.id,nonce:job.cancelNonce!,conversationId:job.conversation!.id,lane:job.lane,outcome:'unverified',inputComplete:false,replyState:'none',reason:'Cancellation confirmation timed out'}).catch(()=>{});},options.cancelTimeoutMs??15000);
      return;
    }
    if(['queued','dispatched'].includes(job.phase)){if(job.workerDispatched)send({type:'cancel',id:job.id,lane:job.lane});const error=new Error('Client disconnected; browser request cancelled');error.name='AbortError';finish(job,error);}
  }
  async function correctFormatOnce(job:Job,receipt:unknown){
    if(job.transition)return true;
    if(!job.directFrame||!job.conversation||job.phase!=='dispatched'||job.cancelContinuation!==1)return false;
    if((job.formatAttempt??0)>=AUTOMATIC_RETRY_LIMIT)throw new BridgeError('Copilot reply JSON correction failed after '+job.formatAttempt+' attempts. Last failure: '+(job.formatFailure??'malformed reply'),502,'api_error');
    if(job.runDeadline!==undefined&&job.runDeadline<=Date.now()){expire(job);return true;}
    job.transition=true;clearTimeout(job.timer);
    const oldId=job.id;
    try{
      // Only a completed, authenticated response with verified chat evidence
      // permits this follow-up. Never replay the client request or switch chats.
      const observed=await conversations.complete(job.conversation,receipt,oldId),nextId=randomUUID();
      const conversation=await conversations.reserve({mode:'continue',id:observed.id,workspaceKey:job.directFrame.workspaceKey,lane:job.lane},job.request.model,nextId);
      let frame:DirectFrame;try{frame=await direct.correctFormat(job.directFrame,nextId,observed.id);}catch(error){await conversations.cancelBeforeDispatch(conversation.id,nextId);throw error;}
      clearTimeout(job.timer);
      jobs.set(oldId,{...job,phase:'failed',finished:new Date().toISOString(),error:'Malformed JSON; one same-chat format correction queued',request:{model:job.request.model,max_tokens:1,messages:[]},prompt:'',images:undefined,imagePayloads:undefined,contextPackets:undefined,directFrame:undefined,deliveryFrame:undefined});
      if(active?.id===oldId)active=undefined;
      Object.assign(job,{id:nextId,directFrame:frame,conversation,conversationReceipt:undefined,phase:'queued',submitted:undefined,workerDispatched:false,dispatchWorker:undefined,formatAttempt:(job.formatAttempt??0)+1,resultSettling:false,images:undefined,contextPackets:undefined,isolatedRecovery:false,contextKind:'format-correction',contextReason:'malformed-json'});
      job.prompt='Your previous reply could not be parsed as valid JSON and was NOT delivered to the client. None of its proposed tool calls was executed. Correct only that reply\'s JSON serialization; preserve its intended text and tool arguments. Preserve any refusal as text; never reverse it into a tool request. Do not repeat previously completed local tools or invent tool results. Do not restart the task, change models or edit the workbook. '+REPLY_CONTRACT;
      job.promptChars=job.prompt.length;job.packetCount=1;jobs.set(nextId,job);job.timer=setTimeout(()=>expire(job),Math.min(options.queueTimeoutMs??900000,Math.max(0,(job.runDeadline??Date.now()+job.runTimeoutMs)-Date.now())));await persist();return true;
    }catch(error){finish(job,error instanceof BridgeError?error:new BridgeError(error instanceof Error?error.message:'Could not prepare reply correction',502,'api_error'));return true;}
    finally{job.transition=false;if(job.cancelRequested){job.cancelRequested=false;beginClientCancel(job);}void dispatch();}
  }
  function correctableReply(text:string,request:MessagesRequest){
    if(providerRestriction(text))return false;
    if(/^(?:```(?:json)?\s*\{|\{\s*"content"\s*:)/.test(text.trim()))return true;
    // The DOM renderer can flatten a code block after leading commentary.
    // Validate one complete structured suffix only to permit a same-chat
    // correction. Never extract/execute that suffix as the native response.
    const candidates=[...text.matchAll(/(?:^|\n)[ \t]*(\{\s*"content"\s*:)/g)];
    if(candidates.length!==1)return false;
    const match=candidates[0],offset=match.index!+match[0].indexOf('{');
    try{parseReply(text.slice(offset),request);return true;}catch{return false;}
  }
  async function fallbackOnce(job:Job,cause:string){
    if(job.transition)return true;
    if(job.formatAttempt)return false;
    if(job.fallbackCount||!job.directFrame||!job.conversation||job.phase!=='dispatched'||job.cancelContinuation!==1||!(job.conversation.mode==='continue'||freshNativeMain(job)))return false;
    job.transition=true;for(const secret of [clientKey,workerToken,pairCode])if(secret)cause=cause.replaceAll(secret,'[local credential]');job.recoveryCause=cause.slice(0,500);const oldId=job.id;try{const nextId=randomUUID();const fullPrompt=renderContextPrompt(job.request,planContext(job.request,undefined,'original-chat-unavailable'),freshNativeMain(job)?job.directFrame.epoch:job.directFrame.epoch+1,options.maxPromptChars),packets=segmentContext(fullPrompt,nextId),images=imagesForMessages(job.request.messages,job.imagePayloads??new Map());if(packets&&contextPacketSupport!==1)throw new BridgeError('Reload the Chrome bridge extension to enable segmented long-context recovery. Nothing was submitted.',503,'api_error');await conversations.cancelBeforeDispatch(job.conversation.id,oldId);
    const conversation=await conversations.reserve({mode:'new',workspaceKey:job.directFrame.workspaceKey,lane:job.lane},job.request.model,nextId);let frame:DirectFrame;try{frame=await direct.fallback(job.directFrame,job.request,nextId);}catch(error){await conversations.cancelBeforeDispatch(conversation.id,nextId);throw error;}
    clearTimeout(job.timer);jobs.set(oldId,{...job,phase:'failed',finished:new Date().toISOString(),error:'Original chat unavailable; one isolated recovery queued',request:{model:job.request.model,max_tokens:1,messages:[]},prompt:'',images:undefined,imagePayloads:undefined,contextPackets:undefined,directFrame:undefined,deliveryFrame:undefined});
    if(active?.id===oldId)active=undefined;Object.assign(job,{id:nextId,directFrame:frame,conversation,conversationReceipt:undefined,phase:'queued',submitted:undefined,images,imageCount:images.length,imageBytes:images.reduce((sum,image)=>sum+image.bytes,0),workerDispatched:false,dispatchWorker:undefined,isolatedRecovery:true,fallbackCount:1,resultSettling:false,recoveryNotice:'[Bridge] 原 Copilot 聊天无法恢复，已在新的聊天中完整同步上下文。',contextEpoch:frame.epoch,contextKind:'bootstrap',contextReason:'original-chat-unavailable'});
    job.prompt=fullPrompt;job.contextPackets=packets;job.promptChars=job.prompt.length;job.packetCount=job.contextPackets?.length??1;jobs.set(nextId,job);job.timer=setTimeout(()=>expire(job),options.queueTimeoutMs??900000);await persist();return true;}catch(error){finish(job,error instanceof BridgeError?error:new BridgeError(error instanceof Error?error.message:'Could not prepare recovery',502,'api_error'));return true;}finally{job.transition=false;if(job.cancelRequested){job.cancelRequested=false;beginClientCancel(job);}void dispatch();}
  }
  function json(res: ServerResponse, statusCode: number, data: unknown) { res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-should-retry': 'false' }); res.end(JSON.stringify(data)); }
  const server = http.createServer(async (req, res) => {
    let heartbeat: NodeJS.Timeout | undefined, job: Job | undefined,directFrame:DirectFrame|undefined,reservedConversation:ConversationCommand|undefined,reservationJobId:string|undefined;
    try {
      const host = req.headers.host ?? ''; if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new BridgeError('Loopback Host required', 403);
      const path = new URL(req.url!, 'http://' + host).pathname;
      const origin = req.headers.origin ?? '';
      if(desktop&&origin)throw new BridgeError('Desktop gateway rejects browser origins',403);
      if (origin && !extensionOrigin(origin)) throw new BridgeError('Browser origin rejected', 403);
      if (extensionOrigin(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS' && extensionOrigin(origin)) { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key' }); res.end(); return; }
      if (path === '/bridge/pair' && req.method === 'POST') {
        if(desktop)throw new BridgeError('Desktop gateway does not accept browser pairing',403);
        if (!extensionOrigin(origin)) throw new BridgeError('Pairing requires Chrome extension origin', 403);
        const value = await body(req);
        if (pairUsed || typeof value.code !== 'string' || !sameSecret(value.code, pairCode)) throw new BridgeError('Invalid or used pairing code', 403);
        pairUsed = true; workerToken = randomBytes(32).toString('hex'); pairedOrigin = origin; workerId = '';
        worker?.close(1000, 'New pairing'); worker = undefined; ready = false;
        await saveCredentials();
        json(res, 200, { token: workerToken }); return;
      }
      const key = String(req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!sameSecret(key, clientKey)) throw new BridgeError('Local gateway credential required', 401, 'authentication_error');
      if (path === '/bridge/status' && req.method === 'GET') { json(res, 200, status()); return; }
      if(path==='/bridge/context/status'&&req.method==='GET'){json(res,200,{contexts:direct.list(new URL(req.url!,'http://'+host).searchParams.get('session')??undefined),usage:'estimated',billing:'unavailable'});return;}
      if(path==='/bridge/context/compact'&&req.method==='POST'){
        const event=await body(req);if(!['PreCompact','PostCompact'].includes(event.hook_event_name)||!['manual','auto'].includes(event.trigger)||!validSession(event.session_id))throw new BridgeError('Invalid native compaction event');
        await direct.compact(event.session_id,event.workspaceKey,event.hook_event_name,event.trigger,event.agent_id);json(res,200,{accepted:true});return;
      }
      if(path==='/bridge/context/reset'&&req.method==='POST'){const value=await body(req);await direct.reset(value.session_id,value.agent_id,value.model);json(res,200,{reset:true});return;}
      if(path==='/bridge/conversations'&&req.method==='GET'){json(res,200,{conversations:conversations.list(new URL(req.url!,'http://'+host).searchParams.get('workspaceKey')??'')});return;}
      if (path === '/bridge/stop' && req.method === 'POST') { if(active||[...jobs.values()].some(j=>j.phase==='queued'))throw new BridgeError('Gateway is busy; stop only after active requests finish',409);json(res, 200, { stopping: true }); setTimeout(() => { void close(); }, 50); return; }
      if (path === '/api/hello' && req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
      if (path === '/v1/messages/count_tokens'&&req.method==='POST') { const input=await body(req),request=parseRequest({...input,max_tokens:1});res.setHeader('x-bridge-usage','estimated');json(res,200,{input_tokens:estimateTokens(request)});return; }
      if (path === '/v1/models' && req.method === 'GET') { json(res, 200, { data: Object.keys(MODEL_LABELS).map(id => ({ id, type: 'model', display_name: MODEL_LABELS[id], created_at: '2026-10-11T00:00:00Z' })), has_more: false }); return; }
      const advisory = path === '/bridge/advice';
      if(desktop&&path==='/v1/messages')throw new BridgeError('Excel desktop supports the advisor MCP only; keep the original Claude Code model',400);
      if ((!advisory && path !== '/v1/messages') || req.method !== 'POST') throw new BridgeError('Endpoint not supported', 404, 'not_found_error');
      const input = await body(req);
      if (advisory && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > (options.maxPromptChars ?? (desktop?63000:180000)))) throw new BridgeError('Invalid or oversized advice context'+(desktop?' (desktop limit: 63000 characters)':''));
      const projected=projectImages(parseRequest(advisory ? { model: input.model, max_tokens: 8192, messages: [{ role: 'user', content: input.prompt }] } : input));const request=projected.request;
      if(projected.payloads.size&&imageInput!==1)throw new BridgeError('Reload the matching bridge extension, refresh the workbook and enable optional image input in the bridge popup to enable actual image attachments. Nothing was submitted.',503,'api_error');
      if(advisory&&input.conversation&&!conversationControl)throw new BridgeError('The selected adapter does not support verified conversation continuation',503,'api_error');
      const session=advisory?undefined:nativeSession(req,request);const syncing=!desktop&&sessionSyncVersion===1&&auxiliaryLanes&&conversationControl;
      if(session&&!syncing)throw new BridgeError('Reload the Chrome bridge extension and workbook to enable verified native session synchronization.',503,'api_error');
      const workspaceHeader=req.headers['x-bridge-workspace-key'];
      const workspaceKey=typeof workspaceHeader==='string'&&/^[a-f0-9]{64}$/.test(workspaceHeader)?workspaceHeader:createHash('sha256').update('native:'+session).digest('hex');
      const requestClass=req.headers['x-claude-code-request-class'];
      const agentHeader=advisory?undefined:req.headers['x-claude-code-agent-id'];if(agentHeader!==undefined&&!validAgent(agentHeader))throw new BridgeError('Invalid native agent identity');const agentId=typeof agentHeader==='string'?agentHeader:undefined;
      if(!advisory&&(requestClass==='subagent'||requestClass==='workflow')&&!agentId)throw new BridgeError('Native agent identity is missing; agent contexts cannot be mixed');
      if(agentId&&(!session||agentContexts!==1))throw new BridgeError('Reload the Chrome bridge extension to enable isolated native agent contexts. Nothing was submitted.',503,'api_error');
      const nativeAgentType=req.headers['x-claude-code-agent-type'];const agentType=typeof nativeAgentType==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(nativeAgentType)?nativeAgentType:undefined;
      const compactHint=req.headers['x-claude-code-compaction'];
      const contextCompacted=['auto','manual','reactive'].includes(String(req.headers['x-claude-code-context-compacted']??''));
      const auxiliaryClass=requestClass==='auxiliary'||requestClass==='compaction'||['auto','manual','reactive'].includes(String(compactHint??''));
      if(session&&syncing&&direct.compacting(session,agentId)&&!auxiliaryClass&&(requestClass==='main'||request.tools?.length))await direct.abortCompact(session,agentId);
      let lane:BrowserLane=syncing&&(advisory||!session||auxiliaryClass||(requestClass!=='main'&&(!Array.isArray(request.tools)||direct.compacting(session,agentId))))?'auxiliary':'main';if(agentId&&!auxiliaryClass)lane='main';
      const summary=!advisory&&lane==='auxiliary'&&isSummaryRequest(requestClass,compactHint,!!session&&direct.compacting(session,agentId));
      if(summary&&summaryRouting!==1)throw new BridgeError('Reload the Chrome bridge extension to enable summary model routing. Nothing was submitted.',503,'api_error');
      const jobId=randomUUID();reservationJobId=jobId;let conversation:ConversationCommand|undefined;
      if(!advisory&&session&&lane!=='auxiliary')directFrame=await direct.prepare(session,workspaceKey,request,jobId,contextCompacted,agentId,cancelContinuation===1);
      if(closing)throw new BridgeError('Gateway is stopping',503,'api_error');
      if(directFrame&&agentId)lane=`agent:${directFrame.key}`;
      if(directFrame){try{conversation=await conversations.reserve({mode:directFrame.conversationId?'continue':'new',...(directFrame.conversationId?{id:directFrame.conversationId}:{}),workspaceKey,lane},request.model,jobId);}catch(error){if(cancelContinuation!==1||!directFrame.conversationId||!(error instanceof BridgeError)||error.status!==409)throw error;directFrame=await direct.fallback(directFrame,request,jobId);conversation=await conversations.reserve({mode:'new',workspaceKey,lane},request.model,jobId);}}
      else if(advisory&&input.conversation)conversation=await conversations.reserve({...input.conversation,lane},request.model,jobId);
      reservedConversation=conversation;
      const images=imagesForMessages(directFrame?.plan.messages??request.messages,projected.payloads);
      const sourcePrompt = advisory ? (input.conversation?'请只提供规划、指导或审阅建议，不编辑工作簿，不执行本地命令。只读文件助手会执行明确的阅读材料请求。请遵守下方的回复格式。\n':'请只在聊天中提供规划或审查建议。不要编辑工作簿，也不要运行或调用任何本地工具。请正常输出建议文本，不必输出 JSON。\n') + input.prompt : directFrame?renderContextPrompt(request,directFrame.plan,directFrame.epoch,options.maxPromptChars):buildPrompt(request,options.maxPromptChars);
      const prompt=summary?compactionPrompt(sourcePrompt,options.maxPromptChars):sourcePrompt;
      const sourcePackets=!desktop&&!advisory?segmentContext(prompt,jobId):undefined;
      const packets=summary?summaryPackets(sourcePackets):sourcePackets;
      if(packets&&contextPacketSupport!==1)throw new BridgeError('Reload the Chrome bridge extension to enable segmented long-context transfer. Nothing was submitted.',503,'api_error');
      if ((!ready && !active && !everReady&&!directFrame?.isolatedRecovery&&!(cancelContinuation===1&&directFrame?.conversationId)) || worker?.readyState !== WebSocket.OPEN) throw new BridgeError('Connect the selected Copilot adapter with a ready chat first.', 503, 'api_error');
      if ([...jobs.values()].filter(j => ['queued', 'dispatched'].includes(j.phase)).length >= 16) throw new BridgeError('Browser queue is full', 429, 'rate_limit_error');
      if(res.destroyed){throw new BridgeError('Client disconnected before submission',499,'api_error');}
      let resolve!: (text: string) => void, reject!: (err: Error) => void;
      const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      job = { id: jobId, kind: advisory ? 'advice' : 'messages', phase: 'queued', request, prompt,summary,images,imagePayloads:projected.payloads,imageCount:images.length,imageBytes:images.reduce((sum,image)=>sum+image.bytes,0),agentId,agentType,requestClass:typeof requestClass==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(requestClass)?requestClass:undefined,runTimeoutMs:options.timeoutMs??Math.max(240000,(packets?.length??0)*45000+180000)*(summary?SUMMARY_MODELS.length:1),contextPackets:packets,promptChars:prompt.length,packetCount:packets?.length??1, session: session??'anonymous', created: new Date().toISOString(), resolve, reject, conversation,lane,directFrame,contextEpoch:directFrame?.epoch,contextKind:directFrame?.plan.kind,contextReason:directFrame?.plan.reason,contextRemovedFields:directFrame?.plan.removedFields,cancelContinuation:cancelContinuation===1&&directFrame?1:undefined,isolatedRecovery:directFrame?.isolatedRecovery,fallbackCount:directFrame?.isolatedRecovery?1:0,recoveryNotice:directFrame?.isolatedRecovery?'[Bridge] 原 Copilot 聊天无法恢复，已在新的聊天中完整同步上下文。':undefined };
      jobs.set(job.id, job);
      const cancel = () => {if(job)beginClientCancel(job);};
      res.once('close', () => { if (!res.writableEnded) cancel(); });
      job.timer=setTimeout(()=>expire(job!),options.queueTimeoutMs??900000);
      res.setHeader('x-bridge-usage', session&&syncing?'estimated':'unavailable');res.setHeader('x-bridge-billing','unavailable'); res.setHeader('x-bridge-transport', 'copilot-ui-json'); res.setHeader('request-id', job.id);
      if(directFrame){res.setHeader('x-bridge-context-epoch',String(directFrame.epoch));res.setHeader('x-bridge-context-kind',directFrame.plan.kind);}
      if (request.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'x-should-retry': 'false' });
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
        heartbeat = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), 10000);
      }
      // Attach rejection handler immediately; cancellation can occur while dispatch persistence awaits.
      void result.catch(() => {});
      void dispatch();
      const text = await result;
      if (advisory) { json(res, 200, { requestId: job.id, model: request.model, advice: text, usage: 'unavailable',backend,transport:desktop?'excel-desktop-uia':'copilot-ui-json',...(job.conversationReceipt?{conversation:job.conversationReceipt,contextMode:job.conversation?.mode,contextContinuity:desktop?'same-excel-desktop-chat':'same-browser-chat',conversationVerification:{source:desktop?'authenticated local Excel desktop adapter':'authenticated local browser adapter',method:desktop?'sha256-last-user-and-assistant-accessibility-messages':'sha256-last-user-and-assistant-messages',beforeCursor:job.conversation?.expectedCursor??null,afterCursor:job.conversationReceipt.cursor,resumability:'active-chat-only'}}:{}) }); return; }
      if(job.contextAckRepairs&&!res.headersSent){res.setHeader('x-bridge-context-ack-repairs',job.contextAckRepairs);res.setHeader('x-bridge-context-ack-repair-chars',job.contextAckRepairChars??0);}
      const reply=parseReply(text,request);if(job.formatAttempt)reply.content.unshift({type:'text',text:'[Bridge] Copilot 回复格式异常，已在原聊天中自动纠正 '+job.formatAttempt+' 次。'});if(job.recoveryNotice)reply.content.unshift({type:'text',text:job.recoveryNotice});const message = toMessage(request, reply, job.id,session&&syncing?{input_tokens:estimateTokens(request),output_tokens:estimateTokens(reply)}:undefined);
      if (request.stream) { for (const event of sseEvents(message)) res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`); res.end(); }
      else json(res, 200, message);
    } catch (error) {
      if(directFrame&&!job)await direct.fail(directFrame,false).catch(()=>{});
      if(reservedConversation&&!job)await conversations.cancelBeforeDispatch(reservedConversation.id,reservationJobId??'').catch(()=>{});
      const failure = error instanceof BridgeError ? error : new BridgeError(error instanceof Error ? error.message : 'Gateway error', 500, 'api_error');
      const payload = { type: 'error', error: { type: failure.type, message: failure.message } };
      lastError = failure.message;
      if (!res.destroyed) { if (res.headersSent) { res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`); res.end(); } else json(res, failure.status, payload); }
    } finally { clearInterval(heartbeat);if(job?.phase!=='cancelling'&&job)job.deliveryFrame=undefined; }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  server.on('upgrade', (req, socket, head) => {
    const validTransport=desktop?req.url==='/bridge/desktop/socket'&&!req.headers.origin:req.url==='/bridge/socket'&&extensionOrigin(req.headers.origin)&&req.headers.origin===pairedOrigin;
    if (!validTransport || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', (ws: WebSocket) => {
    let authenticated = false;
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('message', async bytes => {
      try {
        const value = JSON.parse(String(bytes));
        if (!authenticated) {
          if (value.type !== 'hello' || typeof value.token !== 'string' || !sameSecret(value.token, workerToken) || typeof value.workerId !== 'string') throw new Error('Invalid worker authentication');
          if (worker && worker !== ws) worker.close(1000, 'Reconnected');
          if (workerId && workerId !== value.workerId) throw new Error('Different paired worker');
          authenticated = true; clearTimeout(authTimer); worker = ws; workerId = value.workerId;readinessRevision++;ready = value.ready === true;everReady=ready;conversationControl=value.conversationControl===true&&value.conversationResumability==='active-chat-only';sessionSyncVersion=value.sessionSyncVersion===1?1:0;auxiliaryLanes=value.auxiliaryLanes===true;auxiliaryBootstrap=value.auxiliaryBootstrap===1?1:0;contextPacketSupport=value.contextPackets===1?1:0;summaryRouting=value.summaryRouting===1?1:0;agentContexts=value.agentContexts===1?1:0;cancelContinuation=value.cancelContinuation===1?1:0;imageInput=value.imageInput===1?1:0;
          await saveCredentials();
          send({ type: 'connected', activeId: active?.id ?? null });
          if(active?.phase==='cancelling')send(cancelMessage(active));else if (active?.workerDispatched) send({ type: 'recover', id: active.id,lane:active.lane }); else void dispatch();
          return;
        }
        if (worker !== ws) return;
        if (value.type === 'ping') { send({ type: 'pong' }); return; }
        if(value.type==='cancel_receipt'){
          const job=jobs.get(value.id);if(!job||job.phase!=='cancelling'){send({type:'ack',id:value.id,cancelReceipt:true,discarded:true});return;}
          const receipt=parseCancelReceipt(value.receipt);
          if(receipt.jobId!==job.id||receipt.nonce!==job.cancelNonce||receipt.lane!==job.lane||receipt.conversationId!==job.conversation?.id){lastError='Cancellation receipt identity mismatch';return;}
          await settleCancelled(job,receipt);return;
        }
        if (value.type === 'ready') { readinessRevision++;ready = value.ready === true;if(ready)everReady=true;if(value.conversationControl!==undefined)conversationControl=value.conversationControl===true&&value.conversationResumability==='active-chat-only';if(value.sessionSyncVersion!==undefined)sessionSyncVersion=value.sessionSyncVersion===1?1:0;if(value.auxiliaryLanes!==undefined)auxiliaryLanes=value.auxiliaryLanes===true;if(value.auxiliaryBootstrap!==undefined)auxiliaryBootstrap=value.auxiliaryBootstrap===1?1:0;if(value.contextPackets!==undefined)contextPacketSupport=value.contextPackets===1?1:0;if(value.summaryRouting!==undefined)summaryRouting=value.summaryRouting===1?1:0;if(value.agentContexts!==undefined)agentContexts=value.agentContexts===1?1:0;if(value.cancelContinuation!==undefined)cancelContinuation=value.cancelContinuation===1?1:0;if(value.imageInput!==undefined)imageInput=value.imageInput===1?1:0;void dispatch(); return; }
        if (value.type === 'result' || value.type === 'failure') {
          const job = jobs.get(value.id);
          if(job?.transition)return;
          if(job?.phase==='cancelling'){
            if(value.type==='failure'&&value.code==='provider_refusal')await settleCancelled(job,{version:1,jobId:job.id,nonce:job.cancelNonce!,conversationId:job.conversation!.id,lane:job.lane,outcome:'unverified',inputComplete:false,replyState:'none',reason:'provider_refusal',refusalKind:refusalKind(value.error)});
            return;
          }
          if (!job || job.phase !== 'dispatched') { send({ type: 'ack', id: value.id, discarded: true }); return; }
          if(value.contextAckRepairs!==undefined){const maxRepairs=AUTOMATIC_RETRY_LIMIT*(job.summary?SUMMARY_MODELS.length:1),maxRepairChars=value.contextAckRepairs*contextAckRepairPrompt('BRIDGE_CONTEXT_ACK_'+job.id+'_31').length;if(!Number.isInteger(value.contextAckRepairs)||value.contextAckRepairs<0||value.contextAckRepairs>maxRepairs||!Number.isInteger(value.contextAckRepairChars)||value.contextAckRepairChars<0||value.contextAckRepairChars>maxRepairChars)throw new Error('Invalid context ACK repair diagnostics');job.contextAckRepairs=value.contextAckRepairs;job.contextAckRepairChars=value.contextAckRepairChars;}
          if(job.summary){
            if(Array.isArray(value.summaryAttempts))job.summaryAttempts=value.summaryAttempts.slice(0,3).filter((a:any)=>SUMMARY_MODELS.includes(a?.model)).map((a:any)=>{let diagnostic=typeof a.error==='string'?a.error:undefined;for(const secret of [clientKey,workerToken,pairCode])if(secret)diagnostic=diagnostic?.replaceAll(secret,'[local credential]');return{model:a.model,...(diagnostic?{error:diagnostic.slice(0,500)}:{})};});
            if(value.type==='result'){if(!SUMMARY_MODELS.includes(value.summaryModel))throw new Error('Summary model provenance is missing');job.summaryModel=value.summaryModel;}
          }
          if (value.type === 'failure') {
            if(typeof value.submitted==='boolean')job.submitted=value.submitted;
            if(value.code==='provider_refusal'){
              const message=String(value.error||'Copilot refused this request');if(job.directFrame)await direct.terminalFailure(job.directFrame,message);finish(job,new BridgeError(message,400,'invalid_request_error'));
            }else if(value.code==='conversation_unavailable'&&value.submitted===false&&await fallbackOnce(job,String(value.error??'Original chat unavailable'))){send({type:'ack',id:value.id,discarded:true});return;}
            else finish(job,new BridgeError(String(value.error || 'Copilot transport failed'),502,'api_error'));
          }
          else {
            // Deduplicate before the first asynchronous persistence operation.
            // Keep cancellation independent so it can still claim this job.
            if(job.resultSettling)return;job.resultSettling=true;
            if (typeof value.text !== 'string') throw new Error('Missing reply text');
            const restriction=providerRestriction(value.text);
            if(restriction){if(job.directFrame)await direct.terminalFailure(job.directFrame,restriction);finish(job,new BridgeError(restriction,400,'invalid_request_error'));send({type:'ack',id:value.id});return;}
            if(job.images?.length&&(!Array.isArray(value.imageIds)||value.imageIds.length!==job.images.length||job.images.some((image,index)=>value.imageIds[index]!==image.id)))throw new Error('Browser did not verify actual image attachment delivery; the reply was not returned');
            if(job.summary){validateSummary(value.text);assertCompactionSummary(value.text);}
            // Count a success only after validating the actual upstream response.
            if (job.kind === 'messages') {
              try{parseReply(value.text,job.request);}catch(error){
                if(error instanceof ReplyFormatError&&correctableReply(value.text,job.request)){job.formatFailure=error.message;if(await correctFormatOnce(job,value.conversation)){send({type:'ack',id:value.id});return;}}
                throw error;
              }
            }
            else if (!value.text.trim() || value.text.length > 500000) throw new Error('Empty or oversized advisory response');
            if(job.conversation)job.conversationReceipt=await conversations.complete(job.conversation,value.conversation,job.id);
            else if(job.lane==='auxiliary')await conversations.invalidateLane('auxiliary');
            if(job.phase!=='dispatched')return;
            if(job.directFrame){if(!job.conversationReceipt)throw new Error('Native browser context was not verified');await direct.commit(job.directFrame,job.conversationReceipt.id);}
            if(job.phase!=='dispatched')return;
            finish(job, undefined, value.text);
          }
          send({ type: 'ack', id: value.id });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Worker protocol failure'; lastError = message;
        if (!authenticated) ws.close(1008, 'Authentication failed');
        else if (active) finish(active, new BridgeError(message, 502, 'api_error'));
      }
    });
    ws.on('close', () => { clearTimeout(authTimer); if (worker === ws) { worker = undefined; readinessRevision++;ready = false;everReady=false;agentContexts=0;cancelContinuation=0;imageInput=0;conversationControl=false;sessionSyncVersion=0;auxiliaryLanes=false;auxiliaryBootstrap=0;contextPacketSupport=0;summaryRouting=0; } });
    ws.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 59173, '127.0.0.1', resolve); });
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
  await saveCredentials();
  await writeFile(join(options.stateDir, 'runtime.json'), JSON.stringify({ url, clientKey, pairCode, pid: process.pid,backend, started: new Date().toISOString() }, null, 2), { mode: 0o600 });
  async function close() {
    if (closing) return; closing = true;
    options.onClose?.();
    for(const job of jobs.values())if(job.phase==='cancelling')await settleCancelled(job,{version:1,jobId:job.id,nonce:job.cancelNonce!,conversationId:job.conversation!.id,lane:job.lane,outcome:'unverified',inputComplete:false,replyState:'none',reason:'Gateway stopped before cancellation confirmation'}).catch(()=>{});
    for (const job of jobs.values()) if (['queued', 'dispatched'].includes(job.phase)) finish(job, new BridgeError('Gateway stopped; no request will be replayed', 503, 'api_error'));
    for (const ws of sockets.clients) ws.terminate(); sockets.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await persistence.catch(() => {});await conversations.flush().catch(()=>{});await direct.flush().catch(()=>{});
  }
  return { url, clientKey, pairCode, close, status,backend,desktopWorkerToken:desktop?workerToken:undefined };
}
