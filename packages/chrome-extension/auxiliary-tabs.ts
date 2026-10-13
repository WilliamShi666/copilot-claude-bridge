export interface AuxiliaryBinding {tabId:number;sourceUrl:string;documentKey?:string;frameId?:number;ready?:boolean}
export interface AuxiliaryDependencies {primary():Promise<{tabId:number;url:string}>;binding():AuxiliaryBinding|undefined;save(value:AuxiliaryBinding|undefined):Promise<void>;create(url:string):Promise<{id?:number;url?:string}>;get(id:number):Promise<{id?:number;url?:string}>;inject(id:number):Promise<void>;remove(id:number):Promise<void>;activate?(id:number):Promise<void>;identity?(id:number):Promise<string|undefined>}
export class AuxiliaryTabs {
 private preparing:Promise<AuxiliaryBinding>|undefined;
 constructor(private deps:AuxiliaryDependencies){}
 async ensure(timeoutMs=60000):Promise<AuxiliaryBinding>{
  if(this.preparing)return this.preparing;this.preparing=this.prepare(timeoutMs);try{return await this.preparing;}finally{this.preparing=undefined;}
 }
 private async prepare(timeoutMs:number):Promise<AuxiliaryBinding>{
  const primary=await this.deps.primary();if(!/^https:\/\/excel\.cloud\.microsoft\/open\//.test(primary.url))throw new Error('The paired main tab must be an Excel workbook');
  let binding=this.deps.binding(),createdHere=false;
  if(binding){
   const tab=await this.deps.get(binding.tabId).catch(()=>undefined);
   if(!tab){await this.deps.save(undefined);binding=undefined;}
   else if(binding.tabId===primary.tabId||(tab.url!==undefined&&tab.url!==binding.sourceUrl))throw new Error('Auxiliary tab ownership changed; it will not be commandeered');
   else if(binding.sourceUrl!==primary.url){await this.close();binding=undefined;}
  }
  if(!binding){const documentKey=await this.deps.identity?.(primary.tabId);if(this.deps.identity&&!documentKey)throw new Error('The main Office document identity is unavailable; open its workbook first');const tab=await this.deps.create(primary.url);if(!Number.isInteger(tab.id)||tab.id===primary.tabId)throw new Error('No separate owned auxiliary tab was created');binding={tabId:tab.id!,sourceUrl:primary.url,documentKey,ready:false};createdHere=true;await this.deps.save(binding);}
  const deadline=Date.now()+timeoutMs;let lastInjection=0,activated=false;
  while(Date.now()<deadline){
   const current=this.deps.binding();if(!current||current.tabId!==binding.tabId)throw new Error('Auxiliary tab ownership was lost');
   const tab=await this.deps.get(current.tabId);if(tab.url!==undefined&&tab.url!==current.sourceUrl)throw new Error('Auxiliary tab URL changed; no request was submitted');
   const identity=await this.deps.identity?.(current.tabId).catch(()=>undefined);
   if(identity&&current.documentKey&&identity!==current.documentKey)throw new Error('Auxiliary document ownership changed; no request was submitted');
   if(!activated&&(createdHere||tab.url===current.sourceUrl||!!identity&&identity===current.documentKey)){await this.deps.activate?.(current.tabId);activated=true;}
   if(Date.now()-lastInjection>=1000){lastInjection=Date.now();await this.deps.inject(current.tabId).catch(()=>{});}
   const observed=this.deps.binding();if(observed?.ready&&Number.isInteger(observed.frameId)&&(!this.deps.identity||identity===current.documentKey))return observed;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Open Copilot in the bridge-owned auxiliary workbook tab; no main conversation was changed');
 }
 async observe(tabId:number,frameId:number|undefined,url:string|undefined,ready:boolean):Promise<boolean>{
  const binding=this.deps.binding();let safe=false;try{safe=new URL(url??'').hostname==='fa000000124.officeapps.live.com';}catch{}
  if(!binding||binding.tabId!==tabId||!Number.isInteger(frameId)||!safe)return false;
  await this.deps.save({...binding,frameId,ready});return true;
 }
 async close(preserveTab=false){
  const binding=this.deps.binding();if(!binding)return;const primary=await this.deps.primary().catch(()=>undefined),tab=await this.deps.get(binding.tabId).catch(()=>undefined);
  const identity=tab&&tab.url===undefined?await this.deps.identity?.(binding.tabId).catch(()=>undefined):undefined;
  const owned=tab&&(tab.url!==undefined?tab.url===binding.sourceUrl:!!binding.documentKey&&identity===binding.documentKey);
  if(!preserveTab&&primary&&binding.tabId!==primary.tabId&&owned)await this.deps.remove(binding.tabId);
  await this.deps.save(undefined);
 }
}
