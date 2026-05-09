#!/usr/bin/env bash
set -euo pipefail

cd "${CODEX_WORKTREE_PATH:-$(dirname "${BASH_SOURCE[0]}")/..}"

if [ -x .codex/maintenance-cloud.sh ]; then
  bash .codex/maintenance-cloud.sh
else
  echo "No .codex/maintenance-cloud.sh found; skipping local worktree setup."
fi
