import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const publicFiles=['package.json','package-lock.json','tsconfig.json','.gitignore','.gitattributes','README.md','README.en.md','README.zh-CN.md','LICENSE','CONTRIBUTING.md','SECURITY.md','CHANGELOG.md','scripts/build.mjs','scripts/build-desktop.mjs','scripts/ImportUia.cs','scripts/export-source.mjs','scripts/export-source.test.mjs'];
export const publicDirectories=['packages','tests','docs/public','.github'];
const patterns=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['GitHub token',/\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['provider API key',/\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,})\b/],
 ['personal Windows home',/[A-Z]:[\\/]Users[\\/][^\s"'`<>]+/i],
 ['personal Linux home',/\/home\/(?!<|\$)[a-z][a-z0-9_-]{2,}\//i],
 // The exact docId=approved literal is synthetic in sanitized browser fixtures.
 ['personal workbook URL',/https?:\/\/[^\s"'<>]*[?&](?:docId|driveId)=(?!approved[\s"'<>])[^\s"'<>]+/i],
];
export function findings(text,secrets=[]){return [...patterns.filter(([,pattern])=>pattern.test(text)).map(([name])=>name),...secrets.filter(secret=>secret.length>=20&&text.includes(secret)).map(()=> 'local runtime credential')];}
async function filesIn(directory){
 const directoryStat=await lstat(join(root,directory));if(directoryStat.isSymbolicLink()||!directoryStat.isDirectory())throw new Error('Only real directories may be exported: '+directory);
 const result=[];
 for(const entry of (await readdir(join(root,directory))).sort()){
  const name=directory+'/'+entry,st=await lstat(join(root,name));
  if(st.isSymbolicLink())throw new Error('Symlinks are not exported: '+name);
  if(st.isDirectory())result.push(...await filesIn(name));else if(st.isFile())result.push(name);else throw new Error('Unsupported source entry: '+name);
 }
 return result;
}
async function localSecrets(){
 const values=[];const state=process.env.M365_BRIDGE_STATE_DIR??join(homedir(),'.m365-claude-bridge');
 for(const name of ['credentials.json','runtime.json']){
  try{const data=JSON.parse(await readFile(join(state,name),'utf8'));for(const key of ['clientKey','workerToken','pairCode'])if(typeof data[key]==='string')values.push(data[key]);}
  catch(error){if(error.code!=='ENOENT')throw new Error('Could not inspect local bridge credentials for export safety');}
 }
 return values;
}
export async function exportSource(output){
 const destination=resolve(output??join(root,'release-staging','copilot-claude-bridge-'+new Date().toISOString().replace(/[:.]/g,'-')));
 try{await lstat(destination);throw new Error('Output already exists; choose a new directory');}catch(error){if(error.code!=='ENOENT')throw error;}
 const files=[...publicFiles];for(const directory of publicDirectories)files.push(...await filesIn(directory));files.sort();
 const secrets=await localSecrets(),data=new Map(),issues=[];
 for(const file of files){
  const st=await lstat(join(root,file));if(!st.isFile()||st.isSymbolicLink())throw new Error('Only regular files may be exported: '+file);
  const bytes=await readFile(join(root,file)),text=bytes.toString('utf8');data.set(file,bytes);
  for(const reason of findings(text,secrets))issues.push({file,reason});
  if(/(?:^|\/)(?:node_modules|dist|evidence|tasks|release-staging|release-reports)(?:\/|$)|\.local\./.test(file))issues.push({file,reason:'private/generated file'});
 }
 for(const [file,bytes] of data)if(file.endsWith('.md')){
  for(const match of bytes.toString('utf8').matchAll(/\]\(([^\s)]+)\)/g)){
   const target=match[1];if(/^[a-z][a-z0-9+.-]*:|^#/i.test(target))continue;
   const clean=target.split('#')[0];const name=relative(root,resolve(root,dirname(file),clean)).replaceAll('\\','/');
   if(!data.has(name))issues.push({file,reason:'link outside public export: '+target});
  }
 }
 if(issues.length)throw new Error('Public export scan failed:\n'+issues.map(i=>i.file+': '+i.reason).join('\n'));
 await mkdir(dirname(destination),{recursive:true});await mkdir(destination);
 const manifest=[];
 for(const [file,bytes] of data){await mkdir(dirname(join(destination,file)),{recursive:true});await writeFile(join(destination,file),bytes);manifest.push({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 await writeFile(join(destination,'SOURCE-MANIFEST.json'),JSON.stringify({schemaVersion:1,project:'copilot-claude-bridge',version:JSON.parse(data.get('package.json')).version,files:manifest},null,2)+'\n');
 return{directory:destination,fileCount:files.length,scan:'passed',localMarkdownLinks:'passed'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--output'))throw new Error('Usage: node scripts/export-source.mjs [--output <new-directory>]');
 console.log(JSON.stringify(await exportSource(args[1]),null,2));
}
