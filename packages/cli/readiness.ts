export interface AdapterStatus {paired:boolean;workerConnected:boolean;browserReady:boolean;active?:{lane?:string}|null;queued?:number}
export interface ReadinessOptions {timeoutMs?:number;now?:()=>number;sleep?:(ms:number)=>Promise<void>;onWait?:(status:AdapterStatus)=>void}
function unavailable(status:AdapterStatus):Error{
  if(!status.paired)return new Error('Chrome bridge is not paired. Select the workbook and pair it with the local gateway.');
  if(!status.workerConnected)return new Error('Chrome extension is not connected to the gateway. Keep Chrome open and check the bridge popup, then run doctor.');
  if(status.active||status.queued)return new Error(`Copilot bridge is busy${status.active?.lane?' in the '+status.active.lane+' lane':''}. Wait for the current request to finish, then start Claude Code again.`);
  return new Error('Chrome extension is connected, but the paired Copilot chat is not ready. Open Copilot in its paired workbook; if already open, use the selected Excel tab in the bridge popup, then run doctor.');
}
export async function waitForBrowserReady<T extends {status:AdapterStatus}>(check:()=>Promise<T>,options:ReadinessOptions={}):Promise<T>{
  const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const deadline=now()+(options.timeoutMs??15000);let notified=false;
  for(;;){
    // Read-only status checks: never replay, cancel, reset or rebind browser jobs.
    const data=await check(),status=data.status;
    if(status.paired&&status.workerConnected&&status.browserReady&&!status.active&&!status.queued)return data;
    if(!status.paired||now()>=deadline)throw unavailable(status);
    if(!notified){notified=true;options.onWait?.(status);}
    await sleep(Math.min(250,Math.max(0,deadline-now())));
  }
}
