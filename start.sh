#!/usr/bin/env bash
# Starts the agent-video-vision MCP server. Kicks off bootstrap.sh in the
# background first, so a fresh machine sets itself up while the session starts.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.agent-video-vision"
nohup bash "$ROOT/bootstrap.sh" >> "$HOME/.agent-video-vision/bootstrap.log" 2>&1 < /dev/null &
exec node "$ROOT/mcp-server/dist/index.js"
