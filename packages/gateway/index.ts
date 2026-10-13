import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual,createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { BridgeError, parseRequest, buildPrompt, parseReply, toMessage, sseEvents, MODEL_LABELS, type MessagesRequest } from '../protocol/index.js';
import { ConversationStore } from './conversations.js';
import type { ConversationCommand,ConversationReceipt,BrowserLane } from '../protocol/conversation.js';
import {DirectSessions,validSession,type DirectFrame} from './direct-sessions.js';
import {renderContextPrompt,estimateTokens} from '../protocol/context.js';
import {contextPackets as segmentContext,type ContextPacket} from '../protocol/transfer.js';

import {SUMMARY_MODELS,isSummaryRequest,validateSummary,type SummaryAttempt} from '../protocol/summary.js';
import {compactionPrompt,summaryPackets,assertCompactionSummary} from './summary-prompt.js';

interface Options { stateDir: string; port?: number; timeoutMs?: number; maxPromptChars?: number; backend?:'chrome'|'excel-desktop';selectedWindow?:number;onClose?:()=>void }
interface Job { id: string; kind: 'messages' | 'advice'; phase: 'queued' | 'dispatched' | 'completed' | 'cancelled' | 'failed'; request: MessagesRequest; prompt: string;summary?:boolean;summaryModel?:string;summaryAttempts?:SummaryAttempt[];contextPackets?:ContextPacket[];promptChars?:number;packetCount?:number; session: string; created: string;finished?:string;error?:string;submitted?:boolean;contextKind?:string;contextReason?:string;contextRemovedFields?:string[]; resolve: (text: string) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout; conversation?:ConversationCommand; conversationReceipt?:ConversationReceipt;lane:BrowserLane;directFrame?:DirectFrame }
function nativeSession(req:IncomingMessage,request:MessagesRequest):string|undefined {
 const header=req.headers['x-claude-code-session-id']??req.headers['x-bridge-session'];if(validSession(header))return header;
 try{const metadata=typeof request.metadata?.user_id==='string'?JSON.parse(request.metadata.user_id):request.metadata;if(validSession(metadata?.session_id))return metadata.session_id;}catch{}
 return undefined;
}
const extensionOrigin = (value = '') => /^chrome-extension:\/\/[a-p]{32}$/.test(value);
export function sameSecret(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
async function body(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4_000_000) throw new BridgeError('Request too large', 413); chunks.push(chunk); }
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
  let active: Job | undefined, completed = 0, lastError: string | null = null, closing = false, conversationControl=false,sessionSyncVersion=0,auxiliaryLanes=false,auxiliaryBootstrap=0,contextPacketSupport=0,summaryRouting=0;
  const jobs = new Map<string, Job>();
  let persistence = Promise.resolve();
  const ledger = join(options.stateDir, 'dispatch-ledger.json');
  let previousInterrupted = 0;
  try { const previous = JSON.parse(await readFile(ledger, 'utf8')); previousInterrupted = previous.jobs.filter((j: any) => ['queued', 'dispatched'].includes(j.phase)).length; } catch {}
  function persist() {
    const snapshot = JSON.stringify({ updated: new Date().toISOString(), jobs: [...jobs.values()].map(({ id, phase, created, finished, error, submitted, session, request,lane,contextKind,contextReason,contextRemovedFields,promptChars,packetCount,summary,summaryModel,summaryAttempts }) => ({ id, phase, created, finished, error, submitted, session,lane,contextKind,contextReason,contextRemovedFields,promptChars,packetCount,summary,summaryModel,summaryAttempts, model: request.model })) });
    persistence = persistence.then(async () => { const temp = ledger + '.tmp'; await writeFile(temp, snapshot, { mode: 0o600 }); await rename(temp, ledger); });
    return persistence;
  }
  const status = () => ({ pid: process.pid,backend,selectedWindow:desktop?options.selectedWindow:undefined, paired: !!workerToken, workerConnected: !!worker && worker.readyState === WebSocket.OPEN, browserReady: ready, active: active ? { id: active.id, phase: active.phase, model: active.request.model,lane:active.lane,promptChars:active.promptChars,packetCount:active.packetCount } : null, queued: [...jobs.values()].filter(j => j.phase === 'queued').length, completed, previousInterrupted, lastError, usage: sessionSyncVersion===1?'estimated':'unavailable',billing:'unavailable', transport: desktop?'excel-desktop-uia':'copilot-ui-json', capabilities: { text: true, clientTools: true, media: false, promptCache: false, apiReasoningControls: false, conversationControl,sessionSyncVersion,auxiliaryLanes,auxiliaryBootstrap,contextPackets:contextPacketSupport,summaryRouting,summaryModels:SUMMARY_MODELS,foregroundInput:desktop },nativeContexts:direct.list() });
  function send(message: unknown) { if (worker?.readyState === WebSocket.OPEN) worker.send(JSON.stringify(message)); }
  async function dispatch() {
    if (closing || active || !ready || worker?.readyState !== WebSocket.OPEN) return;
    const job = [...jobs.values()].find(j => j.phase === 'queued'); if (!job) return;
    active = job; job.phase = 'dispatched'; ready = false;
    try { await persist(); send({ type: 'job', id: job.id, model: job.request.model, modelLabel: job.summary?SUMMARY_MODELS[0]:MODEL_LABELS[job.request.model],...(job.summary?{summary:true}:{}), prompt: job.contextPackets?.[0].prompt??job.prompt,...(job.contextPackets?{contextPackets:job.contextPackets}:{}),lane:job.lane, ...(job.conversation?{conversation:job.conversation}:{}) }); }
    catch { finish(job, new BridgeError('Could not persist dispatch state', 500, 'api_error')); }
  }
  function finish(job: Job, error?: Error, text?: string) {
    if (!['queued', 'dispatched'].includes(job.phase)) return;
    clearTimeout(job.timer);
    const dispatched=job.phase==='dispatched';job.phase = error ? (error.name === 'AbortError' ? 'cancelled' : 'failed') : 'completed';job.finished=new Date().toISOString();
    if(error){let diagnostic=error.message;for(const secret of [clientKey,workerToken,pairCode])if(secret)diagnostic=diagnostic.replaceAll(secret,'[local credential]');job.error=diagnostic.slice(0,2000);}
    const uncertain=dispatched&&job.submitted!==false;
    if(error&&job.directFrame)void direct.fail(job.directFrame,uncertain).catch(()=>{lastError='Native context persistence failed';});
    if (error) { lastError = error.message; if(job.conversation)void (uncertain?conversations.fail(job.conversation.id,job.id):conversations.cancelBeforeDispatch(job.conversation.id,job.id)).catch(()=>{lastError='Conversation metadata persistence failed';});if(job.lane==='auxiliary'&&validSession(job.session)&&direct.compacting(job.session))void direct.abortCompact(job.session).catch(()=>{});job.reject(error); } else { lastError = null; completed++; job.resolve(text!); }
    if (active?.id === job.id) active = undefined;
    // Do not retain source text/history in completed job objects or persisted metadata.
    job.prompt = ''; job.contextPackets=undefined; job.request = { model: job.request.model, max_tokens: 1, messages: [] };
    job.directFrame=undefined;
    void persist().then(dispatch).catch(() => { lastError = 'Ledger persistence failed'; });
    const done = [...jobs.values()].filter(j => !['queued', 'dispatched'].includes(j.phase));
    for (const old of done.slice(0, Math.max(0, done.length - 100))) jobs.delete(old.id);
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
        await direct.compact(event.session_id,event.workspaceKey,event.hook_event_name,event.trigger);json(res,200,{accepted:true});return;
      }
      if(path==='/bridge/context/reset'&&req.method==='POST'){const value=await body(req);await direct.reset(value.session_id);json(res,200,{reset:true});return;}
      if(path==='/bridge/conversations'&&req.method==='GET'){json(res,200,{conversations:conversations.list(new URL(req.url!,'http://'+host).searchParams.get('workspaceKey')??'')});return;}
      if (path === '/bridge/stop' && req.method === 'POST') { if(active||[...jobs.values()].some(j=>j.phase==='queued'))throw new BridgeError('Gateway is busy; stop only after active requests finish',409);json(res, 200, { stopping: true }); setTimeout(() => { void close(); }, 50); return; }
      if (path === '/api/hello' && req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
      if (path === '/v1/messages/count_tokens'&&req.method==='POST') { const input=await body(req);parseRequest({...input,max_tokens:1});res.setHeader('x-bridge-usage','estimated');json(res,200,{input_tokens:estimateTokens(input)});return; }
      if (path === '/v1/models' && req.method === 'GET') { json(res, 200, { data: Object.keys(MODEL_LABELS).map(id => ({ id, type: 'model', display_name: MODEL_LABELS[id], created_at: '2026-10-11T00:00:00Z' })), has_more: false }); return; }
      const advisory = path === '/bridge/advice';
      if(desktop&&path==='/v1/messages')throw new BridgeError('Excel desktop supports the advisor MCP only; keep the original Claude Code model',400);
      if ((!advisory && path !== '/v1/messages') || req.method !== 'POST') throw new BridgeError('Endpoint not supported', 404, 'not_found_error');
      const input = await body(req);
      if (advisory && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > (options.maxPromptChars ?? (desktop?63000:180000)))) throw new BridgeError('Invalid or oversized advice context'+(desktop?' (desktop limit: 63000 characters)':''));
      const request = parseRequest(advisory ? { model: input.model, max_tokens: 8192, messages: [{ role: 'user', content: input.prompt }] } : input);
      if(advisory&&input.conversation&&!conversationControl)throw new BridgeError('The selected adapter does not support verified conversation continuation',503,'api_error');
      const session=advisory?undefined:nativeSession(req,request);const syncing=!desktop&&sessionSyncVersion===1&&auxiliaryLanes&&conversationControl;
      if(session&&!syncing)throw new BridgeError('Reload the Chrome bridge extension and workbook to enable verified native session synchronization.',503,'api_error');
      const workspaceHeader=req.headers['x-bridge-workspace-key'];
      const workspaceKey=typeof workspaceHeader==='string'&&/^[a-f0-9]{64}$/.test(workspaceHeader)?workspaceHeader:createHash('sha256').update('native:'+session).digest('hex');
      const requestClass=req.headers['x-claude-code-request-class'];
      const compactHint=req.headers['x-claude-code-compaction'];
      const contextCompacted=['auto','manual','reactive'].includes(String(req.headers['x-claude-code-context-compacted']??''));
      const auxiliaryClass=requestClass==='auxiliary'||requestClass==='compaction'||['auto','manual','reactive'].includes(String(compactHint??''));
      if(session&&syncing&&direct.compacting(session)&&!auxiliaryClass&&(requestClass==='main'||request.tools?.length))await direct.abortCompact(session);
      const lane:BrowserLane=syncing&&(advisory||!session||auxiliaryClass||(requestClass!=='main'&&(!Array.isArray(request.tools)||direct.compacting(session))))?'auxiliary':'main';
      const summary=!advisory&&lane==='auxiliary'&&isSummaryRequest(requestClass,compactHint,!!session&&direct.compacting(session));
      if(summary&&summaryRouting!==1)throw new BridgeError('Reload the Chrome bridge extension to enable summary model routing. Nothing was submitted.',503,'api_error');
      const jobId=randomUUID();reservationJobId=jobId;let conversation:ConversationCommand|undefined;
      if(!advisory&&session&&lane==='main')directFrame=await direct.prepare(session,workspaceKey,request,jobId,contextCompacted);
      if(directFrame)conversation=await conversations.reserve({mode:directFrame.conversationId?'continue':'new',...(directFrame.conversationId?{id:directFrame.conversationId}:{}),workspaceKey,lane:'main'},request.model,jobId);
      else if(advisory&&input.conversation)conversation=await conversations.reserve({...input.conversation,lane},request.model,jobId);
      reservedConversation=conversation;
      const sourcePrompt = advisory ? (input.conversation?'请只提供规划、指导或审阅建议，不编辑工作簿，不执行本地命令。只读文件助手会执行明确的阅读材料请求。请遵守下方的回复格式。\n':'请只在聊天中提供规划或审查建议。不要编辑工作簿，也不要运行或调用任何本地工具。请正常输出建议文本，不必输出 JSON。\n') + input.prompt : directFrame?renderContextPrompt(request,directFrame.plan,directFrame.epoch,options.maxPromptChars):buildPrompt(request,options.maxPromptChars);
      const prompt=summary?compactionPrompt(sourcePrompt,options.maxPromptChars):sourcePrompt;
      const sourcePackets=!desktop&&!advisory?segmentContext(prompt,jobId):undefined;
      const packets=summary?summaryPackets(sourcePackets):sourcePackets;
      if(packets&&contextPacketSupport!==1)throw new BridgeError('Reload the Chrome bridge extension to enable segmented long-context transfer. Nothing was submitted.',503,'api_error');
      if ((!ready && !active) || worker?.readyState !== WebSocket.OPEN) throw new BridgeError('Connect the selected Copilot adapter with a ready chat first.', 503, 'api_error');
      if ([...jobs.values()].filter(j => ['queued', 'dispatched'].includes(j.phase)).length >= 16) throw new BridgeError('Browser queue is full', 429, 'rate_limit_error');
      if(res.destroyed){if(conversation)await conversations.fail(conversation.id,jobId);throw new BridgeError('Client disconnected before submission',499,'api_error');}
      let resolve!: (text: string) => void, reject!: (err: Error) => void;
      const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      job = { id: jobId, kind: advisory ? 'advice' : 'messages', phase: 'queued', request, prompt,summary,contextPackets:packets,promptChars:prompt.length,packetCount:packets?.length??1, session: session??'anonymous', created: new Date().toISOString(), resolve, reject, conversation,lane,directFrame,contextKind:directFrame?.plan.kind,contextReason:directFrame?.plan.reason,contextRemovedFields:directFrame?.plan.removedFields };
      jobs.set(job.id, job);
      const cancel = () => { if (job && ['queued', 'dispatched'].includes(job.phase)) { send({ type: 'cancel', id: job.id }); const error = new Error('Client disconnected; browser request cancelled'); error.name = 'AbortError'; finish(job, error); } };
      res.once('close', () => { if (!res.writableEnded) cancel(); });
      job.timer = setTimeout(() => { send({ type: 'cancel', id: job!.id }); finish(job!, new BridgeError('Copilot request timed out; it was not automatically resubmitted', 504, 'api_error')); }, options.timeoutMs ?? Math.max(240000,(packets?.length??0)*45000+180000)*(summary?SUMMARY_MODELS.length:1));
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
      const reply=parseReply(text,request);const message = toMessage(request, reply, job.id,session&&syncing?{input_tokens:estimateTokens(request),output_tokens:estimateTokens(reply)}:undefined);
      if (request.stream) { for (const event of sseEvents(message)) res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`); res.end(); }
      else json(res, 200, message);
    } catch (error) {
      if(directFrame&&!job)await direct.fail(directFrame,false).catch(()=>{});
      if(reservedConversation&&!job)await conversations.cancelBeforeDispatch(reservedConversation.id,reservationJobId??'').catch(()=>{});
      const failure = error instanceof BridgeError ? error : new BridgeError(error instanceof Error ? error.message : 'Gateway error', 500, 'api_error');
      const payload = { type: 'error', error: { type: failure.type, message: failure.message } };
      lastError = failure.message;
      if (!res.destroyed) { if (res.headersSent) { res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`); res.end(); } else json(res, failure.status, payload); }
    } finally { clearInterval(heartbeat); }
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
          authenticated = true; clearTimeout(authTimer); worker = ws; workerId = value.workerId; ready = value.ready === true;conversationControl=value.conversationControl===true&&value.conversationResumability==='active-chat-only';sessionSyncVersion=value.sessionSyncVersion===1?1:0;auxiliaryLanes=value.auxiliaryLanes===true;auxiliaryBootstrap=value.auxiliaryBootstrap===1?1:0;contextPacketSupport=value.contextPackets===1?1:0;summaryRouting=value.summaryRouting===1?1:0;
          await saveCredentials();
          send({ type: 'connected', activeId: active?.id ?? null });
          if (active) send({ type: 'recover', id: active.id,lane:active.lane }); else void dispatch();
          return;
        }
        if (worker !== ws) return;
        if (value.type === 'ping') { send({ type: 'pong' }); return; }
        if (value.type === 'ready') { ready = value.ready === true;if(value.conversationControl!==undefined)conversationControl=value.conversationControl===true&&value.conversationResumability==='active-chat-only';if(value.sessionSyncVersion!==undefined)sessionSyncVersion=value.sessionSyncVersion===1?1:0;if(value.auxiliaryLanes!==undefined)auxiliaryLanes=value.auxiliaryLanes===true;if(value.auxiliaryBootstrap!==undefined)auxiliaryBootstrap=value.auxiliaryBootstrap===1?1:0;if(value.contextPackets!==undefined)contextPacketSupport=value.contextPackets===1?1:0;if(value.summaryRouting!==undefined)summaryRouting=value.summaryRouting===1?1:0;void dispatch(); return; }
        if (value.type === 'result' || value.type === 'failure') {
          const job = jobs.get(value.id);
          if (!job || job.phase !== 'dispatched') { send({ type: 'ack', id: value.id, discarded: true }); return; }
          if(job.summary){
            if(Array.isArray(value.summaryAttempts))job.summaryAttempts=value.summaryAttempts.slice(0,3).filter((a:any)=>SUMMARY_MODELS.includes(a?.model)).map((a:any)=>{let diagnostic=typeof a.error==='string'?a.error:undefined;for(const secret of [clientKey,workerToken,pairCode])if(secret)diagnostic=diagnostic?.replaceAll(secret,'[local credential]');return{model:a.model,...(diagnostic?{error:diagnostic.slice(0,500)}:{})};});
            if(value.type==='result'){if(!SUMMARY_MODELS.includes(value.summaryModel))throw new Error('Summary model provenance is missing');job.summaryModel=value.summaryModel;}
          }
          if (value.type === 'failure') {if(typeof value.submitted==='boolean')job.submitted=value.submitted;finish(job, new BridgeError(String(value.error || 'Copilot transport failed'), 502, 'api_error'));}
          else {
            if (typeof value.text !== 'string') throw new Error('Missing reply text');
            if(job.summary){validateSummary(value.text);assertCompactionSummary(value.text);}
            // Count a success only after validating the actual upstream response.
            if (job.kind === 'messages') parseReply(value.text, job.request);
            else if (!value.text.trim() || value.text.length > 500000) throw new Error('Empty or oversized advisory response');
            if(job.conversation)job.conversationReceipt=await conversations.complete(job.conversation,value.conversation,job.id);
            else if(job.lane==='auxiliary')await conversations.invalidateLane('auxiliary');
            if(job.directFrame){if(!job.conversationReceipt)throw new Error('Native browser context was not verified');await direct.commit(job.directFrame,job.conversationReceipt.id);}
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
    ws.on('close', () => { clearTimeout(authTimer); if (worker === ws) { worker = undefined; ready = false;conversationControl=false;sessionSyncVersion=0;auxiliaryLanes=false;auxiliaryBootstrap=0;contextPacketSupport=0;summaryRouting=0; } });
    ws.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 59173, '127.0.0.1', resolve); });
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
  await saveCredentials();
  await writeFile(join(options.stateDir, 'runtime.json'), JSON.stringify({ url, clientKey, pairCode, pid: process.pid,backend, started: new Date().toISOString() }, null, 2), { mode: 0o600 });
  async function close() {
    if (closing) return; closing = true;
    options.onClose?.();
    for (const job of jobs.values()) if (['queued', 'dispatched'].includes(job.phase)) finish(job, new BridgeError('Gateway stopped; no request will be replayed', 503, 'api_error'));
    for (const ws of sockets.clients) ws.terminate(); sockets.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await persistence.catch(() => {});await conversations.flush().catch(()=>{});await direct.flush().catch(()=>{});
  }
  return { url, clientKey, pairCode, close, status,backend,desktopWorkerToken:desktop?workerToken:undefined };
}
