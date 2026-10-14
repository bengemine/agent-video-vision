# Privacy Policy

**Last updated:** 2026-06-12

This document describes how `agent-video-vision` handles your data.

## Summary

- **Everything runs locally.** Video, audio, frames, and transcription never leave your machine.
- **No API keys, no cloud backends.** Transcription runs on your CPU (Fluid Speech Mini or Whisper).
- **No telemetry**, no analytics, no account, no crash reporting, no usage tracking.
- **No data is collected** by the maintainer.

## Data the server processes

When your agent analyzes a video:

1. **The video file you provide** is read from your local filesystem.
2. **Frames are extracted** using `ffmpeg` into a temporary directory, then cleaned up.
3. **Audio is extracted** into a temporary `.wav` file and transcribed locally by the configured engine (Fluid Speech Mini ONNX or Whisper), then cleaned up.
4. **Frames and transcription are returned to your agent's session** (Claude Code or Codex CLI). What happens in that session is governed by your agent provider's terms — the server itself sends nothing anywhere.

## Network activity

The only network calls this project ever makes:

- **Model downloads at setup time** from HuggingFace:
  - Fluid Speech Mini: `huggingface.co/FluidVoice-Labs/fluid-speech-mini-onnx` (one-time, ~300MB)
  - Whisper: `huggingface.co/ggerganov/whisper.cpp` (one-time per model, on first use)
- **Optional YouTube downloads** via `yt-dlp`, only when you explicitly pass a YouTube URL.
- **PyPI** during setup, when installing `onnxruntime`, `numpy`, `soundfile` and `huggingface_hub` into the local venv.

That's it. No other endpoints are contacted. There are no API keys to leak because none are used.

## Local files

The server writes and reads these locations on your machine:

- `~/.agent-video-vision/config.json` — engine and extraction preferences
- `~/.agent-video-vision/models/` — downloaded transcription models
- `~/.agent-video-vision/venv/` — Python venv for the Fluid Speech engine
- `~/.agent-video-vision/sessions/` — cached frames per video (when enabled; auto-expired)
- `~/.agent-video-vision/downloads/` — videos downloaded via `yt-dlp` for YouTube URLs (auto-expired)
- OS temporary directory — frames and audio for a single analysis (cleaned up after each call)

None of these files leave your machine.

## Changes to this policy

Changes will be committed to this file in the public repository. The git history provides a full audit trail.
