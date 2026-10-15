import { OFFICE_ORIGINS, pairingCoordinator, type PairIntent } from './pairing.js';
import {validBrowserLane,type BrowserLane,type ConversationReceipt} from '../protocol/conversation.js';
import {AuxiliaryTabs,type AuxiliaryBinding} from './auxiliary-tabs.js';
import type {CancelReceipt} from '../protocol/cancellation.js';
import {TransportFailure} from '../protocol/cancellation.js';
import {ImageInput} from './image-input.js';
import {SUMMARY_MODELS} from '../protocol/summary.js';
interface Config { url: string; token: string; workerId: string; tabId: number;workbookUrl?:string;documentKey?:string; frameId?: number; ready?: boolean;conversationControl?:boolean;cancelContinuation?:boolean;imageInput?:boolean;auxiliary?:AuxiliaryBinding;recovery?:AuxiliaryBinding;agents?:Record<string,AuxiliaryBinding> }
type InternalLane=BrowserLane|'recovery';
type SavedPairing = Pick<Config,'url'|'token'|'workerId'>;
let savedPairings:Record<string,SavedPairing>={};
let socket: WebSocket | undefined, config: Config | undefined;
let reconnecting = false;
let switching=false;
let imagePermission=false,imageEnabled=false;
let busyLane:{id:string;lane:BrowserLane}|undefined;
const canceledJobs=new Set<string>();
const inFlightJobs=new Set<string>(),settledJobs=new Set<string>();
const pending = new Map<string, { type: string; id: string; text?: string; error?: string;conversation?:ConversationReceipt }>();
const jobBindings=new Map<string,{tabId:number;frameId:number|undefined;delivered:boolean;imageInput?:boolean;summary?:boolean;modelLabel?:string;imageAttempt?:number;imageNonce?:string}>();
const cancelOperations=new Map<string,Promise<void>>();
const officeFrames=new Map<number,{frameId:number;documentKey:string}>();
function validUrl(value: string) { const url = new URL(value); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Gateway must be http://127.0.0.1:<port>'); return url.origin; }
const safeFrame = (url = '') => {try{return new URL(url).hostname === 'fa000000124.officeapps.live.com';}catch{return false;}};
async function load() { const data=await chrome.storage.local.get(['config','savedPairings','imageInputEnabled']);imageEnabled=data.imageInputEnabled===true;config=data.config as Config|undefined;savedPairings=(data.savedPairings??{}) as Record<string,SavedPairing>;imagePermission=await chrome.permissions.contains({permissions:['debugger']}); }
async function save() {
  if(config)savedPairings[config.url]={url:config.url,token:config.token,workerId:config.workerId};
  await chrome.storage.local.set({config,savedPairings});
}
function assertSwitchIdle(){if(switching||busyLane||inFlightJobs.size||pending.size||imageInput.busy)throw new Error('Finish or cancel the current request before switching gateway/workbook');}
async function changeConnection(action:()=>Promise<void>){
  assertSwitchIdle();switching=true;send({type:'ready',ready:false});
  try{await action();}finally{switching=false;await connect();announceReady();await uiStatus();}
}
async function uiStatus(error?: string) { await chrome.storage.local.set({ status: { connected: socket?.readyState === WebSocket.OPEN, ready: config?.ready === true&&!busyLane,busy:!!busyLane||imageInput.busy, tabId: config?.tabId, frameId: config?.frameId,sessionSyncVersion:1,auxiliaryTabId:config?.auxiliary?.tabId, error: error ?? null, updated: Date.now() } }); }
const imageInput=new ImageInput({
 attach:async tabId=>{await chrome.debugger.attach({tabId},'1.3');},
 focus:async(tabId,enabled)=>{await chrome.debugger.sendCommand({tabId},'Emulation.setFocusEmulationEnabled',{enabled});},
 enter:async(tabId,type)=>{
  const key={key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:0,location:0,isKeypad:false};
  await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{...key,type,...(type==='keyDown'?{text:'\r',unmodifiedText:'\r',autoRepeat:false,commands:[]}:{})});
 },
 detach:async tabId=>{await chrome.debugger.detach({tabId});},
});
async function refreshImagePermission(){imagePermission=await chrome.permissions.contains({permissions:['debugger']});announceReady();await uiStatus();}
function send(value: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function ownedBinding(lane:InternalLane){return lane==='auxiliary'?config?.auxiliary:lane==='recovery'?config?.recovery:config?.agents?.[lane];}
function laneForTab(tabId:number|undefined):InternalLane|undefined{if(!config)return;if(tabId===config.tabId)return 'main';if(tabId===config.auxiliary?.tabId)return 'auxiliary';if(tabId===config.recovery?.tabId)return 'recovery';return Object.keys(config.agents??{}).find(lane=>config!.agents![lane].tabId===tabId) as BrowserLane|undefined;}
function makeOwnedTabs(lane:InternalLane){return new AuxiliaryTabs({
 primary:async()=>{if(!config)throw new Error('No paired workbook');if(lane.startsWith('agent:')&&!ownedBinding(lane)&&Object.keys(config.agents??{}).length>=16)throw new Error('Agent tab limit reached; close finished bridge-owned agent tabs first');const tab=await chrome.tabs.get(config.tabId).catch(()=>undefined);const url=tab?.url??config.workbookUrl;if(!url)throw new Error('Open the extension popup and use the selected Excel tab once to save its workbook address');if(tab?.url){config.workbookUrl=tab.url;await save();}return{tabId:config.tabId,url};},
 binding:()=>ownedBinding(lane),
 save:async value=>{if(config){if(lane==='auxiliary')config.auxiliary=value;else if(lane==='recovery')config.recovery=value;else{config.agents??={};if(value)config.agents[lane]=value;else delete config.agents[lane];}await save();}},
 create:async url=>await chrome.tabs.create({url,active:false}),get:async id=>await chrome.tabs.get(id),
 activate:async id=>{await chrome.tabs.update(id,{active:true});},
 inject:async id=>{
   const host=officeFrames.get(id),binding=ownedBinding(lane),frameId=binding?.tabId===id?binding.frameId:undefined;
   // A ready add-in already owns this pane. Reopening the host can toggle it closed.
   if(frameId!==undefined){const state=await chrome.tabs.sendMessage(id,{type:'inspect'},{frameId}).catch(()=>undefined);if(state?.ready===true)return;}
   if(host&&binding?.tabId===id){
     if(binding.documentKey&&host.documentKey!==binding.documentKey)throw new Error('Auxiliary document identity changed');
     await chrome.tabs.sendMessage(id,{type:'office-open-copilot'},{frameId:host.frameId});
   }
   if(frameId!==undefined)await chrome.scripting.executeScript({target:{tabId:id,frameIds:[frameId]},files:['content.js']});
 },remove:async id=>await chrome.tabs.remove(id),
 identity:async id=>{
   const observed=officeFrames.get(id);if(observed)return observed.documentKey;
   if(id!==config?.tabId)return undefined;
   if(config.documentKey)return config.documentKey;
   // Existing Office host permissions suffice. Return only a document hash,
   // never the WOPI URL's query credentials or a broader user-tab inventory.
   const results=await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},func:async()=>{
     if(location.hostname!=='excel.officeapps.live.com')return undefined;
     const source=new URL(location.href).searchParams.get('wopisrc');if(!source)return undefined;const document=new URL(source);
     const bytes=new TextEncoder().encode(document.origin+document.pathname);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
   }});
   const key=results.map(r=>r.result).find((value):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value));if(key&&config){config.documentKey=key;await save();}return key;
 },
});}
const auxiliary=makeOwnedTabs('auxiliary'),recovery=makeOwnedTabs('recovery'),agentManagers=new Map<BrowserLane,AuxiliaryTabs>();
function ownedManager(lane:InternalLane){if(lane==='auxiliary')return auxiliary;if(lane==='recovery')return recovery;if(!validBrowserLane(lane)||lane==='main')throw new Error('Invalid owned agent lane');let manager=agentManagers.get(lane);if(!manager){manager=makeOwnedTabs(lane);agentManagers.set(lane,manager);}return manager;}
async function retireAgentTabs(){for(const lane of Object.keys(config?.agents??{}) as BrowserLane[]){const frame=ownedBinding(lane);if(frame?.frameId!==undefined)await chrome.tabs.sendMessage(frame.tabId,{type:'disconnect'},{frameId:frame.frameId}).catch(()=>{});await ownedManager(lane).close(true);}agentManagers.clear();}
function announceReady(){send({type:'ready',ready:config?.ready===true&&!busyLane&&!switching,conversationControl:config?.conversationControl===true,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,auxiliaryBootstrap:1,contextPackets:1,summaryRouting:1,agentContexts:1,cancelContinuation:config?.cancelContinuation?1:0,imageInput:config?.imageInput&&imagePermission&&imageEnabled?1:0});}
async function requirePacketFrame(tabId:number,frameId:number|undefined,lane:string){
 let state:any;try{state=await chrome.tabs.sendMessage(tabId,{type:'inspect'},{frameId});}catch{}
 if(state?.contextPackets!==1)throw Object.assign(new Error('Refresh the '+lane+' workbook to enable segmented context transfer'),{submitted:false});
}
async function frameMessage(value: any) {
  const lane=value.lane??'main';if(!validBrowserLane(lane))throw new Error('Invalid browser lane');
  if(value.type==='job'&&value.isolatedRecovery){
    if(lane==='main'){
      await recovery.close(true);const frame=await recovery.ensure();if(canceledJobs.has(value.id))throw Object.assign(new Error('Recovery cancelled before submission'),{submitted:false});
      if(!config)throw new Error('Pairing lost during recovery');config.tabId=frame.tabId;config.frameId=frame.frameId;config.ready=frame.ready;config.documentKey=frame.documentKey;config.recovery=undefined;await save();
    }else await ownedManager(lane).close(true);
  }
  if(lane!=='main'){
    if(value.type==='cancel'){const frame=ownedBinding(lane);if(frame?.frameId===undefined)return{cancelled:true};return await chrome.tabs.sendMessage(frame.tabId,value,{frameId:frame.frameId});}
    let frame:AuxiliaryBinding;try{frame=await ownedManager(lane).ensure();}catch(error){if(value.type==='job')throw Object.assign(error instanceof Error?error:new Error('Owned agent tab unavailable'),{submitted:false});throw error;}
    if(value.contextPackets)await requirePacketFrame(frame.tabId,frame.frameId,'auxiliary');
    if(value.summary){const state=await chrome.tabs.sendMessage(frame.tabId,{type:'inspect'},{frameId:frame.frameId});if(state?.summaryRouting!==1)throw Object.assign(new Error('Refresh the auxiliary workbook to enable summary model routing'),{submitted:false});}
    if(value.type==='job'&&canceledJobs.has(value.id))throw Object.assign(new Error('Auxiliary request canceled before submission'),{submitted:false});
    return await sendFrame(value,frame.tabId,frame.frameId);
  }
  if (!config || config.frameId === undefined) throw Object.assign(new TransportFailure('Copilot frame not paired; reload selected workbook with Copilot open','conversation_unavailable'),{submitted:false});
  // Activate only the paired workbook tab, never the browser window. UI preparation
  // must not depend on background-tab rendering after a long idle period.
  if(value.type==='job')await chrome.tabs.update(config.tabId,{active:true}).catch(()=>{throw Object.assign(new TransportFailure('Original Copilot tab is unavailable','conversation_unavailable'),{submitted:false});});
  if(value.contextPackets)await requirePacketFrame(config.tabId,config.frameId,'paired');
  return await sendFrame(value,config.tabId,config.frameId);
}
async function sendFrame(value:any,tabId:number,frameId:number|undefined){
 if(value.type==='job'){
  if(value.images?.length){if(!imageEnabled||!await chrome.permissions.contains({permissions:['debugger']}))throw Object.assign(new Error('Enable optional image input in the bridge popup before sending images'),{submitted:false});const imageState=await chrome.tabs.sendMessage(tabId,{type:'inspect'},{frameId}).catch(()=>undefined);if(imageState?.imageInput!==1||imageState?.trustedImageInput!==9)throw Object.assign(new Error('Refresh this workbook to enable image attachments'),{submitted:false});}
  if(value.cancelContinuation===1){const state=await chrome.tabs.sendMessage(tabId,{type:'inspect'},{frameId}).catch(()=>{throw Object.assign(new TransportFailure('Original Copilot frame is unavailable','conversation_unavailable'),{submitted:false});});if(state?.cancelContinuation!==1)throw Object.assign(new Error('Refresh this workbook to enable cancellation continuation'),{submitted:false});}
  const binding={tabId,frameId,delivered:false,imageInput:!!value.images?.length,summary:value.summary===true,modelLabel:value.modelLabel};jobBindings.set(value.id,binding);await chrome.storage.local.set({['binding:'+value.id]:binding});
  const stored=(await chrome.storage.local.get('bindingOrder')).bindingOrder;const order=Array.isArray(stored)?stored.filter((id:any)=>typeof id==='string'&&id!==value.id):[];order.push(value.id);for(const old of order.splice(0,Math.max(0,order.length-100))){jobBindings.delete(old);await chrome.storage.local.remove('binding:'+old);}await chrome.storage.local.set({bindingOrder:order});
  if(canceledJobs.has(value.id))throw Object.assign(new Error('Cancelled before submission'),{submitted:false});binding.delivered=true;
 }
 return await chrome.tabs.sendMessage(tabId,value,{frameId});
}
async function confirmCancel(value:any){
 if(cancelOperations.has(value.id))return cancelOperations.get(value.id);
 const operation=(async()=>{
  canceledJobs.add(value.id);const base={version:1 as const,jobId:value.id,nonce:value.nonce,conversationId:value.conversationId,lane:value.lane as BrowserLane,inputComplete:false,replyState:'none' as const};
  let receipt:CancelReceipt|undefined;const binding=jobBindings.get(value.id)??(await chrome.storage.local.get('binding:'+value.id))['binding:'+value.id] as {tabId:number;frameId?:number}|undefined;
  if(!binding)receipt={...base,outcome:inFlightJobs.has(value.id)?'not_sent':'unverified',reason:'No current frame binding'};
  else{
   await chrome.tabs.sendMessage(binding.tabId,value,{frameId:binding.frameId}).catch(()=>{});
   const end=Date.now()+14000;
   while(Date.now()<end){
    try{const proof=await chrome.tabs.sendMessage(binding.tabId,{type:'cancel-proof',id:value.id,nonce:value.nonce,conversationId:value.conversationId,lane:value.lane},{frameId:binding.frameId});if(proof?.receipt){receipt=proof.receipt;break;}}
    catch{receipt={...base,outcome:'unverified',reason:'Original frame unavailable'};break;}
    await new Promise(resolve=>setTimeout(resolve,400));
   }
  }
  receipt??={...base,outcome:'unverified',reason:'Cancellation confirmation timed out'};
  const message={type:'cancel_receipt',id:value.id,receipt};await chrome.storage.local.set({['cancel:'+value.id]:message});pending.set(value.id,message);send(message);
  if(busyLane?.id===value.id){busyLane=undefined;settledJobs.delete(value.id);}announceReady();await uiStatus();
 })();cancelOperations.set(value.id,operation);try{await operation;}finally{cancelOperations.delete(value.id);}
}
async function retireCancelledLane(id:string,lane:BrowserLane,answer?:any){
  if(busyLane?.id!==id)return;
  if(lane==='main'&&config){
    const ready=typeof answer?.ready==='boolean'?answer.ready:await frameMessage({type:'inspect'}).then(state=>state?.ready===true).catch(()=>false);
    config.ready=ready;await save();
  }else if(lane!=='main'&&typeof answer?.ready==='boolean'){const frame=ownedBinding(lane);if(frame){frame.ready=answer.ready;await save();}}
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
  await changeConnection(async()=>{
  const response = await fetch(intent.url + '/bridge/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: intent.code }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) { const detail = await response.json().catch(() => null); throw new Error(detail?.error?.message ?? 'Pair code rejected; restart gateway for a fresh code'); }
  const { token } = await response.json();
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid gateway pairing response');
  await save();await frameMessage({type:'disconnect'}).catch(()=>{});await retireAgentTabs();await auxiliary.close(true);
  socket?.close(); socket = undefined;
  const selected=await chrome.tabs.get(intent.tabId);
  config = { url: intent.url, token, workerId: crypto.randomUUID(), tabId: intent.tabId,workbookUrl:selected.url, ready: false }; await save();
  const old = await chrome.scripting.getRegisteredContentScripts();
  if (!old.some(x => x.id === 'copilot-frame')) await chrome.scripting.registerContentScripts([{ id: 'copilot-frame', matches: ['https://fa000000124.officeapps.live.com/*'], js: ['content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true }]);
  try { await chrome.scripting.executeScript({ target: { tabId: config.tabId, allFrames: true }, files: ['content.js'] }); }
  catch { await uiStatus('Paired. Reload selected workbook and reopen Copilot to activate its frame.'); }
  await connect();
  });
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
  if (switching || reconnecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  reconnecting = true;
  try {
    await load(); if (!config) return;
    await restoreAdapter();
    const url = validUrl(config.url).replace('http:', 'ws:') + '/bridge/socket'; const ws = new WebSocket(url); socket = ws;
    ws.onopen = async () => {
      if(socket!==ws)return;
      const captured=config!;
      try { const checked = await frameMessage({ type: 'inspect' });if(socket!==ws||config!==captured)return;captured.ready = checked.ready === true;captured.cancelContinuation=checked.cancelContinuation===1;captured.imageInput=checked.imageInput===1&&checked.trustedImageInput===9;captured.conversationControl=checked.conversationControl===true&&checked.conversationResumability==='active-chat-only'; } catch {if(socket!==ws||config!==captured)return;captured.ready = false;captured.conversationControl=false; }
      if(socket!==ws)return;
      send({ type: 'hello', token: config!.token, workerId: config!.workerId, ready: config!.ready,conversationControl:config!.conversationControl,conversationResumability:'active-chat-only',sessionSyncVersion:1,auxiliaryLanes:true,auxiliaryBootstrap:1,contextPackets:1,summaryRouting:1,agentContexts:1,cancelContinuation:config!.cancelContinuation?1:0,imageInput:config!.imageInput&&imagePermission&&imageEnabled?1:0 }); await uiStatus();
    };
    ws.onmessage = event => { void (async () => {
      if(socket!==ws)return;
      const value = JSON.parse(event.data);
      if(switching&&['job','recover'].includes(value.type)){send({type:'failure',id:value.id,error:'Gateway/workbook switch in progress',...(value.type==='job'?{submitted:false}:{})});return;}
      if (value.type === 'connected') {
        if(value.activeId===null&&busyLane){const orphan=busyLane;canceledJobs.add(orphan.id);const answer=await frameMessage({type:'cancel',id:orphan.id,lane:orphan.lane}).catch(()=>undefined);await retireCancelledLane(orphan.id,orphan.lane,answer);}
        const stored=await chrome.storage.local.get(null);for(const [key,message] of Object.entries(stored))if(key.startsWith('cancel:')&&(message as any)?.type==='cancel_receipt')pending.set((message as any).id,message as any);
        for (const reply of pending.values()) send(reply); return;
      }
      if(value.type==='cancel'&&value.cancelContinuation===1){await confirmCancel(value);return;}
      if (value.type === 'ack') { if(value.cancelReceipt){jobBindings.delete(value.id);await chrome.storage.local.remove(['cancel:'+value.id,'cancel-proof:'+value.id]);await chrome.storage.local.remove('binding:'+value.id);}pending.delete(value.id);if(!inFlightJobs.has(value.id))canceledJobs.delete(value.id);if(busyLane?.id!==value.id)settledJobs.delete(value.id);await chrome.storage.local.remove('job:' + value.id); return; }
      if (value.type === 'job' || value.type === 'cancel' || value.type === 'recover') {
        if(value.type==='recover'&&inFlightJobs.has(value.id))return;
        if(value.type==='job'){inFlightJobs.add(value.id);jobBindings.delete(value.id);}
        if(value.type==='job'||value.type==='recover')busyLane={id:value.id,lane:value.lane??'main'};
        if(value.type==='cancel'){canceledJobs.add(value.id);value.lane=busyLane&&busyLane.id===value.id?busyLane.lane:value.lane??'main';}
        try {
          const answer = await frameMessage(value);
          if (answer?.type === 'result' || answer?.type === 'failure') { send(answer);if(busyLane?.id===value.id)busyLane=undefined;announceReady(); }
          if(value.type==='cancel')await retireCancelledLane(value.id,value.lane??'main',answer);
        } catch (error) { send({ type: 'failure', id: value.id, error: error instanceof Error ? error.message : 'Paired tab unavailable',...((error as any)?.submitted===false?{submitted:false}:{}),...((error as any)?.code?{code:(error as any).code}:{}) });if(busyLane?.id===value.id)busyLane=undefined;announceReady(); }
        finally{if(value.type==='job'){inFlightJobs.delete(value.id);canceledJobs.delete(value.id);}}
      }
    })().catch(err => uiStatus(String(err.message))); };
    ws.onclose = () => { if (socket !== ws)return;socket = undefined; void uiStatus('Gateway disconnected; reconnecting without resubmitting uncertain jobs'); };
    ws.onerror = () => { if(socket===ws)void uiStatus('Cannot connect to localhost gateway'); };
  } catch (error) { await uiStatus(error instanceof Error ? error.message : 'Connection failed'); }
  finally { reconnecting = false; }
}
chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { void pairing.resume(); void connect(); });
chrome.permissions.onAdded.addListener(() => { void pairing.resume();void refreshImagePermission(); });
chrome.permissions.onRemoved?.addListener(() => { void refreshImagePermission(); });
// WebSocket traffic resets the MV3 idle timer in supported Chrome versions.
setInterval(() => { send({ type: 'ping' }); void connect(); }, 20000);
chrome.runtime.onStartup.addListener(() => { void pairing.resume(); void connect(); });
chrome.tabs.onRemoved.addListener(tabId => { const removedLane=laneForTab(tabId);officeFrames.delete(tabId);if(config&&removedLane?.startsWith('agent:')){delete config.agents?.[removedLane];agentManagers.delete(removedLane as BrowserLane);if(busyLane?.lane===removedLane){send({type:'failure',id:busyLane.id,error:'Bridge-owned agent tab closed'});settledJobs.delete(busyLane.id);busyLane=undefined;announceReady();}void save();}if(config?.auxiliary?.tabId===tabId){config.auxiliary=undefined;if(busyLane?.lane==='auxiliary'){send({type:'failure',id:busyLane.id,error:'Bridge-owned auxiliary tab closed'});settledJobs.delete(busyLane.id);busyLane=undefined;announceReady();}void save();}if(config?.recovery?.tabId===tabId){config.recovery=undefined;void save();}if (config?.tabId === tabId) { config.ready = false; send({ type: 'ready', ready: false }); void save(); void uiStatus('Paired tab closed'); } });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void (async () => {
    if (sender.tab) {
      if(message.type==='office-host-ready'){
        let office=false;try{office=new URL(sender.url??'').hostname==='excel.officeapps.live.com';}catch{}
        if(config&&office&&Number.isInteger(sender.frameId)&&typeof message.documentKey==='string'&&/^[a-f0-9]{64}$/.test(message.documentKey)&&laneForTab(sender.tab.id)!==undefined){officeFrames.set(sender.tab.id!,{frameId:sender.frameId!,documentKey:message.documentKey});if(sender.tab.id===config.tabId){config.documentKey=message.documentKey;await save();}}
        respond({accepted:true});return;
      }
      if (!config || !safeFrame(sender.url)) return;
      const lane=laneForTab(sender.tab.id);if(!lane)return;
      if(message.type==='image-submit'){
        const binding=jobBindings.get(message.id);
        if(!binding?.imageInput||!binding.delivered||busyLane?.id!==message.id||busyLane?.lane!==lane||canceledJobs.has(message.id)||settledJobs.has(message.id)||binding.tabId!==sender.tab!.id||binding.frameId!==sender.frameId)throw new Error('Image input is not owned by this active job/frame');
        const allowedModel=binding?.summary?SUMMARY_MODELS[message.attempt-1]:binding?.modelLabel;
        if(!binding?.imageInput||!Number.isInteger(message.attempt)||message.attempt<1||message.attempt>(binding.summary?SUMMARY_MODELS.length:1)||typeof message.modelLabel!=='string'||message.modelLabel!==allowedModel||typeof message.nonce!=='string'||!message.nonce||message.nonce.length>100)throw new Error('Invalid image submission model/attempt');
        if(binding.imageAttempt===message.attempt){if(binding.imageNonce!==message.nonce)throw new Error('Image attempt nonce changed');}
        else{if(message.attempt<=(binding.imageAttempt??0))throw new Error('Image submission attempt is out of order');binding.imageAttempt=message.attempt;binding.imageNonce=message.nonce;}
        const verify=async(requirePageFocus=false,afterInput=false)=>{
          if(binding.imageAttempt!==message.attempt||binding.imageNonce!==message.nonce||!binding.delivered||busyLane?.id!==message.id||busyLane?.lane!==lane||canceledJobs.has(message.id)||settledJobs.has(message.id)||binding.tabId!==sender.tab!.id||binding.frameId!==sender.frameId)throw new Error('Image input is not owned by this active job/frame');
          if(!imageEnabled||!await chrome.permissions.contains({permissions:['debugger']}))throw new Error('The image-enabled build and explicit image input switch are required');
          let proof:any,timer:ReturnType<typeof setTimeout>|undefined;try{const request=chrome.tabs.sendMessage(binding.tabId,{type:'image-submit-proof',id:message.id,nonce:message.nonce,pageInstance:message.pageInstance,requirePageFocus,afterInput},{frameId:binding.frameId, ...(sender.documentId?{documentId:sender.documentId}:{})});proof=afterInput?await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Image submission acknowledgement channel timed out; input was not repeated')),20000);})]):await request;}finally{clearTimeout(timer);}
          if(proof?.ready!==true||afterInput&&proof.submitted!==true||canceledJobs.has(message.id)||busyLane?.id!==message.id)throw new Error(proof?.error??'Image input page, draft or job changed before submission');
          return afterInput&&proof.submitted===true;
        };
        await verify();await imageInput.submit(message.id+':image:'+message.attempt,binding!.tabId,verify);respond({submitted:true});return;
      }
      if (message.type === 'frame-ready') {
        if(lane==='main'){config.frameId = sender.frameId; config.ready = message.ready === true;config.cancelContinuation=message.cancelContinuation===1;config.imageInput=message.imageInput===1&&message.trustedImageInput===9;if(sender.tab.url?.startsWith('https://excel.cloud.microsoft/open/'))config.workbookUrl=sender.tab.url;config.conversationControl=message.conversationControl===true&&message.conversationResumability==='active-chat-only';await save();}
        else await ownedManager(lane).observe(sender.tab.id!,sender.frameId,sender.url,message.ready===true);
        if(busyLane?.lane===lane&&message.ready===true&&settledJobs.has(busyLane.id)){settledJobs.delete(busyLane.id);busyLane=undefined;}
        announceReady();await connect();await uiStatus();
      }
      const frameId=lane==='main'?config.frameId:ownedBinding(lane)?.frameId;
      if (['result', 'failure'].includes(message.type) && sender.frameId === frameId && busyLane?.id===message.id && busyLane?.lane===lane) { pending.set(message.id, message);settledJobs.add(message.id); await connect(); send(message); }
      respond({ accepted: true }); return;
    }
    if (sender.id !== chrome.runtime.id) throw new Error('Only extension UI can pair');
    if (message.type === 'rebind-tab') {
      await changeConnection(async()=>{
      await load();
      if (!config) throw new Error('Pair the local gateway first');
      const target=validUrl(message.url??config.url),different=target!==config.url;
      const stored=different?savedPairings[target]:undefined;
      if(different&&(!stored||stored.url!==target||!/^[a-f0-9]{64}$/.test(stored.token)||typeof stored.workerId!=='string'||!stored.workerId))throw new Error('This gateway has no saved pairing. Run setup in that environment and pair once.');
      if (!Number.isInteger(message.tabId)) throw new Error('Invalid selected tab');
      if (!(await chrome.permissions.contains({ origins: OFFICE_ORIGINS }))) throw new Error('Office frame permission is missing; pair again to grant access');
      const tab = await chrome.tabs.get(message.tabId);
      if (!tab.url?.startsWith('https://excel.cloud.microsoft/')) throw new Error('Select an Excel workbook tab first');
      await frameMessage({ type: 'disconnect' }).catch(() => {});
      await retireAgentTabs();await auxiliary.close(true); // A retired auxiliary tab may contain a human draft.
      if(different){await save();send({type:'ready',ready:false});socket?.close();socket=undefined;config={...stored!,tabId:message.tabId,ready:false};}
      config.tabId = message.tabId;config.documentKey=undefined;config.workbookUrl=tab.url; config.frameId = undefined; config.ready = false; await save();
      send({ type: 'ready', ready: false });
      try { await chrome.scripting.executeScript({ target: { tabId: config.tabId, allFrames: true }, files: ['content.js'] }); }
      catch { await uiStatus('Refresh the selected workbook and reopen Copilot to activate its frame.'); }
      });respond({ ok: true }); return;
    }
    if(message.type==='image-input-toggle'){assertSwitchIdle();if(typeof message.enabled!=='boolean')throw new Error('Invalid image input choice');if(message.enabled&&!await chrome.permissions.contains({permissions:['debugger']}))throw new Error('Install the image-enabled build to use image input');imageEnabled=message.enabled;await chrome.storage.local.set({imageInputEnabled:imageEnabled});await refreshImagePermission();respond({ok:true});return;}
    if (message.type === 'prepare-pair') { respond(await pairing.prepare(message)); return; }
    if (message.type === 'permission-decision') {
      if (!message.granted) { await chrome.storage.local.remove('pairIntent'); await chrome.storage.local.set({ pairingStatus: { phase: 'failed', error: 'Office frame access was not granted' } }); }
      else await pairing.resume();
      respond({ ok: true }); return;
    }
    if (message.type === 'unpair') {
      await changeConnection(async()=>{
      await frameMessage({ type: 'disconnect' }).catch(() => {});
      await retireAgentTabs();await auxiliary.close();
      socket?.close(); socket = undefined; config = undefined; pending.clear();
      await chrome.scripting.unregisterContentScripts({ ids: ['copilot-frame','bridge-office-host'] });
      savedPairings={};await chrome.storage.local.clear();
      });respond({ ok: true }); return;
    }
    respond({ error: 'Unknown extension request' });
  })().catch(error => respond({ error: error instanceof Error ? error.message : 'Extension failure' }));
  return true;
});
void pairing.resume(); void connect();
