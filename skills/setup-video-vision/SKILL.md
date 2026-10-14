---
name: setup-video-vision
description: Use when the user says "set up video vision", "install video vision", "configure video transcription", asks to configure agent-video-vision, or hits first-run setup errors (missing engine, venv, or Fluid Speech model). Interactive wizard — choose a transcription engine, install deps, download models, verify.
---

# Setup Video Vision

Guide the user through configuring agent-video-vision step by step. Ask one question at a time using multiple choice. Everything runs locally — there is no API key or cloud backend to configure.

## Step 0: Build the server (fresh installs)

A fresh plugin install ships source only — the MCP server must be built once. Find the repo root (it is two directories up from this SKILL.md file; on Claude Code plugin installs it lives under `~/.claude/plugins/`). Then check whether `mcp-server/dist/index.js` exists there. If it does not:

```bash
cd <repo-root>/mcp-server
npm install
npm run build
```

Requires Node.js 20+. If the `video_*` tools were unavailable in this session, the host must restart its session after the build (and, on Codex manual setups, after the config.toml wiring in "Host-specific final steps") for the MCP server to connect — tell the user this explicitly, and continue setup in the new session.

## Step 1: Engine Selection

Ask the user:

> Which local transcription engine do you want?
>
> **a) fluid-speech** (recommended) — Fluid Speech Mini, ONNX on CPU. ~8x realtime, ~0.7GB RAM, Parakeet-class accuracy. **English only.** Needs a one-time ~300MB model download and a small Python 3.12+ venv.
>
> **b) whisper-cpp** — whisper.cpp (`whisper-cli`). ~1–2x realtime, 99 languages. Models auto-download on first use.
>
> **c) whisper-python** — openai-whisper CLI. Slowest, 99 languages. Use only if you already have it installed.
>
> All engines use ffmpeg to extract video frames — your agent sees the frames directly.

## Step 2: Dependency Check

Call `video_setup` with the chosen engine. Report exactly what is present and what is missing (ffmpeg, whisper-cli, Python venv, Fluid Speech model dir, yt-dlp). Mention that `yt-dlp` is optional and only needed for YouTube URLs.

If the `video_*` tools are not available at all, jump to "Host-specific final steps" below to wire up the MCP server first, then come back here.

For anything missing, walk through the relevant section below.

## Step 3a: Fluid Speech Setup (engine = fluid-speech)

First ask:

> Do you already have the Fluid Speech Mini ONNX model directory on disk?
>
> **a) Yes** — give me the path
>
> **b) No** — download it for me (~300MB)

**If yes:** call `video_configure` with `fluid_model_dir` set to their path. Skip the model download below, but still verify the venv.

**If no (or venv missing), guide through these exact commands.**

The venv must be **Python 3.12 or newer**: the model's 2-bit weights need ONNX Runtime 1.31+, which is not published for older Pythons. Prefer `uv` — it downloads a private Python 3.12 if the system has none.

1. Create the venv:

```bash
uv venv --python 3.12 ~/.agent-video-vision/venv
```

Without uv (only if `python3.12` or newer is already installed):

```bash
python3.12 -m venv ~/.agent-video-vision/venv
```

If an old venv exists at that path (for example from the Parakeet engine), delete it first: `rm -rf ~/.agent-video-vision/venv`.

2. Install ONNX Runtime and the helpers:

```bash
uv pip install --python ~/.agent-video-vision/venv/bin/python "onnxruntime>=1.31" numpy soundfile huggingface_hub
```

pip variant (venvs made with `python -m venv` have pip; `uv venv` ones do not):

```bash
~/.agent-video-vision/venv/bin/pip install "onnxruntime>=1.31" numpy soundfile huggingface_hub
```

3. Download the ONNX build from HuggingFace (`FluidVoice-Labs/fluid-speech-mini-onnx`):

```bash
~/.agent-video-vision/venv/bin/python -c "
from huggingface_hub import snapshot_download
snapshot_download(
  'FluidVoice-Labs/fluid-speech-mini-onnx',
  ignore_patterns=['assets/*'],
  local_dir='~/.agent-video-vision/models/fluid-speech-mini-onnx'.replace('~', __import__('os').path.expanduser('~')),
)
print('done')
"
```

Offer to run these commands for the user. Run them one at a time and confirm each succeeds before the next.

WSL note: if the user points at a model dir under `/mnt/*` (a Windows drive), warn that it loads much slower than the Linux filesystem and suggest copying it to `~/.agent-video-vision/models/`.

## Step 3b: Whisper Setup (engine = whisper-cpp or whisper-python)

- **whisper-cpp:** needs the `whisper-cli` binary (`brew install whisper-cpp` on macOS, or build whisper.cpp from source on Linux). Models auto-download from HuggingFace (`ggerganov/whisper.cpp`) on first use — no manual download.
- **whisper-python:** needs the `whisper` CLI (`pip install openai-whisper`).

Then ask:

> Which whisper model?
>
> **a) tiny** (75MB) — very fast, basic quality
>
> **b) small** (500MB) — good balance
>
> **c) large-v3-turbo** (1.5GB) — best cost-benefit, 8GB+ RAM
>
> **d) large-v3** (2.9GB) — maximum quality, 16GB+ RAM
>
> **e) auto** — pick based on your hardware

Call `video_configure` with `whisper_model`.

## Step 4: Frame Configuration

Ask these one at a time (skip if user says "defaults"):

### Resolution
> Frame extraction resolution (width in pixels, height auto-scales)?
>
> **a) 256px** — low res, fast, fewer tokens
>
> **b) 512px** (default) — good balance
>
> **c) 768px** — higher detail
>
> **d) 1024px** — maximum detail, more tokens

Call `video_configure` with `frame_resolution`.

### Frame Mode
> How should frames be delivered?
>
> **a) Images** (Claude Code default) — frames come back as inline images in the tool result (better perception, more tokens)
>
> **b) Paths** (Codex default) — the tool returns `timestamp -> /abs/path` file lists; the agent opens the frame files it needs
>
> **c) Descriptions** — frames are converted to text descriptions by the host agent (fewer tokens, loses visual nuance)

Call `video_configure` with `frame_mode`. The host-specific section below has the right default per host.

## Step 5: Save Engine

Call `video_configure` with the chosen `engine` (plus `fluid_model_dir` if not already saved). Confirm the resulting config back to the user.

## Step 6: Host-specific final steps

Do the section matching the host you are running on.

### If you are Codex

1. **MCP server connection.** If the `video_*` tools are not available in this session, the MCP server isn't connected. Add this block to `~/.codex/config.toml` (use the absolute path to the plugin/clone directory):

   ```toml
   [mcp_servers.agent-video-vision]
   command = "node"
   args = ["/home/YOUR_USER/agent-video-vision/mcp-server/dist/index.js"]  # absolute path — ~ does not expand in TOML
   ```

   Then tell the user to restart the Codex session so the tools load.

2. **Install the frame-describer custom agent.** Codex plugins cannot bundle agents, so copy the TOML into the personal agents dir:

   ```bash
   mkdir -p ~/.codex/agents
   cp ~/agent-video-vision/codex/agents/frame-describer.toml ~/.codex/agents/
   ```

3. **Recommend paths mode.** Codex cannot see inline MCP images — it must open frame files with its `view_image` tool. Save it:

   ```
   video_configure { "frame_mode": "paths" }
   ```

### If you are Claude Code

Nothing extra — the plugin already provides the MCP server, skills, and the `frame-describer` subagent. Keep `frame_mode: "images"` (the default) so frames come back inline.

## Step 7: Verify

Run `video_setup` once more — everything should now report OK.

Then ask:

> Setup complete! Want to run a quick smoke test? Give me a path to any short video file.

If the user provides one, call `video_info` on it, then `video_analyze` with `transcription: true` to confirm the engine actually transcribes. Report duration, resolution, and the first transcription line.

## Important

- Ask ONE question at a time — never combine multiple questions
- Call `video_configure` after EACH answer to save incrementally
- If the user says "default" or "just use defaults", set engine to `fluid-speech` with defaults, jump to Step 2, then still do Step 6 for your host
- If the user seems experienced, keep it concise — don't over-explain
