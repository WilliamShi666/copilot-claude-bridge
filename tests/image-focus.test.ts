import test from 'node:test';import assert from 'node:assert/strict';
import {ImageFocus,type FocusTarget} from '../packages/chrome-extension/image-focus.js';
import {ImageInput,ImageInputFailure} from '../packages/chrome-extension/image-input.js';
function fixture(){
 let listener:((s:FocusTarget,m:string,p:any)=>void)|undefined,removed=0;const calls:any[]=[];let action=async(_t:FocusTarget,_m:string,_p:any)=>{};
 const protocol={command:async(t:FocusTarget,m:string,p:any)=>{calls.push([t,m,p]);await action(t,m,p);},listen:(fn:typeof listener)=>{listener=fn;return()=>{removed++;listener=undefined;};}};
 return{scope:new ImageFocus(protocol,7),calls,removed:()=>removed,onCommand:(fn:typeof action)=>{action=fn;},event:(source:FocusTarget,method:string,params:any)=>listener?.(source,method,params)};
}
const attached=(sessionId:string,url:string,type='iframe')=>({sessionId,targetInfo:{type,url}});
const excel='https://excel.officeapps.live.com/x/_layouts/xlviewerinternal.aspx',copilot='https://fa000000124.officeapps.live.com/taskpane.html';
test('root -> Excel -> Copilot OOPIF targets all receive scoped focus before one Enter',async()=>{
 const f=fixture();let focused=false,enters=0;
 f.onCommand(async(t,m,p)=>{
  if(m==='Target.setAutoAttach'&&p.autoAttach){if(!t.sessionId)f.event(t,'Target.attachedToTarget',attached('excel',excel));else if(t.sessionId==='excel')f.event(t,'Target.attachedToTarget',attached('copilot',copilot));}
  if(t.sessionId==='copilot'&&m==='Emulation.setFocusEmulationEnabled')focused=p.enabled;
 });
 const input=new ImageInput({attach:async()=>{},focus:async(_id,on)=>on?f.scope.enable(200):f.scope.disable(),enter:async(_id,type)=>{if(type==='keyDown'){assert.equal(focused,true);enters++;}},detach:async()=>{}});
 await input.submit('image',7,async(requireFocus,after)=>{if(requireFocus&&!after)assert.equal(focused,true);});
 assert.equal(enters,1);assert.equal(focused,false);assert.equal(f.removed(),1);
 assert.deepEqual(f.calls.filter(c=>c[1]==='Emulation.setFocusEmulationEnabled'&&c[2].enabled).map(c=>c[0].sessionId??'root'),['root','excel','copilot']);
 assert.ok(f.calls.every(c=>c[0].tabId===7&&['Emulation.setFocusEmulationEnabled','Target.setAutoAttach'].includes(c[1])));
});
test('foreign tabs, unrelated parents and non-Office targets never gain focus or recursive attachment',async()=>{
 const f=fixture();f.onCommand(async(t,m,p)=>{if(m==='Target.setAutoAttach'&&p.autoAttach&&!t.sessionId){f.event({tabId:8},'Target.attachedToTarget',attached('foreign',copilot));f.event({tabId:7,sessionId:'unowned'},'Target.attachedToTarget',attached('unowned',copilot));for(const [id,url,type]of [['other','https://example.com/','iframe'],['spoof','https://fa000000124.officeapps.live.com.evil.invalid/','iframe'],['worker',copilot,'worker']])f.event(t,'Target.attachedToTarget',attached(id,url,type));f.event(t,'Target.attachedToTarget',attached('copilot',copilot));}});
 await f.scope.enable(100);await f.scope.disable();assert.equal(f.calls.filter(c=>c[1]==='Target.detachFromTarget').length,3);assert.ok(!f.calls.some(c=>['foreign','unowned','other','spoof','worker'].includes(c[0].sessionId)));assert.ok(f.calls.every(c=>c[0].tabId===7));
});
test('child focus failure is proven pre-input and releases root/child focus without Enter',async()=>{
 const f=fixture();let enters=0;f.onCommand(async(t,m,p)=>{if(m==='Target.setAutoAttach'&&p.autoAttach&&!t.sessionId)f.event(t,'Target.attachedToTarget',attached('copilot',copilot));if(t.sessionId==='copilot'&&m==='Emulation.setFocusEmulationEnabled'&&p.enabled)throw Error('child focus failed');});
 const input=new ImageInput({attach:async()=>{},focus:async(_id,on)=>on?f.scope.enable(100):f.scope.disable(),enter:async()=>{enters++;},detach:async()=>{}});
 await assert.rejects(input.submit('image',7,async()=>{}),(e:any)=>e instanceof ImageInputFailure&&e.inputAttempted===false);assert.equal(enters,0);assert.ok(f.calls.some(c=>!c[0].sessionId&&c[1]==='Emulation.setFocusEmulationEnabled'&&!c[2].enabled));assert.equal(f.removed(),1);
});
test('late events after release and duplicate target events do not recreate focused sessions',async()=>{
 const f=fixture();f.onCommand(async(t,m,p)=>{if(m==='Target.setAutoAttach'&&p.autoAttach&&!t.sessionId){f.event(t,'Target.attachedToTarget',attached('copilot',copilot));f.event(t,'Target.attachedToTarget',attached('copilot',copilot));}});await f.scope.enable(100);assert.equal(f.calls.filter(c=>c[0].sessionId==='copilot'&&c[1]==='Emulation.setFocusEmulationEnabled'&&c[2].enabled).length,1);await f.scope.disable();const count=f.calls.length;f.event({tabId:7},'Target.attachedToTarget',attached('late',copilot));assert.equal(f.calls.length,count);
});
test('a same-process page can rely on root emulation without inventing a child session',async()=>{const f=fixture();await f.scope.enable(10);await f.scope.disable();assert.ok(f.calls.every(c=>!c[0].sessionId));assert.equal(f.removed(),1);});

for(const phase of ['verify','attach','focus','keypress','ack'] as const)test('image failure delivery flag matches the actual input boundary: '+phase,async()=>{
 let entered=0;const fail=()=>{throw Error(phase);};const input=new ImageInput({attach:async()=>{if(phase==='attach')fail();},focus:async(_id,on)=>{if(on&&phase==='focus')fail();},enter:async(_id,type)=>{if(type==='keyDown'){entered++;if(phase==='keypress')fail();}},detach:async()=>{}});
 await assert.rejects(input.submit('image',7,async(_focus,after)=>{if(phase==='verify'||phase==='ack'&&after)fail();}),(e:any)=>e instanceof ImageInputFailure&&e.inputAttempted===(entered>0));
 assert.equal(entered,phase==='keypress'||phase==='ack'?1:0);
});
