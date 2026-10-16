// Only related Office iframe sessions within this image operation's tab are
// observed. No Runtime, Network, cookies, target inventory or page data access.
export interface FocusTarget {tabId:number;sessionId?:string}
export interface FocusProtocol {
 command(target:FocusTarget,method:string,params:Record<string,unknown>):Promise<unknown>;
 listen(callback:(source:FocusTarget,method:string,params:any)=>void):()=>void;
}
const autoAttach={autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]};
const officeHost=(value:unknown)=>{try{const u=new URL(String(value));return u.protocol==='https:'&&['excel.officeapps.live.com','fa000000124.officeapps.live.com'].includes(u.hostname)?u.hostname:undefined;}catch{return undefined;}};
export class ImageFocus {
 private sessions=new Map<string,{target:FocusTarget;copilot:boolean}>();
 private pending=new Set<Promise<void>>();private error:unknown;private unlisten?:()=>void;private closed=false;
 constructor(private protocol:FocusProtocol,private tabId:number){}
 private async command(target:FocusTarget,method:string,params:Record<string,unknown>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([this.protocol.command(target,method,params),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Scoped image focus command timed out')),2500);})]);}
  finally{clearTimeout(timer);}
 }
 private event=(source:FocusTarget,method:string,params:any)=>{
  if(this.closed||source.tabId!==this.tabId||source.sessionId&&!this.sessions.has(source.sessionId))return;
  if(method==='Target.detachedFromTarget'){
   if(this.sessions.delete(params?.sessionId))this.error=new Error('Image focus iframe changed before input');
   return;
  }
  if(method!=='Target.attachedToTarget'||typeof params?.sessionId!=='string'||this.sessions.has(params.sessionId))return;
  const target={tabId:this.tabId,sessionId:params.sessionId},host=params.targetInfo?.type==='iframe'&&officeHost(params.targetInfo?.url);
  if(!host){void this.command(source,'Target.detachFromTarget',{sessionId:params.sessionId}).catch(()=>{});return;}
  this.sessions.set(params.sessionId,{target,copilot:host==='fa000000124.officeapps.live.com'});
  const pending=(async()=>{
   await this.command(target,'Emulation.setFocusEmulationEnabled',{enabled:true});
   if(this.closed)return;
   // Auto-attach is not recursive: Excel's target must expose the nested
   // Copilot target before that frame can receive its own focus emulation.
   await this.command(target,'Target.setAutoAttach',autoAttach);
  })().catch(error=>{this.error=error;});
  this.pending.add(pending);void pending.finally(()=>this.pending.delete(pending));
 };
 async enable(timeoutMs=2000){
  this.unlisten=this.protocol.listen(this.event);
  await this.command({tabId:this.tabId},'Emulation.setFocusEmulationEnabled',{enabled:true});
  await this.command({tabId:this.tabId},'Target.setAutoAttach',autoAttach);
  const end=Date.now()+timeoutMs;
  // Commands can finish before onEvent callbacks arrive. Bound the discovery
  // wait; same-process frames need only the root override and no child target.
  while(Date.now()<end){
   if(this.error)throw this.error;
   if([...this.sessions.values()].some(s=>s.copilot)&&!this.pending.size)return;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(this.pending.size)throw new Error('Image focus iframe preparation timed out before input');
  if(this.error)throw this.error;
 }
 async disable(){
  this.closed=true;this.unlisten?.();
  await Promise.allSettled([...this.pending]);
  await Promise.allSettled([...this.sessions.values()].reverse().map(({target})=>this.command(target,'Emulation.setFocusEmulationEnabled',{enabled:false})));
  try{await this.command({tabId:this.tabId},'Emulation.setFocusEmulationEnabled',{enabled:false});}
  finally{await this.command({tabId:this.tabId},'Target.setAutoAttach',{autoAttach:false,waitForDebuggerOnStart:false,flatten:true});this.sessions.clear();}
 }
}
