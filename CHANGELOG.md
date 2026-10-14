# Changelog

## Unreleased

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
