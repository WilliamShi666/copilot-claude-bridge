import { OFFICE_ORIGINS, pairingCoordinator, type PairIntent } from './pairing.js';
import type { ConversationReceipt } from '../protocol/conversation.js';
import {AuxiliaryTabs,type AuxiliaryBinding} from './auxiliary-tabs.js';
interface Config { url: string; token: string; workerId: string; tabId: number;workbookUrl?:string; frameId?: number; ready?: boolean;conversationControl?:boolean;auxiliary?:AuxiliaryBinding }
let socket: WebSocket | undefined, config: Config | undefined;
let reconnecting = false;
let busyLane:{id:string;lane:'main'|'auxiliary'}|undefined;
const canceledJobs=new Set<string>();
const inFlightJobs=new Set<string>(),settledJobs=new Set<string>();
const pending = new Map<string, { type: string; id: string; text?: string; error?: string;conversation?:ConversationReceipt }>();
const officeFrames=new Map<number,{frameId:number;documentKey:string}>();
function validUrl(value: string) { const url = new URL(value); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Gateway must be http://127.0.0.1:<port>'); return url.origin; }
const safeFrame = (url = '') => {try{return new URL(url).hostname === 'fa000000124.officeapps.live.com';}catch{return false;}};
async function load() { config = (await chrome.storage.local.get('config')).config as Config | undefined; }
async function save() { await chrome.storage.local.set({ config }); }
async function uiStatus(error?: string) { await chrome.storage.local.set({ status: { connected: socket?.readyState === WebSocket.OPEN, ready: config?.ready === true&&!busyLane, tabId: config?.tabId, frameId: config?.frameId,sessionSyncVersion:1,auxiliaryTabId:config?.auxiliary?.tabId, error: error ?? null, updated: Date.now() } }); }
function send(value: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
const auxiliary=new AuxiliaryTabs({
 primary:async()=>{if(!config)throw new Error('No paired workbook');const tab=await chrome.tabs.get(config.tabId);const url=tab.url??config.workbookUrl;if(!url)throw new Error('Open the extension popup and use the selected Excel tab once to save its workbook address');if(tab.url){config.workbookUrl=tab.url;await save();}return{tabId:config.tabId,url};},
 binding:()=>config?.auxiliary,
 save:async value=>{if(config){config.auxiliary=value;await save();}},
 create:async url=>await chrome.tabs.create({url,active:false}),get:async id=>await chrome.tabs.get(id),
 activate:async id=>{await chrome.tabs.update(id,{active:true});},
 inject:async id=>{
   const host=officeFrames.get(id);
   if(host&&config?.auxiliary?.tabId===id){
     if(config.auxiliary.documentKey&&host.documentKey!==config.auxiliary.documentKey)throw new Error('Auxiliary document identity changed');
     await chrome.tabs.sendMessage(id,{type:'office-open-copilot'},{frameId:host.frameId});
   }
   const frameId=config?.auxiliary?.tabId===id?config.auxiliary.frameId:undefined;
   if(frameId!==undefined)await chrome.scripting.executeScript({target:{tabId:id,frameIds:[frameId]},files:['content.js']});
 },remove:async id=>await chrome.tabs.remove(id),
 identity:async id=>{
   const observed=officeFrames.get(id);if(observed)return observed.documentKey;
   if(id!==config?.tabId)return undefined;
   // Existing Office host permissions suffice. Return only a document hash,
   // never the WOPI URL's query credentials or a broader user-tab inventory.
   const results=await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},func:async()=>{
     if(location.hostname!=='excel.officeapps.live.com')return undefined;
     const source=new URL(location.href).searchParams.get('wopisrc');if(!source)return undefined;const document=new URL(source);
     const bytes=new TextEncoder().encode(document.origin+document.pathname);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
   }});
   return results.map(r=>r.result).find((value):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value));
 },
});
function announceReady(){send({type:'ready',ready:config?.ready===true&&!busyLane,conversationControl:config?.conversationControl===true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,auxiliaryBootstrap:1,contextPackets:1,summaryRouting:1});}
async function requirePacketFrame(tabId:number,frameId:number|undefined,lane:string){
 let state:any;try{state=await chrome.tabs.sendMessage(tabId,{type:'inspect'},{frameId});}catch{}
 if(state?.contextPackets!==1)throw Object.assign(new Error('Refresh the '+lane+' workbook to enable segmented context transfer'),{submitted:false});
}
async function frameMessage(value: any) {
  const lane=value.lane??'main';
  if(lane==='auxiliary'){
    if(value.type==='cancel'){const frame=config?.auxiliary;if(frame?.frameId===undefined)return{cancelled:true};return await chrome.tabs.sendMessage(frame.tabId,value,{frameId:frame.frameId});}
    const frame=await auxiliary.ensure();
    if(value.contextPackets)await requirePacketFrame(frame.tabId,frame.frameId,'auxiliary');
    if(value.summary){const state=await chrome.tabs.sendMessage(frame.tabId,{type:'inspect'},{frameId:frame.frameId});if(state?.summaryRouting!==1)throw Object.assign(new Error('Refresh the auxiliary workbook to enable summary model routing'),{submitted:false});}
    if(value.type==='job'&&canceledJobs.has(value.id))throw new Error('Auxiliary request canceled before submission');
    return await chrome.tabs.sendMessage(frame.tabId,value,{frameId:frame.frameId});
  }
  if (!config || config.frameId === undefined) throw new Error('Copilot frame not paired; reload selected workbook with Copilot open');
  // Activate only the paired workbook tab, never the browser window. UI preparation
  // must not depend on background-tab rendering after a long idle period.
  if(value.type==='job')await chrome.tabs.update(config.tabId,{active:true});
  if(value.contextPackets)await requirePacketFrame(config.tabId,config.frameId,'paired');
  return await chrome.tabs.sendMessage(config.tabId, value, { frameId: config.frameId });
}
async function retireCancelledLane(id:string,lane:'main'|'auxiliary',answer?:any){
  if(busyLane?.id!==id)return;
  if(lane==='main'&&config){
    const ready=typeof answer?.ready==='boolean'?answer.ready:await frameMessage({type:'inspect'}).then(state=>state?.ready===true).catch(()=>false);
    config.ready=ready;await save();
  }else if(lane==='auxiliary'&&config?.auxiliary&&typeof answer?.ready==='boolean'){config.auxiliary.ready=answer.ready;await save();}
  if(busyLane?.id!==id)return;
  settledJobs.delete(id);busyLane=undefined;announceReady();await uiStatus();
}
async function restoreAdapter() {
  if (!config || !(await chrome.permissions.contains({ origins: OFFICE_ORIGINS }))) return;
  const old = await chrome.scripting.getRegisteredContentScripts();
  if (!old.some(x => x.id === 'copilot-frame')) await chrome.scripting.registerContentScripts([{ id: 'copilot-frame', matches: ['https://fa000000124.officeapps.live.com/*'], js: ['content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true }]);
  if (!old.some(x => x.id === 'bridge-office-host')) await chrome.scripting.registerContentScripts([{id:'bridge-office-host',matches:['https://excel.officeapps.live.com/*'],js:['office-host.js'],allFrames:true,runAt:'document_idle',persistAcrossSessions:true}]);
  const tab = await chrome.tabs.get(config.tabId).catch(() => undefined);
  if(tab?.url?.startsWith('https://excel.cloud.microsoft/open/')){config.workbookUrl=tab.url;await save();}
  if (!tab?.url?.startsWith('https://excel.cloud.microsoft/')) return;
  await chrome.scripting.executeScript({ target: { tabId: config.tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
}
async function commitPair(intent: PairIntent) {
  const response = await fetch(intent.url + '/bridge/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: intent.code }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) { const detail = await response.json().catch(() => null); throw new Error(detail?.error?.message ?? 'Pair code rejected; restart gateway for a fresh code'); }
  const { token } = await response.json();
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid gateway pairing response');
  socket?.close(); socket = undefined;
  const selected=await chrome.tabs.get(intent.tabId);
  config = { url: intent.url, token, workerId: crypto.randomUUID(), tabId: intent.tabId,workbookUrl:selected.url, ready: false }; await save();
  const old = await chrome.scripting.getRegisteredContentScripts();
  if (!old.some(x => x.id === 'copilot-frame')) await chrome.scripting.registerContentScripts([{ id: 'copilot-frame', matches: ['https://fa000000124.officeapps.live.com/*'], js: ['content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true }]);
  try { await chrome.scripting.executeScript({ target: { tabId: config.tabId, allFrames: true }, files: ['content.js'] }); }
  catch { await uiStatus('Paired. Reload selected workbook and reopen Copilot to activate its frame.'); }
  await connect();
}
const pairing = pairingCoordinator({
  read: async () => (await chrome.storage.local.get('pairIntent')).pairIntent as PairIntent | undefined,
  write: async value => { await chrome.storage.local.set({ pairIntent: value }); },
  clear: async () => { await chrome.storage.local.remove('pairIntent'); },
  hasPermissions: async () => await chrome.permissions.contains({ origins: OFFICE_ORIGINS }),
  checkTab: async tabId => { const tab = await chrome.tabs.get(tabId); if (!tab.url?.startsWith('https://excel.cloud.microsoft/')) throw new Error('Selected Excel workbook tab is no longer available'); },
  commit: commitPair,
  status: async (phase, error) => { await chrome.storage.local.set({ pairingStatus: { phase, error: error ?? null, updated: Date.now() } }); },
  now: Date.now,
});
async function connect() {
  if (reconnecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  reconnecting = true;
  try {
    await load(); if (!config) return;
    await restoreAdapter();
    const url = validUrl(config.url).replace('http:', 'ws:') + '/bridge/socket'; const ws = new WebSocket(url); socket = ws;
    ws.onopen = async () => {
      try { const checked = await frameMessage({ type: 'inspect' }); config!.ready = checked.ready === true;config!.conversationControl=checked.conversationControl===true&&checked.conversationResumability==='active-chat-only'; } catch { config!.ready = false;config!.conversationControl=false; }
      send({ type: 'hello', token: config!.token, workerId: config!.workerId, ready: config!.ready,conversationControl:config!.conversationControl,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,auxiliaryBootstrap:1,contextPackets:1,summaryRouting:1 }); await uiStatus();
    };
    ws.onmessage = event => { void (async () => {
      const value = JSON.parse(event.data);
      if (value.type === 'connected') {
        if(value.activeId===null&&busyLane){const orphan=busyLane;canceledJobs.add(orphan.id);const answer=await frameMessage({type:'cancel',id:orphan.id,lane:orphan.lane}).catch(()=>undefined);await retireCancelledLane(orphan.id,orphan.lane,answer);}
        for (const reply of pending.values()) send(reply); return;
      }
      if (value.type === 'ack') { pending.delete(value.id);if(!inFlightJobs.has(value.id))canceledJobs.delete(value.id);if(busyLane?.id!==value.id)settledJobs.delete(value.id);await chrome.storage.local.remove('job:' + value.id); return; }
      if (value.type === 'job' || value.type === 'cancel' || value.type === 'recover') {
        if(value.type==='recover'&&inFlightJobs.has(value.id))return;
        if(value.type==='job')inFlightJobs.add(value.id);
        if(value.type==='job'||value.type==='recover')busyLane={id:value.id,lane:value.lane??'main'};
        if(value.type==='cancel'){canceledJobs.add(value.id);value.lane=busyLane&&busyLane.id===value.id?busyLane.lane:value.lane??'main';}
        try {
          const answer = await frameMessage(value);
          if (answer?.type === 'result' || answer?.type === 'failure') { send(answer);if(busyLane?.id===value.id)busyLane=undefined;announceReady(); }
          if(value.type==='cancel')await retireCancelledLane(value.id,value.lane??'main',answer);
        } catch (error) { send({ type: 'failure', id: value.id, error: error instanceof Error ? error.message : 'Paired tab unavailable',...((error as any)?.submitted===false?{submitted:false}:{}) });if(busyLane?.id===value.id)busyLane=undefined;announceReady(); }
        finally{if(value.type==='job'){inFlightJobs.delete(value.id);canceledJobs.delete(value.id);}}
      }
    })().catch(err => uiStatus(String(err.message))); };
    ws.onclose = () => { if (socket === ws) socket = undefined; void uiStatus('Gateway disconnected; reconnecting without resubmitting uncertain jobs'); };
    ws.onerror = () => { void uiStatus('Cannot connect to localhost gateway'); };
  } catch (error) { await uiStatus(error instanceof Error ? error.message : 'Connection failed'); }
  finally { reconnecting = false; }
}
chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { void pairing.resume(); void connect(); });
chrome.permissions.onAdded.addListener(() => { void pairing.resume(); });
// WebSocket traffic resets the MV3 idle timer in supported Chrome versions.
setInterval(() => { send({ type: 'ping' }); void connect(); }, 20000);
chrome.runtime.onStartup.addListener(() => { void pairing.resume(); void connect(); });
chrome.tabs.onRemoved.addListener(tabId => { officeFrames.delete(tabId);if(config?.auxiliary?.tabId===tabId){config.auxiliary=undefined;if(busyLane?.lane==='auxiliary'){send({type:'failure',id:busyLane.id,error:'Bridge-owned auxiliary tab closed'});settledJobs.delete(busyLane.id);busyLane=undefined;announceReady();}void save();}if (config?.tabId === tabId) { config.ready = false; send({ type: 'ready', ready: false }); void save(); void uiStatus('Paired tab closed'); } });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void (async () => {
    if (sender.tab) {
      if(message.type==='office-host-ready'){
        let office=false;try{office=new URL(sender.url??'').hostname==='excel.officeapps.live.com';}catch{}
        if(config&&office&&Number.isInteger(sender.frameId)&&typeof message.documentKey==='string'&&/^[a-f0-9]{64}$/.test(message.documentKey)&&(sender.tab.id===config.tabId||sender.tab.id===config.auxiliary?.tabId))officeFrames.set(sender.tab.id!,{frameId:sender.frameId!,documentKey:message.documentKey});
        respond({accepted:true});return;
      }
      if (!config || !safeFrame(sender.url)) return;
      const lane=sender.tab.id===config.tabId?'main':sender.tab.id===config.auxiliary?.tabId?'auxiliary':undefined;if(!lane)return;
      if (message.type === 'frame-ready') {
        if(lane==='main'){config.frameId = sender.frameId; config.ready = message.ready === true;if(sender.tab.url?.startsWith('https://excel.cloud.microsoft/open/'))config.workbookUrl=sender.tab.url;config.conversationControl=message.conversationControl===true&&message.conversationResumability==='active-chat-only';await save();}
        else await auxiliary.observe(sender.tab.id!,sender.frameId,sender.url,message.ready===true);
        if(busyLane?.lane===lane&&message.ready===true&&settledJobs.has(busyLane.id)){settledJobs.delete(busyLane.id);busyLane=undefined;}
        announceReady();await connect();await uiStatus();
      }
      const frameId=lane==='main'?config.frameId:config.auxiliary?.frameId;
      if (['result', 'failure'].includes(message.type) && sender.frameId === frameId) { pending.set(message.id, message);settledJobs.add(message.id); await connect(); send(message); }
      respond({ accepted: true }); return;
    }
    if (sender.id !== chrome.runtime.id) throw new Error('Only extension UI can pair');
    if (message.type === 'rebind-tab') {
      await load();
      if (!config) throw new Error('Pair the local gateway first');
      if (!Number.isInteger(message.tabId)) throw new Error('Invalid selected tab');
      if (!(await chrome.permissions.contains({ origins: OFFICE_ORIGINS }))) throw new Error('Office frame permission is missing; pair again to grant access');
      const tab = await chrome.tabs.get(message.tabId);
      if (!tab.url?.startsWith('https://excel.cloud.microsoft/')) throw new Error('Select an Excel workbook tab first');
      await frameMessage({ type: 'disconnect' }).catch(() => {});
      await auxiliary.close(true); // A retired auxiliary tab may contain a human draft.
      config.tabId = message.tabId;config.workbookUrl=tab.url; config.frameId = undefined; config.ready = false; await save();
      send({ type: 'ready', ready: false });
      try { await chrome.scripting.executeScript({ target: { tabId: config.tabId, allFrames: true }, files: ['content.js'] }); }
      catch { await uiStatus('Refresh the selected workbook and reopen Copilot to activate its frame.'); }
      await connect(); respond({ ok: true }); return;
    }
    if (message.type === 'prepare-pair') { respond(await pairing.prepare(message)); return; }
    if (message.type === 'permission-decision') {
      if (!message.granted) { await chrome.storage.local.remove('pairIntent'); await chrome.storage.local.set({ pairingStatus: { phase: 'failed', error: 'Office frame access was not granted' } }); }
      else await pairing.resume();
      respond({ ok: true }); return;
    }
    if (message.type === 'unpair') {
      await frameMessage({ type: 'disconnect' }).catch(() => {});
      await auxiliary.close();
      socket?.close(); socket = undefined; config = undefined; pending.clear();
      await chrome.scripting.unregisterContentScripts({ ids: ['copilot-frame','bridge-office-host'] });
      await chrome.storage.local.clear(); respond({ ok: true }); return;
    }
    respond({ error: 'Unknown extension request' });
  })().catch(error => respond({ error: error instanceof Error ? error.message : 'Extension failure' }));
  return true;
});
void pairing.resume(); void connect();
