import { exchange, captureConversation, inspect, stop, type BrowserJob } from './adapter.js';
import type { ConversationReceipt } from '../protocol/conversation.js';
import type {SummaryAttempt} from '../protocol/summary.js';
interface Entry { id: string; phase: 'preparing' | 'submitted' | 'done' | 'failed'; text?: string; error?: string; submitted?:boolean; updated: number; conversation?:ConversationReceipt;summaryModel?:string;summaryAttempts?:SummaryAttempt[] }
// Reinjection must not register a second listener or submit a request twice.
const root = globalThis as typeof globalThis & { __m365BridgeInstalled?: boolean };
if (!root.__m365BridgeInstalled && /^https:\/\/[^/]+\.officeapps\.live\.com\//.test(location.href)) {
  root.__m365BridgeInstalled = true;
  let current: { id: string; controller: AbortController; submitted:boolean } | undefined;
  const key = (id: string) => 'job:' + id;
  const save = async (entry: Entry) => { await chrome.storage.local.set({ [key(entry.id)]: entry }); };
  async function run(job: BrowserJob) {
    const previous = (await chrome.storage.local.get(key(job.id)))[key(job.id)] as Entry | undefined;
    if (previous?.phase === 'done') { await chrome.runtime.sendMessage({ type: 'result', id: job.id, text: previous.text,conversation:previous.conversation,summaryModel:previous.summaryModel,summaryAttempts:previous.summaryAttempts }); return; }
    if (previous) { await chrome.runtime.sendMessage({ type: 'failure', id: job.id, error: 'Previously started request is uncertain; automatic resubmission prevented',submitted:previous.submitted }); return; }
    if (current) throw new Error('Another request is active in the paired frame');
    const controller = new AbortController(); current = { id: job.id, controller,submitted:false };let submitted=false;
    await save({ id: job.id, phase: 'preparing', submitted:false,updated: Date.now() });
    let summaryModel:string|undefined;const summaryAttempts:SummaryAttempt[]=[];
    try {
      const text = await exchange(document, job, controller.signal, async () => {submitted=true;if(current?.id===job.id)current.submitted=true;await save({ id: job.id, phase: 'submitted',submitted:true, updated: Date.now() });},model=>{summaryModel=model;},attempt=>{summaryAttempts.push(attempt);});
      const conversation=await captureConversation(document,job,controller.signal);
      await save({ id: job.id, phase: 'done', text, updated: Date.now(),conversation,summaryModel,summaryAttempts });
      await chrome.runtime.sendMessage({ type: 'result', id: job.id, text,conversation,summaryModel,summaryAttempts });
    } catch (err) {
      if(submitted)stop(document); const error = err instanceof Error ? err.message : 'Browser error';
      await save({ id: job.id, phase: 'failed', error,submitted, updated: Date.now(),summaryModel,summaryAttempts });
      await chrome.runtime.sendMessage({ type: 'failure', id: job.id, error,submitted,summaryModel,summaryAttempts });
    } finally { current = undefined; await chrome.runtime.sendMessage({ type: 'frame-ready', ...inspect(document) }).catch(() => {}); }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'inspect') { respond({...inspect(document),ready:!current&&inspect(document).ready,contextPackets:1,summaryRouting:1}); return false; }
    if (message.type === 'job') { void run(message).catch(error => chrome.runtime.sendMessage({ type: 'failure', id: message.id, error: String(error.message) })); respond({ accepted: true }); return false; }
    if (message.type === 'cancel') { if(current&&current.id===message.id){current.controller.abort();if(current.submitted)stop(document);}respond({cancelled:true,ready:!current&&inspect(document).ready});return false; }
    if (message.type === 'disconnect') { if (current) { current.controller.abort(); if(current.submitted)stop(document); } respond({ disconnected: true }); return false; }
    if (message.type === 'recover') {
      void (async () => {
        const entry = (await chrome.storage.local.get(key(message.id)))[key(message.id)] as Entry | undefined;
        if (entry?.phase === 'done') respond({ type: 'result', id: message.id, text: entry.text,conversation:entry.conversation,summaryModel:entry.summaryModel,summaryAttempts:entry.summaryAttempts });
        else if (current?.id === message.id) respond({ running: true });
        else respond({ type: 'failure', id: message.id, error: entry?.error ?? 'Request was interrupted; resubmission prevented',submitted:entry?.submitted,summaryModel:entry?.summaryModel,summaryAttempts:entry?.summaryAttempts });
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
    const state = {...inspect(document),ready:!current&&inspect(document).ready}, signature = JSON.stringify(state);
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
