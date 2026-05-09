#!/usr/bin/env bash
set -euo pipefail

cd "${CODEX_WORKTREE_PATH:-$(dirname "${BASH_SOURCE[0]}")/..}"

if [ -f docker-compose.yml ] || [ -f docker-compose.yaml ] || [ -f compose.yml ] || [ -f compose.yaml ]; then
  docker compose down --remove-orphans 2>/dev/null || true
fi

rm -rf .cache/tmp .next/cache .turbo .vitest .wrangler/tmp node_modules/.cache tmp
