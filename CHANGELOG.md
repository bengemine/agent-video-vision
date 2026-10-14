# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-14

### Changed

- **Transcription engine switched to Fluid Speech Mini** (`engine: "fluid-speech"`), replacing the Parakeet engine. Same Parakeet-class English accuracy in a ~300MB download (was ~670MB), ~0.7GB RAM (was ~2GB), and faster on CPU (~8x realtime vs ~6x measured on a 12-core laptop). English only — use `whisper-cpp` for other languages.
- Runner is `python/fluid_speech_transcribe.py`: plain ONNX Runtime (no onnx-asr, no PyTorch), with segment timestamps derived from the TDT decoder's frame positions instead of a separate Silero VAD pass.
- The Python venv now needs **Python 3.12+** and **onnxruntime >= 1.31** (2-bit `MatMulNBits` support). The setup wizard uses `uv venv --python 3.12`.
- Config keys `parakeet_model_dir`, `parakeet_quantization`, `parakeet_python` are replaced by `fluid_model_dir` and `fluid_python`. Existing configs with `engine: "parakeet"` are migrated on load.

### Removed

- Parakeet engine, `onnx-asr` dependency and `python/parakeet_transcribe.py`.

## [0.1.0] - 2026-06-13

Initial release of **agent-video-vision**.

### Added

- **Local-only video perception MCP server** — extracts frames via ffmpeg and transcribes audio fully on-CPU. Zero LLM calls from the server; no API keys anywhere.
- **Parakeet engine** — NVIDIA Parakeet TDT 0.6B v3 (ONNX int8, via [onnx-asr](https://github.com/istupakov/onnx-asr) in a Python venv). ~5x realtime CPU transcription; the recommended default. Supports pointing at an existing Parakeet ONNX model dir (`parakeet_model_dir`) instead of downloading.
- **Whisper engines** — `whisper-cpp` (whisper-cli, with Silero VAD) and `whisper-python` as alternatives. Models auto-download from HuggingFace (`ggerganov/whisper.cpp`) on first use.
- **Agent-agnostic packaging** — works as a Claude Code plugin and as an OpenAI Codex CLI MCP server + skill. `codex/README.md` covers Codex setup. The `video-perception` skill is host-neutral.
- **Host-fulfilled frame descriptions** — in `descriptions` frame mode the server returns frames plus a neutral instruction; Claude Code spawns the `frame-describer` subagent, Codex describes the frames in-session.
- **MCP tools**: `video_info`, `video_analyze`, `video_watch`, `video_detail`, `video_setup`, `video_configure`.
- **Setup flow** — models are never shipped; the setup wizard creates the Python venv and downloads the Parakeet model from HuggingFace, with a `uv` fallback for systems without `python3-venv`.
- Config at `~/.agent-video-vision/config.json`: `engine` (`parakeet` | `whisper-cpp` | `whisper-python`), `whisper_model`, `parakeet_model_dir`, `parakeet_quantization`, `parakeet_python`, frame options.
