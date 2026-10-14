# Security and data handling

Direct mode sends Claude Code's system instructions, tool definitions, conversation, and returned tool output to Microsoft 365 Copilot through its logged-in chat UI. This can include source code, file paths, command output and secrets read by the client. Choose workspaces and tools accordingly. The bridge does not automatically redact native request contents: redaction would change the model's context.

The gateway binds to `127.0.0.1`, authenticates client requests, and pairs one Chrome extension using a one-time local code. Keep it on loopback; do not expose it through a reverse proxy, LAN listener or public tunnel. Browser responses are untrusted and validated against the supplied tool schemas. Claude Code executes tools locally using its own permissions.

The extension requests `activeTab`, `scripting`, `storage`, `alarms` and loopback access. Its optional Office permission upper bound is `https://*.officeapps.live.com/*`; pairing requests the two exact frame origins `https://fa000000124.officeapps.live.com/*` and `https://excel.officeapps.live.com/*`. It does not request cookies, history, debugger, native messaging or filesystem access. It reads the logged-in Copilot chat DOM rather than exporting Microsoft passwords or login tokens.

Bridge state is in `~/.m365-claude-bridge` (or `M365_BRIDGE_STATE_DIR`). It includes local authentication credentials and context metadata. POSIX files use private permissions; Windows relies on the user profile's access controls. Gateway metadata does not persist source conversation bodies. The extension journals pending replies until acknowledged; interrupted replies may remain until disconnected. Claude Code itself maintains its normal local transcripts, which can contain the complete request and tool output. Killing a launcher can leave a private temporary session settings file; remove it after that client has exited.

The extension remembers local gateway URLs, worker IDs and pairing tokens for Windows/WSL switching in Chrome local extension storage. This does not include Microsoft credentials. Only one gateway is connected at a time; finish pending requests before switching. Browser profile access can reveal these local tokens, so protect that profile as well as the gateway state directory.

Disconnect in the extension to remove all saved gateway pairings, pending replies and optional host grants. Stop the gateway with `node dist/packages/cli/index.js stop`. These actions do not delete native Claude Code transcripts or Microsoft chat history. Manage those separately in their respective applications.

## Reporting vulnerabilities

Do not post credentials, exploit payloads containing private data, or a working account/session in a public issue. After this project is published, use its GitHub **Security → Report a vulnerability** feature when private reporting is enabled. If it is unavailable, open a minimal issue asking for a private reporting channel, without exploit details. The initial release checklist requires enabling private reporting.

There is no guaranteed response time for this experimental project. For ordinary installation and UI issues, use a redacted bug report.
