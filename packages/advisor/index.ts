import { readFile,realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectWorkspace } from './evidence.js';
import type { ConversationReceipt } from '../protocol/conversation.js';
export interface AdviceRequest { mode: 'plan' | 'review'; task: string; files?: string[]; evidence?: string; model?: 'opus' | 'sonnet';conversation?:'new'|'continue';conversationId?:string }
async function connection(workspace:string) {
  const runtime = JSON.parse(await readFile(join(process.env.M365_BRIDGE_STATE_DIR ?? join(homedir(), '.m365-claude-bridge'), 'runtime.json'), 'utf8'));
  const url = new URL(runtime.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid local gateway URL');
  const workspaceKey=createHash('sha256').update(await realpath(workspace)).digest('hex');
  return {runtime,url,workspaceKey};
}
export async function listConversations(workspace:string) {
  const {runtime,url,workspaceKey}=await connection(workspace);
  const response=await fetch(url.origin+'/bridge/conversations?workspaceKey='+workspaceKey,{headers:{'x-api-key':runtime.clientKey},signal:AbortSignal.timeout(3000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error?.message??'Could not list Copilot conversations');return result;
}
export async function requestAdvice(workspace: string, input: AdviceRequest) {
  if (!input.task || input.task.length > 12000 || (input.evidence?.length ?? 0) > 20000) throw new Error('Advice task/evidence exceeds limit');
  const selected=input.conversation??'new';
  if(selected==='continue'&&!z.string().uuid().safeParse(input.conversationId).success)throw new Error('Continuing requires a returned conversationId (not inspection sessionId)');
  if(selected==='new'&&input.conversationId)throw new Error('New conversations must omit conversationId');
  const {runtime,url,workspaceKey}=await connection(workspace);
  let conversationId=input.conversationId,receipt:ConversationReceipt|undefined,verification:unknown,continuity='same-browser-chat',backend='chrome',transport='copilot-ui-json';
  const result=await inspectWorkspace(workspace,input,async prompt=>{
    // Wait for readiness BEFORE creating the next request; never retry a submitted chat message.
    const deadline=Date.now()+20000;
    while (true) {
      const response=await fetch(url.origin+'/bridge/status',{headers:{'x-api-key':runtime.clientKey},signal:AbortSignal.timeout(3000)});
      if (!response.ok) throw new Error('Local gateway is not authenticated');
      const status=await response.json() as {browserReady:boolean;workerConnected:boolean;active:unknown;capabilities?:{conversationControl?:boolean}};
      if(status.workerConnected&&!status.capabilities?.conversationControl)throw new Error('The selected Copilot adapter does not support verified conversations');
      if(status.workerConnected && (status.browserReady || status.active)) break;
      if(Date.now()>=deadline) throw new Error('The selected Copilot chat is not ready for the next inspection round');
      await delay(500);
    }
    const response = await fetch(url.origin + '/bridge/advice', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': runtime.clientKey }, body: JSON.stringify({ model: input.model === 'sonnet' ? 'copilot-sonnet-5.5' : 'copilot-opus-5.5', prompt,conversation:{mode:conversationId?'continue':'new',...(conversationId?{id:conversationId}:{}),workspaceKey} }), signal: AbortSignal.timeout(245000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? 'Copilot advice request failed');
    if (!result.advice) throw new Error('Copilot returned no advisory text');
    if(!result.conversation)throw new Error('Gateway did not return verified conversation evidence');
    receipt=result.conversation;conversationId=receipt!.id;
    verification=result.conversationVerification;
    continuity=result.contextContinuity;backend=result.backend??'chrome';transport=result.transport??'copilot-ui-json';
    return result;
  });
  return {...result,conversationId:receipt!.id,conversationLabel:receipt!.title,conversationCursor:receipt!.cursor,conversationVerification:verification,contextMode:selected,contextContinuity:continuity,backend,transport,resumability:'active-chat-only'};
}
