#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export CI=1
export npm_config_audit=false
export npm_config_fund=false

node --version
npm --version

# This repo intentionally has no lockfile. Avoid creating one in Codex setup.
npm install --package-lock=false
npm run check
npm test
