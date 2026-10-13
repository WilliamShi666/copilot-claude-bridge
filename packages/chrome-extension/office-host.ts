// Loaded only in the already permitted Excel Office frame, never the outer site.
const officeRoot=globalThis as typeof globalThis & {__m365OfficeHostInstalled?:boolean};
if(location.hostname==='excel.officeapps.live.com'&&!officeRoot.__m365OfficeHostInstalled){
 officeRoot.__m365OfficeHostInstalled=true;
 let alive=true;
 async function report(){
  if(!alive)return;
  try{
   const source=new URL(location.href).searchParams.get('wopisrc');if(!source)return;
   const file=new URL(source);const bytes=new TextEncoder().encode(file.origin+file.pathname);
   const documentKey=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
   await chrome.runtime.sendMessage({type:'office-host-ready',documentKey});
  }catch(error){if(String((error as Error).message).includes('context invalidated')){alive=false;clearInterval(timer);}}
 }
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||message.type!=='office-open-copilot')return;
  // The background sends this only to a verified bridge-owned auxiliary tab.
  const mounted=[...document.querySelectorAll<HTMLIFrameElement>('iframe')].some(frame=>{try{const rect=frame.getBoundingClientRect();return new URL(frame.src).hostname==='fa000000124.officeapps.live.com'&&frame.getClientRects().length>0&&rect.width>0&&rect.height>0&&!frame.closest('[hidden],[aria-hidden="true"]');}catch{return false;}});
  if(!mounted){const button=[...document.querySelectorAll<HTMLElement>('button,[role="button"]')].find(el=>/^(与 Copilot 聊天|Chat with Copilot)$/i.test(el.getAttribute('aria-label')??el.textContent?.trim()??''));button?.click();}
  respond({prepared:true});return false;
 });
 const timer=setInterval(()=>void report(),2000);addEventListener('pagehide',()=>{alive=false;clearInterval(timer);},{once:true});void report();
}
