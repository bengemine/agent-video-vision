# agent-video-vision on OpenAI Codex CLI

agent-video-vision is a **dual plugin** — the same repo ships both a Claude Code manifest (`.claude-plugin/plugin.json`) and a Codex manifest (`.codex-plugin/plugin.json`). On Codex the primary install path is the plugin itself.

## Install (recommended): Codex plugin

Install **agent-video-vision** from the Codex plugin browser / marketplace. The plugin provides:

- the `video-perception` and `setup-video-vision` skills (from the plugin's `skills/` dir)
- the MCP server registration (via the plugin's `.mcp.json` — Codex sets `CLAUDE_PLUGIN_ROOT`, so the shared config works in both hosts)

Then ask:

> set up video vision

The setup skill picks an engine, installs dependencies, downloads the model, and does the two Codex-specific steps below (frame-describer agent + paths mode).

## Build the server

The MCP server must be built once (also needed for manual setup):

```bash
cd ~/agent-video-vision/mcp-server
npm install
npm run build
```

## Manual setup (fallback, no plugin)

If you don't install the plugin, wire things up by hand:

### 1. Register the MCP server

Add to `~/.codex/config.toml` (use the absolute path to your clone):

```toml
[mcp_servers.agent-video-vision]
command = "node"
args = ["/home/YOUR_USER/agent-video-vision/mcp-server/dist/index.js"]  # absolute path — ~ does not expand in TOML
```

Restart Codex. The `video_*` tools (`video_info`, `video_analyze`, `video_watch`, `video_detail`, `video_setup`, `video_configure`) are now available.

### 2. Install the skills

Copy or symlink `skills/video-perception` and `skills/setup-video-vision` into a skills directory Codex reads (`~/.agents/skills/`, `~/.codex/skills/`, or project `.agents/skills/`):

```bash
ln -s ~/agent-video-vision/skills/video-perception ~/.codex/skills/video-perception
ln -s ~/agent-video-vision/skills/setup-video-vision ~/.codex/skills/setup-video-vision
```

(Or use `npx skills add bengemine/agent-video-vision`.)

### 3. Run setup

Ask Codex:

> set up video vision

## The frame-describer custom agent

Codex plugins cannot bundle agents, so the setup skill copies the agent definition into your personal agents dir:

```bash
mkdir -p ~/.codex/agents
cp ~/agent-video-vision/codex/agents/frame-describer.toml ~/.codex/agents/
```

It describes extracted video frames as concise text (one `Frame at [timestamp] — ...` line per frame). Codex only uses custom agents when they are **named explicitly** — the `video-perception` skill names "frame-describer" when delegating batch frame description.

## How frames reach Codex (paths mode)

Codex **cannot see inline (base64) images in MCP tool results**. Use `frame_mode: "paths"` instead — the setup skill configures this:

```
video_configure { "frame_mode": "paths" }
```

In paths mode, `video_watch` and `video_detail` return `timestamp -> /abs/path` lists of extracted frame files. Codex opens the frames it needs with its `view_image` tool, or hands batches to the frame-describer agent.

**Descriptions mode** (`frame_mode: "descriptions"`): the server returns frames plus a neutral instruction; Codex fulfills the descriptions itself — inline for a few frames, or via the frame-describer agent for batches.

## Billing

The server makes zero LLM calls. All visual understanding happens inside your interactive Codex session, on your existing ChatGPT subscription. No API keys.
