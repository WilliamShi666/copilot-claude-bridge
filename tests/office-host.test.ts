import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {webcrypto,createHash} from 'node:crypto';import {JSDOM} from 'jsdom';
test('Office host reports only a document hash and opens Copilot through its own verified frame',async()=>{
 const documentUrl='https://my.microsoftpersonalcontent.com/personal/test/_vti_bin/wopi.ashx/files/approved?access_token=SECRET_QUERY';
 const dom=new JSDOM('<button aria-label="与 Copilot 聊天"></button>',{url:'https://excel.officeapps.live.com/x/?wopisrc='+encodeURIComponent(documentUrl)});let listener:any;const sent:any[]=[];let clicks=0;
 dom.window.document.querySelector('button')!.addEventListener('click',()=>clicks++);
 const chrome={runtime:{id:'owned-extension',sendMessage:async(value:any)=>{sent.push(value);},onMessage:{addListener:(fn:any)=>{listener=fn;}}}};
 vm.runInNewContext(await readFile('dist/extension/office-host.js','utf8'),{chrome,location:dom.window.location,document:dom.window.document,URL,TextEncoder,Uint8Array,crypto:webcrypto,setInterval:()=>1,clearInterval:()=>{},addEventListener:()=>{}});
 for(let i=0;i<20&&!sent.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(sent[0].documentKey,createHash('sha256').update('https://my.microsoftpersonalcontent.com/personal/test/_vti_bin/wopi.ashx/files/approved').digest('hex'));assert.ok(!JSON.stringify(sent).includes('SECRET_QUERY'));
 listener({type:'office-open-copilot'},{id:'unrelated-extension'},()=>{});assert.equal(clicks,0);
 listener({type:'office-open-copilot'},{id:'owned-extension'},()=>{});assert.equal(clicks,1);
 const frame=dom.window.document.createElement('iframe');frame.src='https://fa000000124.officeapps.live.com/taskpane.html';dom.window.document.body.append(frame);
 // Excel can preload an invisible Copilot iframe before its pane is opened.
 listener({type:'office-open-copilot'},{id:'owned-extension'},()=>{});assert.equal(clicks,2);
 frame.getClientRects=()=>[{width:300,height:500}] as unknown as DOMRectList;
 frame.getBoundingClientRect=()=>({width:300,height:500}) as DOMRect;
 listener({type:'office-open-copilot'},{id:'owned-extension'},()=>{});assert.equal(clicks,2);dom.window.close();
});
