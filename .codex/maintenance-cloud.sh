#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export CI=1
export npm_config_audit=false
export npm_config_fund=false

npm install --package-lock=false
