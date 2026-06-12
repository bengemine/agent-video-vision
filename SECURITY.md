# Security Policy

## Supported versions

Only the latest `0.x` release is actively supported.

## Reporting a vulnerability

If you find a security vulnerability in agent-video-vision, please **do not open a public issue**.

Instead, report it privately via GitHub Security Advisories on this repository.

Include:
- A description of the vulnerability
- Steps to reproduce
- The affected version
- Any suggested fix if you have one

I aim to respond within 7 days and issue a fix within 30 days for confirmed vulnerabilities.

## Scope

In scope:
- The MCP server code (`mcp-server/`)
- The plugin manifest and configuration (`.claude-plugin/`, `.mcp.json`)
- The slash commands, skill, and Codex packaging (`commands/`, `skills/`, `agents/`, `codex/`)

Out of scope:
- Issues in upstream dependencies — ffmpeg, yt-dlp, whisper.cpp, onnx-asr, onnxruntime (report to their maintainers)
- Issues specific to Claude Code or Codex CLI themselves

## Sensitive data

This project handles:
- Video files provided by the user
- Transcribed audio content
- Cached frames and config under `~/.agent-video-vision/`

There are **no API keys** — all processing is local. Nothing is logged or transmitted off the machine; the only network activity is model downloads at setup time and optional `yt-dlp` YouTube downloads (see [PRIVACY.md](./PRIVACY.md)).
