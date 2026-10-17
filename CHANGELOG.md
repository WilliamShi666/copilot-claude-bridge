# Changelog

## Unreleased

- Release recovery attempt markers only after proven unsent preparation failures, reuse the preparing owned page, and preserve real unknown-delivery causes instead of masking them with attempt-limit errors.
- Retire stale recovery routing when rebinding or pairing, including when a previous recovery page becomes the selected main page; keep the pages and drafts intact.
- Continue after native clients withdraw a cancelled standalone text prompt, while requiring the earlier history and all actual tool results to remain intact.
- Allow five same-chat JSON corrections, five ACK corrections per transfer and five unsent editor restorations, retaining the original inference deadline and at most one actual submit.
- Accept mixed-provider resumed/forked histories by omitting historical assistant reasoning only from the browser transport copy, preserving native transcripts and tool records.
- Add explicit GPT-6.1 Sol and GPT-6 Sol main-model selection, independent model context/refusal state and model-scoped context reset.
- Document failed GPT local Write/Read acceptance in both Chat-only and an isolated Allow editing experiment; retain the existing default mode and no automatic main-model fallback.
- Correct a verified truncated transfer acknowledgment once in the same chat without replaying source data, and record bounded correction diagnostics.

- Apply image-input focus emulation to nested Office iframe targets, and distinguish proven pre-Enter failures from unknown delivery without discarding native context or image-summary evidence.
- Accept reordered inline attachment references only when their unique filename set exactly matches the expected images; permit one explicit same-chat format correction for commentary preceding a validated structured suffix.

- Correct one syntactically malformed native JSON reply in its verified original Copilot chat, without replaying client history, executing the rejected tools or changing models.

- Remove lifetime count caps from conversation, native-context and compaction registries, including restart loading, while preserving all existing state.

- Recover a closed paired main tab on the first native request instead of leaving Claude Code waiting after an auxiliary title reply.

- Forward base64 images from native Read/user messages as verified Copilot attachments, preserving stable image references and allowing subsequent feedback to continue without repeating image uploads.
- Confirm native cancellation and continue verified original chats with recovery deltas; discard cancelled tool calls and preserve actual native tool results.
- Rebuild an unavailable chat at most once per feedback in an isolated tab, preserving drafts and reporting full synchronization.
- Preserve terminal upstream refusals across retries/restarts, including late replies tied to the original input; negotiate matching cancellation-capable gateway/extension versions.
- Start Windows or WSL Claude Code through repository launchers that reuse a running gateway or start it in the background after it stops.
- Add first-install, daily-start, restart recovery and Windows/WSL switching instructions in Chinese, with linked English instructions.
- Preserve gateway address and pairing-code edits while the Chrome popup refreshes connection status.
- Document the observed split-pane Agent Teams routing failure; use in-process teammates for the tested team flow.
- Isolate native subagent and in-process teammate contexts by session, agent and model, each with its own Copilot workbook tab.
- Queue browser inference with separate wait/generation deadlines and scope cancellation, compaction and recovery to the requesting agent.
- Reuse ready Copilot panes, wait for enabled controls, and recover only an empty unsent editor while protecting changed drafts and conversations.
- Prevent dispatch after cancellation during ledger persistence and avoid partial resets when another model is active.
- Add real three-agent and Auto-mode teammate Write/Read/Bash continuation checks, with documented native stop and permission-mode limits.

## 0.1.0 — 2026-10-14

- Experimental Excel web Copilot transport for native Claude Code, with Chrome pairing and an authenticated loopback gateway.
- Opus/Sonnet routing, verified continuation in the active main chat, native local tools, and explicit recovery from uncertain delivery.
- Separate browser lanes for titles and native compaction, ordered long-context transfer, and GPT-6.1 Sol → GPT-6 Sol summary fallback for recoverable transport/format failures.
- Session-only model/context settings, native PreCompact/PostCompact hooks, local usage estimates and buffered SSE output.
- Optional original-provider plus Copilot advisor mode; separate Windows Excel desktop advisor transport.
- MIT license, public installation/security/contribution documentation, automated CI and an allowlist-based source export.

Initial public source release in `WilliamShi666/copilot-claude-bridge`. No npm package or prebuilt extension release is published with this source commit.
