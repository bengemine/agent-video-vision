# Contributing to agent-video-vision

Thanks for your interest in contributing! This document explains how to get set up and submit changes.

## Development setup

```bash
# Clone and install
git clone https://github.com/bengemine/agent-video-vision ~/agent-video-vision
cd ~/agent-video-vision/mcp-server
npm install

# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test
```

You'll need `ffmpeg` installed (`brew install ffmpeg` on macOS, `apt install ffmpeg` on Linux).

## Testing the plugin locally

Claude Code:

```bash
claude --plugin-dir ~/agent-video-vision
```

Codex CLI: see [codex/README.md](./codex/README.md).

## Making a change

1. Fork the repo and create a topic branch from `main`
2. Make your changes following existing patterns
3. Add tests if you're adding behavior
4. Run `npm test` — all tests must pass
5. Run `npm run build` — must compile without errors
6. Commit with a clear message (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`)
7. Open a pull request against `main`

## Adding a new transcription engine

Engines live in `mcp-server/src/backends/`. To add one:

1. Create `your-engine.ts` implementing the audio processing interface
2. Export an analyze function returning `AudioResult`
3. Wire it into `mcp-server/src/tools/video-watch.ts`
4. Add the engine name to the engine type in `types.ts`
5. Update `video-configure.ts` and `video-setup.ts` to support it
6. Update the setup wizard in `commands/setup-video-vision.md`

Note: only **local** engines are accepted. This project's core promise is local-only processing with no API keys — cloud transcription backends won't be merged.

## Code style

- TypeScript strict mode — no `any` unless genuinely necessary
- Keep files focused — one responsibility per file
- Tests live next to the code in `tests/`, mirror the `src/` structure
- Follow existing naming and import patterns

## Reporting bugs

Open an issue using the bug report template. Include:
- Your OS and Node.js version
- The engine you're using (parakeet, whisper-cpp, whisper-python)
- The host (Claude Code or Codex CLI)
- The exact command or action that triggered the bug
- Any error output from `~/.agent-video-vision/` logs or MCP stderr
