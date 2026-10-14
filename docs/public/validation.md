# Validation scope

The initial release preparation is based on local native Claude Code 2.1.296 sessions with Windows Chrome and a signed-in Excel web Copilot account. The source includes self-contained automated tests; private account sessions, screenshots, workbook identifiers and transcripts are deliberately excluded.

## Automated checks

The agent-isolation repair contains 129 Node tests covering protocol/tool validation, loopback authentication, pairing, cancellation, duplicate handling, reply reception, context continuity, auxiliary lanes, ordered packet transfer, startup readiness, summary semantics, independent agent contexts and reset/dispatch cancellation races. Two source-export checks run separately. Clean source installation, typechecking, builds and all 131 checks passed locally on Ubuntu WSL / Node 22 and Windows / Node 24 during release preparation. A ledger assertion reads after shutdown/flush to avoid Windows reader-versus-rename locking. CI is configured for Node 22/24 on Ubuntu and Windows; its hosted runs must be checked after publication.

The startup/switching repair adds launcher and saved-gateway coverage: 134 runtime tests, six launcher checks and two source-export checks. The updated suite passed on Windows Node 24 and Ubuntu WSL Node 22. Separate live process checks on both OSes passed cold start, reuse, restart after an explicit gateway stop and preservation of the client credential. These checks simulate a gateway process restart, not a full Windows reboot.

## Native agents and in-process teams

Claude Code 2.1.296 was exercised interactively on Ubuntu WSL through the signed-in Windows Chrome workbook. Three unnamed subagents were launched in one assistant response and returned their three distinct markers. Three named in-process teammates were also launched together; each used native Write and Read for a different file. The same teammates then received three SendMessage follow-ups, recalled their own original markers, and wrote/read three further files. Child transcripts, independently read file contents and gateway identities confirmed separate agent lanes, continuation at epoch 1 and no overlapping-context 409 errors. Each write was approved individually in session-only standard permission mode. Saved provider settings were retained.

Stopping one named teammate from the native panel did not stop the other two, which completed afterward. In this client build, the stopped teammate did not immediately close its pending HTTP request; that request still ran through the browser queue. Gateway tests separately verify that an actual client disconnect before submission rolls back only the affected agent, never sends a late job, and leaves sibling work running. Do not equate the native panel's stop indication with immediate upstream inference cancellation.

After the readiness and unsent-editor repairs, a fresh native Auto-mode session launched three named teammates in one assistant response. All three passed the native permission classifier and returned their separate markers without retries. The same three teammates then received three SendMessage follow-ups in one response; each recalled its original complete sentence and marker, used native Write and Read for its own file, and ran native Bash `pwd`. Independent file reads matched the actual Write arguments byte for byte; native tool results succeeded, each agent continued its original lane at epoch 1, and no gateway failures or native API errors occurred. No manual Yes approvals or saved permission-setting changes were used. This is limited acceptance of the tested in-process scenario, not certification of arbitrary Auto-mode tasks or split-pane teams.

## Startup and saved gateway live acceptance

After reloading the built extension, Windows Chrome was paired to the existing Ubuntu WSL gateway. Native Linux Claude Code 2.1.300 was launched interactively through the local startup entrypoint with Auto Mode. Write, Read and Bash `uname -s` all completed: independent disk reads matched the actual Write content byte for byte, the Bash result was Linux, native tool results succeeded and no native API errors occurred. The normal initial workspace trust prompt was accepted; no manual tool Yes approvals were used, and the saved native settings hash was unchanged.

The real Chrome popup then switched from WSL to the previously paired Windows gateway and back to WSL with an empty pairing-code field. Both gateways became ready on their respective selected main workbook tabs; no new pairing code was supplied. The final WSL launcher readiness check passed. One extension still connects to only one gateway at a time; startup does not automatically select the destination in Chrome.

## Split-pane Agent Teams

A separate Ubuntu WSL / tmux check launched one lead and three native teammate processes. All three initial teammate replies returned, but the lead received repeated context 409 errors. Separate-process requests omitted the agent identity used by the bridge and were routed as main conversations, changing the lead browser chat. This mode did not pass; the launcher defaults to in-process teammates.

## Local live acceptance

| Native model | Summary model | Outcome observed |
| --- | --- | --- |
| Opus 5.5 | GPT-6.1 Sol | Automatic compaction around 532k estimated tokens; native Write/Read/Bash and five earlier facts recovered |
| Sonnet 5.5 | GPT-6.1 Sol | Automatic compaction around 532k; native Write/Read/Edit/Bash and five earlier facts recovered |
| Sonnet 5.5 | GPT-6 Sol after a controlled interruption of the primary summary attempt | Same native request completed with an actual task summary; Write/Read/Bash and five earlier facts recovered |

These long-context cases replayed an existing native transcript with only native session identifiers changed. They were checked through interactive native terminals, authenticated Chrome UI observation and actual on-disk tool results. The final consolidated local report passed 22 operational/semantic assertions. Normal saved provider settings were retained.

The original raw evidence remains private. This public document is a sanitized account of the checks, not independently reproducible proof of another account's capabilities. Run the small disposable-workspace check in [README.md](../../README.md) before doing real work. For compaction checks, keep test records free of secrets, verify the summary's actual task and pending work, then require fresh reads and independent on-disk tool verification. A successful summary or a recovered remembered fact alone does not prove a tool operation completed.

Do not advertise unlimited context, guaranteed model access, exact usage/billing or full Claude Code compatibility from these limited tests.
