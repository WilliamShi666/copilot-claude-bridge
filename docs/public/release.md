# Preparing public source

Suggested repository name: **copilot-claude-bridge**.

Suggested GitHub description:

> An experimental local bridge that lets Claude Code use Claude models in Microsoft 365 Copilot through Excel and Chrome.

Suggested topics: `claude-code`, `microsoft-365`, `copilot`, `excel`, `chrome-extension`, `wsl`, `llm-gateway`.

The package/extension identifiers retain `m365-claude-bridge` for compatibility. `private: true` intentionally prevents accidental npm publication. MIT applies to this project's source; dependencies retain their own licenses. No Microsoft/Anthropic product binaries, credentials, browser profiles or native client installation are included.

## Export

```sh
npm run export:source
```

This creates a new directory under `release-staging/`, copies an explicit list of public source/docs/tests, scans it, validates local Markdown links, and writes a SHA-256 file manifest. It refuses an existing output directory and symlinks. It omits private `evidence/`, `tasks/`, old internal docs and personal live QA helpers; `node_modules`, `dist`, local state and archives are also omitted. The scan checks common token/private-key patterns, machine-specific paths, personal workbook URLs and currently stored local bridge credentials when available. It is a targeted check, not a guarantee that arbitrary future files contain no secrets. Review the export before publication.

Use **only this exported directory** for the initial public repository. Do not upload the original development folder wholesale. Build artifacts are reproducible with `npm ci` and `npm run build`. The manifest covers source inputs, not locally generated dependencies/build output.

## Before publishing

- Confirm the repository name, owner and description; inspect the exported README, LICENSE and source manifest.
- In the export, run a clean `npm ci`, `npm run typecheck`, `npm test`, `npm run test:export`, `npm audit` and `npm run export:source`.
- Review excluded/allowed files and the final diff; ensure no source from third parties was added without appropriate notices.
- Create/publish the public GitHub repository only after explicit authorization. Enable private vulnerability reporting and inspect the first hosted CI run.
- If providing a downloadable extension later, build it from reviewed source and identify the matching commit/version. No prebuilt extension is included in this source-only preparation.

Local preparation does not create a repository, push source, publish a release or publish to npm. The source export preserves the live gateway and current Chrome pairing.
