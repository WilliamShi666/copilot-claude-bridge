# Validation scope

The initial release preparation is based on local native Claude Code 2.1.296 sessions with Windows Chrome and a signed-in Excel web Copilot account. The source includes self-contained automated tests; private account sessions, screenshots, workbook identifiers and transcripts are deliberately excluded.

## Automated checks

The pre-release baseline contains 108 Node tests covering protocol/tool validation, loopback authentication, pairing, cancellation, duplicate handling, reply reception, context continuity, auxiliary lanes, ordered packet transfer, startup readiness and summary semantics. Two source-export checks run separately. Clean source installation, typechecking, builds and all 110 checks passed locally on Ubuntu WSL / Node 22 and Windows / Node 24 during release preparation. A ledger assertion reads after shutdown/flush to avoid Windows reader-versus-rename locking. CI is configured for Node 22/24 on Ubuntu and Windows; its hosted runs must be checked after publication.

## Local live acceptance

| Native model | Summary model | Outcome observed |
| --- | --- | --- |
| Opus 5.5 | GPT-6.1 Sol | Automatic compaction around 532k estimated tokens; native Write/Read/Bash and five earlier facts recovered |
| Sonnet 5.5 | GPT-6.1 Sol | Automatic compaction around 532k; native Write/Read/Edit/Bash and five earlier facts recovered |
| Sonnet 5.5 | GPT-6 Sol after a controlled interruption of the primary summary attempt | Same native request completed with an actual task summary; Write/Read/Bash and five earlier facts recovered |

These long-context cases replayed an existing native transcript with only native session identifiers changed. They were checked through interactive native terminals, authenticated Chrome UI observation and actual on-disk tool results. The final consolidated local report passed 22 operational/semantic assertions. Normal saved provider settings were retained.

The original raw evidence remains private. This public document is a sanitized account of the checks, not independently reproducible proof of another account's capabilities. Run the small disposable-workspace check in [README.md](../../README.md) before doing real work. For compaction checks, keep test records free of secrets, verify the summary's actual task and pending work, then require fresh reads and independent on-disk tool verification. A successful summary or a recovered remembered fact alone does not prove a tool operation completed.

Do not advertise unlimited context, guaranteed model access, exact usage/billing or full Claude Code compatibility from these limited tests.
