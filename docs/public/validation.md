# Validation scope

The initial release preparation is based on local native Claude Code 2.1.296 sessions with Windows Chrome and a signed-in Excel web Copilot account. The source includes self-contained automated tests; private account sessions, screenshots, workbook identifiers and transcripts are deliberately excluded.

## Automated checks

The agent-isolation repair contains 129 Node tests covering protocol/tool validation, loopback authentication, pairing, cancellation, duplicate handling, reply reception, context continuity, auxiliary lanes, ordered packet transfer, startup readiness, summary semantics, independent agent contexts and reset/dispatch cancellation races. Two source-export checks run separately. Clean source installation, typechecking, builds and all 131 checks passed locally on Ubuntu WSL / Node 22 and Windows / Node 24 during release preparation. A ledger assertion reads after shutdown/flush to avoid Windows reader-versus-rename locking. CI is configured for Node 22/24 on Ubuntu and Windows; its hosted runs must be checked after publication.

## Native agents and in-process teams

Claude Code 2.1.296 was exercised interactively on Ubuntu WSL through the signed-in Windows Chrome workbook. Three unnamed subagents were launched in one assistant response and returned their three distinct markers. Three named in-process teammates were also launched together; each used native Write and Read for a different file. The same teammates then received three SendMessage follow-ups, recalled their own original markers, and wrote/read three further files. Child transcripts, independently read file contents and gateway identities confirmed separate agent lanes, continuation at epoch 1 and no overlapping-context 409 errors. Each write was approved individually in session-only standard permission mode. Saved provider settings were retained.

Stopping one named teammate from the native panel did not stop the other two, which completed afterward. In this client build, the stopped teammate did not immediately close its pending HTTP request; that request still ran through the browser queue. Gateway tests separately verify that an actual client disconnect before submission rolls back only the affected agent, never sends a late job, and leaves sibling work running. Do not equate the native panel's stop indication with immediate upstream inference cancellation.

After the readiness and unsent-editor repairs, a fresh native Auto-mode session launched three named teammates in one assistant response. All three passed the native permission classifier and returned their separate markers without retries. The same three teammates then received three SendMessage follow-ups in one response; each recalled its original complete sentence and marker, used native Write and Read for its own file, and ran native Bash `pwd`. Independent file reads matched the actual Write arguments byte for byte; native tool results succeeded, each agent continued its original lane at epoch 1, and no gateway failures or native API errors occurred. No manual Yes approvals or saved permission-setting changes were used. This is limited acceptance of the tested in-process scenario, not certification of arbitrary Auto-mode tasks or split-pane teams.

## Local live acceptance

| Native model | Summary model | Outcome observed |
| --- | --- | --- |
| Opus 5.5 | GPT-6.1 Sol | Automatic compaction around 532k estimated tokens; native Write/Read/Bash and five earlier facts recovered |
| Sonnet 5.5 | GPT-6.1 Sol | Automatic compaction around 532k; native Write/Read/Edit/Bash and five earlier facts recovered |
| Sonnet 5.5 | GPT-6 Sol after a controlled interruption of the primary summary attempt | Same native request completed with an actual task summary; Write/Read/Bash and five earlier facts recovered |

These long-context cases replayed an existing native transcript with only native session identifiers changed. They were checked through interactive native terminals, authenticated Chrome UI observation and actual on-disk tool results. The final consolidated local report passed 22 operational/semantic assertions. Normal saved provider settings were retained.

The original raw evidence remains private. This public document is a sanitized account of the checks, not independently reproducible proof of another account's capabilities. Run the small disposable-workspace check in [README.md](../../README.md) before doing real work. For compaction checks, keep test records free of secrets, verify the summary's actual task and pending work, then require fresh reads and independent on-disk tool verification. A successful summary or a recovered remembered fact alone does not prove a tool operation completed.

Do not advertise unlimited context, guaranteed model access, exact usage/billing or full Claude Code compatibility from these limited tests.
