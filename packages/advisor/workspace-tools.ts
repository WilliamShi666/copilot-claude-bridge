import { readdir, stat } from 'node:fs/promises';
import { join, extname, posix } from 'node:path';
import { excludedSourcePath, sourceExtensions, sourcePath, readSelectedFiles } from './workspace.js';
export interface Entry { path: string; kind: 'directory' | 'file' }
export async function listWorkspaceFiles(workspace: string, path = '.', recursive = false) {
  const base = await sourcePath(workspace, path);
  if (!(await stat(base.path)).isDirectory()) throw new Error('Directory required');
  const entries: Entry[] = []; let truncated = false, visited = 0;
  async function visit(directory: string, prefix: string, depth: number) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (++visited > 3000 || entries.length >= 300) { truncated = true; return; }
      const rel = posix.join(prefix, item.name);
      if (item.isSymbolicLink() || excludedSourcePath(rel)) continue;
      if (item.isDirectory()) {
        entries.push({ path: rel, kind: 'directory' });
        if (recursive && depth < 5) await visit(join(directory, item.name), rel, depth + 1);
        else if (recursive) truncated = true;
      } else if (item.isFile() && sourceExtensions.has(extname(item.name).toLowerCase())) entries.push({ path: rel, kind: 'file' });
      if (truncated && (entries.length >= 300 || visited > 3000)) return;
    }
  }
  await visit(base.path, base.relative || '.', 0);
  return { entries, truncated, observedAt: new Date().toISOString() };
}
export async function searchWorkspaceText(workspace: string, query: string, path = '.') {
  if (!query || query.length > 200 || query.includes('\0')) throw new Error('Use a literal search query of 1-200 characters');
  const listing = await listWorkspaceFiles(workspace, path, true);
  const names = listing.entries.filter(e=>e.kind === 'file').map(e=>e.path);
  const hits: { path: string; sha256: string; line: number; snippet: string }[] = [];
  let scanned = 0, bytes = 0, truncated = listing.truncated || names.length > 100;
  for (const name of names.slice(0,100)) {
    let file;
    try { [file] = await readSelectedFiles(workspace,[name]); } catch { continue; }
    bytes += file.content.length; if (bytes > 1_000_000) { truncated = true; break; }
    scanned++;
    const lines = file.content.split(/\r?\n/);
    for (let i=0; i<lines.length; i++) {
      const at = lines[i].indexOf(query); if (at < 0) continue;
      hits.push({ path: file.path, sha256: file.sha256, line: i+1, snippet: lines[i].slice(Math.max(0,at-120),at+query.length+200) });
      if (hits.length >= 40) return { hits, scanned, truncated: true, observedAt: new Date().toISOString() };
    }
  }
  return { hits, scanned, truncated, observedAt: new Date().toISOString() };
}
