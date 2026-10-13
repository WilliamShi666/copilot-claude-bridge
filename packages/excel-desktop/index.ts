import WebSocket from 'ws';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ExcelClient,type Snapshot} from './client.js';
import {messages,cursor,chatMode,modelLabel,assertIdle,busy} from './transcript.js';
import type {ConversationCommand} from '../protocol/conversation.js';
interface Job {id:string;modelLabel:string;prompt:string;conversation:ConversationCommand}
export async function performJob(client:ExcelClient,job:Job,signal:AbortSignal){
  if(!job.conversation)throw new Error('Excel desktop accepts tracked advisor jobs only');
  let snapshot=await client.snapshot();assertIdle(snapshot);
  const wait=async(check:(s:Snapshot)=>boolean,timeout:number)=>{const deadline=Date.now()+timeout;while(true){signal.throwIfAborted();const s=await client.snapshot();if(check(s))return s;if(Date.now()>deadline)throw new Error('Excel UI did not reach the required state; not retried');await delay(250,undefined,{signal});}};
  if(job.conversation.mode==='continue'){
    if(!chatMode(snapshot)||modelLabel(snapshot)!==job.modelLabel||cursor(snapshot)!==job.conversation.expectedCursor)throw new Error('Active Excel chat/model changed; continuation was not sent');
  }else{
    await client.request('new-chat');snapshot=await wait(s=>messages(s).length===0,10000);
    await delay(500,undefined,{signal});if(messages(await client.snapshot()).length)throw new Error('Excel new chat did not clear the previous messages');
    await client.request('model',{label:job.modelLabel});await client.request('chat-only');snapshot=await wait(s=>chatMode(s)&&modelLabel(s)===job.modelLabel,10000);
  }
  assertIdle(snapshot);const count=messages(snapshot).length;signal.throwIfAborted();
  if(job.conversation.mode==='continue'&&cursor(await client.snapshot())!==job.conversation.expectedCursor)throw new Error('Excel chat changed before input');
  await client.request('send',{text:job.prompt});
  const expected=job.prompt.replace(/\r\n/g,'\n').trim();let last='',stable=0;const deadline=Date.now()+220000;
  while(Date.now()<deadline){
    signal.throwIfAborted();snapshot=await client.snapshot();if(!chatMode(snapshot)||modelLabel(snapshot)!==job.modelLabel)throw new Error('Excel chat mode/model changed during generation');
    const list=messages(snapshot),pair=list.slice(count);
    if(pair.length>2||pair[0]&&pair[0].role!=='user'||pair[0]&&pair[0].text!==expected)throw new Error('Excel chat contains unexpected messages; response rejected');
    const reply=pair[1];
    if(reply?.role==='assistant'&&reply.complete&&!busy(snapshot)&&reply.text){
      const next=cursor(snapshot);if(next===last){if(Date.now()-stable>=1000)return {text:reply.text,conversation:{id:job.conversation.id,title:job.conversation.title,cursor:next,resumability:'active-chat-only' as const}};}else{last=next;stable=Date.now();}
    }else{last='';stable=0;}await delay(500,undefined,{signal});
  }throw new Error('Excel reply timed out; message was not resubmitted');
}
export async function startDesktopWorker(options:{url:string;token:string;window:number}){
  const client=new ExcelClient(options.window),workerId='excel-'+createHash('sha256').update(String(options.window)).digest('hex');
  try{const initial=await client.snapshot();assertIdle(initial);await client.request('chat-only');}catch(error){client.close();throw error;}
  let socket:WebSocket|undefined,controller:AbortController|undefined,closed=false,checking=false,reconnect:NodeJS.Timeout|undefined;
  const send=(value:unknown)=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(value));};
  const readiness=async()=>{if(checking||controller||closed)return;checking=true;try{const s=await client.snapshot();assertIdle(s);send({type:'ready',ready:chatMode(s),conversationControl:true,conversationResumability:'active-chat-only'});}catch{send({type:'ready',ready:false,conversationControl:true,conversationResumability:'active-chat-only'});}finally{checking=false;}};
  const connect=()=>{
    if(closed)return;const ws=new WebSocket(options.url.replace('http:','ws:')+'/bridge/desktop/socket');socket=ws;
    ws.on('open',()=>{send({type:'hello',token:options.token,workerId,ready:false,conversationControl:true,conversationResumability:'active-chat-only'});void readiness();});
    ws.on('message',async data=>{
      const value=JSON.parse(String(data));
      if(value.type==='recover'){send({type:'failure',id:value.id,error:'Desktop worker reconnected after uncertain dispatch; no request was replayed'});return;}
      if(value.type==='cancel'){if(controller){controller.abort();client.close();}return;}
      if(value.type!=='job')return;
      if(controller){send({type:'failure',id:value.id,error:'Desktop worker already busy'});return;}
      controller=new AbortController();try{const result=await performJob(client,value,controller.signal);send({type:'result',id:value.id,...result});}
      catch(e){send({type:'failure',id:value.id,error:e instanceof Error?e.message:'Desktop transport failed'});}
      finally{controller=undefined;await readiness();}
    });
    ws.on('close',()=>{controller?.abort();if(!closed)reconnect=setTimeout(connect,3000);});ws.on('error',()=>{});
  };
  connect();const timer=setInterval(()=>void readiness(),3000);
  return {close:()=>{closed=true;clearInterval(timer);clearTimeout(reconnect);controller?.abort();socket?.terminate();client.close();}};
}
