# Optional Windows Excel desktop advisor

This is a separate transport for a local Windows Excel Copilot pane. It supports **original-provider plus Copilot advisor**, not the experimental inference backend. It may briefly focus the selected Excel window. The Chrome permissions do not apply to this transport.

Requirements: Windows x64 with local Excel/Copilot, Node 22+, native Claude Code and the Windows .NET Framework C# compiler. Build from the repository root:

```powershell
npm.cmd run build
npm.cmd run build:desktop
node dist/packages/cli/index.js desktop-windows
```

Choose the returned Excel window handle explicitly, open Copilot in Chat mode, and start the gateway:

```powershell
node dist/packages/cli/index.js start --backend excel-desktop --window <handle>
```

Keep that terminal open, then run from a second terminal in the same checkout:

```powershell
node dist/packages/cli/index.js doctor --backend excel-desktop
node dist/packages/cli/index.js run --backend excel-desktop --cwd "C:\Projects\my-project"
```

The original provider must work independently. Desktop state defaults to `~/.m365-claude-bridge-excel-desktop`, separate from browser state. No Chrome pairing is needed. Stop with `node dist/packages/cli/index.js stop --backend excel-desktop`.

Desktop accessibility layout changes can break the adapter. This optional build has not been included in the clean-source browser release validation; treat it as a separate experimental feature.
