import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectWorkspace, parseInspectionReply } from '../packages/advisor/evidence.js';
import { listWorkspaceFiles, searchWorkspaceText } from '../packages/advisor/workspace-tools.js';
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'m365-evidence-'));
  await mkdir(join(root,'src')); await mkdir(join(root,'.claude'));
  await writeFile(join(root,'src','scene.ts'),'import timing from "./timing.json";\nexport const titleAt = timing.titleAt;');
  await writeFile(join(root,'src','timing.json'),'{"titleAt":90}');
  await writeFile(join(root,'.env'),'PRIVATE'); await writeFile(join(root,'.claude','settings.json'),'PRIVATE');
  return root;
}
test('bounded file tools list/search fresh sources without exposing excluded files',async()=>{
  const root=await fixture();
  try {
    const list=await listWorkspaceFiles(root,'.',true);
    assert.deepEqual(list.entries.map(e=>e.path),['src','src/scene.ts','src/timing.json']);
    const result=await searchWorkspaceText(root,'titleAt'); assert.equal(result.hits.length,2); assert.equal(result.hits[0].line,2);
    await assert.rejects(listWorkspaceFiles(root,'..'),/outside/);
    await assert.rejects(listWorkspaceFiles(root,'.claude'),/excluded/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('Copilot chooses dependent files, receives fresh contents, and cannot invent evidence',async()=>{
  const root=await fixture(); let calls=0;
  try {
    const result=await inspectWorkspace(root,{mode:'plan',task:'inspect title timing'},async prompt=>{
      const context=JSON.parse(prompt.slice(prompt.indexOf('\n{')));
      if (++calls===1) { assert.equal(context.readFiles.length,0); return {advice:JSON.stringify({action:'inspect',requests:[{op:'read_file',path:'src/scene.ts'}]})}; }
      if(calls===2) { assert.match(context.readFiles[0].content,/timing.json/); return {advice:JSON.stringify({action:'inspect',requests:[{op:'read_file',path:'src/timing.json'}]})}; }
      assert.equal(context.readFiles[1].content,'{"titleAt":90}');
      return {model:'fixture-only',advice:JSON.stringify({action:'advise',advice:'titleAt is 90',evidencePaths:['src/scene.ts','src/timing.json']})};
    });
    assert.equal(calls,3); assert.equal(result.inspectionJournal.filter(e=>e.chosenBy==='copilot'&&e.ok).length,2);
    assert.match(result.sourceFiles[0].sha256,/^[a-f0-9]{64}$/);
    await assert.rejects(inspectWorkspace(root,{mode:'plan',task:'inspect'},async()=>({advice:'{"action":"advise","advice":"invented","evidencePaths":["src/scene.ts"]}'})),/not read/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('unsupported commands/refusal are never executed and endless read requests stop',async()=>{
  assert.throws(()=>parseInspectionReply('{"action":"inspect","requests":[{"op":"shell","command":"anything"}]}'),/unsupported/);
  assert.throws(()=>parseInspectionReply('I cannot do that'),/refused/);
  const root=await fixture();
  try {
    const result=await inspectWorkspace(root,{mode:'review',task:'check',files:['src/scene.ts']},async prompt=>{
      const context=JSON.parse(prompt.slice(prompt.indexOf('\n{')));
      if(context.round===1) return {advice:'{"action":"inspect","requests":[{"op":"read_file","path":".env"}]}'};
      assert.match(context.inspectionResults.at(-1).error,/excluded/);
      return {advice:'{"action":"advise","advice":"could not read credentials","evidencePaths":["src/scene.ts"]}'};
    });
    assert.equal(result.inspectionJournal.at(-1)?.ok,false);
    await assert.rejects(inspectWorkspace(root,{mode:'plan',task:'check',maxRounds:2},async()=>({advice:'{"action":"inspect","requests":[{"op":"read_file","path":"src/scene.ts"}]}'})),/round budget/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('a repeated Copilot read observes changed content and retains both actual hashes',async()=>{
  const root=await fixture();
  try {
    const result=await inspectWorkspace(root,{mode:'review',task:'verify latest timing'},async prompt=>{
      const context=JSON.parse(prompt.slice(prompt.indexOf('\n{')));
      if(context.round===1)return {advice:'{"action":"inspect","requests":[{"op":"read_file","path":"src/timing.json"}]}'};
      if(context.round===2){
        assert.match(context.readFiles[0].content,/90/);
        await writeFile(join(root,'src','timing.json'),'{"titleAt":45}');
        return {advice:'{"action":"inspect","requests":[{"op":"read_file","path":"src/timing.json"}]}'};
      }
      assert.match(context.readFiles[0].content,/45/);
      return {advice:'{"action":"advise","advice":"now 45","evidencePaths":["src/timing.json"]}'};
    });
    assert.notEqual(result.inspectionJournal[0].sha256,result.inspectionJournal[1].sha256);
    assert.equal(result.sourceFiles[0].sha256,result.inspectionJournal[1].sha256);
  } finally {await rm(root,{recursive:true,force:true});}
});
