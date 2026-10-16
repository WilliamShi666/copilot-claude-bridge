# Copilot Claude Bridge

[中文说明（仓库主页）](README.md)

[![CI](https://github.com/WilliamShi666/copilot-claude-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamShi666/copilot-claude-bridge/actions/workflows/ci.yml)

An experimental local bridge that lets **Claude Code use Claude models in Microsoft 365 Copilot through Excel and Chrome**.

Keep the native Claude Code terminal and its local Read, Write, Edit, Bash and MCP tools. Model requests travel through an authenticated loopback gateway to your signed-in Excel web Copilot chat. Claude Code executes tools locally using its normal permissions.

```text
Claude Code (Windows or Ubuntu WSL)
        ↓ authenticated localhost API
Local Node.js gateway
        ↓ paired WebSocket
Chrome extension → Excel web Copilot → Claude model
        ↑ validated response; native tools stay in Claude Code
```

This is an unofficial UI integration, unaffiliated with Microsoft or Anthropic. It requires your own account with the desired Copilot models available. Model availability and account limits still apply; it does not add access to unavailable models. A working browser login and open workbook are required.

## Prerequisites

For personal accounts, subscribe to **Microsoft 365 Premium** and sign in to [Excel for the web](https://excel.cloud.microsoft/) in your local Chrome browser with that subscription account. Open a workbook and Copilot, confirm the required Claude models are available, and select Chat mode before pairing. Keep the browser signed in while using the bridge.

Eligible commercial Microsoft Copilot subscriptions also provide model selection; enterprise Claude access requires the administrator to enable Anthropic. See [Microsoft’s official Excel Copilot FAQ](https://support.microsoft.com/en-us/excel/copilot/frequently-asked-questions-about-copilot-in-excel).

## What it supports

- Native Claude Code with session-only provider/model overrides; ordinary saved provider settings are retained.
- Verified continuation in one active main Copilot chat, with incremental context after the initial bootstrap.
- Separate bridge-owned browser chats for titles and compaction. Summaries use **GPT-6.1 Sol**, with **GPT-6 Sol** fallback for recoverable transport/JSON-format failures. Policy refusals and unsafe chat changes fail rather than being retried through another model.
- Ordered long-context transfer, native compaction hooks and explicit recovery after uncertain delivery.
- An optional mode that keeps your original inference provider and adds Copilot as a planning/review advisor.

Model labels currently targeted by the adapter are Opus 5.5 and Sonnet 5.5. Your Excel account must expose these labels, and both GPT summary models are needed to use the complete fallback chain. Read the [tested scope](docs/public/validation.md) and [limitations](docs/public/limitations.md).

## Quick start: Windows + Chrome

Requirements: Node.js 22+, Chrome 120+, native Claude Code installed, and a signed-in Excel web workbook with Copilot available in **Chat** mode. Download the source or clone this repository, then open PowerShell in its root.

```powershell
git clone https://github.com/WilliamShi666/copilot-claude-bridge.git
cd copilot-claude-bridge
npm.cmd ci --registry=https://registry.npmjs.org
npm.cmd run build
.\start-copilot.cmd --gateway-only
```

The gateway stays in the background. **From the same repository root**:

```powershell
node dist/packages/cli/index.js setup
```

1. In Chrome, open `chrome://extensions`, enable Developer mode and **Load unpacked** the repository's `dist/extension` folder.
2. Open your Excel web workbook, open Copilot and choose Chat mode. Leave no unsent draft or active generation.
3. Open **M365 Claude Bridge (Experimental)**. Enter the gateway URL and the one-time local pairing code printed by `setup`.
4. Click **Pair selected Excel tab** and review the requested Office frame permissions. If requested, refresh the workbook and reopen Copilot.
5. Run `doctor`; proceed when `workerConnected` and `browserReady` are both `true`.

```powershell
node dist/packages/cli/index.js doctor
.\start-copilot.cmd "C:\Projects\my-project"
# To use Sonnet instead:
.\start-copilot.cmd "C:\Projects\my-project" --model sonnet
```

Replace the workspace with an existing directory. Start only one main Claude Code session per paired workbook. The initial request can be large because it includes the client's instructions, tool schemas and history. A long request may appear as several transfer messages in Copilot.

For a first check, use a disposable directory and ask: **“Create hello.md containing hello, then read it back.”** Inspect both the native tool results and the file on disk. Keep Claude Code's permission prompts enabled.

The terminal wrapper and extension retain their internal `m365-claude-bridge` name for compatibility. The source is not yet published to npm; use the local commands above.

Daily/restart launch reuses or starts the gateway and waits for Chrome. CMD uses `start-copilot.cmd`; Git Bash uses `./start-copilot.cmd`. Defaults are in-process teammates and native Auto Mode; override with `--permission-mode default`. See [startup and environment switching](docs/public/startup.en.md).

## Ubuntu WSL + Windows Chrome

Install native Linux Node.js and Claude Code inside WSL. Install/build this repository inside WSL too; do not share a Windows `node_modules` directory with Linux. The browser and extension stay in Windows Chrome. Pair them to the **WSL gateway** using Windows-to-WSL localhost forwarding. See the [WSL quick start](docs/public/wsl.md).

## Context and compaction

The default explicit client compaction window is `533k`. With the tested Claude Code version, its reserves leave approximately 500k input tokens before automatic compaction. Use `--compact-window 200k` for a smaller client window. Start the gateway with `--max-prompt-chars 2000000` for the long-context mode shown above; its ordinary default is only 180,000 characters.

This configures the client's threshold. It does not establish Copilot's provider context limit or guarantee 500k on another account. All displayed token usage is a local estimate. Native `/compact` sends the complete pre-compaction source to a separate summary chat, then rebases the main browser context from the compacted native conversation. See [context behavior](docs/public/context.md).

## Recovery and stopping

Conversation, native-context and compaction registries have no fixed lifetime record-count ceiling, including on reload. The old `Conversation registry limit reached` error came from a local 100-record cap, not a turn count or Copilot quota. Update and restart an idle gateway without clearing history or resetting the task.

Native subagents and in-process teammates have separate context records keyed by session, agent and model. Each agent continues in its own bridge-owned workbook tab. Browser inference is serialized through one queue; local tools remain under Claude Code. Queue waiting and generation have separate deadlines, and canceling an unsent request does not cancel a sibling. Up to 16 agent tabs are retained; close completed tabs manually. Split-pane team processes have an observed missing-agent-identity routing failure with lead-context 409 errors; use in-process teammates. After rebuilding/reloading the extension, `doctor` must show `capabilities.agentContexts: 1` for agent routing.

Native Auto mode passed a limited live check: three named teammates started together and each continued with Write, Read and Bash without manual Yes approvals. See the [validation scope](docs/public/validation.md) for details and limitations.

Keep Chrome, the paired workbook and Copilot open. Do not manually switch that chat during a request. If the extension was rebuilt, reload it, refresh the workbook and select **Use selected Excel tab** when already paired. After restarting a gateway, run `doctor` again.

After a native interruption, the bridge stops the matching browser generation and waits up to 15 seconds for a correlated cancellation receipt. New feedback waits for confirmation. A verified original page continues in the same chat and epoch using a recovery delta; unchanged system instructions and tool schemas are not resent. Cancelled browser tool calls are discarded. Actual local tool results remain authoritative.

If the original chat is closed, changed, has a new draft, or cannot be verified, each feedback request gets at most one complete rebuild in a new bridge-owned workbook tab. The old page and draft are preserved, and the response visibly reports full synchronization. Ordinary feedback after completion continues incrementally. Real compaction and substantive history changes still require complete synchronization.

A clear upstream refusal is a separate, nonretryable error. It never triggers another chat or model attempt, and a retry changing only `max_tokens` retains the original reason. `context-reset` does not resolve a provider refusal.

Update the gateway and extension together, reload the extension, and refresh the workbook. `doctor` must show `capabilities.cancelContinuation: 1`; launch commands are unchanged.

Older uncertain records without cancellation receipts or a verifiable interruption checkpoint still require explicit recovery. Check actual tool effects before using the native session ID from a **409 Native context delivery is uncertain** error:

```powershell
node dist/packages/cli/index.js context-reset --session <native-session-id>
```

Retry from Claude Code after checking the actual workspace for any completed tool effects. This resets local context tracking; it cannot undo an already executed tool. Uncertain requests are not automatically replayed.

For an agent-specific error, use its suggested `context-reset --session <native-session-id> --agent <agent-id>` command. This resets that agent's records and compaction tracking without resetting the lead or siblings.

```powershell
node dist/packages/cli/index.js stop
```

For **Chrome extension is not ready**, check the gateway URL, pairing, logged-in workbook, open Copilot pane, Chat mode and unsent drafts; run `doctor` again. In PowerShell, use `npm.cmd` and `claude.cmd` to avoid blocked npm script shims. The bridge itself looks for native `claude.exe`; if discovery fails, set `CLAUDE_CODE_EXECUTABLE` to its absolute executable path.

## Optional advisor mode

Omitting the experimental flag keeps your configured original provider and adds a temporary Copilot advisor MCP server:

```powershell
node dist/packages/cli/index.js run --cwd "C:\Projects\my-project"
```

This mode requires an independently working original model/provider. The optional [Excel Windows desktop transport](docs/public/desktop-advisor.md) supports advisor mode only.

## Privacy, limitations and development

Direct mode sends the client's context and tool output to Copilot, which can include private code and secrets. See [SECURITY.md](SECURITY.md) for data flow, local storage and extension permissions.

Image input requires the optional image build: run `npm run build:images`, then reload the extension. It adds the powerful required Chrome `debugger` permission; explicitly approve that increased access before installation/reload. The default `npm run build` text profile omits it. The image build additionally starts with **Enable image input** off. It waits for attachment upload to finish; a decoded preview alone does not mean the upload is complete. This implementation temporarily emulates target-page focus, sends one Enter to the verified native Send button, retains scoped focus until the owned message is acknowledged, then restores focus emulation and detaches; Chrome may show a debugging banner. **Disable image input** or disconnect stops use but does not revoke that required permission. Rebuild/reload the default text extension or uninstall to remove it. Disabled image requests fail before submission.

Image interpretation uses Copilot's built-in attachment/vision capability. It does not automatically run local OCR or an external vision service; restrictions on all visual analysis can prevent viewing. Attachment verification does not certify the answer or identify Copilot's internal vision model.

This UI transport supports text and base64 image attachments with buffered responses, local token estimates and no measured provider billing. UI changes, account limits, policy refusals and malformed replies can interrupt tasks. PNG/JPEG/GIF/WebP images from native Read or user messages are sent as actual Copilot attachments, with stable references in text history. Limits are 5 MB per image, 10 MB of unique image data in a request and five attachments per browser turn. Remote image URLs, audio, video, signed thinking, exact API caching and arbitrary long-running/subagent flows are not supported or guaranteed. See [limitations](docs/public/limitations.md).

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run export:source
```

Tests use local mock servers and sanitized DOM fixtures; they do not establish live account compatibility. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Public source exports deliberately omit local QA scripts, runtime credentials, screenshots and private acceptance transcripts. See [release preparation](docs/public/release.md).

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses. Microsoft 365 Copilot and Claude Code remain separate services/products subject to their own access requirements. Their branding and services are not licensed by this repository.
