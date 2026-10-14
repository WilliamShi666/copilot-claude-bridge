import {readFile,access,mkdir,stat} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root=resolve(import.meta.dirname,'..');
const cli=join(root,'dist/packages/cli/index.js');

export function parseArguments(input,cwd=process.cwd()){
 const args=[...input],workspace=resolve(args[0]&&!args[0].startsWith('--')?args.shift():cwd);
 let checkOnly=false,gatewayOnly=false;const bridgeArgs=[],nativeArgs=[];
 while(args.length){
  const arg=args.shift();
  if(arg==='--'){nativeArgs.push(...args);break;}
  if(arg==='--check'){checkOnly=true;continue;}
  if(arg==='--gateway-only'){gatewayOnly=true;continue;}
  if(arg==='--model'||arg==='--compact-window'){
   const value=args.shift();if(!value||value.startsWith('--'))throw Error('Value required: '+arg);
   if(arg==='--model'&&!['opus','sonnet'].includes(value))throw Error('Model must be opus or sonnet');
   if(arg==='--compact-window'&&!/^(?:\d+)(?:k|m)?$/i.test(value))throw Error('Use --compact-window <tokens>, for example 533k');
   bridgeArgs.push(arg,value);continue;
  }
  nativeArgs.push(arg);
 }
 if(checkOnly&&gatewayOnly)throw Error('Choose --check or --gateway-only');
 const defaults=[];
 if(!nativeArgs.some(a=>/^--teammate-mode(?:=|$)/.test(a)))defaults.push('--teammate-mode','in-process');
 if(!nativeArgs.some(a=>/^--permission-mode(?:=|$)/.test(a)))defaults.push('--permission-mode','auto');
 return{workspace,checkOnly,gatewayOnly,bridgeArgs,nativeArgs:[...defaults,...nativeArgs]};
}

export function validateRuntime(runtime){
 const u=new URL(runtime.url);
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.search||u.hash||u.username||u.password||typeof runtime.clientKey!=='string'||!runtime.clientKey)throw Error('Invalid local gateway runtime. Inspect your bridge state directory.');
 return runtime;
}

export async function readRuntime(state){
 try{return validateRuntime(JSON.parse(await readFile(join(state,'runtime.json'),'utf8')));}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
}

export async function inspectGateway(state,request=fetch){
 const runtime=await readRuntime(state);if(!runtime)return null;
 let response;
 try{response=await request(runtime.url+'/bridge/status',{headers:{'x-api-key':runtime.clientKey},signal:AbortSignal.timeout(3000)});}
 catch(e){if(e.cause?.code==='ECONNREFUSED')return null;throw Error('Could not reach the local gateway. Check its logs and port.',{cause:e});}
 if(!response.ok)throw Error('Gateway authentication/status failed ('+response.status+'). Run doctor; do not delete credentials or re-pair blindly.');
 const status=await response.json();
 if(typeof status.workerConnected!=='boolean'||typeof status.browserReady!=='boolean')throw Error('Unexpected gateway status response. Check the saved port for another service.');
 return{runtime,status};
}

export async function ensureGateway({state,platform=process.platform,inspect=()=>inspectGateway(state),launch=launchGateway,sleep=delay}){
 let current=await inspect();if(current)return current;
 const prior=await readRuntime(state),port=prior?Number(new URL(prior.url).port):(platform==='win32'?59173:59175);
 const worker=launch(state,port);let failed;
 worker.once('error',e=>{failed=e;});worker.unref();
 console.error('Starting '+(platform==='win32'?'Windows':'Linux')+' Copilot gateway on 127.0.0.1:'+port+'...');
 for(let i=0;i<30&&!current;i++){if(failed)throw failed;await sleep(500);current=await inspect();}
 if(!current)throw Error('Gateway did not start. Inspect '+join(state,'gateway.stderr.log')+'; the port may be occupied.');
 return current;
}

function launchGateway(state,port){
 const handles=[];
 try{
  handles.push(openSync(join(state,'gateway.stdout.log'),'a',0o600));
  handles.push(openSync(join(state,'gateway.stderr.log'),'a',0o600));
  return spawn(process.execPath,[cli,'start','--quiet','--port',String(port),'--max-prompt-chars','2000000'],{
   cwd:root,env:{...process.env,M365_BRIDGE_STATE_DIR:state},detached:true,windowsHide:true,stdio:['ignore',...handles],
  });
 }finally{for(const handle of handles)closeSync(handle);}
}

export async function waitForChrome(current,{inspect,sleep=delay,attempts=35}){
 const url=current.runtime.url;
 if(!current.status.workerConnected||!current.status.browserReady){
  console.error('Waiting for Chrome Excel Copilot to reconnect...');
  for(let i=0;i<attempts;i++){
   await sleep(1000);current=await inspect();
   if(current?.status.workerConnected&&current.status.browserReady)break;
  }
 }
 if(!current)throw Error('Gateway stopped while waiting. Run this launcher again.');
 if(!current.status.workerConnected||!current.status.browserReady)throw Error('Chrome Copilot is not ready. Keep the signed-in workbook and Copilot Chat open; the extension must use '+url+'. For first pairing run: node "'+cli+'" setup. For an existing pairing choose Use selected Excel tab.');
 return current;
}

export async function main(input=process.argv.slice(2)){
 if(input.includes('--help')){console.log('Usage: node scripts/run-copilot.mjs [workspace] [--gateway-only | --check] [--model opus|sonnet] [--compact-window 533k] [-- <Claude flags>]\nDefault: current workspace, in-process teammates, native Auto Mode. No permission bypass.');return;}
 if(!['win32','linux'].includes(process.platform))throw Error('This launcher supports Windows and Linux/WSL.');
 const options=parseArguments(input),state=resolve(process.env.M365_BRIDGE_STATE_DIR??join(homedir(),'.m365-claude-bridge'));
 try{await access(cli);}catch(e){if(e.code==='ENOENT')throw Error('Bridge is not built. In the repository root run npm ci and npm run build.');throw e;}
 if(!(await stat(options.workspace)).isDirectory())throw Error('Workspace must be an existing directory.');
 await mkdir(state,{recursive:true,mode:0o700});
 let current=await ensureGateway({state});
 if(options.gatewayOnly){console.log('Gateway: '+current.runtime.url+'\nRun node "'+cli+'" setup for first pairing, then run this launcher again. The gateway continues in the background.');return;}
 current=await waitForChrome(current,{inspect:()=>inspectGateway(state)});
 if(options.checkOnly){console.log(JSON.stringify({gateway:current.runtime.url,connected:current.status.workerConnected,ready:current.status.browserReady,pid:current.runtime.pid}));return;}
 const child=spawn(process.execPath,[cli,'run','--experimental-copilot-backend','--cwd',options.workspace,...options.bridgeArgs,'--',...options.nativeArgs],{cwd:options.workspace,env:{...process.env,M365_BRIDGE_STATE_DIR:state},stdio:'inherit',windowsHide:true});
 await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>{process.exitCode=code??1;yes();});});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
