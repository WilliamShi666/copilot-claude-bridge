import {createHash} from 'node:crypto';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';
export function workspaceFingerprint(workspace:string){return createHash('sha256').update(resolve(workspace)).digest('hex');}
export async function notifyCompact(input:any,env:NodeJS.ProcessEnv=process.env,transport:typeof fetch=fetch){
 if(!input||!['PreCompact','PostCompact'].includes(input.hook_event_name)||!['manual','auto'].includes(input.trigger)||typeof input.session_id!=='string'||typeof input.cwd!=='string')throw new Error('Invalid native compaction notification');
 const url=new URL(env.ANTHROPIC_BASE_URL??'');if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password)throw new Error('Compaction notification requires the configured localhost gateway');
 const key=env.ANTHROPIC_AUTH_TOKEN||env.ANTHROPIC_API_KEY;if(!key)throw new Error('Local bridge credential unavailable');
 const body={session_id:input.session_id,workspaceKey:workspaceFingerprint(input.cwd),hook_event_name:input.hook_event_name,trigger:input.trigger,...(input.agent_id===undefined?{}:{agent_id:input.agent_id})};
 const response=await transport(url.origin+'/bridge/context/compact',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error('Compaction notification rejected by the local bridge ('+response.status+')');
 return {notified:true,event:input.hook_event_name};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let text='',bytes=0;process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>2_000_000){console.error('Compaction hook input exceeds limit');process.exit(1);}text+=chunk;});
 process.stdin.on('end',()=>{void (async()=>{let input;try{input=JSON.parse(text);}catch{throw new Error('Malformed native compact hook input');}await notifyCompact(input);})().catch(error=>{console.error(error instanceof Error?error.message:'Compaction notification failed');process.exitCode=1;});});
}
