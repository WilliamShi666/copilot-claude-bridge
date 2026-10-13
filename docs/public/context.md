# Native context, browser chats and compaction

Claude Code remains the source of the conversation. Its request contains the system instructions, available tool schemas, messages and tool results. The bridge serializes supported text content into Copilot chat prompts and validates the structured response before returning native text/tool events.

The main lane bootstraps full context once, then sends appended messages and changed request fields to the verified active Copilot chat. A changed tool list can still produce a large update. The bridge compares the current browser conversation fingerprint before continuing. It does not restore arbitrary old Office chats from the history sidebar. Keep one active main client session per paired workbook.

Title requests and native compaction run in bridge-owned auxiliary browser tabs/chats. They do not append to the main conversation. Seeing these additional sessions in Copilot is expected. A long source is transmitted in ordered packets, each acknowledged before the next is sent. The final packet asks for the actual response; intermediate acknowledgments are not native model answers. The UI packet cap is 350,000 characters; serialized escaping reduces each packet's available source capacity. Source text is not silently truncated.

## Thresholds

The launcher applies native model overrides and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in a temporary session settings file. Its default is `533000`, with the older percentage override cleared. The tested Claude Code build reserves enough room that this targets roughly 500k input tokens. Change the native threshold with `--compact-window 200k` or another supported integer from 100k to 1m. Reserves and recognition behavior can change with client versions.

The gateway's independent prompt cap is measured in **characters**, not tokens. The default is 180,000 characters. Long-context operation requires starting it with `--max-prompt-chars 2000000` (the maximum). A larger client window alone does not increase this transport cap. Token counters are local heuristics, especially approximate for mixed-language text and tool schemas.

## Compaction

1. Native Claude Code requests manual `/compact` or automatic compaction.
2. The bridge sends the complete summary request to a fresh auxiliary chat, using GPT-6.1 Sol.
3. Recoverable UI/JSON-format errors can start a fresh GPT-6 Sol attempt. Cancellation, policy refusals, unsent drafts and unexpected chat changes stop the chain.
4. Only a text response containing a nonempty task-summary section is accepted; a historical answer or tool request is rejected. This structural check cannot guarantee perfect factual fidelity.
5. Native PreCompact/PostCompact hooks reset tracking for the main context, so the next main turn bootstraps the authoritative compacted native conversation.

Sending the full pre-compaction source can take several UI messages and minutes. Summaries are lossy; continue using fresh file reads to verify current state. A client-configured 500k threshold and selected-account acceptance do not prove a provider-wide 1m deployment limit.

## Uncertain delivery

The bridge records dispatch before submission and does not automatically replay an interrupted request that may have reached Copilot. A 409 uncertain-context error requires an explicit `context-reset --session <native-session-id>` after finishing/canceling the active request. Check actual tool effects before retrying. Resetting context tracking does not roll back files, commands or native history.
