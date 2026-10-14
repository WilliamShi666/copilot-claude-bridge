#!/usr/bin/env bash
set -euo pipefail
bridge_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$bridge_root/scripts/run-copilot.mjs" "$@"
