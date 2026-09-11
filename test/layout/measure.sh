#!/usr/bin/env bash
# Render the harness headless at a given size and print the probe's JSON.
# Usage: measure.sh <width> <height> [route]
set -u
CHROME=${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}
W=${1:-1440}; H=${2:-900}; R=${3:-dashboard}
DIR="$(cd "$(dirname "$0")" && pwd)"
timeout 90 "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --hide-scrollbars=false --window-size="$W,$H" --force-device-scale-factor=1 \
  --virtual-time-budget=4000 --dump-dom "file://$DIR/harness.html#$R" 2>/dev/null \
  | tr -d '\n' | grep -o 'MEASURE:{[^<]*}' | sed 's/^MEASURE://'
