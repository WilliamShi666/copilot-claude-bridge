import { exchange, captureConversation, verifyImageDelivery,focusImageSubmission,imageSendTarget,imageSubmissionDiagnostics,confirmImageSubmission,input, inspect, stop,observeTurn,stopOwnedTurn,cancellationProof, type BrowserJob,type TurnObservation } from './adapter.js';
import {trustedEnterObservation,ImageInputFailure} from './image-input.js';
import {TransportFailure,refusalKind,type RefusalKind,type CancelReceipt,type FailureCode} from '../protocol/cancellation.js';
import type { ConversationReceipt } from '../protocol/conversation.js';
import {SUMMARY_MODELS,type SummaryAttempt} from '../protocol/summary.js';
interface Entry { id: string; phase: 'preparing' | 'submitted' | 'done' | 'failed'; text?: string; error?: string;code?:FailureCode; submitted?:boolean; updated: number; conversation?:ConversationReceipt;imageIds?:string[];summaryModel?:string;summaryAttempts?:SummaryAttempt[] }
// Reinjection must not register a second listener or submit a request twice.
const capabilities={contextPackets:1,summaryRouting:1,cancelContinuation:1,imageInput:1,trustedImageInput:10} as const;
const root = globalThis as typeof globalThis & { __m365BridgeInstalled?: boolean };
if (!root.__m365BridgeInstalled && /^https:\/\/[^/]+\.officeapps\.live\.com\//.test(location.href)) {
  root.__m365BridgeInstalled = true;
  interface Running {id:string;job:BrowserJob;controller:AbortController;submitted:boolean;turn?:TurnObservation;imageNonce?:string;imageModel?:string;imageAttempt?:number;imageEditor?:HTMLElement;imageTarget?:HTMLElement;imageObservation?:ReturnType<typeof trustedEnterObservation>;cancelled?:boolean;failureCode?:FailureCode;failureKind?:RefusalKind}
  let current:Running|undefined;const recent=new Map<string,Running>(),cancelledBeforeStart=new Set<string>();
  const key = (id: string) => 'job:' + id;
  const save = async (entry: Entry) => { await chrome.storage.local.set({ [key(entry.id)]: entry }); };
  async function run(job: BrowserJob) {
    const previous = (await chrome.storage.local.get(key(job.id)))[key(job.id)] as Entry | undefined;
    if(cancelledBeforeStart.has(job.id))throw Object.assign(new Error('Cancelled before content dispatch'),{submitted:false});
    if (previous?.phase === 'done') { await chrome.runtime.sendMessage({ type: 'result', id: job.id, text: previous.text,conversation:previous.conversation,imageIds:previous.imageIds,summaryModel:previous.summaryModel,summaryAttempts:previous.summaryAttempts }); return; }
    if (previous) { await chrome.runtime.sendMessage({ type: 'failure', id: job.id, error: 'Previously started request is uncertain; automatic resubmission prevented',submitted:previous.submitted }); return; }
    if (current) throw Object.assign(new Error('Another request is active in the paired frame'),{submitted:false});
    const controller = new AbortController();const running:Running={id:job.id,job,controller,submitted:false,...(job.cancelContinuation===1||job.images?.length?{turn:observeTurn(document)}:{})};current=running;recent.set(job.id,running);for(const id of [...recent.keys()].slice(0,-4))recent.delete(id);let submitted=false;
    await save({ id: job.id, phase: 'preparing', submitted:false,updated: Date.now() });
    let summaryModel:string|undefined;const summaryAttempts:SummaryAttempt[]=[];
    try {
      const text = await exchange(document, job, controller.signal, async () => {submitted=true;if(current?.id===job.id)current.submitted=true;await save({ id: job.id, phase: 'submitted',submitted:true, updated: Date.now() });},model=>{summaryModel=model;},attempt=>{summaryAttempts.push(attempt);},running.turn,async modelLabel=>{
        controller.signal.throwIfAborted();running.imageNonce=crypto.randomUUID();running.imageModel=modelLabel;running.imageAttempt=job.summary?SUMMARY_MODELS.findIndex(model=>model===modelLabel)+1:1;
        const editor=input(document),target=imageSendTarget(document);if(!editor||!target)throw new Error('Image editor or native Send button disappeared before trusted input');running.imageEditor=editor;running.imageTarget=target;running.imageObservation?.dispose();const observed=trustedEnterObservation(target,controller.signal);running.imageObservation=observed;
        try{const response=await chrome.runtime.sendMessage({type:'image-submit',id:job.id,nonce:running.imageNonce,modelLabel,attempt:running.imageAttempt,pageInstance:running.turn?.pageInstance});
          if(response?.submitted!==true)throw new ImageInputFailure(response?.error??'Trusted image input was not confirmed',response?.inputAttempted!==false);
          observed.arm();if(!await observed.promise)throw new Error('Trusted Enter did not reach the verified Copilot Send button; input was not repeated');
        }finally{observed.dispose();delete running.imageEditor;delete running.imageTarget;}
      });
      const conversation=await captureConversation(document,job,controller.signal);const imageIds=verifyImageDelivery(document,job);
      await save({ id: job.id, phase: 'done', text, updated: Date.now(),conversation,imageIds,summaryModel,summaryAttempts });
      // No further page operations remain. Release the execution lock before
      // publishing: the native tool result can arrive before runtime ACK does.
      if(running.turn)running.turn.finished=true;if(current?.id===job.id)current=undefined;
      if(!running.cancelled)await chrome.runtime.sendMessage({ type: 'result', id: job.id, text,conversation,imageIds,summaryModel,summaryAttempts });
    } catch (err) {
      if(running.imageObservation)controller.abort();
      if(err instanceof ImageInputFailure&&!err.inputAttempted&&running.turn){
        // The driver proves it never invoked keyDown. The write-ahead journal
        // remains conservative on a crash, but this completed failure is not
        // proof of delivery. Prior long-context packets still count as sent.
        running.turn.sendClicked=false;running.turn.sentPackets=Math.max(0,running.turn.sentPackets-1);running.turn.inputComplete=false;
        submitted=running.turn.sentPackets>0;running.submitted=submitted;
      }
      if(submitted){if(running.turn)stopOwnedTurn(document,running.turn);else stop(document);}const baseError=err instanceof Error ? err.message : 'Browser error',trace=running.imageObservation?.trace()??[],error=baseError+(trace.length?' [image Enter events: '+JSON.stringify(trace)+']':''),code=err instanceof TransportFailure?err.code:undefined;running.failureCode=code;if(code==='provider_refusal')running.failureKind=refusalKind(baseError);
      await save({ id: job.id, phase: 'failed', error,code,submitted, updated: Date.now(),summaryModel,summaryAttempts });
      if(!running.cancelled||code==='provider_refusal')await chrome.runtime.sendMessage({ type: 'failure', id: job.id, error,code,submitted,summaryModel,summaryAttempts });
    } finally {running.imageObservation?.dispose();for(const image of running.job.images??[])image.data='';if(running.turn)running.turn.finished=true;if(current?.id===job.id)current=undefined;await chrome.runtime.sendMessage({ type: 'frame-ready', ...inspect(document),ready:!current&&inspect(document).ready,...capabilities }).catch(() => {}); }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if(message.type==='image-submit-proof'){
      const running=current;const owned=()=>!!running&&current===running&&!running.controller.signal.aborted&&running.id===message.id&&running.imageNonce===message.nonce&&running.turn?.pageInstance===message.pageInstance;
      if(message.afterInput===true){
        if(!running||!owned()){respond({ready:false});return false;}
        void confirmImageSubmission(document,running.job,running.turn,running.controller.signal).then(()=>respond({ready:owned(),submitted:owned()})).catch(error=>respond({ready:false,error:error instanceof Error?error.message:'Image submission was not acknowledged'}));return true;
      }
      const ready=owned()&&!!running?.imageEditor&&!!running.imageTarget&&focusImageSubmission(document,{...running.job,modelLabel:running.imageModel??running.job.modelLabel},running.turn,message.requirePageFocus===true,running.imageEditor,running.imageTarget);respond({ready,submitted:false,...(!ready?{error:owned()?'Image input state changed: '+JSON.stringify(imageSubmissionDiagnostics(document,{...running!.job,modelLabel:running!.imageModel??running!.job.modelLabel},running!.turn,running!.imageEditor,running!.imageTarget)):'Image input ownership changed'}:{})});return false;
    }
    if (message.type === 'inspect') { respond({...inspect(document),ready:!current&&inspect(document).ready,...capabilities}); return false; }
    if (message.type === 'job') { void run(message).catch(error => chrome.runtime.sendMessage({ type: 'failure', id: message.id, error: String(error.message),...(error.submitted===false?{submitted:false}:{}) })); respond({ accepted: true }); return false; }
    if (message.type === 'cancel') {
      const running=recent.get(message.id);
      if(message.cancelContinuation===1){cancelledBeforeStart.add(message.id);for(const id of [...cancelledBeforeStart].slice(0,-100))cancelledBeforeStart.delete(id);if(running)running.cancelled=true;}
      if(current&&current.id===message.id){current.controller.abort();if(current.turn)stopOwnedTurn(document,current.turn);else if(current.submitted)stop(document);}
      respond({cancelled:true,ready:!current&&inspect(document).ready});return false;
    }
    if(message.type==='cancel-proof'){
      void(async()=>{
        const cacheKey='cancel-proof:'+message.id,cached=(await chrome.storage.local.get(cacheKey))[cacheKey] as CancelReceipt|undefined;
        if(cached?.nonce===message.nonce){respond({receipt:cached});return;}
        const running=recent.get(message.id);let receipt:CancelReceipt|undefined;
        const existing=(await chrome.storage.local.get(key(message.id)))[key(message.id)] as Entry|undefined;
        if(!running&&!existing&&cancelledBeforeStart.has(message.id)){receipt={version:1,jobId:message.id,nonce:message.nonce,conversationId:message.conversationId,lane:message.lane,outcome:'not_sent',inputComplete:false,replyState:'none'};}
        else if(running?.failureCode==='provider_refusal'||existing?.code==='provider_refusal')receipt={version:1,jobId:message.id,nonce:message.nonce,conversationId:message.conversationId,lane:message.lane,outcome:'unverified',inputComplete:false,replyState:'none',reason:'provider_refusal',refusalKind:running?.failureKind??refusalKind(existing?.error)};
        else receipt=await cancellationProof(document,running?.job??{id:message.id,modelLabel:'',prompt:'',lane:message.lane,conversation:{id:message.conversationId,mode:'continue',title:''}},running?.turn,message.nonce);
        if(receipt)await chrome.storage.local.set({[cacheKey]:receipt});respond(receipt?{receipt}:{pending:true});
      })().catch(()=>respond({pending:true}));return true;
    }
    if (message.type === 'disconnect') { if (current) { current.controller.abort(); if(current.turn)stopOwnedTurn(document,current.turn);else if(current.submitted)stop(document); } respond({ disconnected: true }); return false; }
    if (message.type === 'recover') {
      void (async () => {
        const entry = (await chrome.storage.local.get(key(message.id)))[key(message.id)] as Entry | undefined;
        if (entry?.phase === 'done') respond({ type: 'result', id: message.id, text: entry.text,conversation:entry.conversation,imageIds:entry.imageIds,summaryModel:entry.summaryModel,summaryAttempts:entry.summaryAttempts });
        else if (current?.id === message.id) respond({ running: true });
        else respond({ type: 'failure', id: message.id, error: entry?.error ?? 'Request was interrupted; resubmission prevented',code:entry?.code,submitted:entry?.submitted,summaryModel:entry?.summaryModel,summaryAttempts:entry?.summaryAttempts });
      })(); return true;
    }
    return false;
  });
  let lastReported = '';
  let reportingAlive = true;
  const stopReporting = () => { reportingAlive = false; clearInterval(readinessTimer); };
  function reportReadiness() {
    if (!reportingAlive) return;
    try {
    const state = {...inspect(document),ready:!current&&inspect(document).ready,...capabilities}, signature = JSON.stringify(state);
    // Retry the frame announcement regularly: UI can mount after document_idle,
    // or the same live frame can be explicitly rebound to an existing pairing.
    if (signature !== lastReported || !current) {
      lastReported = signature;
      void chrome.runtime.sendMessage({ type: 'frame-ready', ...state }).catch(error => { if (String(error?.message ?? error).includes('context invalidated')) stopReporting(); });
    }
    } catch { stopReporting(); }
  }
  const readinessTimer = setInterval(reportReadiness, 2000);
  addEventListener('pagehide', () => clearInterval(readinessTimer), { once: true });
  reportReadiness();
}
