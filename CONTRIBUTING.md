# Contributing

Use Node.js 22 or newer. Install and test from a clean checkout:

```sh
npm ci --registry=https://registry.npmjs.org
npm run typecheck
npm test
npm run test:export
npm run export:source
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.
The automated tests use local servers and sanitized DOM fixtures; they do not require a Microsoft account, Claude Code installation, or a live workbook.

Keep gateway authentication, browser transport, protocol validation and native tool execution separate. Native tools belong to Claude Code; browser replies never authorize their execution. Preserve cancellation, explicit uncertain-delivery recovery, source contents, tool-result correlation and the user's native permissions. Do not add automatic replay of requests that might already have been submitted.

For bug fixes, add a focused regression case that reproduces the behavior. State which checks used mock replies and which used a real authenticated UI. A mocked response does not prove live Copilot compatibility. Do not commit browser profiles, pairing codes, API keys, private transcripts, real workbook URLs, screenshots containing private content, or local acceptance artifacts.

For live checks, use a disposable workspace and workbook. Verify file changes on disk, retain normal permission prompts, and report the tested OS, Claude Code version and visible model label. Request a fresh Read when checking files changed outside the client. Redact identifiers before sharing a report.

The original development folder contains private local QA helpers. Public source is exported from an explicit file list by `scripts/export-source.mjs`. Add new distributable files to that list deliberately; never upload the development folder wholesale. See [release preparation](docs/public/release.md).
