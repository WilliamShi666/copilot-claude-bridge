export function promptLimit(value?:string){
 const limit=Number(value??180000);
 if(!Number.isInteger(limit)||limit<20000||limit>2000000)throw new Error('Prompt limit must be an integer between 20000 and 2000000 characters');
 return limit;
}
export function compactWindow(value?:string){
 const text=value??'533000';
 const match=/^(\d+)(k|m)?$/i.exec(text);
 const window=match?Number(match[1])*(match[2]?.toLowerCase()==='k'?1000:match[2]?.toLowerCase()==='m'?1000000:1):NaN;
 if(!Number.isInteger(window)||window<100000||window>1000000)throw new Error('Compact window must be an integer between 100000 and 1000000 tokens');
 return window;
}
