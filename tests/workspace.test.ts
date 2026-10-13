import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSelectedFiles } from '../packages/advisor/workspace.js';
test('advisor reads fresh files and hashes; rejects traversal, secrets and binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-advisor-test-'));
  try {
    await writeFile(join(dir,'source.cjs'), 'original'); await writeFile(join(dir,'.env'), 'SECRET'); await writeFile(join(dir,'binary.txt'), 'x\0y');
    const first = await readSelectedFiles(dir,['source.cjs']); await writeFile(join(dir,'source.cjs'),'changed');
    const second = await readSelectedFiles(dir,['source.cjs']); assert.notEqual(first[0].sha256, second[0].sha256); assert.equal(second[0].content, 'changed');
    await assert.rejects(readSelectedFiles(dir,['.env']), /excluded/);
    await assert.rejects(readSelectedFiles(dir,['binary.txt']), /Binary/);
    await assert.rejects(readSelectedFiles(dir,[join(dir,'source.cjs')]), /relative/);
    await assert.rejects(readSelectedFiles(dir,['..']), /outside/);
  } finally { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/')); await rm(dir,{recursive:true,force:true}); }
});
