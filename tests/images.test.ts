import test from 'node:test';import assert from 'node:assert/strict';
import {parseRequest,buildPrompt} from '../packages/protocol/index.js';
import {projectImages,imagesForMessages} from '../packages/protocol/images.js';
import {planContext,renderContextPrompt,resumeContext,estimateTokens} from '../packages/protocol/context.js';
const pixels='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';
const image={type:'image',source:{type:'base64',media_type:'image/png',data:pixels}};
const base={model:'copilot-opus-5.5',max_tokens:1000,tools:[{name:'Read',input_schema:{type:'object'}}],messages:[{role:'user',content:'Inspect the image'},{role:'assistant',content:[{type:'tool_use',id:'read-image',name:'Read',input:{file_path:'fixture.png'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'read-image',content:[{type:'text',text:'Original image dimensions'},image]}]}]};
test('native nested Read images become exact pixel attachments and source-free stable history references',()=>{
 const parsed=parseRequest(base),{request,payloads}=projectImages(parsed),plan=planContext(request),images=imagesForMessages(plan.messages,payloads);assert.equal(images.length,1);assert.equal(images[0].data,pixels);assert.equal(images[0].mediaType,'image/png');assert.match(images[0].name,/^bridge-image-[a-f0-9]{64}\.png$/);assert.match(buildPrompt(request),/Bridge image attachment/);assert.ok(!buildPrompt(request).includes(pixels));assert.deepEqual((base.messages[2] as any).content[0].content?.[1],image);
});
test('ordinary feedback after an image continues with a delta and does not upload unchanged pixels again',()=>{
 const first=projectImages(parseRequest(base));const prior=planContext(first.request);const next=projectImages(parseRequest({...base,messages:[...base.messages,{role:'assistant',content:'Observed the actual attachment'},{role:'user',content:'Continue with the same picture'}]}));const plan=planContext(next.request,prior.snapshot);assert.equal(plan.kind,'delta');assert.equal(imagesForMessages(plan.messages,next.payloads).length,0);assert.ok(!renderContextPrompt(next.request,plan,1).includes(pixels));
});
test('new direct user images and resumed replacement tails preserve their attachment identity',()=>{
 const raw={...base,messages:[{role:'user',content:[image,image,{type:'text',text:'Read the marker'}]}]},first=projectImages(parseRequest(raw)),prior=planContext(first.request);assert.equal(imagesForMessages(prior.messages,first.payloads).length,1);const next=projectImages(parseRequest({...raw,messages:[{role:'user',content:[image,image,{type:'text',text:'Read the marker'},{type:'text',text:'Continue after interruption'}]}]})),resumed=resumeContext(next.request,prior.snapshot,'cancelled');assert.equal(imagesForMessages(resumed.messages,next.payloads)[0].id,[...first.payloads.keys()][0]);
});
test('remote sources, malformed data, wrong MIME and assistant-side images fail before any browser operation',()=>{
 for(const invalid of [{type:'image',source:{type:'url',url:'http://127.0.0.1/private'}},{type:'image',source:{type:'base64',media_type:'image/png',data:'%%%%'}},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:pixels}}])assert.throws(()=>parseRequest({...base,messages:[{role:'user',content:[invalid]}]}));assert.throws(()=>parseRequest({...base,messages:[{role:'assistant',content:[image]}]}));
});

test('image estimates do not count base64 strings as enormous text prompts',()=>{
 const larger={...image,source:{...image.source,data:pixels+'A'.repeat(400000)}};const estimated=estimateTokens({messages:[{role:'user',content:[larger]}]});assert.ok(estimated>=2048&&estimated<3000);
});
