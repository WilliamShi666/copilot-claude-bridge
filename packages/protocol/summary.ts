export const SUMMARY_MODELS=['GPT-6.1 Sol','GPT-6 Sol'] as const;
export interface SummaryAttempt {model:string;error?:string}
export function isSummaryRequest(requestClass:unknown,hint:unknown,compacting:boolean){
 return requestClass==='compaction'||['auto','manual','reactive'].includes(String(hint??''))||(compacting&&requestClass!=='main'&&requestClass!=='auxiliary');
}
export function providerRestriction(text:string){
 const value=text.trim();
 if(/^(?:The model returned no content because the response was blocked by content filtering|Copilot blocked the response by content filtering)/i.test(value))return 'Copilot blocked the response by content filtering';
 if(/^Copilot refused external-client relay use/i.test(value)||/^I\b[\s\S]{0,100}\b(?:cannot|can\x27t|won\x27t|will not)\b[\s\S]{0,700}\b(?:relay|model backend|context transfer)\b/i.test(value))return 'Copilot refused external-client relay use';
}
export function validateSummary(text:string){
 const policy=providerRestriction(text);if(policy)throw new Error(policy);
 let reply:any;try{reply=JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw new Error('Summary response is not valid JSON');}
 if(!reply||Object.keys(reply).join(',')!=='content'||!Array.isArray(reply.content)||!reply.content.length||!reply.content.every((b:any)=>b?.type==='text'&&typeof b.text==='string'&&b.text.trim()&&Object.keys(b).sort().join(',')==='text,type'))throw new Error('Summary must contain nonempty text only; tools were not forwarded');
}
export async function runSummaryChain(run:(model:string)=>Promise<string>,recover:()=>Promise<void>,signal:AbortSignal,onAttempt:(attempt:SummaryAttempt)=>void=()=>{}){
 const attempts:SummaryAttempt[]=[];
 for(const [index,model]of SUMMARY_MODELS.entries()){
  signal.throwIfAborted();
  try{const text=await run(model);validateSummary(text);const attempt={model};attempts.push(attempt);onAttempt(attempt);return{text,model,attempts};}
  catch(error){
   const message=error instanceof Error?error.message:'Summary inference failed';const attempt={model,error:message.slice(0,500)};attempts.push(attempt);onAttempt(attempt);
   signal.throwIfAborted();
   if(providerRestriction(message)||/draft|already generating|changed|altered|truncated|Invalid segmented/i.test(message))throw error;
   if(index===SUMMARY_MODELS.length-1)throw new Error('Summary models failed: '+attempts.map(a=>a.model+': '+a.error).join('; '));
   await recover();
  }
 }
 throw new Error('No summary model configured');
}
