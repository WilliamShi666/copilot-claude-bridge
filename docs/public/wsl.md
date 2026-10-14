# Ubuntu WSL with Windows Chrome

The Node gateway and native Claude Code run inside Ubuntu WSL. The logged-in Excel web workbook and extension remain in Windows Chrome. Chrome must be able to reach the WSL gateway through localhost forwarding; no public tunnel is needed.

Personal accounts require Microsoft 365 Premium. Sign in to [Excel for the web](https://excel.cloud.microsoft/) in Windows Chrome with that subscription account before pairing. See the [account prerequisites](../../README.en.md#prerequisites) for commercial account eligibility.

Install Node.js 22+ and native Linux Claude Code in WSL using their upstream installation instructions. In Ubuntu, verify `node --version` and `claude --version`. `command -v claude` must resolve to a Linux launcher rather than Windows' npm directory. Clone into a Linux directory:

```sh
mkdir -p "$HOME/projects"
cd "$HOME/projects"
git clone https://github.com/WilliamShi666/copilot-claude-bridge.git
cd copilot-claude-bridge
npm ci --registry=https://registry.npmjs.org
npm run build
bash ./start-copilot.sh --gateway-only
```

The gateway runs in the background. From the same **WSL** checkout:

```sh
node dist/packages/cli/index.js setup
```

The extension files built in WSL are available to Windows through the distro's network path, for example `\\wsl.localhost\Ubuntu\home\<linux-user>\projects\copilot-claude-bridge\dist\extension`. In Chrome's Load unpacked dialog, choose that directory. If Chrome cannot load from that network path, copy the complete built `dist/extension` folder to a local Windows directory and load that copy. Repeat the copy and reload the extension after rebuilding it.

Pair the extension using `http://127.0.0.1:59175` and the code printed by the WSL `setup` command. Select your signed-in Excel workbook and open Copilot in Chat mode. Pairing with a previous Windows gateway does not pair the WSL gateway. The extension uses one gateway at a time.

```sh
node dist/packages/cli/index.js doctor
mkdir -p "$HOME/projects/copilot-demo"
bash ./start-copilot.sh "$HOME/projects/copilot-demo"
```

Proceed only when `doctor` shows `workerConnected: true` and `browserReady: true`. Native tool permission prompts remain in effect. To check Linux execution, ask Claude Code to create/read a small file and run `uname -s` after approving that command.

If Chrome cannot connect, check that Windows can reach the loopback URL, WSL is running, localhost forwarding is enabled, and the selected port is not occupied by a Windows service. Keep the gateway bound to `127.0.0.1`; changing it to a LAN address is not a supported workaround.

Do not share `node_modules` between Windows and WSL. Dependencies such as esbuild install a platform-specific binary. WSL state is in the Linux user's `~/.m365-claude-bridge`, separate from Windows state. The repository launcher instructions above do not install a system service or depend on a particular Linux username.

After installing and pairing, you may run the local CLI from Windows with `wsl.exe -d Ubuntu --cd <checkout-path> -- node dist/packages/cli/index.js run --experimental-copilot-backend --cwd <linux-workspace>`. Replace paths with your own installation. Run `stop` inside the same WSL environment when finished.

For daily startup, reboot recovery and switching an already paired Windows extension to WSL, see [startup and environment switching](startup.en.md) ([中文](startup.md)). Each environment must be paired once. Saved gateway switches use the popup with an empty code; simply starting WSL does not change the extension target.
