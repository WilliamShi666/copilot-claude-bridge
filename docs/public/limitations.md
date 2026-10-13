# Supported scope and limitations

This experimental integration drives an authenticated web chat, rather than a supported Microsoft Anthropic-compatible API. The visible UI, localization, account access and model labels can change. Copilot's own instructions and service policies remain in effect. The bridge does not bypass a refusal or request access to models absent from the account.

- **Tools:** Claude Code executes local tools with its native permissions. Tool names/arguments are validated against the request's schema. Successful Read/Write/Edit/Bash checks do not establish compatibility with every plugin, MCP server, subagent or permission mode.
- **Content:** Text only. Unsupported image/audio/document blocks are rejected. Native media transport, signed thinking and full reasoning-block compatibility are not established.
- **Streaming:** SSE heartbeats keep the client informed while Copilot generates; answer events are buffered until the UI response completes. This is not upstream token streaming.
- **API controls:** Requested effort, output size, beta flags and cache metadata can be serialized as instructions, but cannot be enforced as real API controls. Prompt caching and measured provider billing are unavailable.
- **Usage:** Context/token meters and costs calculated by the client do not measure actual Copilot service usage. Counts are local estimates, exposed as such by the launcher, doctor and response headers.
- **Concurrency:** One paired gateway, one active main native session per workbook, serialized inference. Do not change the active chat mid-request. Title/summary tabs are separate and owned by the bridge.
- **Recovery:** Chrome must stay running, logged in, with the workbook and Copilot available. Sleep, discarded tabs, expired login or gateway restarts can interrupt a request. Ambiguous delivery fails explicitly rather than replaying.
- **Capacity:** Approximately 500k local estimated input and compaction were tested on selected sessions. Neither a 1m upstream window nor reliable arbitrary unattended long histories is certified.
- **Platforms:** Windows Claude Code and Ubuntu WSL with Windows Chrome were exercised locally. Automated Linux fixtures do not establish live macOS/browser/account compatibility.
- **Desktop Excel:** The separate Windows accessibility transport supports advisor mode only. It may briefly focus Excel and cannot replace native Claude Code inference.

Direct mode transmits the native client's context to Copilot, including any code and tool output it contains. Review [SECURITY.md](../../SECURITY.md) before choosing a workspace.
