import {spawn,execFileSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export interface UiNode {name:string;id:string;type:number;enabled:boolean;offscreen:boolean;depth:number;value:string|null}
export interface Snapshot {window:number;pid:number;nodes:UiNode[]}
export const adapterPath=()=>resolve(dirname(fileURLToPath(import.meta.url)),'../../desktop/ExcelAdapter.exe');
export function desktopWindows(){if(process.platform!=='win32')throw new Error('Excel desktop requires Windows');return JSON.parse(execFileSync(adapterPath(),['--list'],{encoding:'utf8',windowsHide:true,timeout:15000}));}
export class ExcelClient {
  private child:ChildProcessWithoutNullStreams;
  private pending?:{yes:(value:any)=>void;no:(error:Error)=>void;timer:NodeJS.Timeout};
  private queue:Promise<unknown>=Promise.resolve();private stopped=false;
  constructor(window:number){
    if(process.platform!=='win32'||!Number.isSafeInteger(window)||window<=0)throw new Error('A selected Excel window handle is required');
    this.child=spawn(adapterPath(),['--window',String(window)],{windowsHide:true,stdio:'pipe'});
    createInterface({input:this.child.stdout}).on('line',line=>{const pending=this.pending;if(!pending)return;this.pending=undefined;clearTimeout(pending.timer);try{const value=JSON.parse(line);if(!value.ok)throw new Error(value.error);pending.yes(value.result);}catch(e){pending.no(e instanceof Error?e:new Error('Invalid desktop response'));}});
    this.child.on('error',e=>{this.stopped=true;this.fail(e);});this.child.on('exit',()=>{this.stopped=true;this.fail(new Error('Excel adapter exited; no request was replayed'));});
    this.child.stderr.on('data',()=>{});
  }
  private fail(error:Error){if(this.pending){clearTimeout(this.pending.timer);this.pending.no(error);this.pending=undefined;}}
  request(op:string,args:Record<string,unknown>={}):Promise<any>{
    const result=this.queue.then(()=>this.execute(op,args));this.queue=result.catch(()=>{});return result;
  }
  private execute(op:string,args:Record<string,unknown>):Promise<any>{
    if(this.stopped)throw new Error('Excel adapter stopped; restart the desktop service');
    if(this.pending)throw new Error('Desktop operation already active');
    return new Promise((yes,no)=>{const timer=setTimeout(()=>{this.fail(new Error('Excel accessibility call timed out; adapter stopped'));this.child.kill();},20000);this.pending={yes,no,timer};this.child.stdin.write(JSON.stringify({op,...args})+'\n');});
  }
  snapshot():Promise<Snapshot>{return this.request('snapshot');}
  close(){this.stopped=true;this.fail(new Error('Excel adapter stopped'));this.child.kill();}
}
