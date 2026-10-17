export interface ContextPacket {prompt:string;ack?:string}
export const UI_PACKET_CHARS=350000;
export const AUTOMATIC_RETRY_LIMIT=5;
export class ContextAckFormatError extends Error {constructor(){super('Copilot context transfer acknowledgment is malformed');}}
export function validateContextAck(reply:string,ack:string):void{
 const clean=reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1');let value:any;
 try{value=JSON.parse(clean);}catch{throw new ContextAckFormatError();}
 if(Object.keys(value??{}).join(',')!=='content'||!Array.isArray(value.content)||value.content.length!==1||value.content[0]?.type!=='text'||value.content[0]?.text!==ack||Object.keys(value.content[0]).sort().join(',')!=='text,type')throw new Error('Copilot did not acknowledge the exact context fragment; intermediate tools were not forwarded');
}
export function repairableContextAck(reply:string,ack:string):boolean{
 if(!ack.startsWith('BRIDGE_CONTEXT_ACK_')||ack.length<32)return false;
 const raw=reply.trimStart().replace(/^```(?:json)?\s*/,'');let partial='',quoted=false,escaped=false;
 for(const char of raw){
  if(quoted){partial+=char;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
  else {if(char==='"')quoted=true;if(!/\s/.test(char))partial+=char;}
 }
 const expected=JSON.stringify({content:[{type:'text',text:ack}]});
 return partial.length<expected.length&&partial.includes(ack.slice(0,32))&&expected.startsWith(partial);
}
export function contextAckRepairPrompt(ack:string):string{
 return 'Your acknowledgment of the immediately preceding context fragment was truncated. Do not repeat or reprocess the source data, answer the task, edit the workbook, or request tools. Only acknowledge that same already received fragment. If you cannot acknowledge it, explain that instead. Return exactly this one fenced JSON block and no other content:\n```json\n'+JSON.stringify({content:[{type:'text',text:ack}]})+'\n```';
}
const prefix='Receive a consecutive fragment of the complete native client request. The data field is a JSON string: decode its escapes and retain the exact text in order. Do not answer the request or execute tools yet. Do not edit the workbook. After every fragment, return exactly one fenced json block with the specified acknowledgment and no other content.\nCONTEXT TRANSFER DATA:\n';
function render(id:string,index:number,total:number,data:string){
 const ack=`BRIDGE_CONTEXT_ACK_${id}_${index}`;
 return{prompt:prefix+JSON.stringify({transfer:id,index,total,data})+'\nRequired response: '+JSON.stringify({content:[{type:'text',text:ack}]}),ack};
}
// Preserve the complete request; segment only its UI transport.
export function contextPackets(prompt:string,id:string,limit=UI_PACKET_CHARS):ContextPacket[]|undefined{
 if(prompt.length<=limit)return;
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!Number.isInteger(limit)||limit<2000)throw new Error('Invalid context transfer identity or packet limit');
 const fragments:string[]=[];let start=0;
 while(start<prompt.length){
  let lo=1,hi=Math.min(prompt.length-start,limit),best=0;
  while(lo<=hi){const size=Math.floor((lo+hi)/2);if(render(id,32,32,prompt.slice(start,start+size)).prompt.length<=limit){best=size;lo=size+1;}else hi=size-1;}
  if(best===0)throw new Error('Context transfer packet has no room for source text');
  if(start+best<prompt.length&&/[\uD800-\uDBFF]/.test(prompt[start+best-1]))best--;
  if(!best)throw new Error('Context transfer cannot split a Unicode character');
  fragments.push(prompt.slice(start,start+best));start+=best;
  if(fragments.length>31)throw new Error('Context transfer has too many packets');
 }
 const packets:ContextPacket[]=fragments.map((data,i)=>render(id,i+1,fragments.length,data));
 packets.push({prompt:`All ${fragments.length} fragments for transfer ${id} are complete. Concatenate their decoded data fields in index order to obtain the exact complete client request. Answer that request now, using its current instructions, tool schemas, native conversation and reply contract. Earlier tool calls and results are historical records; do not re-execute them. Do not edit the workbook. Return only the final fenced JSON response required by the client request.`});
 return packets;
}
