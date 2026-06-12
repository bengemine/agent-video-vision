---
name: video-perception
description: Use when the user mentions a video file (.mp4, .mov, .avi, .mkv, .webm), a YouTube URL, asks to watch/analyze/review a video, or references video content in conversation
---

# Video Perception

You have access to video understanding tools via the agent-video-vision MCP server. Everything runs locally — frame extraction via ffmpeg, transcription on CPU (Parakeet or Whisper). The server makes no LLM calls; all visual understanding happens in your session.

## Available Tools

- `video_analyze` — Analyze video structure with ffmpeg filters (scene changes, silence, motion, etc.). Use this BEFORE extracting frames to plan your strategy.
- `video_watch` — Extract frames + transcribe audio from a video. Supports variable FPS/resolution per segment.
- `video_detail` — Drill into specific segments. Separates extraction from viewing — extract many frames, view few at a time.
- `video_info` — Get video metadata without processing.
- `video_configure` — Change settings (engine, resolution, frame_mode, etc.).
- `video_setup` — Check dependencies and report what's missing.

## Workflow

**IMPORTANT: You MUST follow these steps in order. Do NOT skip step 2.**

1. Always start with `video_info` to get duration, resolution, and audio presence.
   If the user gives a YouTube URL, pass the URL directly as `path`.
   The MCP server downloads it with `yt-dlp`, prefers YouTube subtitles/auto-captions
   for transcription, and falls back to the configured local engine only when
   captions are missing, empty, or suspiciously incomplete.

2. **REQUIRED for videos > 30s:** Call `video_analyze` BEFORE extracting any frames.
   This is NOT optional — it gives you structural data to make smart extraction decisions.
   Select filters relevant to the user's question:

   | User intent | Filters to select |
   |---|---|
   | "What happens in this video?" | scene_changes, silence, transcription |
   | "Find the scene transitions" | scene_changes, black_intervals |
   | "Are there frozen/stuck parts?" | freeze, blur |
   | "Is this a talking head or action?" | motion |
   | "When does the music start?" | silence, loudness |
   | "Analyze the lighting" | exposure |
   | "Summarize this lecture" | transcription, scene_changes, silence |
   | General / unclear intent | scene_changes, silence, transcription |

   Always include `transcription: true` when the video has audio — the transcription
   tells you WHERE to look visually.

3. Use the analysis results and transcription to plan your frame extraction strategy:
   - Low FPS (0.1-0.5) for static or predictable segments
   - Higher FPS (1-3) only around scene changes, motion peaks, or moments
     referenced in speech ("look at this", "as you can see", "let me show you")
   - Never exceed the minimum FPS needed for the task
   - Prefer fewer segments at lower FPS — you can always drill deeper

4. Call `video_watch` to extract frames:
   - For **short videos (< 2 minutes):** Use `fps: "auto"` without `view_sample` — short videos need full coverage to avoid missing brief moments. The auto FPS already adapts to duration.
   - For **long videos (> 2 minutes):** Use `segments` based on analysis data with variable FPS, and `view_sample` to limit initial frame count. You can always drill deeper with `video_detail`.

5. Use `video_detail` to drill into specific moments:
   - Start with 3-5 second windows around points of interest
   - Use `view_sample: 3` to preview (first, middle, last frame)
   - Then request specific timestamps with `view` if you need more detail
   - Expand the window only if the initial view is insufficient
   - Treat frame viewing like a binary search — narrow down to what matters
   - Never view all extracted frames at once

6. When the user asks follow-up questions about the same video, consult
   the manifest already in your context. Do not re-extract frames you
   already have at the same resolution. Do not re-request frames you
   already have in context.

## Frame delivery modes

`frame_mode` (set via `video_configure`) controls how `video_watch` / `video_detail` return frames:

- **`images`** (Claude Code default) — frames come back as inline images in the tool result.
- **`paths`** (Codex default) — the tool returns `timestamp -> /abs/path` file lists instead of inline images. Codex MUST use this mode: inline MCP images are invisible to Codex; it views image files via its `view_image` tool.
- **`descriptions`** — host-fulfilled text descriptions instead of images (fewest tokens; see below).

## Frame Descriptions (frame_mode: "descriptions")

When `frame_mode` is `"descriptions"`, the server returns the frames plus a neutral instruction asking for text descriptions — it does NOT call any LLM itself. YOU fulfill the descriptions, depending on which host you are:

- **Claude Code:** spawn the `frame-describer` subagent (bundled with this plugin) and pass it the frame images. It returns one description per frame in the format `Frame at [timestamp] — [description]`.
- **Codex CLI:** use `frame_mode: "paths"`, then open the listed frame files with your `view_image` tool. For a handful of frames, describe them yourself inline in the same `Frame at [timestamp] — [description]` format. For larger batches, delegate to the **frame-describer** custom agent — name it explicitly as "frame-describer" in your delegation prompt (Codex only uses custom agents when they are named explicitly) and pass it the frame file paths with timestamps. (Install it once via the setup skill: it copies `codex/agents/frame-describer.toml` into `~/.codex/agents/`.)
- **Any other host without subagents:** view the frames and write the descriptions yourself inline, same format. Cover people, on-screen text, objects, setting, and changes from the previous frame. Be factual — describe, don't interpret.

Either way, use the resulting descriptions in place of repeated image viewing for follow-up reasoning.

## Parameter Guide

**fps:** `"auto"` for general overview. Use the video's original fps (from `video_info`) for frame-by-frame detail. Use 5-10 for analyzing specific short moments. Use 0.1-0.5 for long videos.

**resolution:** 256-512 for quick scans. 512-768 for normal analysis. 1024+ when reading on-screen text or fine details.

**segments:** Use when you have analysis data. Each segment can have its own fps and resolution. Overrides global fps/start_time/end_time.

**view_sample:** Returns N evenly spaced frames from the extracted set. Use this to avoid flooding context with too many images.

**skip_audio:** Set to true when you only need visual analysis.

**YouTube URLs:** Pass supported YouTube URLs directly as `path`. Treat
`transcription_source: "youtube_subtitles"` as stronger than
`youtube_auto_captions`; auto-captions can still have recognition errors.

## Working with Results

You receive:
- **Manifest** (when enable_index is on) — index of all cached frames by resolution and timestamp. Use this to avoid redundant requests.
- **Frames** — inline images (`frame_mode: "images"`) or `timestamp -> /abs/path` file lists (`frame_mode: "paths"`; open the files you need with your image-viewing tool). Look at them to understand what's happening visually.
- **Audio transcription** with timestamps — read the speech content
- **Analysis data** — scene changes, silence intervals, motion levels, etc.

Combine all sources to form a complete understanding. Use analysis + transcription to guide where you look visually. The analysis tells you WHEN things happen; the frames tell you WHAT happens.

If a tool fails with a setup error (missing ffmpeg, missing model, missing venv), call `video_setup` and guide the user through the reported fix before retrying.
