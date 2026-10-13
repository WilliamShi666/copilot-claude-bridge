import {createHash} from 'node:crypto';
import type {Snapshot,UiNode} from './client.js';
export interface Message {role:'user'|'assistant';id:string;text:string;complete:boolean}
export function messages(snapshot:Snapshot):Message[]{
  const result:Message[]=[];
  for(let i=0;i<snapshot.nodes.length;i++){
    const node=snapshot.nodes[i];if(node.type!==50026||!/^You said: |^Copilot said: ?/.test(node.name))continue;
    const role=node.name.startsWith('You said: ')?'user':'assistant';const children:UiNode[]=[];
    for(let j=i+1;j<snapshot.nodes.length&&snapshot.nodes[j].depth>node.depth;j++)children.push(snapshot.nodes[j]);
    const title=children.find(n=>/-message-.*-title$/.test(n.id));
    const textNodes=children.filter(n=>n.type===50020&&!n.id.endsWith('-title'));
    if(role==='assistant'&&textNodes[0]?.name==='Copilot')textNodes.shift();
    const parts=textNodes.map(n=>n.name);
    const text=parts.join('\n').replace(/\r\n/g,'\n').trim();
    result.push({role,id:title?.id??'',text,complete:role==='user'||children.some(n=>n.type===50000&&n.name==='Copy')});
  }return result;
}
export function chatMode(snapshot:Snapshot){return snapshot.nodes.some(n=>n.type===50000&&/^Switch mode, current: Chat(?: only)?,/.test(n.name));}
export function modelLabel(snapshot:Snapshot){return snapshot.nodes.find(n=>n.type===50000&&n.name.startsWith('Select model '))?.name.slice('Select model '.length);}
export function draft(snapshot:Snapshot){return snapshot.nodes.find(n=>n.type===50003&&n.name==='Chat input')?.value;}
export function busy(snapshot:Snapshot){return snapshot.nodes.some(n=>n.type===50000&&/^Stop generating$|^停止生成$/.test(n.name));}
export function assertIdle(snapshot:Snapshot){if(busy(snapshot))throw new Error('Excel Copilot is generating; no submission');if(draft(snapshot)===undefined||draft(snapshot)?.trim())throw new Error('Excel chat input missing or contains a user draft; no overwrite');}
export function cursor(snapshot:Snapshot){
  const list=messages(snapshot),assistant=list.at(-1),user=list.at(-2);
  if(!assistant||assistant.role!=='assistant'||!assistant.complete||!assistant.id||!assistant.text||!user||user.role!=='user'||!user.id||!user.text||busy(snapshot))throw new Error('Excel chat has no verified completed message pair');
  return createHash('sha256').update(JSON.stringify({window:snapshot.window,pid:snapshot.pid,model:modelLabel(snapshot),user:{id:user.id,text:user.text},assistant:{id:assistant.id,text:assistant.text}})).digest('hex');
}
