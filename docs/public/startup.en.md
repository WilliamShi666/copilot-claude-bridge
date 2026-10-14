# Startup and Windows / WSL switching

[中文完整说明](startup.md) · [English README](../../README.en.md)

Requires Node.js 22+, native Claude Code, Windows Chrome, Microsoft 365 Premium for personal accounts, and a signed-in Excel web workbook with the desired models and Copilot Chat available. Build this checkout before running a launcher.

## First pairing

In Windows PowerShell, from the repository root:

```powershell
npm.cmd ci --registry=https://registry.npmjs.org
npm.cmd run build
.\start-copilot.cmd --gateway-only
node dist/packages/cli/index.js setup
```

Load `dist/extension` in Chrome's extensions page. Select your workbook, open Copilot Chat, enter the URL and local one-time code from `setup`, and pair. Refresh/reopen Copilot if requested. Check readiness:

```powershell
.\start-copilot.cmd --check
.\start-copilot.cmd "C:\Projects\my-project"
```

Use `start-copilot.cmd` in CMD, or `./start-copilot.cmd` in Git Bash. In CMD, `cd /d <repository-path>` changes drives too. A workspace argument must be an existing directory. Omitting it uses your current working directory.

## WSL

Install Linux Node and Claude Code inside WSL and build in a Linux checkout. Do not share Windows `node_modules`. Confirm `command -v claude` uses Linux's launcher. Windows Chrome remains the browser. See [WSL setup](wsl.md) for loading the extension files.

```bash
npm ci --registry=https://registry.npmjs.org
npm run build
bash ./start-copilot.sh --gateway-only
node dist/packages/cli/index.js setup
# After pairing Windows Chrome to this WSL gateway:
bash ./start-copilot.sh --check
bash ./start-copilot.sh /mnt/d/my-project
```

The public shell launcher needs neither a specific Linux username nor a preinstalled systemd service or `claude-copilot` command. It can reuse an existing service-owned gateway.

## Daily start and restart recovery

The launchers reuse a healthy gateway or start a detached one on its saved port. Fresh state defaults to Windows port `59173`, Linux/WSL port `59175`. New gateways allow 2,000,000 prompt characters; existing gateways retain their configuration. Default native flags are `--teammate-mode in-process --permission-mode auto`; Auto Mode retains native automated permission checks and initial trust prompts. Override with `--permission-mode default` for ordinary prompts. Split-pane teams have an observed routing failure and are not recommended.

Use `--model sonnet` or `--compact-window 200k` before `--`. Other native flags may follow `--`. `--gateway-only` starts only the gateway, without waiting for Chrome; `--check` starts/checks the gateway and waits for Chrome readiness, without launching Claude Code.

A reboot or WSL shutdown can stop the gateway. Reopen signed-in Chrome, the workbook and Copilot, then rerun the launcher. If Chrome restored a different tab, select it and click **Use selected Excel tab**. No login automation or OS autostart service is installed. Startup waits about 15 seconds for a gateway and 35 seconds for Chrome. If readiness fails, the gateway remains available while you repair the browser and rerun.

## Switching environments

**Starting the destination gateway does not change the extension's current target.** The extension connects to one gateway at a time. Windows and WSL have separate state/credentials.

1. Finish/cancel pending requests and exit the old native client. Switching while a request is pending is rejected.
2. Start the destination with `--gateway-only`. Pair each gateway once with that environment's `setup` code.
3. For later switches, select the intended workbook and set **Local gateway** to the saved destination URL. Leave the pairing code empty and click **Switch gateway and use selected tab**.
4. Run the destination's `--check`, then launch its native client. Both `connected` and `ready` must be `true`.

Saved credentials remain in Chrome extension local storage. **Disconnect and clear pairing** clears all saved targets. Use distinct workbook tabs for the two environments where possible. Switching rebinds the main tab and retires old auxiliary/agent bindings; do not assume an older native session can seamlessly continue across gateways or changed main chats.

## Troubleshooting

- **fetch failed:** the older direct `run` command requires a running gateway. Use the new launcher and `--check` first.
- **Extension not connected:** verify Chrome is open and the popup targets the correct environment/port.
- **Copilot not ready:** verify login, workbook, Chat mode, no unsent draft/generation, and selected-tab binding.
- **No saved pairing / rejected credentials:** run `setup` in the destination. If its one-time code was already used, stop/restart that idle gateway for a fresh code and pair once.
- **Not built / module missing:** run installation/build commands in this checkout. Do not copy another machine's absolute paths.
- **PowerShell scripts disabled:** use `.cmd` wrappers; no global execution-policy change is needed.
- **Authentication/status failure:** run `doctor` and inspect port occupancy; the launcher does not hide auth errors or overwrite credentials.
- **409 uncertain delivery:** inspect actual tool effects before resetting the session/agent named by the error. See [recovery](../../README.en.md#recovery-and-stopping).

Run `node dist/packages/cli/index.js doctor` for diagnostics, or `stop` in the same environment to stop the gateway. Exiting Claude Code leaves the gateway running. Detached logs are in that environment's `~/.m365-claude-bridge/gateway.stdout.log` and `gateway.stderr.log`; service-owned gateways use service logs. Do not publish credentials/private histories.

First acceptance: ask Claude Code to create/read a disposable `hello.md` file, then check disk contents. In WSL also request `uname -s` and verify `Linux`.
