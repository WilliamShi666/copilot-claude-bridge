import test from 'node:test';
import assert from 'node:assert/strict';
import {promptLimit,compactWindow} from '../packages/cli/limits.js';
import {buildPrompt} from '../packages/protocol/index.js';
test('an explicit larger UI limit preserves a full large client tool schema',()=>{
 const description='full native tool description '.repeat(10500);
 const request={model:'copilot-opus-5.5',max_tokens:1000,messages:[{role:'user',content:'WSL task'}],tools:[{name:'Read',description,input_schema:{type:'object',properties:{path:{type:'string'}},required:['path']}}]};
 assert.throws(()=>buildPrompt(request,promptLimit()),/Nothing was truncated/);
 const prompt=buildPrompt(request,promptLimit('400000'));
 assert.ok(prompt.includes(JSON.stringify(description)));assert.ok(prompt.includes('"required":["path"]'));assert.ok(prompt.length>300000&&prompt.length<400000);
});
test('custom UI limits remain bounded and reject invalid values',()=>{
 assert.equal(promptLimit(),180000);assert.equal(promptLimit('400000'),400000);
 assert.equal(promptLimit('2000000'),2000000);
 for(const value of ['0','19999','2000001','NaN','3.5','Infinity'])assert.throws(()=>promptLimit(value),/20000.*2000000/);
});
test('token compact windows accept explicit token units and reject ambiguous invalid input',()=>{
 assert.equal(compactWindow(),533000);assert.equal(compactWindow('600k'),600000);assert.equal(compactWindow('1M'),1000000);
 for(const value of ['65','99999','1000001','500k garbage','500.5','0','NaN'])assert.throws(()=>compactWindow(value),/100000.*1000000/);
});
test('large summary transport preserves the beginning and end without truncation',()=>{
 const text='BEGIN_RANDOM_FACT\n'+'ordinary archive material '.repeat(56000)+'\nEND_RANDOM_FACT';
 const request={model:'copilot-opus-5.5',max_tokens:32000,messages:[{role:'user',content:text}]};
 assert.throws(()=>buildPrompt(request,400000),/Nothing was truncated/);
 const rendered=buildPrompt(request,promptLimit('2000000'));
 assert.ok(rendered.includes(JSON.stringify(text)));assert.ok(rendered.length>1000000);
});
