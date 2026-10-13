import { execFileSync } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
await mkdir('dist/extension', { recursive: true });
for (const name of ['manifest.json', 'popup.html', 'popup.css']) await copyFile('packages/chrome-extension/' + name, 'dist/extension/' + name);
await build({ entryPoints: ['packages/chrome-extension/background.ts', 'packages/chrome-extension/content.ts', 'packages/chrome-extension/office-host.ts', 'packages/chrome-extension/popup.ts'], outdir: 'dist/extension', bundle: true, platform: 'browser', target: 'chrome120', format: 'iife' });
console.log('Gateway, CLI and Chrome extension built.');
