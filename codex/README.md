# agent-video-vision on OpenAI Codex CLI

Codex CLI uses the same MCP server and skill as Claude Code — only the wiring differs.

## 1. Build the server

```bash
cd /path/to/agent-video-vision/mcp-server
npm install
npm run build
```

## 2. Register the MCP server

Add to `~/.codex/config.toml` (use the absolute path to your clone):

```toml
[mcp_servers.agent-video-vision]
command = "node"
args = ["/absolute/path/to/agent-video-vision/mcp-server/dist/index.js"]
```

Restart Codex. The `video_*` tools (`video_info`, `video_analyze`, `video_watch`, `video_detail`, `video_setup`, `video_configure`) are now available.

## 3. Install the skill

Copy or symlink `skills/video-perception` into your skills directory:

```bash
# If you use the shared ~/.agents/skills junction setup:
ln -s /absolute/path/to/agent-video-vision/skills/video-perception ~/.agents/skills/video-perception

# Otherwise, Codex's own skills dir:
ln -s /absolute/path/to/agent-video-vision/skills/video-perception ~/.codex/skills/video-perception
```

(Copy instead of symlink if you prefer: `cp -r ... ~/.codex/skills/video-perception`.)

The skill text is host-neutral — it works unchanged on Claude Code and Codex.

## 4. Run setup

There is no slash-command wizard in Codex. Just ask:

> set up video vision

Codex follows the skill: it runs `video_setup`, reports missing dependencies (ffmpeg, Python venv, Parakeet model), and walks you through venv creation and the ~670MB model download with exact commands. See the main [README](../README.md#setup-flow) for the commands if you'd rather run them yourself.

## How frames reach Codex

Frame images come back as **base64 images inside the MCP tool results**, which Codex renders directly in-session — no files to open manually.

**Descriptions mode** (`frame_mode: "descriptions"`): the server returns frames plus a neutral instruction; Codex views the images itself and writes the descriptions inline. There is no subagent involved (that's a Claude Code-only nicety).

## Billing

The server makes zero LLM calls. All visual understanding happens inside your interactive Codex session, on your existing ChatGPT subscription. No API keys.
