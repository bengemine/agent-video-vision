---
description: "Interactive setup wizard for agent-video-vision — choose a transcription engine, install deps, download models, verify"
---

# Setup Video Vision

Guide the user through configuring agent-video-vision step by step. Ask one question at a time using multiple choice. Everything runs locally — there is no API key or cloud backend to configure.

## Step 1: Engine Selection

Ask the user:

> Which local transcription engine do you want?
>
> **a) parakeet** (recommended) — NVIDIA Parakeet TDT 0.6B v3, ONNX int8 on CPU. ~5x realtime, English + 24 European languages. Needs a one-time ~670MB model download and a small Python venv.
>
> **b) whisper-cpp** — whisper.cpp (`whisper-cli`). ~1–2x realtime, 99 languages. Models auto-download on first use.
>
> **c) whisper-python** — openai-whisper CLI. Slowest, 99 languages. Use only if you already have it installed.
>
> All engines use ffmpeg to extract video frames — your agent sees the frames directly.

## Step 2: Dependency Check

Call `video_setup` with the chosen engine. Report exactly what is present and what is missing (ffmpeg, whisper-cli, Python venv, Parakeet model dir, yt-dlp). Mention that `yt-dlp` is optional and only needed for YouTube URLs.

For anything missing, walk through the relevant section below.

## Step 3a: Parakeet Setup (engine = parakeet)

First ask:

> Do you already have a Parakeet ONNX model directory on disk (for example from the Handy app)?
>
> **a) Yes** — give me the path
>
> **b) No** — download it for me (~670MB)

**If yes:** call `video_configure` with `parakeet_model_dir` set to their path. Skip the model download below, but still verify the venv.

**If no (or venv missing), guide through these exact commands.**

1. Create the venv:

```bash
python3 -m venv ~/.agent-video-vision/venv
```

If that fails (missing `python3-venv` / "ensurepip is not available"), use uv instead:

```bash
uv venv ~/.agent-video-vision/venv
```

2. Install onnx-asr (note the onnxruntime pin — newer versions break onnx-asr):

```bash
~/.agent-video-vision/venv/bin/pip install "onnx-asr[cpu,hub]" "onnxruntime<1.24"
```

uv variant:

```bash
uv pip install --python ~/.agent-video-vision/venv/bin/python "onnx-asr[cpu,hub]" "onnxruntime<1.24"
```

3. Download the int8 model from HuggingFace (`istupakov/parakeet-tdt-0.6b-v3-onnx`):

```bash
~/.agent-video-vision/venv/bin/python -c "
from huggingface_hub import snapshot_download
snapshot_download(
  'istupakov/parakeet-tdt-0.6b-v3-onnx',
  allow_patterns=['*.int8.onnx', 'vocab.txt', 'config.json'],
  local_dir='~/.agent-video-vision/models/parakeet-tdt-0.6b-v3-int8'.replace('~', __import__('os').path.expanduser('~')),
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
> **a) Images** (default) — the agent sees the actual frames (better perception, more tokens)
>
> **b) Descriptions** — frames are converted to text descriptions (fewer tokens, loses visual nuance). On Claude Code this uses the frame-describer subagent; on Codex the agent describes frames itself.

Call `video_configure` with `frame_mode`.

## Step 5: Save Engine

Call `video_configure` with the chosen `engine` (plus `parakeet_model_dir` if not already saved). Confirm the resulting config back to the user.

## Step 6: Verify

Run `video_setup` once more — everything should now report OK.

Then ask:

> Setup complete! Want to run a quick smoke test? Give me a path to any short video file.

If the user provides one, call `video_info` on it, then `video_analyze` with `transcription: true` to confirm the engine actually transcribes. Report duration, resolution, and the first transcription line.

## Important

- Ask ONE question at a time — never combine multiple questions
- Call `video_configure` after EACH answer to save incrementally
- If the user says "default" or "just use defaults", set engine to `parakeet` with defaults and jump to Step 2
- If the user seems experienced, keep it concise — don't over-explain
