import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {findings,exportSource} from './export-source.mjs';

test('export scanner rejects machine/account secrets and only permits the exact synthetic workbook fixture',()=>{
 assert.ok(findings('ghp_'+'x'.repeat(36)).includes('GitHub token'));
 assert.ok(findings('sk-ant-'+'x'.repeat(32)).includes('provider API key'));
 assert.ok(findings('C:/'+['Users','example-person','file'].join('/')).includes('personal Windows home'));
 assert.ok(findings('/'+['home','example-person','file'].join('/')).includes('personal Linux home'));
 const base='https://excel.cloud.microsoft/open/onedrive/?';
 assert.ok(findings(base+'docId='+'private-id').includes('personal workbook URL'));
 assert.deepEqual(findings(base+'docId='+'approved"'),[]);
 assert.ok(findings(base+'docId='+'approved&driveId=private-id').includes('personal workbook URL'));
 assert.ok(findings(base+'docId='+'approved-private-id').includes('personal workbook URL'));
 const credential='local-credential-'+ '1'.repeat(32);assert.ok(findings(credential,[credential]).includes('local runtime credential'));
});

test('source export excludes private development artifacts, validates hashes, and never overwrites an existing directory',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'copilot-public-export-')),out=join(temporary,'source');
 try{
  const result=await exportSource(out);assert.equal(result.scan,'passed');assert.equal(result.localMarkdownLinks,'passed');
  const names=await readdir(out);assert.ok(names.includes('LICENSE'));assert.ok(!names.includes('evidence'));assert.ok(!names.includes('tasks'));assert.ok(!names.includes('node_modules'));assert.ok(!names.includes('dist'));
  const manifest=JSON.parse(await readFile(join(out,'SOURCE-MANIFEST.json'),'utf8'));assert.equal(result.fileCount,manifest.files.length);
  for(const path of ['start-copilot.cmd','start-copilot.sh','scripts/run-copilot.mjs','scripts/run-copilot.test.mjs'])assert.ok(manifest.files.some(file=>file.path===path));
  assert.ok(!manifest.files.some(f=>f.path.endsWith('.local.json')||f.path.startsWith('docs/debug-')||f.path==='scripts/setup-wsl-gateway.mjs'));
  for(const file of manifest.files){const bytes=await readFile(join(out,file.path));assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));}
  await assert.rejects(exportSource(out),/already exists/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
