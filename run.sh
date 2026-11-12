#!/bin/sh
# One command: run both setups on all 50 tasks, then score the run.
#   ANTHROPIC_API_KEY=... ./run.sh /Applications/Browz.app [out dir] [more bench.mjs options...]
# Your Claude credential stays in your environment; it is never written to disk.
set -eu
[ $# -ge 1 ] || { echo "usage: ./run.sh <Browz.app or install folder> [out dir] [bench.mjs options...]" >&2; exit 2; }
BROWZ=$1; OUT=${2:-runs/$(date -u +%Y-%m-%d)}; [ $# -ge 2 ] && shift 2 || shift 1
cd "$(dirname "$0")"
node bench.mjs --browz "$BROWZ" --out "$OUT" "$@"
node score.mjs "$OUT" --write
echo "Run folder: $OUT (check it with: node redact.mjs $OUT --check)"
