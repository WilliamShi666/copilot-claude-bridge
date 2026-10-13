import { realpath, readFile, stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
export interface SourceFile { path: string; sha256: string; content: string }
export const sourceExtensions = new Set(['.md','.txt','.js','.ts','.tsx','.jsx','.cjs','.mjs','.json','.py','.go','.rs','.java','.cs','.css','.html','.yaml','.yml','.toml','.sh','.ps1']);
export function excludedSourcePath(path: string) {
  return path.split(/[\\/]/).some(part => /^(?:\.git|\.ssh|\.aws|\.codex|\.claude|node_modules|dist)$/i.test(part)) || /(?:^|[\\/])\.env(?:[.\\/]|$)|(?:credentials|secrets?|password|private[-_]?key|\.local\.json|runtime\.json|\.pem$|\.key$|\.pfx$)/i.test(path);
}
export async function sourcePath(workspace: string, name: string) {
  if (isAbsolute(name)) throw new Error('Use relative paths inside the selected workspace');
  if (excludedSourcePath(name)) throw new Error('Credential or private runtime files are excluded');
  const root = await realpath(workspace), path = await realpath(resolve(root, name));
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('File is outside the selected workspace');
  if (excludedSourcePath(rel)) throw new Error('Credential or private runtime files are excluded');
  return { root, path, relative: rel.replaceAll('\\', '/') };
}
export async function readSelectedFiles(workspace: string, names: string[]): Promise<SourceFile[]> {
  const root = await realpath(workspace);
  if (names.length > 20) throw new Error('Select at most 20 source files');
  const files: SourceFile[] = []; let size = 0;
  for (const name of names) {
    const { path, relative: rel } = await sourcePath(root, name);
    if (!sourceExtensions.has(extname(path).toLowerCase())) throw new Error('Only selected text/code files are supported');
    const info = await stat(path); if (!info.isFile() || info.size > 150000) throw new Error('File exceeds source context limit');
    const content = await readFile(path, 'utf8'); if (content.includes('\0')) throw new Error('Binary file is not supported');
    size += content.length; if (size > 150000) throw new Error('Combined source context exceeds 150000 characters');
    files.push({ path: rel, sha256: createHash('sha256').update(content).digest('hex'), content });
  }
  return files;
}
