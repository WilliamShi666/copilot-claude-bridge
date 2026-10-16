import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {JSDOM} from 'jsdom';import {webcrypto} from 'node:crypto';
async function flush(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
async function until(condition:()=>boolean){const deadline=Date.now()+1500;while(!condition()){if(Date.now()>deadline)throw new Error('Expected asynchronous browser event did not arrive');await new Promise(resolve=>setTimeout(resolve,10));}}
async function boot(deferred=false,cancelReplyMissing=false,cancelContinuation=false,trustedImages=false,debuggerGranted=true,actualInspection?:any,fastAckTimeout=false){
 const url='https://excel.cloud.microsoft/open/onedrive/?docId=approved';const storage:any={imageInputEnabled:trustedImages,config:{url:'http://127.0.0.1:59173',token:'a'.repeat(64),workerId:'test',tabId:7,frameId:2,ready:true,conversationControl:true}};
 const receipts:any[]=[];const tabs=new Map([[7,url]]),jobs:any[]=[],activations:number[]=[],openCalls:number[]=[];let debuggerListener:any;let listener:any,socket:any,resolveCreate:any,nextTabId=20;const debuggerCalls:any[]=[];let imageProof=true,imageFocus=true,imageSubmitted=true;let rawAction=async()=>{},ackAction=async()=>{};
 const source='https://fa000000124.officeapps.live.com/taskpane.html';
 const emit=async(message:any,tabId:number,frameId:number,url=source)=>{listener(message,{tab:{id:tabId},frameId,url},()=>{});await flush();};
 const chromeMock:any={
 storage:{local:{get:async()=>JSON.parse(JSON.stringify(storage)),set:async(value:any)=>Object.assign(storage,structuredClone(value)),remove:async(key:string|string[])=>{for(const k of Array.isArray(key)?key:[key])delete storage[k];}}},
 permissions:{contains:async(value:any)=>value.permissions?.includes('debugger')?debuggerGranted:true,onAdded:{addListener:()=>{}}},
 debugger:{onEvent:{addListener:(fn:any)=>{debuggerListener=fn;},removeListener:()=>{debuggerListener=undefined;}},attach:async(target:any,version:any)=>{debuggerCalls.push(['attach',target.tabId,version]);},sendCommand:async(target:any,command:any,value:any)=>{if(command==='Target.setAutoAttach'){if(value.autoAttach&&!target.sessionId)queueMicrotask(()=>debuggerListener?.(target,'Target.attachedToTarget',{sessionId:'copilot-child',targetInfo:{type:'iframe',url:source}}));return;}if(target.sessionId&&command==='Emulation.setFocusEmulationEnabled')return;if(command==='Emulation.setFocusEmulationEnabled'){debuggerCalls.push(['focus',target.tabId,value.enabled]);return;}assert.equal(command,'Input.dispatchKeyEvent');assert.equal(value.key,'Enter');assert.equal(value.windowsVirtualKeyCode,13);assert.equal(value.modifiers,0);if(value.type==='keyDown'){assert.equal(value.text,'\r');assert.equal(value.unmodifiedText,'\r');assert.deepEqual(Array.from(value.commands),[]);}debuggerCalls.push([value.type,target.tabId]);if(value.type==='keyDown')await rawAction();},detach:async(target:any)=>{debuggerCalls.push(['detach',target.tabId]);}},
 scripting:{getRegisteredContentScripts:async()=>[{id:'copilot-frame'}],registerContentScripts:async()=>{},executeScript:async({target,func}:any)=>{if(target.tabId>=20&&target.allFrames)throw new Error('Outer Excel site access is not granted');if(func)return[{frameId:1,result:'a'.repeat(64)}];return[];}},
 alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
 runtime:{id:'extension',onStartup:{addListener:()=>{}},onMessage:{addListener:(fn:any)=>{listener=fn;}}},
 tabs:{get:async(id:number)=>{if(!tabs.has(id))throw new Error('closed');if(id>=20)await emit({type:'office-host-ready',documentKey:'a'.repeat(64)},id,1,'https://excel.officeapps.live.com/x/_layouts/xlviewer.aspx');return{id,url:tabs.get(id)};},create:async({url}:any)=>{const id=nextTabId++;if(deferred)return await new Promise(resolve=>{resolveCreate=()=>{tabs.set(id,url);resolve({id,url});};});tabs.set(id,url);return{id,url};},remove:async(id:number)=>{tabs.delete(id);},sendMessage:async(tabId:number,value:any,{frameId}:any)=>{if(value.type==='image-submit-proof'){if(value.afterInput)await ackAction();return{ready:imageProof&&(!value.requirePageFocus||imageFocus),submitted:value.afterInput&&imageSubmitted};}if(value.type==='cancel-proof')return{receipt:{version:1,jobId:value.id,nonce:value.nonce,conversationId:value.conversationId,lane:value.lane,outcome:'settled',inputComplete:true,replyState:'partial',cursor:'a'.repeat(64),pageInstance:'page-1'}};if(value.type==='inspect')return actualInspection??{ready:true,summaryRouting:1,imageInput:trustedImages?1:undefined,trustedImageInput:trustedImages?10:undefined,cancelContinuation:cancelContinuation?1:undefined,conversationControl:true,conversationResumability:'active-chat-only'};if(value.type==='office-open-copilot'){openCalls.push(tabId);assert.ok(tabId>=20);assert.equal(frameId,1);await emit({type:'frame-ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'},tabId,4);return{prepared:true};}if(value.type==='job'){jobs.push({tabId,frameId,value});return{accepted:true};}return cancelReplyMissing?undefined:{cancelled:true,ready:true};},onRemoved:{addListener:()=>{}}},
 };
 chromeMock.tabs.update=async(id:number,properties:any)=>{assert.equal(properties.active,true);assert.ok(tabs.has(id));activations.push(id);return{id,url:tabs.get(id)};};
 chromeMock.windows={update:()=>{throw new Error('The browser window must not be focused');}};
 class Socket {static OPEN=1;static CONNECTING=0;readyState=1;sent:any[]=[];onopen:any;onmessage:any;constructor(){socket=this;}send(value:string){const v=JSON.parse(value);if(v.type==='cancel_receipt'){assert.deepEqual(storage['cancel:'+v.id],v);receipts.push(v);}this.sent.push(v);}close(){}}
 vm.runInNewContext(await readFile('dist/extension/background.js','utf8'),{chrome:chromeMock,WebSocket:Socket,URL,Date,Error,Promise,JSON,Map,Set,Number,setInterval:()=>1,setTimeout:(fn:any,ms:number)=>setTimeout(fn,fastAckTimeout&&ms===20000?5:ms),clearTimeout});await flush();await socket.onopen();await flush();
 const server=async(value:any)=>{socket.onmessage({data:JSON.stringify(value)});await flush();};
 const request=(message:any,tabId=7,frameId=2)=>new Promise<any>(resolve=>listener(message,{tab:{id:tabId},frameId,documentId:'current-document',url:source},resolve));
 return {socket,jobs,tabs,server,emit,request,debuggerCalls,setImageProof:(value:boolean)=>{imageProof=value;},setImageFocus:(value:boolean)=>{imageFocus=value;},setImageSubmitted:(value:boolean)=>{imageSubmitted=value;},onRawDown:(fn:()=>Promise<void>)=>{rawAction=fn;},onAck:(fn:()=>Promise<void>)=>{ackAction=fn;},activations,openCalls,storage,receipts,release:async()=>{resolveCreate();await flush();}};
}
test('worker routes main/auxiliary frames separately and becomes ready even when ACK precedes frame completion',async()=>{
 const f=await boot();assert.deepEqual(f.activations,[]);await f.server({type:'job',id:'main-1',lane:'main',prompt:'main'});assert.equal(f.jobs[0].tabId,7);assert.deepEqual(f.activations,[7]);
 await f.emit({type:'result',id:'main-1',text:'real reply'},7,2);await f.server({type:'ack',id:'main-1'});
 await f.emit({type:'frame-ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'},7,2);
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);
 await f.server({type:'job',id:'aux-1',lane:'auxiliary',prompt:'title'});await until(()=>f.jobs.length===2);assert.equal(f.jobs[1].tabId,20);assert.equal(f.jobs[1].frameId,4);assert.deepEqual(f.activations,[7,20]);
 await f.emit({type:'frame-ready',ready:true,conversationControl:true,conversationResumability:'active-chat-only'},7,2);assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,false);
 await f.emit({type:'result',id:'aux-1',text:'title reply'},20,4);await f.server({type:'ack',id:'aux-1'});await f.emit({type:'frame-ready',ready:true},20,4);
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);
});
test('cancellation during auxiliary tab creation prevents a delayed model submission after ACK',async()=>{
 const f=await boot(true);await f.server({type:'job',id:'cancel-before-creation',lane:'auxiliary',prompt:'must not be sent'});
 await f.server({type:'cancel',id:'cancel-before-creation',lane:'auxiliary'});await f.server({type:'ack',id:'cancel-before-creation'});await f.release();
 await until(()=>f.socket.sent.some((x:any)=>x.type==='failure'&&x.id==='cancel-before-creation'));assert.equal(f.jobs.length,0);
});
test('canceling an obsolete main-frame job restores readiness even when that frame has no matching controller',async()=>{
 const f=await boot(false,true);await f.server({type:'job',id:'obsolete',lane:'main',prompt:'old'});
 await f.emit({type:'frame-ready',ready:true},7,2);assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,false);
 await f.server({type:'cancel',id:'obsolete'});
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);assert.equal(f.jobs.length,1);
});
test('a late cancellation for an older job cannot clear a newer active lane',async()=>{
 const f=await boot();await f.server({type:'job',id:'current',lane:'main',prompt:'current'});
 await f.emit({type:'frame-ready',ready:true},7,2);await f.server({type:'cancel',id:'older'});
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,false);
});
test('reconnecting to an idle gateway retires an orphaned busy lane without replaying it',async()=>{
 const f=await boot();await f.server({type:'job',id:'orphan',lane:'main',prompt:'old'});
 await f.emit({type:'frame-ready',ready:true},7,2);await f.server({type:'connected',activeId:null});
 assert.equal(f.socket.sent.filter((x:any)=>x.type==='ready').at(-1).ready,true);assert.equal(f.jobs.length,1);
});

test('each native agent reuses its own tab and a sibling cannot deliver its response',async()=>{
 const f=await boot(),a='agent:'+'a'.repeat(64),b='agent:'+'b'.repeat(64);
 const finish=async(id:string,tabId:number)=>{await f.emit({type:'result',id,text:'reply'},tabId,4);await f.server({type:'ack',id});await f.emit({type:'frame-ready',ready:true},tabId,4);};
 await f.server({type:'job',id:'a-first',lane:a,prompt:'a'});await until(()=>f.jobs.length===1);assert.equal(f.jobs[0].tabId,20);await finish('a-first',20);
 await f.server({type:'job',id:'b-first',lane:b,prompt:'b'});await until(()=>f.jobs.length===2);assert.equal(f.jobs[1].tabId,21);await finish('b-first',21);
 await f.server({type:'job',id:'a-next',lane:a,prompt:'next a'});await until(()=>f.jobs.length===3);assert.equal(f.jobs[2].tabId,20);
 await f.emit({type:'result',id:'a-next',text:'wrong sibling'},21,4);assert.ok(!f.socket.sent.some((m:any)=>m.type==='result'&&m.id==='a-next'));
 await finish('a-next',20);assert.equal(f.socket.sent.filter((m:any)=>m.type==='result'&&m.id==='a-next').length,1);
 assert.equal(f.socket.sent.filter((m:any)=>m.type==='ready').at(-1).ready,true);
});

test('canceling one agent restores readiness and a late cancellation cannot clear its sibling',async()=>{
 const f=await boot(),a='agent:'+'a'.repeat(64),b='agent:'+'b'.repeat(64);
 await f.server({type:'job',id:'a',lane:a,prompt:'a'});await until(()=>f.jobs.length===1);await f.server({type:'cancel',id:'a',lane:a});
 assert.equal(f.socket.sent.filter((m:any)=>m.type==='ready').at(-1).ready,true);
 await f.server({type:'job',id:'b',lane:b,prompt:'b'});await until(()=>f.jobs.length===2);await f.server({type:'cancel',id:'a',lane:a});
 assert.equal(f.socket.sent.filter((m:any)=>m.type==='ready').at(-1).ready,false);assert.equal(f.jobs[1].tabId,21);
});

test('an agent tab preparation failure reports that no prompt was submitted',async()=>{
 const f=await boot();f.tabs.set(7,'https://example.com/changed');await f.server({type:'job',id:'unsent-agent',lane:'agent:'+'a'.repeat(64),prompt:'unsent'});
 await until(()=>f.socket.sent.some((m:any)=>m.type==='failure'&&m.id==='unsent-agent'));
 assert.equal(f.jobs.length,0);assert.equal(f.socket.sent.find((m:any)=>m.type==='failure'&&m.id==='unsent-agent').submitted,false);
});

test('reusing a ready auxiliary or agent frame never toggles its Copilot pane',async()=>{
 for(const lane of ['auxiliary','agent:'+'a'.repeat(64)]){const f=await boot();
 await f.server({type:'job',id:'first',lane,prompt:'first'});await until(()=>f.jobs.length===1);
 await f.emit({type:'result',id:'first',text:'reply'},20,4);await f.server({type:'ack',id:'first'});await f.emit({type:'frame-ready',ready:true},20,4);
 await f.server({type:'job',id:'second',lane,prompt:'second'});await until(()=>f.jobs.length===2);
 assert.deepEqual(f.openCalls,[20]);assert.equal(f.jobs[1].tabId,20);
 }
});

test('confirmed cancellation uses the original frame, persists before sending and removes evidence after ACK',async()=>{
 const f=await boot(false,false,true);await f.server({type:'job',id:'cancelled',lane:'main',cancelContinuation:1,prompt:'task'});
 assert.equal(f.storage['binding:cancelled'].tabId,7);
 const cancel={type:'cancel',id:'cancelled',lane:'main',cancelContinuation:1,nonce:'nonce',conversationId:'chat'};
 await f.server(cancel);await until(()=>f.receipts.length===1);assert.equal(f.receipts[0].receipt.outcome,'settled');assert.equal(f.receipts[0].receipt.conversationId,'chat');
 await f.server({type:'connected',activeId:'cancelled'});assert.ok(f.receipts.length>=2,'reconnect resends durable receipt');
 f.storage['cancel-proof:cancelled']={nonce:'nonce'};await f.server({type:'ack',id:'cancelled',cancelReceipt:true});assert.equal(f.storage['cancel:cancelled'],undefined);assert.equal(f.storage['cancel-proof:cancelled'],undefined);assert.equal(f.storage['binding:cancelled'],undefined);
});

test('an isolated main rebuild preserves the original workbook tab and moves only bridge routing',async()=>{
 const f=await boot(false,false,true);await f.server({type:'job',id:'recovery',lane:'main',isolatedRecovery:true,cancelContinuation:1,prompt:'complete native history'});await until(()=>f.jobs.length===1);
 assert.ok(f.tabs.has(7),'old page and its drafts must remain');assert.equal(f.jobs[0].tabId,20);assert.equal(f.storage.config.tabId,20);assert.equal(f.storage.config.recovery,undefined);
});

test('cancelling recovery during tab creation prevents later submission even after cancellation ACK',async()=>{
 const f=await boot(true,false,true);await f.server({type:'job',id:'recover-cancel',lane:'main',isolatedRecovery:true,cancelContinuation:1,prompt:'must not send'});
 await f.server({type:'cancel',id:'recover-cancel',lane:'main',cancelContinuation:1,nonce:'n',conversationId:'chat'});await until(()=>f.receipts.length===1);assert.equal(f.receipts[0].receipt.outcome,'not_sent');await f.server({type:'ack',id:'recover-cancel',cancelReceipt:true});await f.release();await until(()=>f.socket.sent.some((e:any)=>e.type==='failure'&&e.id==='recover-cancel'));assert.equal(f.jobs.length,0);assert.ok(f.tabs.has(7));
});


test('image permission is optional and an ungranted browser never receives an image job',async()=>{const f=await boot(false,false,true,true,false);assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'image-denied',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.match(f.socket.sent.find((v:any)=>v.type==='failure').error,/Enable optional image input/);assert.equal(f.socket.sent.find((v:any)=>v.type==='failure').submitted,false);assert.deepEqual(f.debuggerCalls,[]);});

test('trusted image Enter is bound to the active image job, tab and frame and is never repeated',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'image-one',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});const message={type:'image-submit',attempt:1,modelLabel:'Claude Opus 5.5',id:'image-one',nonce:'nonce',pageInstance:'page'};for(const [tabId,frameId,id] of [[7,3,'image-one'],[7,2,'other-job']]){const response=await f.request({...message,id},tabId as number,frameId as number);assert.match(response.error,/not owned/);}assert.deepEqual(f.debuggerCalls,[]);assert.equal((await f.request(message)).submitted,true);assert.deepEqual(f.debuggerCalls,[['attach',7,'1.3'],['focus',7,true],['keyDown',7],['keyUp',7],['focus',7,false],['detach',7]]);assert.match((await f.request(message)).error,/already attempted/);assert.equal(f.debuggerCalls.length,6);});

test('a changed image draft and a text-only job cannot request debugger input',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'image-proof',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});f.setImageProof(false);assert.match((await f.request({type:'image-submit',attempt:1,modelLabel:'Claude Opus 5.5',id:'image-proof',nonce:'nonce',pageInstance:'page'})).error,/draft or job changed/);assert.deepEqual(f.debuggerCalls,[]);await f.server({type:'cancel',id:'image-proof',cancelContinuation:1,lane:'main',nonce:'cancel',conversationId:'chat'});await f.server({type:'job',id:'text-only',lane:'main'});assert.match((await f.request({type:'image-submit',attempt:1,modelLabel:'Claude Opus 5.5',id:'text-only',nonce:'nonce',pageInstance:'page'})).error,/not owned/);assert.deepEqual(f.debuggerCalls,[]);});

test('a canceled image job cannot submit a delayed trusted keypress',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'late-image',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});await f.server({type:'cancel',id:'late-image',cancelContinuation:1,lane:'main',nonce:'cancel',conversationId:'chat'});assert.match((await f.request({type:'image-submit',attempt:1,modelLabel:'Claude Opus 5.5',id:'late-image',nonce:'nonce',pageInstance:'page'})).error,/not owned/);assert.deepEqual(f.debuggerCalls,[]);});


test('image summary fallback allows only its ordered model attempts and never repeats one attempt',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'image-summary',lane:'auxiliary',summary:true,modelLabel:'GPT-6.1 Sol',images:[{id:'image'}]});await until(()=>f.jobs.length===1);const msg={type:'image-submit',id:'image-summary',nonce:'primary',pageInstance:'page',attempt:1,modelLabel:'GPT-6.1 Sol'};assert.equal((await f.request(msg,20,4)).submitted,true);assert.match((await f.request({...msg,nonce:'different'},20,4)).error,/nonce changed/);assert.match((await f.request({...msg,attempt:2,modelLabel:'Claude Opus 5.5'},20,4)).error,/Invalid.*model/);assert.equal((await f.request({...msg,attempt:2,modelLabel:'GPT-6 Sol',nonce:'fallback'},20,4)).submitted,true);assert.match((await f.request({...msg,attempt:2,modelLabel:'GPT-6 Sol',nonce:'fallback'},20,4)).error,/already attempted/);assert.equal(f.debuggerCalls.filter(v=>v[0]==='keyDown').length,2);assert.ok(f.debuggerCalls.every(v=>v[1]===20));});


test('a summary model failing before its image send may skip to the fallback image attempt',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'early-summary-error',lane:'auxiliary',summary:true,modelLabel:'GPT-6.1 Sol',images:[{id:'image'}]});await until(()=>f.jobs.length===1);const message={type:'image-submit',id:'early-summary-error',nonce:'fallback-first-image',pageInstance:'page',attempt:2,modelLabel:'GPT-6 Sol'};assert.equal((await f.request(message,20,4)).submitted,true);assert.match((await f.request({...message,attempt:1,nonce:'late-primary',modelLabel:'GPT-6.1 Sol'},20,4)).error,/out of order/);assert.equal(f.debuggerCalls.filter(v=>v[0]==='keyDown').length,1);});


test('an unfocused page cannot authorize Enter even when its editor DOM is otherwise ready',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'page-focus-missing',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});f.setImageFocus(false);const response=await f.request({type:'image-submit',attempt:1,modelLabel:'Claude Opus 5.5',id:'page-focus-missing',nonce:'nonce',pageInstance:'page'});assert.match(response.error,/page, draft or job changed/);assert.deepEqual(f.debuggerCalls,[['attach',7,'1.3'],['focus',7,true],['focus',7,false],['detach',7]]);});


test('actual bundled content inspect and heartbeat negotiate the same focused-image version with the background',async()=>{const dom=new JSDOM('<button aria-label="Selected model: Claude Opus 5.5"></button><button aria-label="Switch mode, current: Chat,"></button><span contenteditable="true" role="combobox" aria-label="Chat input"></span>',{url:'https://fa000000124.officeapps.live.com/taskpane.html',runScripts:'outside-only'});try{dom.window.HTMLElement.prototype.getClientRects=()=>({length:1}) as any;const context=dom.getInternalVMContext(),reports:any[]=[];let listener:any,heartbeat:any;Object.defineProperty(context,'crypto',{value:webcrypto,configurable:true});Object.assign(context,{TextEncoder,MessageChannel,setInterval:(fn:any)=>{heartbeat=fn;return 1;},clearInterval:()=>{},chrome:{runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}},sendMessage:async(value:any)=>{reports.push(value);}},storage:{local:{get:async()=>({}),set:async()=>{}}}}});vm.runInContext(await readFile('dist/extension/content.js','utf8'),context);const inspection=await new Promise<any>(r=>listener({type:'inspect'},{},r));heartbeat();await flush();assert.equal(inspection.trustedImageInput,10);assert.ok(reports.filter(v=>v.type==='frame-ready').every(v=>v.trustedImageInput===inspection.trustedImageInput));const f=await boot(false,false,true,true,true,inspection);assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,1);await f.server({type:'job',id:'actual-version-image',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,1);assert.ok(!f.socket.sent.some((v:any)=>v.type==='failure'));}finally{dom.window.close();}});


for(const reason of ['cancel','draft'])test('actual combined CDP Enter acknowledgement cannot add another submitting gesture after '+reason,async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'char-race',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});f.onRawDown(async()=>{if(reason==='cancel')await f.server({type:'cancel',id:'char-race',cancelContinuation:1,lane:'main',nonce:'cancel',conversationId:'chat'});else f.setImageProof(false);});const response=await f.request({type:'image-submit',id:'char-race',attempt:1,modelLabel:'Claude Opus 5.5',nonce:'nonce',pageInstance:'page'});assert.ok(response.error);assert.ok(f.debuggerCalls.some(v=>v[0]==='keyDown'));assert.ok(!f.debuggerCalls.some(v=>v[0]==='char'));assert.deepEqual(f.debuggerCalls.slice(-3),[['keyUp',7],['focus',7,false],['detach',7]]);});
test('the background never adds a character after a combined Enter submitted the verified image message',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'raw-sent',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});f.onRawDown(async()=>{f.setImageSubmitted(true);});assert.equal((await f.request({type:'image-submit',id:'raw-sent',attempt:1,modelLabel:'Claude Opus 5.5',nonce:'nonce',pageInstance:'page'})).submitted,true);assert.ok(!f.debuggerCalls.some(v=>v[0]==='char'));assert.equal(f.debuggerCalls.filter(v=>v[0]==='keyDown').length,1);});

test('an older editor-target image script cannot negotiate or dispatch native Send activation',async()=>{const f=await boot(false,false,true,true,true,{ready:true,imageInput:1,trustedImageInput:3,conversationControl:true,conversationResumability:'active-chat-only'});assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'old-image-content',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.deepEqual(f.debuggerCalls,[]);assert.match(f.socket.sent.find((v:any)=>v.type==='failure').error,/Refresh this workbook/);});

test('an older split-button image script cannot negotiate or dispatch native Send activation',async()=>{const f=await boot(false,false,true,true,true,{ready:true,imageInput:1,trustedImageInput:4,conversationControl:true,conversationResumability:'active-chat-only'});assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'old-image-content',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.deepEqual(f.debuggerCalls,[]);assert.match(f.socket.sent.find((v:any)=>v.type==='failure').error,/Refresh this workbook/);});

test('an older short-lived focus image script cannot negotiate or dispatch native Send activation',async()=>{const f=await boot(false,false,true,true,true,{ready:true,imageInput:1,trustedImageInput:5,conversationControl:true,conversationResumability:'active-chat-only'});assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'old-image-content',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.deepEqual(f.debuggerCalls,[]);assert.match(f.socket.sent.find((v:any)=>v.type==='failure').error,/Refresh this workbook/);});

test('ready without an owned-message acknowledgement cannot release an image as submitted',async()=>{const f=await boot(false,false,true,true);await f.server({type:'job',id:'missing-owned-ack',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});f.setImageSubmitted(false);const response=await f.request({type:'image-submit',id:'missing-owned-ack',attempt:1,modelLabel:'Claude Opus 5.5',nonce:'nonce',pageInstance:'page'});assert.ok(response.error);assert.deepEqual(f.debuggerCalls.slice(-2),[['focus',7,false],['detach',7]]);assert.equal(f.debuggerCalls.filter(v=>v[0]==='keyDown').length,1);});

test('a stalled or late image acknowledgement releases the connection without another input',async()=>{const f=await boot(false,false,true,true,true,undefined,true);await f.server({type:'job',id:'late-owned-ack',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});let release!:()=>void;f.onAck(()=>new Promise<void>(r=>{release=r;}));const response=await f.request({type:'image-submit',id:'late-owned-ack',attempt:1,modelLabel:'Claude Opus 5.5',nonce:'nonce',pageInstance:'page'});assert.match(response.error,/acknowledgement channel timed out/);assert.deepEqual(f.debuggerCalls.slice(-2),[['focus',7,false],['detach',7]]);const count=f.debuggerCalls.length;release();await flush();assert.equal(f.debuggerCalls.length,count);});

test('an older preview-only readiness image script cannot negotiate or dispatch native Send activation',async()=>{const f=await boot(false,false,true,true,true,{ready:true,imageInput:1,trustedImageInput:6,conversationControl:true,conversationResumability:'active-chat-only'});assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'old-image-content',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.deepEqual(f.debuggerCalls,[]);assert.match(f.socket.sent.find((v:any)=>v.type==='failure').error,/Refresh this workbook/);});

test('an older upload-readiness image script cannot negotiate or dispatch native Send activation',async()=>{const f=await boot(false,false,true,true,true,{ready:true,imageInput:1,trustedImageInput:7,conversationControl:true,conversationResumability:'active-chat-only'});assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'old-image-content',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.deepEqual(f.debuggerCalls,[]);assert.match(f.socket.sent.find((v:any)=>v.type==='failure').error,/Refresh this workbook/);});


test('an older image script without inline reference readiness cannot dispatch native activation',async()=>{const f=await boot(false,false,true,true,true,{ready:true,imageInput:1,trustedImageInput:8,conversationControl:true,conversationResumability:'active-chat-only'});assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'old-image-content',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.deepEqual(f.debuggerCalls,[]);assert.match(f.socket.sent.find((v:any)=>v.type==='failure').error,/Refresh this workbook/);});

test('a root-focus-only image frame cannot mix with iframe-focus delivery accounting',async()=>{const f=await boot(false,false,true,true,true,{ready:true,imageInput:1,trustedImageInput:9,conversationControl:true,conversationResumability:'active-chat-only'});assert.equal(f.socket.sent.find((v:any)=>v.type==='hello').imageInput,0);await f.server({type:'job',id:'old-root-focus',lane:'main',modelLabel:'Claude Opus 5.5',images:[{id:'image'}]});assert.equal(f.jobs.length,0);assert.deepEqual(f.debuggerCalls,[]);const failure=f.socket.sent.find((v:any)=>v.type==='failure');assert.equal(failure.submitted,false);assert.match(failure.error,/Refresh this workbook/);});
