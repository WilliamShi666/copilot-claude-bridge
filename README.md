# Copilot Claude Bridge

[English documentation](README.en.md)

[![CI](https://github.com/WilliamShi666/copilot-claude-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamShi666/copilot-claude-bridge/actions/workflows/ci.yml)

通过本地网关与 Chrome 扩展，让原生 **Claude Code 使用网页版 Excel Copilot 中的 Claude 模型**。Read、Write、Edit、Bash、MCP 等工具仍由 Claude Code 在本地执行，保留原生权限检查。

这是非官方、实验性的网页 UI 集成。你需要自行拥有可用的 Microsoft 365 Copilot 账号，并在 Excel 中能选到对应模型。它不会新增账号的模型权限，也不保证任意任务、任意账号都可用。

## 使用前提

**个人账号需订阅 Microsoft 365 Premium。** 在本地 Chrome 中使用该订阅账号登录 [网页版 Excel](https://excel.cloud.microsoft/)，打开工作簿与 Copilot，确认能选择所需的 Claude 模型，并切换到 Chat 模式后再配对。使用期间保持浏览器登录、工作簿和 Copilot 面板打开。

具备模型选择权限的商业 Microsoft Copilot 订阅也可使用；企业账号的 Claude 权限需管理员启用 Anthropic。具体许可要求见 [微软官方 Excel Copilot 常见问题](https://support.microsoft.com/en-us/excel/copilot/frequently-asked-questions-about-copilot-in-excel)。

## Windows 快速启动

先安装 Node.js 22+、Chrome 120+ 和原生 Claude Code，下载本仓库源码。在仓库根目录打开 PowerShell：

```powershell
git clone https://github.com/WilliamShi666/copilot-claude-bridge.git
cd copilot-claude-bridge
npm.cmd ci --registry=https://registry.npmjs.org
npm.cmd run build
.\start-copilot.cmd --gateway-only
```

网关会在后台运行。仍在同一仓库根目录执行：

```powershell
node dist/packages/cli/index.js setup
```

1. Chrome 打开 `chrome://extensions`，启用开发者模式，加载仓库的 `dist/extension` 文件夹。
2. 登录网页版 Excel，打开自己的工作簿与 Copilot，切换为 Chat 模式，清除未发送草稿并等生成结束。
3. 打开扩展 **M365 Claude Bridge (Experimental)**，填入 `setup` 显示的本地网关地址与一次性配对码。
4. 点 **Pair selected Excel tab**，检查并允许所需 Office 页面权限。如果扩展提示刷新工作簿，就刷新并重新打开 Copilot。
5. 执行 `doctor`，确认 `workerConnected` 与 `browserReady` 都为 `true`。

```powershell
node dist/packages/cli/index.js doctor
.\start-copilot.cmd "C:\Projects\my-project"
# 使用 Sonnet：
.\start-copilot.cmd "C:\Projects\my-project" --model sonnet
```

把工作目录换成真实存在的目录。首次验证建议使用空的临时目录，输入：**创建 hello.md，内容为 hello，然后读取确认。** 对照原生工具结果与磁盘文件，不要关闭权限检查。一个配对工作簿同时只启动一个主会话。

日常启动和重启后都用这个入口：它会复用或自动启动网关，再等待 Chrome 就绪。CMD 使用 `start-copilot.cmd`，Git Bash 使用 `./start-copilot.cmd`。默认同进程队友与原生 Auto Mode，可用 `--permission-mode default` 改回普通权限提示。完整步骤见 [安装、启动、重启恢复与 Windows / WSL 切换说明](docs/public/startup.md)。

当前适配器目标是 Opus 5.5 / Sonnet 5.5。压缩摘要使用 GPT-6.1 Sol，遇到可恢复的传输或 JSON 格式错误时回退 GPT-6 Sol；完整回退链需要账号同时有这两个模型。明确的服务拒绝与不安全的聊天状态不会通过换模型重试。

## WSL 与上下文

支持 Ubuntu WSL 中的原生 Linux Claude Code；Chrome 留在 Windows。需在 WSL 内单独安装 Node 与依赖，不要混用 Windows 的 `node_modules`。按 [WSL 安装说明](docs/public/wsl.md) 将扩展配对到 WSL 网关。

WSL 仓库内使用 `bash ./start-copilot.sh /mnt/d/my-project`。Windows 默认端口 `59173`，WSL 默认 `59175`；启动目标网关不会自动切换扩展。首次分别配对后，扩展会记住各端配对；再次切换只需选择目标地址、保持码为空，再点 **Switch gateway and use selected tab**。操作前完成/取消旧请求并退出旧客户端，详见 [切换说明](docs/public/startup.md#切换-windows-与-wsl)。

默认客户端压缩窗口为 `533k`，在已测试客户端上扣除预留后约为 500k 输入。可用 `--compact-window 200k` 调小。这是客户端配置，不代表已证明 Copilot 的服务端容量；显示的 token 数为本地估算。大上下文使用上述 200 万字符网关配置；普通默认仅 18 万字符。完整行为见 [上下文说明](docs/public/context.md)。

普通轮次在同一个已校验的 Copilot 主聊天中增量传递。标题与摘要使用独立辅助聊天。首次请求包含系统指令、工具定义和历史，所以可能很长；分段传输还会产生多条 Copilot 消息。原生压缩完成后，主聊天会从 Claude Code 的摘要上下文重新开始。

子代理与同进程 Agent Teams 按原生 session ID、agent ID 和模型区分上下文，每个 agent 使用独立的桥接器标签页并继续自己的聊天。浏览器端模型请求统一排队执行，本地工具仍由 Claude Code 管理。排队等待与生成分别计时；取消未发送的代理请求不会取消正在运行的兄弟代理。当前最多保留 16 个 agent 标签页，结束后可手动关闭；分屏 Agent Teams 已观察到子进程身份未转发导致主会话 409，当前建议使用 in-process。更新扩展后，`doctor` 的 `capabilities.agentContexts` 应为 `1`。

原生 Auto Mode 已通过有限的真实验收：三位命名队友同时启动后，继续各自完成 Write、Read 和 Bash，无需手动点 Yes；详细范围和限制见[验收记录](docs/public/validation.md)。

## 常见问题

**扩展未就绪：** 确认网关地址、登录状态、配对工作簿、Copilot 面板和 Chat 模式，检查未发送草稿。重新运行 `doctor`。重建扩展后需重载扩展、刷新工作簿，再使用 **Use selected Excel tab** 恢复现有配对。

**409 上下文投递不确定：** 先等待或取消当前请求，再按错误中显示的原生 session ID 执行：

```powershell
node dist/packages/cli/index.js context-reset --session <native-session-id>
```

检查磁盘上是否已经有工具执行的结果，再从 Claude Code 重试。重置不会撤销已执行的操作；网关不会自动重发不确定请求。

如果错误属于子代理，使用错误中提供的 `--agent <agent-id>` 参数，仅重置该代理：`context-reset --session <native-session-id> --agent <agent-id>`。

**PowerShell 阻止脚本：** 使用 `npm.cmd`、`claude.cmd` 避开 npm 的 `.ps1` 启动器。网关启动原生 `claude.exe`；发现失败时，将 `CLAUDE_CODE_EXECUTABLE` 设为它的绝对路径。

**停止网关：** `node dist/packages/cli/index.js stop`。

省略 `--experimental-copilot-backend` 则保留原始模型提供商，并只加入 Copilot 规划/审阅顾问。这需要你原有的模型配置独立可用。桌面 Excel 适配器仅支持此顾问模式。

## 隐私、验证与贡献

请求上下文和工具输出会发送到 Copilot，可能包含私有代码、路径和敏感信息。详见 [隐私与安全说明](SECURITY.md)。这是纯文本、等待网页完成后再返回的传输，无法提供真实服务端 token 计量、计费或完整 API 能力。

查看 [实测范围](docs/public/validation.md)、[限制](docs/public/limitations.md) 、[贡献指南](CONTRIBUTING.md) 与 [变更记录](CHANGELOG.md)。本地测试通过不等于任意账号真实可用。

使用 MIT 许可证，见 [LICENSE](LICENSE)。源码公开于 [GitHub](https://github.com/WilliamShi666/copilot-claude-bridge)，尚未发布 npm 包；内部兼容名称仍为 `m365-claude-bridge`。源码包仅导出明确允许公开的文件，不包含私人验收记录、浏览器配置、运行凭据或本机测试脚本。
