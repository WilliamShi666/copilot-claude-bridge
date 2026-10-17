import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {parseRequest,buildPrompt} from '../packages/protocol/index.js';
import {planContext,estimateTokens,requestIdentity} from '../packages/protocol/context.js';
import {startGateway} from '../packages/gateway/index.js';

const thinking={type:'thinking',thinking:'SYNTHETIC_REASONING_NOT_FOR_TRANSFER',signature:'SYNTHETIC_SIGNATURE_NOT_FOR_TRANSFER'};
const redacted={type:'redacted_thinking',data:'SYNTHETIC_REDACTED_NOT_FOR_TRANSFER'};
const request={model:'copilot-opus-5.5',max_tokens:1024,system:'Keep all actual client instructions.',tools:[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}}],messages:[
 {role:'user',content:'Continue the existing task.'},
 {role:'assistant',content:[thinking]},
 {role:'assistant',content:[redacted,{type:'text',text:'Read the actual file.'},{type:'tool_use',id:'legacy-read',name:'Read',input:{file_path:'note.md'}}]},
 {role:'user',content:[{type:'tool_result',tool_use_id:'legacy-read',content:'Actual disk result'},{type:'text',text:'Now continue.'}]}
]};

test('forked history projects opaque reasoning out while preserving actual tools/results and the source request',()=>{
 const before=structuredClone(request),parsed=parseRequest(request),wire=buildPrompt(parsed);
 assert.deepEqual(request,before);
 assert.equal(parsed.messages.length,3);
 assert.deepEqual(parsed.messages[1].content,request.messages[2].content.slice(1));
 assert.deepEqual(parsed.messages[2],request.messages[3]);
 assert.equal(parsed.system,request.system);assert.deepEqual(parsed.tools,request.tools);
 for(const secret of [thinking.thinking,thinking.signature,redacted.data])assert.ok(!wire.includes(secret));
 assert.ok(wire.includes('Actual disk result'));
});

test('reasoning-only history changes do not force bootstrap or change request identity',()=>{
 const first=parseRequest(request),previous=planContext(first);
 const changed=structuredClone(request);(changed.messages[1].content as any)[0]={...thinking,thinking:'CHANGED_OPAQUE_SUMMARY',signature:''};
 const same=parseRequest(changed);assert.equal(requestIdentity(same),requestIdentity(first));
 const plan=planContext(same,previous.snapshot);assert.equal(plan.kind,'delta');assert.equal(plan.messages.length,0);
 const appended=parseRequest({...changed,messages:[...changed.messages,{role:'assistant',content:[thinking,{type:'text',text:'Done.'}]},{role:'user',content:'Read once more.'}]});
 const delta=planContext(appended,previous.snapshot);assert.equal(delta.kind,'delta');assert.equal(delta.messages.length,2);
 assert.equal((delta.messages[0].content as any[]).length,1);
});

test('reasoning compatibility keeps real tool validation and rejects reasoning in user/system/tool-result content',()=>{
 for(const role of ['user','system'])assert.throws(()=>parseRequest({...request,messages:[{role,content:[thinking]}]}),/Unsupported content block/);
 assert.throws(()=>parseRequest({...request,system:[thinking]}),/Unsupported content block/);
 assert.throws(()=>parseRequest({...request,messages:[request.messages[0],request.messages[2],{role:'user',content:[{type:'tool_result',tool_use_id:'legacy-read',content:[thinking]}]}]}),/Unsupported content block/);
 assert.throws(()=>parseRequest({...request,messages:[request.messages[0],{role:'assistant',content:[thinking]},{role:'user',content:[{type:'tool_result',tool_use_id:'missing',content:'x'}]}]}),/Unmatched/);
 for(const block of [{type:'thinking',thinking:42},{type:'thinking',thinking:'x',signature:42},{type:'redacted_thinking',data:42}])assert.throws(()=>parseRequest({...request,messages:[request.messages[0],{role:'assistant',content:[block]}]}),/Invalid historical/);
 assert.throws(()=>parseRequest({...request,messages:[{role:'assistant',content:[thinking]}]}),/No transferable/);
 const literal='A quoted example: {"type":"thinking","thinking":"keep this text"}';
 assert.ok(buildPrompt(parseRequest({...request,messages:[{role:'user',content:literal}]})).includes('keep this text'));
});

test('count_tokens and browser dispatch use the same projection for mixed-provider history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m365-reasoning-')),gateway=await startGateway({stateDir:dir,port:0,timeoutMs:5000});let ws:WebSocket|undefined;
 try{
  const headers={'x-api-key':gateway.clientKey},origin='chrome-extension://'+'f'.repeat(32);
  const count=await fetch(gateway.url+'/v1/messages/count_tokens',{method:'POST',headers,body:JSON.stringify(request)});
  assert.equal(count.status,200);assert.equal((await count.json() as any).input_tokens,estimateTokens(parseRequest({...request,max_tokens:1})));
  const {token}=await(await fetch(gateway.url+'/bridge/pair',{method:'POST',headers:{Origin:origin},body:JSON.stringify({code:gateway.pairCode})})).json() as any;
  ws=new WebSocket(gateway.url.replace('http:','ws:')+'/bridge/socket',{origin});await new Promise<void>(r=>ws!.once('open',r));
  let delivered='';ws.on('message',data=>{const value=JSON.parse(String(data));if(value.type!=='job')return;delivered=value.prompt;ws!.send(JSON.stringify({type:'result',id:value.id,text:'{"content":[{"type":"text","text":"History continued"}]}'}));});
  ws.send(JSON.stringify({type:'hello',token,workerId:'reasoning-history-test',ready:true}));await new Promise<void>(r=>ws!.once('message',()=>r()));
  const response=await fetch(gateway.url+'/v1/messages',{method:'POST',headers,body:JSON.stringify(request)});
  assert.equal(response.status,200);assert.equal((await response.json() as any).content[0].text,'History continued');
  assert.ok(delivered.includes('legacy-read'));assert.ok(delivered.includes('Actual disk result'));
  for(const secret of [thinking.thinking,thinking.signature,redacted.data])assert.ok(!delivered.includes(secret));
 }finally{ws?.terminate();await gateway.close();await rm(dir,{recursive:true,force:true});}
});
