import {createHash} from 'node:crypto';
import {BridgeError,type MessagesRequest,type ObjectValue} from './index.js';

export interface BrowserImage {id:string;name:string;mediaType:string;data:string;bytes:number}
export const MAX_IMAGE_BYTES=5_000_000;
export const MAX_IMAGE_TOTAL_BYTES=10_000_000;
export const MAX_IMAGES_PER_TURN=5;
const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
export function validateImage(block:ObjectValue){
 const source=block.source;
 if(!source||source.type!=='base64'||!extensions[source.media_type]||typeof source.data!=='string')throw new BridgeError('Images require base64 PNG, JPEG, GIF or WebP data; remote image URLs are not fetched.');
 const data=source.data;
 if(!data.length||data.length%4!==0||data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw new BridgeError('Invalid or oversized base64 image (maximum 5 MB per image).',413);
 const bytes=Buffer.from(data,'base64');if(bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==data)throw new BridgeError('Invalid or oversized base64 image.',413);
 const type=source.media_type;
 const valid=type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:type==='image/gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')):bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
 if(!valid)throw new BridgeError('Image bytes do not match their declared media type.');
 return{bytes:bytes.length,mediaType:type,data};
}

// Native history is preserved as stable references. Pixel data travels separately
// as real browser attachments, never as base64 pasted into a text prompt.
export function projectImages(request:MessagesRequest){
 const payloads=new Map<string,BrowserImage>();let total=0;
 const project=(content:any):any=>typeof content==='string'?content:content.map((block:ObjectValue)=>{
  if(block.type==='image'){
   const image=validateImage(block),id=createHash('sha256').update(image.mediaType+'\0').update(Buffer.from(image.data,'base64')).digest('hex');
   const name='bridge-image-'+id+'.'+extensions[image.mediaType];
   if(!payloads.has(id)){total+=image.bytes;if(total>MAX_IMAGE_TOTAL_BYTES)throw new BridgeError('Native image history exceeds the bridge image budget of 10 MB. Compact or reduce the image history; nothing was truncated.',413);payloads.set(id,{id,name,...image});}
   return{type:'text',text:'[Bridge image attachment: '+name+'] This reference replaces a native image block, not a text-only Read result. The pixels are provided as a real attachment in this Copilot conversation. Match the filename and use Copilot\'s built-in attachment viewing/vision capability as needed, subject to the user\'s restrictions; do not request another local Read, OCR or external service just to view this attachment. If its pixels are unavailable, say you cannot see them; never invent visual contents.'};
  }
  return block.type==='tool_result'&&Array.isArray(block.content)?{...block,content:project(block.content)}:block;
 });
 return{request:{...request,messages:request.messages.map(message=>({...message,content:project(message.content)}))},payloads};
}
export function imagesForMessages(messages:ObjectValue[],payloads:Map<string,BrowserImage>):BrowserImage[]{
 const selected=new Map<string,BrowserImage>();
 const walk=(content:any)=>{if(typeof content==='string')return;for(const block of content){if(block.type==='text')for(const match of block.text.matchAll(/\[Bridge image attachment: bridge-image-([a-f0-9]{64})\./g)){const image=payloads.get(match[1]);if(image)selected.set(image.id,image);}else if(block.type==='tool_result'&&Array.isArray(block.content))walk(block.content);}};
 for(const message of messages)walk(message.content);
 if(selected.size>MAX_IMAGES_PER_TURN)throw new BridgeError('This browser turn needs more than five image attachments. Compact or reduce the image history; nothing was truncated.',413);
 return[...selected.values()];
}
