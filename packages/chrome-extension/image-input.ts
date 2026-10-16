// No general CDP command or arbitrary target is exposed to content or the gateway.
export interface ImageInputDriver {
 attach(tabId:number):Promise<void>;
 focus(tabId:number,enabled:boolean):Promise<void>;
 enter(tabId:number,type:'keyDown'|'keyUp'):Promise<void>;
 detach(tabId:number):Promise<void>;
}
export class ImageInputFailure extends Error {
 constructor(message:string,readonly inputAttempted:boolean){super(message);}
}
export function trustedEnterObservation(target:HTMLElement,signal:AbortSignal,timeout=3000){
 let resolve!:(value:boolean)=>void,done=false,disposed=false,timer:ReturnType<typeof setTimeout>|undefined;const records:Record<string,unknown>[]=[];
 const promise=new Promise<boolean>(r=>{resolve=r;});
 const finish=(observed:boolean)=>{if(done)return;done=true;clearTimeout(timer);resolve(observed);};
 const dispose=()=>{if(disposed)return;disposed=true;clearTimeout(timer);for(const type of ['keydown','keypress','keyup','click'])target.removeEventListener(type,key as EventListener,true);signal.removeEventListener('abort',abort);finish(false);};
 const key=(event:KeyboardEvent)=>{
  if(disposed||!(event.type==='click'||event.key==='Enter'||event.type==='keypress'&&event.charCode===13)||!(event.target===target||target.contains(event.target as Node)))return;
  // Only this operation's Enter and activation-click metadata is observed; never key text,
  // other keys, source content, cookies or events elsewhere in the page.
  const doc=target.ownerDocument,selection=doc?.defaultView?.getSelection();
  if(records.length<9){const record={type:event.type||'keydown',trusted:event.isTrusted,code:event.code,keyCode:event.keyCode,which:event.which,charCode:event.charCode,composing:event.isComposing,prevented:event.defaultPrevented,focus:doc?.hasFocus()??false,activation:doc?.defaultView?.navigator.userActivation?.isActive??false,selectionInTarget:!!selection?.anchorNode&&target.contains(selection.anchorNode)};records.push(record);queueMicrotask(()=>{record.prevented=event.defaultPrevented;});}
  if((event.type||'keydown')==='keydown'&&event.isTrusted)finish(true);
 };
 const abort=()=>dispose();
 for(const type of ['keydown','keypress','keyup','click'])target.addEventListener(type,key as EventListener,true);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)dispose();
 // Attachment and focus preparation can take longer than the observation
 // window. Arm its deadline only after the browser input operation returns.
 return{promise,arm:()=>{if(!done&&!timer)timer=setTimeout(dispose,timeout);},trace:()=>records.map(record=>({...record})),dispose};
}
export class ImageInput {
 private attempted=new Set<string>();private activeTabs=new Set<number>();
 constructor(private driver:ImageInputDriver){}
 get busy(){return this.activeTabs.size>0;}
 async submit(id:string,tabId:number,verify:(requirePageFocus?:boolean,afterInput?:boolean)=>Promise<boolean|void>){
  if(this.attempted.has(id))throw new ImageInputFailure('Image submission was already attempted; it was not repeated',true);
  if(this.activeTabs.has(tabId))throw new ImageInputFailure('Image input is still releasing this tab',false);
  this.attempted.add(id);if(this.attempted.size>1000)this.attempted.delete(this.attempted.values().next().value!);this.activeTabs.add(tabId);let attached=false,focusSet=false,pressed=false,keyUpAttempted=false;
  try{try{
   await verify(false);await this.driver.attach(tabId);attached=true;
   // Recheck after attachment: cancellation/navigation may have won that race.
   await verify(false);focusSet=true;await this.driver.focus(tabId,true);
   await verify(true);pressed=true;await this.driver.enter(tabId,'keyDown');
   keyUpAttempted=true;await this.driver.enter(tabId,'keyUp');
   // keyDown includes its text, so Chromium performs one native Enter
   // activation without an intervening focus RPC and separate char event.
   // Release Enter immediately, then retain the scoped connection and page
   // focus until the page acknowledges this owned message or cancellation.
   await verify(true,true);
  }finally{
   try{if(pressed&&!keyUpAttempted)await this.driver.enter(tabId,'keyUp');}
   finally{try{if(focusSet)await this.driver.focus(tabId,false);}finally{try{if(attached)await this.driver.detach(tabId);}finally{this.activeTabs.delete(tabId);}}}
  }}catch(error){throw new ImageInputFailure(error instanceof Error?error.message:'Image input failed',pressed);}
 }
}
