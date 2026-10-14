import { OFFICE_ORIGINS, validateIntent } from './pairing.js';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = el<HTMLPreElement>('status');
const pair = el<HTMLButtonElement>('pair');
let selectedTab: chrome.tabs.Tab | undefined;
let pairedUrl: string | undefined;
let savedUrls:string[]=[];
let gatewayEdited = false, codeEdited = false;
el<HTMLInputElement>('url').addEventListener('input', () => { gatewayEdited = true;updateButton(); });
el<HTMLInputElement>('code').addEventListener('input', () => { codeEdited = true; });
pair.disabled = true;
function updateButton(){const url=el<HTMLInputElement>('url').value.trim();pair.textContent=pairedUrl===url?'Use selected Excel tab':savedUrls.includes(url)?'Switch gateway and use selected tab':'Pair selected Excel tab';}
async function refresh() {
  const data = await chrome.storage.local.get(['status', 'config', 'savedPairings', 'pairIntent', 'pairingStatus']);
  const config = data.config as { url: string } | undefined;
  pairedUrl = config?.url;
  savedUrls=Object.keys(data.savedPairings??{}).filter(url=>/^http:\/\/127\.0\.0\.1:\d+$/.test(url));
  const choices=document.getElementById('gateways');if(choices)choices.innerHTML=savedUrls.map(url=>'<option value="'+url+'"></option>').join('');
  const pending = data.pairIntent as { url: string; code: string } | undefined;
  const connection = data.status as { connected?: boolean; ready?: boolean; error?: string } | undefined;
  const progress = data.pairingStatus as { phase: string; error?: string } | undefined;
  if (config && !gatewayEdited) el<HTMLInputElement>('url').value = config.url;
  else if (!config && pending) {
    if (!gatewayEdited) el<HTMLInputElement>('url').value = pending.url;
    if (!codeEdited) el<HTMLInputElement>('code').value = pending.code;
  }
  updateButton();
  status.textContent = JSON.stringify({ paired: !!config, connected: connection?.connected ?? false, ready: connection?.ready ?? false, phase: progress?.phase ?? 'not_paired', error: progress?.error ?? connection?.error ?? null }, null, 2);
}
void (async () => { [selectedTab] = await chrome.tabs.query({ active: true, currentWindow: true }); pair.disabled = false; await refresh(); })().catch(error => { status.textContent = String(error.message); });
el<HTMLButtonElement>('pair').onclick = async () => {
  try {
    if (selectedTab?.id === undefined || !selectedTab.url?.startsWith('https://excel.cloud.microsoft/')) throw new Error('Select the Excel workbook tab with Copilot open first');
    const url = el<HTMLInputElement>('url').value.trim();
    if (pairedUrl === url || savedUrls.includes(url)&&!el<HTMLInputElement>('code').value.trim()) {
      status.textContent = 'Connecting the existing pairing to the selected Excel tab...';
      const response = await chrome.runtime.sendMessage({ type: 'rebind-tab', tabId: selectedTab.id,...(pairedUrl===url?{}:{url}) });
      if (response?.error) throw new Error(response.error);
      await refresh(); return;
    }
    const code = el<HTMLInputElement>('code').value.trim(); if (!/^[a-f0-9]{40}$/.test(code)) throw new Error('Paste the one-time code from bridge setup');
    const intent = validateIntent({ url, code, tabId: selectedTab.id }, Date.now());
    status.textContent = 'Pairing continues in the background. Allow the Office permissions if Chrome asks.';
    // Both calls start synchronously inside the click. The background receives all
    // data BEFORE a permission prompt can close this transient popup.
    const prepared = chrome.runtime.sendMessage({ type: 'prepare-pair', ...intent });
    const requested = chrome.permissions.request({ origins: OFFICE_ORIGINS });
    const response = await prepared; if (response?.error) throw new Error(response.error);
    const granted = await requested;
    await chrome.runtime.sendMessage({ type: 'permission-decision', granted });
    if (!granted) throw new Error('Office frame access was not granted');
    await refresh();
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Pair failed'; }
};
el<HTMLButtonElement>('unpair').onclick = async () => {try{const response=await chrome.runtime.sendMessage({type:'unpair'});if(response?.error)throw new Error(response.error);await chrome.permissions.remove({origins:OFFICE_ORIGINS});await refresh();}catch(error){status.textContent=error instanceof Error?error.message:'Disconnect failed';}};
chrome.storage.onChanged.addListener(() => { void refresh(); });
