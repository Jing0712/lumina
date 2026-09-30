#!/usr/bin/env bash
# Start agent + gateway + UI WITHOUT nested `npm run` calls (so an old npm elsewhere on
# PATH can never be picked up and loop). Ctrl+C stops all three.
set -e
cd "$(dirname "$0")"
BIN="$PWD/node_modules/.bin"
echo "node $(node -v) — building contract…"
node node_modules/typescript/bin/tsc -p packages/contract/tsconfig.json
trap 'echo; echo stopping…; kill 0' INT TERM EXIT
(cd backend/agent   && "$BIN/tsx" watch src/index.ts 2>&1 | sed 's/^/[agent]   /') &
(cd backend/gateway && "$BIN/tsx" watch src/index.ts 2>&1 | sed 's/^/[gateway] /') &
# Vite only reads env files from web/, so hand it the gateway URL from the root .env.
VITE_API_URL="$(grep -E '^VITE_API_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
export VITE_API_URL="${VITE_API_URL:-http://localhost:8787}"
echo "UI will call the gateway at $VITE_API_URL"
(cd web             && "$BIN/vite" 2>&1 | sed 's/^/[web]     /') &
wait
