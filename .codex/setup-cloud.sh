#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export CI=1
export npm_config_audit=false
export npm_config_fund=false

node --version
npm --version

# Resolve dependencies from the checked-in lockfile.
npm ci
npm run check
npm test
