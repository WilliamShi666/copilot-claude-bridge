# 安装、启动与 Windows / WSL 切换

[English](startup.en.md) · [返回仓库主页](../../README.md)

个人账号需要 Microsoft 365 Premium；具备相应权限的商业订阅见 [使用前提](../../README.md#使用前提)。还需要在本地 Chrome 登录的网页版 Excel、工作簿中可用的 Claude 模型，以及原生 Claude Code。保持工作簿和 Copilot 的 Chat 模式打开。桌面 Excel 不支持这里的直接模型桥接。

## 首次安装：Windows

先安装 Git、Node.js 22+ 和 Windows 原生 Claude Code。在 PowerShell 执行：

```powershell
git clone https://github.com/WilliamShi666/copilot-claude-bridge.git
cd copilot-claude-bridge
npm.cmd ci --registry=https://registry.npmjs.org
npm.cmd run build
.\start-copilot.cmd --gateway-only
node dist/packages/cli/index.js setup
```

`--gateway-only` 只启动后台网关，不启动 Claude Code，不等待首次配对。`setup` 显示网关地址、扩展目录和一次性本地配对码。

1. Chrome 打开 `chrome://extensions/`，开启开发者模式，用“加载已解压的扩展程序”选择仓库内的 `dist/extension`。
2. 登录 [网页版 Excel](https://excel.cloud.microsoft/)，打开一个工作簿和 Copilot，选择 Chat 模式；清空未发送草稿并等当前生成结束。
3. 在这个工作簿标签页打开 **M365 Claude Bridge (Experimental)** 扩展弹窗。
4. 输入 `setup` 显示的地址和配对码，点击 **Pair selected Excel tab**，按提示处理 Office 页面权限。配对码不是 Microsoft 登录密码或验证码。
5. 如提示刷新，刷新工作簿并重新打开 Copilot。运行下列检查，确认 `connected` 和 `ready` 都为 `true`。

```powershell
.\start-copilot.cmd --check
.\start-copilot.cmd "C:\Projects\my-project"
```

项目目录必须已存在。省略路径会在你执行命令的当前目录工作，而不是自动选择仓库或先前项目。

## 日常启动：Windows 三种终端

从仓库根目录启动：

| 终端 | 命令 |
| --- | --- |
| PowerShell | `.\start-copilot.cmd "C:\Projects\my-project"` |
| CMD | `start-copilot.cmd "C:\Projects\my-project"` |
| Git Bash | `./start-copilot.cmd "C:/Projects/my-project"` |

CMD 换盘进入仓库要用 `cd /d <仓库路径>`。在其他目录也可使用启动脚本的绝对路径，并明确传入项目目录。含空格的路径加双引号。

```cmd
"C:\Tools\copilot-claude-bridge\start-copilot.cmd" "C:\Projects\my-project"
```

默认使用 Opus、同进程 Agent Teams 和原生 Auto Mode；Auto Mode 保留 Claude Code 的自动权限检查，新目录仍可能出现信任提示。可用 `--permission-mode default` 恢复普通权限提示。分屏 Agent Teams 已观察到子进程缺失 agent 身份、主会话 409 的问题；当前建议使用默认的 `in-process`。

```powershell
.\start-copilot.cmd "C:\Projects\my-project" --model sonnet
.\start-copilot.cmd "C:\Projects\my-project" --compact-window 200k -- --permission-mode default
```

`--model` 和 `--compact-window` 放在 `--` 前；其后的选项传给原生 Claude Code。

## 首次安装与日常启动：Ubuntu WSL

在 **WSL 内**安装 Linux Node.js 22+ 和 Linux 原生 Claude Code。确认 `command -v node` 和 `command -v claude` 指向 Linux 安装，后者不能指向 Windows 的 npm 启动器。依赖要在 WSL 内安装，不要共享 Windows 的 `node_modules`。

```bash
mkdir -p "$HOME/projects"
cd "$HOME/projects"
git clone https://github.com/WilliamShi666/copilot-claude-bridge.git
cd copilot-claude-bridge
npm ci --registry=https://registry.npmjs.org
npm run build
bash ./start-copilot.sh --gateway-only
node dist/packages/cli/index.js setup
```

Chrome 留在 Windows。扩展可以使用 Windows 构建的同版本文件，或按 [WSL 说明](wsl.md) 加载 WSL 构建的扩展文件。将扩展配对到 **WSL 的** `setup` 地址，首次默认 `http://127.0.0.1:59175`。Windows 的配对不能代替 WSL 配对。

配对就绪后，在这个 WSL 仓库目录执行：

```bash
bash ./start-copilot.sh --check
bash ./start-copilot.sh /mnt/d/my-project
```

也可在任意 WSL 目录使用脚本绝对路径：

```bash
bash "$HOME/projects/copilot-claude-bridge/start-copilot.sh" /mnt/d/my-project
```

这个公开入口不依赖特定 Linux 用户、预装的 `claude-copilot` 命令或 systemd 服务。以前在自己的机器上安装过快捷入口的用户可以继续使用，但新用户不需要安装该快捷入口。

## 切换 Windows 与 WSL

两边的状态和凭据分别保存在各自用户的 `~/.m365-claude-bridge`。新安装默认端口如下；已有安装会沿用 `runtime.json` 中保存的端口，以实际 `setup` 输出为准。

| 执行环境 | 默认网关 | 使用的 Claude Code |
| --- | --- | --- |
| Windows | `http://127.0.0.1:59173` | Windows 原生客户端 |
| Ubuntu WSL | `http://127.0.0.1:59175` | Linux 原生客户端 |

**启动命令会启动目标网关，但不会替你把 Chrome 扩展切到另一端。** 扩展同时只连接一个网关。

1. 等待或取消当前请求，退出旧环境的 Claude Code。扩展会拒绝在未完成的请求中切换。
2. 在目标环境运行启动入口的 `--gateway-only`；第一次连接这一端时，执行 `setup` 并完成一次配对。
3. 再次切换到已经配对的网关时，选择目标 Excel 工作簿，打开扩展弹窗，将 **Local gateway** 改为目标地址；输入框的候选列表包含已经保存的网关。
4. 保持配对码为空，点击 **Switch gateway and use selected tab**。切换凭据保存在扩展本地，不需要新的配对码。**Disconnect and clear pairing** 会清除全部保存的网关配对。
5. 在目标环境运行 `--check`；只有 `connected: true`、`ready: true` 才启动目标环境的 Claude Code。

建议为两端分别使用一个 Excel 工作簿标签页。切换会重新绑定所选主标签页并退役旧的辅助/代理绑定；不要假设旧原生会话可以跨网关或换主聊天后无缝继续。需要延续旧历史时先检查上下文状态，按错误提示恢复。

## 电脑重启或网关停止后

普通后台进程会随 Windows 重启或 WSL 关闭而结束。启动入口会复用可用网关，或按保存的端口启动新网关；原有配对凭据保留。首次新网关允许最多 200 万字符的完整请求；复用网关不会修改它原先的限制。

1. 打开 Chrome，恢复登录状态，打开之前的工作簿和 Copilot Chat。
2. 执行相应启动入口。如果浏览器恢复了不同标签页，打开扩展点击 **Use selected Excel tab**。
3. 如果切换了 Windows / WSL，按上一节选择对应网关。

启动入口会等待网关启动约 15 秒，再等待浏览器连接约 35 秒；未就绪时会退出并显示恢复提示，网关继续在后台运行。恢复浏览器后再次执行即可，不要反复删除凭据或重置会话。

这不是开机自启服务，也不会自动登录 Microsoft。退出 Claude Code 不会停止网关。停止网关请在同一环境、仓库根目录执行：

```sh
node dist/packages/cli/index.js stop
```

## 常见报错

| 提示 | 检查和处理 |
| --- | --- |
| `fetch failed` | 旧的直接 `run` 命令要求网关已经运行。先用启动入口 `--check`；如果仍失败，查看目标环境的网关日志、端口和 `doctor` 输出。 |
| `extension is not connected` | 网关已运行，但 Chrome 未连接。尤其检查 Windows `59173` 与 WSL `59175` 是否选错。启动 WSL 不会自动改变扩展目标。 |
| `Copilot is not ready` | 打开所配对工作簿、登录、Copilot Chat，清除未发送草稿并等生成结束，再 **Use selected Excel tab**。 |
| `no saved pairing` 或旧凭据被拒绝 | 在目标环境执行 `setup`，需要新配对码时先确保空闲再停止并重启目标网关，再进行一次配对。不要把另一端的码拿来用。 |
| `Bridge is not built` / `MODULE_NOT_FOUND` | 在仓库根目录执行 `npm ci` 与 `npm run build`；不要将旧机器的绝对路径照搬。PowerShell 使用 `npm.cmd`。 |
| `.ps1 cannot be loaded` | PowerShell 使用 `.\start-copilot.cmd`、`npm.cmd`、`claude.cmd`，无需修改全局执行策略。 |
| `Gateway authentication/status failed` | 保留凭据，运行 `doctor` 并检查该端口是否被其他服务占用；启动入口不会覆盖错误或另开网关。 |
| `Finish or cancel the current request` | 先完成或取消原生请求，等网关空闲再切换，不要强行断开处理中的会话。 |
| `cancelContinuation` 不为 `1` / matching extension | 网关和扩展成套更新后，重载扩展、刷新配对工作簿，再运行 `doctor`。原有启动命令不变。 |
| 中断后等待取消确认 | 新反馈最多等待约 15 秒；可核实原聊天就增量续接，否则每次反馈最多在新标签页完整重建一次并提示。 |
| `Copilot refused ...` | 上游明确拒绝，不自动换模型、换聊天或重试。只改输出长度的重试仍显示原始错误；`context-reset` 不能解决服务拒绝。 |
| `409 Native context delivery is uncertain` | 旧记录或缺乏可信中断证据时保留保护。检查工具副作用，再按错误中的 session/agent 显式恢复；见 [主页恢复说明](../../README.md#常见问题)。 |

诊断命令：`node dist/packages/cli/index.js doctor`。后台启动日志位于对应环境的 `~/.m365-claude-bridge/gateway.stdout.log` 和 `gateway.stderr.log`；不要公开上传完整凭据、上下文和私人日志。通过 systemd 启动的既有 WSL 网关查看对应服务日志，而不是新入口的日志文件。

## 第一次使用验收

用空的临时项目目录，输入：**创建 hello.md，内容为 hello，然后读取确认。** 在 WSL 可再请求运行 `uname -s`，确认结果为 `Linux`。检查 Claude Code 的真实工具结果和磁盘文件，而不只看 Copilot 聊天里有没有响应。
