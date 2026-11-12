#!/usr/bin/env bash
# Build the claude.ai upload zip from the committed source (HEAD):
# a prebuilt single-file server bundle, no node_modules needed.
# Usage: scripts/package-upload.sh [output.zip]   (needs mcp-server/node_modules)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(realpath -m "${1:-$REPO/../agent-video-vision-upload.zip}")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/agent-video-vision"
mkdir -p "$STAGE"
git -C "$REPO" archive HEAD | tar -x -C "$STAGE"
rm -rf "$STAGE/.github" "$STAGE/codex" "$STAGE/scripts" "$STAGE/mcp-server/tests" "$STAGE/mcp-server/scripts" "$STAGE/mcp-server/package-lock.json"
ln -s "$REPO/mcp-server/node_modules" "$STAGE/mcp-server/node_modules"
(cd "$STAGE/mcp-server" && ./node_modules/.bin/esbuild src/index.ts --bundle --platform=node --format=esm \
  --target=node20 --outfile=dist/index.js --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);")
chmod +x "$STAGE/mcp-server/dist/index.js"
rm "$STAGE/mcp-server/node_modules"
rm -f "$OUT"
(cd "$WORK" && python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', '.', 'agent-video-vision')" "$OUT")
echo "wrote $OUT"
