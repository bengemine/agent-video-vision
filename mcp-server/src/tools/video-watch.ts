import { z } from "zod";
import { join } from "path";
import { copyFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG_PATH, DATA_DIR, SESSIONS_DIR, loadConfig } from "../config.js";
import {
  getVideoMetadata,
  extractFrames,
  calculateAutoFps,
  extractFramesBySegments,
  frameFormatExtension,
  frameFormatMimeType,
} from "../extractors/frames.js";
import { extractAudio } from "../extractors/audio.js";
import { transcribeWithWhisper } from "../backends/local.js";
import { transcribeWithFluidSpeech } from "../backends/fluid-speech.js";
import { HMS_REGEX, parseHMS, shiftAudioResult } from "../utils/timestamps.js";
import { applyKeepMask, computeKeepMask, type DedupeStats } from "../extractors/dedupe.js";
import { buildContactSheets, type ContactSheet } from "../extractors/contact-sheet.js";
import { contactSheetContent, dedupeSummary } from "./sheet-output.js";
import {
  buildCaptionAudioResult,
  getCaptionFallbackReason,
  resolveVideoInputDetailed,
} from "../utils/video-source.js";
import { getSessionDir, loadManifest, saveManifest, computeVideoHash } from "../session/manager.js";
import { createManifest, frameCacheKey, mergeFrames, sampleFrameIndices } from "../session/manifest.js";
import type { AudioResult, VideoWatchResult, Frame, Segment, SessionManifest } from "../types.js";

/** Raw-frame cap in dense / contact-sheet mode (before dedupe). */
const DENSE_MAX_FRAMES = 400;

const UNCONFIGURED_MESSAGE = `## agent-video-vision is not configured yet!

No audio engine is configured. Run the **video_setup** tool to check dependencies, then **video_configure** to pick a local engine.

Available local engines (all fully offline):
- **fluid-speech** — Fluid Speech Mini via ONNX Runtime. Fast, accurate, English only, ~300MB. Requires a Python 3.12+ venv with onnxruntime and the model files.
- **whisper-cpp** — whisper.cpp. Requires the \`whisper-cli\` binary on PATH; models download automatically.
- **whisper-python** — Python Whisper CLI. Requires the \`whisper\` command on PATH.`;

function timestampToFormattedFilename(timestamp: string, extension: string): string {
  return `${timestamp.replace(/:/g, "-")}.${extension}`;
}

export interface DeriveFpsParams {
  fps: number | "auto";
  view_sample?: number;
  start_time?: string;
  end_time?: string;
  segments?: { start: string; end: string }[];
  duration_seconds: number;
}

export function deriveFps(params: DeriveFpsParams): number {
  const usingSegments = params.segments && params.segments.length > 0;
  if (params.fps === "auto") {
    if (params.view_sample && !usingSegments) {
      const startSec = params.start_time ? parseHMS(params.start_time) : 0;
      const endSec = params.end_time ? parseHMS(params.end_time) : params.duration_seconds;
      const activeDuration = Math.max(1, endSec - startSec);
      return params.view_sample / activeDuration;
    }
    return calculateAutoFps(params.duration_seconds);
  }
  return params.fps;
}

/**
 * Dense mode: fps "auto" on a short clip with no segments or view_sample.
 * Extracts at 1–2 fps, drops near-duplicate frames and returns contact sheets,
 * so a short screen recording is seen almost frame by frame.
 */
export function isDenseAuto(params: {
  fps: number | "auto";
  view_sample?: number;
  segments?: unknown[];
  start_time?: string;
  end_time?: string;
  duration_seconds: number;
  dense_max_seconds: number;
}): boolean {
  if (params.fps !== "auto" || params.view_sample || (params.segments && params.segments.length > 0)) return false;
  const startSec = params.start_time ? parseHMS(params.start_time) : 0;
  const endSec = params.end_time ? parseHMS(params.end_time) : params.duration_seconds;
  return endSec - startSec <= params.dense_max_seconds;
}

export function registerVideoWatch(server: McpServer): void {
  server.tool(
    "video_watch",
    "Extract frames and process audio from a local video file or YouTube URL. Returns frames (as base64 images, text descriptions, or file paths) + transcription + audio analysis for the calling agent to understand the video content. Clips up to ~3 minutes with fps 'auto' (and no segments/view_sample) use dense mode: 1–2 fps, near-duplicate frames dropped, frames tiled into timestamped contact sheets (10 per image) — look at every sheet. Set dedupe/contact_sheet false to get single frames. IMPORTANT: For longer videos, call video_analyze FIRST to get structural data (scene changes, silence, transcription) before calling this tool — use that data to set smart segments with variable FPS.",
    {
      path: z.string().describe("Absolute/relative path to the video file, or a YouTube URL"),
      fps: z.union([z.coerce.number().positive(), z.literal("auto")]).default("auto").describe("Frames per second to extract"),
      resolution: z.coerce.number().min(128).max(2048).optional().describe("Frame width in px (maintains aspect ratio)"),
      frame_mode: z.enum(["images", "descriptions", "paths"]).optional().describe("Return frames as base64 images, text descriptions, or file paths to open with the host's image viewer"),
      frame_format: z.enum(["jpeg", "png", "webp"]).optional().describe("Frame image format for extraction"),
      start_time: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format").optional().describe("Start time (e.g. '00:01:30')"),
      end_time: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format").optional().describe("End time (e.g. '00:05:00')"),
      skip_audio: z.boolean().default(false).describe("Skip audio extraction and transcription — frames only"),
      segments: z.array(z.object({
        start: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format"),
        end: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format"),
        fps: z.number().positive(),
        resolution: z.number().min(128).max(2048).optional(),
      })).optional().describe("Variable FPS/resolution segments — overrides global fps/start_time/end_time"),
      view_sample: z.number().min(1).optional().describe("Return only N evenly spaced frames"),
      dedupe: z.boolean().optional().describe("Drop frames that are near-identical to the last kept frame (a cursor move is kept). Default: on in dense mode (short clip, fps auto), off otherwise"),
      dedupe_threshold: z.coerce.number().min(0).max(1).optional().describe("Fraction of pixels that must change to keep a frame (default from config, 0.00002 ≈ 41 px on 1920x1080)"),
      contact_sheet: z.boolean().optional().describe("Return frames tiled into timestamped grid images instead of one image per frame. Default: on in dense mode, off otherwise"),
      sheet_size: z.coerce.number().int().min(1).max(30).optional().describe("Frames per contact sheet, 2 columns wide (default 10 = 2x5)"),
    },
    async (params) => {
      const config = loadConfig(CONFIG_PATH);

      const resolution = params.resolution || config.frame_resolution;
      const frameMode = params.frame_mode || config.frame_mode;
      const resolved = await resolveVideoInputDetailed(params.path);
      const safePath = resolved.path;
      const frameFormat = params.frame_format || config.frame_format;
      const frameExtension = frameFormatExtension(frameFormat);
      const frameMimeType = frameFormatMimeType(frameFormat);

      // 1. Get metadata
      const metadata = await getVideoMetadata(safePath);

      const denseAuto = isDenseAuto({
        fps: params.fps,
        view_sample: params.view_sample,
        segments: params.segments,
        start_time: params.start_time,
        end_time: params.end_time,
        duration_seconds: metadata.duration_seconds,
        dense_max_seconds: config.dense_max_seconds,
      });
      const dedupe = params.dedupe ?? denseAuto;
      const dedupeThreshold = params.dedupe_threshold ?? config.dedupe_threshold;
      const contactSheet = params.contact_sheet ?? denseAuto;
      const sheetSize = params.sheet_size ?? config.contact_sheet_size;
      const maxFrames = contactSheet ? Math.max(config.max_frames, DENSE_MAX_FRAMES) : config.max_frames;
      let dedupeStats: DedupeStats | null = null;

      // Session support. Paths mode and contact sheets force the session dir
      // so frame files survive the call — the host opens them (or zooms into
      // them with video_detail) from disk afterwards.
      const useSession = config.enable_index || frameMode === "paths" || contactSheet;
      let sessionDir: string | null = null;
      let manifest: SessionManifest | null = null;

      if (useSession) {
        sessionDir = getSessionDir(SESSIONS_DIR, safePath);
        manifest = loadManifest(sessionDir) ?? createManifest(computeVideoHash(safePath), safePath);
      }
      const captionFallbackReason = resolved.source?.type === "youtube"
        ? getCaptionFallbackReason(resolved.captions, metadata.duration_seconds)
        : null;

      if (config.engine === "unconfigured" && !params.skip_audio && captionFallbackReason !== null) {
        return { content: [{ type: "text", text: UNCONFIGURED_MESSAGE }] };
      }

      // 2. Calculate fps
      const fps = deriveFps({
        fps: params.fps,
        view_sample: params.view_sample,
        start_time: params.start_time,
        end_time: params.end_time,
        segments: params.segments,
        duration_seconds: metadata.duration_seconds,
      });

      // 3. Prepare work dir
      const workDir = join(tmpdir(), `cvv-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      const framesDir = join(workDir, "frames");

      // 4. Run frame extraction and audio processing
      //    When segments are provided, frame extraction is sequential (per segment);
      //    audio can still run in parallel with the entire segment batch.

      let framesPromise: Promise<Frame[]>;

      if (params.segments && params.segments.length > 0) {
        const segmentDedupe = dedupe
          ? { threshold: dedupeThreshold, stats: { extracted: 0, kept: 0, dropped: 0, threshold: dedupeThreshold } }
          : undefined;
        framesPromise = extractFramesBySegments(safePath, params.segments as Segment[], framesDir, frameFormat, segmentDedupe).then((segmentFrames) => {
          if (segmentDedupe) dedupeStats = segmentDedupe.stats;
          if (useSession && manifest && sessionDir) {
            for (const frame of segmentFrames) {
              if (!frame.sourcePath) continue;

              // Copy to a stable, timestamp-keyed session file.
              const res = String(frame.resolution);
              const resDir = join(sessionDir, "frames", frameFormat, res);
              mkdirSync(resDir, { recursive: true });
              const filePath = join(resDir, timestampToFormattedFilename(frame.timestamp, frameExtension));
              copyFileSync(frame.sourcePath, filePath);
              frame.sourcePath = filePath;
              manifest = mergeFrames(manifest!, frameCacheKey(res, frameFormat), [
                { timestamp: frame.timestamp, file: filePath },
              ]);
            }
          }
          return segmentFrames;
        });
      } else {
        const extractOptions = {
          fps,
          resolution,
          outputDir: framesDir,
          format: frameFormat,
          startTime: params.start_time,
          endTime: params.end_time,
          maxFrames,
        };
        framesPromise = Promise.all([
          extractFrames(safePath, extractOptions),
          dedupe ? computeKeepMask(safePath, { ...extractOptions, threshold: dedupeThreshold }) : Promise.resolve(null),
        ]).then(([allFrames, mask]) => {
          let extractedFrames = allFrames;
          if (mask) {
            extractedFrames = applyKeepMask(allFrames, mask.keep);
            dedupeStats = {
              extracted: allFrames.length,
              kept: extractedFrames.length,
              dropped: allFrames.length - extractedFrames.length,
              threshold: dedupeThreshold,
            };
          }
          if (useSession && manifest && sessionDir) {
            const cacheKey = frameCacheKey(resolution, frameFormat);
            const resDir = join(sessionDir, "frames", frameFormat, String(resolution));
            mkdirSync(resDir, { recursive: true });

            const manifestEntries: { timestamp: string; file: string }[] = [];
            for (const frame of extractedFrames) {
              if (!frame.sourcePath) continue;

              const filePath = join(resDir, timestampToFormattedFilename(frame.timestamp, frameExtension));
              copyFileSync(frame.sourcePath, filePath);
              // Point the frame at its persistent session copy — the temp
              // extraction dir may be cleaned up before the host reads paths.
              frame.sourcePath = filePath;
              manifestEntries.push({ timestamp: frame.timestamp, file: filePath });
            }

            manifest = mergeFrames(manifest, cacheKey, manifestEntries);
          }

          return extractedFrames;
        });
      }

      let audioPromise: Promise<AudioResult>;

      if (params.skip_audio || !metadata.has_audio) {
        audioPromise = Promise.resolve({ backend: "none" as const, transcription: [], audio_tags: [], full_analysis: null });
      } else if (captionFallbackReason === null && resolved.captions) {
        audioPromise = Promise.resolve(
          buildCaptionAudioResult(resolved.captions, {
            startTime: params.start_time,
            endTime: params.end_time,
          }),
        );
      } else if (config.engine === "fluid-speech") {
        const audioDir = join(workDir, "audio");
        audioPromise = extractAudio(safePath, audioDir, {
          startTime: params.start_time,
          endTime: params.end_time,
        }).then((wavPath) =>
          transcribeWithFluidSpeech(wavPath, {
            pythonPath: config.fluid_python,
            modelDir: config.fluid_model_dir,
          }),
        );
      } else if (config.engine === "whisper-cpp" || config.engine === "whisper-python") {
        const audioDir = join(workDir, "audio");
        const modelDir = join(DATA_DIR, "models");
        const engine = config.engine;
        audioPromise = extractAudio(safePath, audioDir, {
          startTime: params.start_time,
          endTime: params.end_time,
        }).then((wavPath) =>
          transcribeWithWhisper(wavPath, {
            engine,
            model: config.whisper_model,
            whisperAt: config.whisper_at,
            modelDir,
          }),
        );
      } else {
        // unconfigured — YouTube captions (if any) were handled above; skip transcription gracefully
        audioPromise = Promise.resolve({ backend: "none" as const, transcription: [], audio_tags: [], full_analysis: null });
      }

      let [frames, rawAudio] = await Promise.all([framesPromise, audioPromise]);

      if (captionFallbackReason !== null && rawAudio.backend !== "youtube-captions" && rawAudio.backend !== "none") {
        rawAudio = { ...rawAudio, transcription_fallback_reason: captionFallbackReason };
      }

      // 5. Align audio timestamps with the original video timeline.
      //    Backends return timestamps relative to the cropped audio, but frames
      //    already carry original-video timestamps via extractFrames. Shift the
      //    audio result so both timelines match.
      const offsetSeconds = params.start_time ? parseHMS(params.start_time) : 0;
      const audio = shiftAudioResult(rawAudio, offsetSeconds);

      // 6. Apply view_sample filtering — return only N evenly spaced frames
      if (params.view_sample && frames.length > params.view_sample) {
        const indices = sampleFrameIndices(frames.length, params.view_sample);
        frames = indices.map((i) => frames[i]);
      }

      // 7. Persist session manifest
      if (useSession && manifest && sessionDir) {
        saveManifest(sessionDir, manifest);
      }

      // 8. Build result
      const result: VideoWatchResult = { metadata, frames, audio };

      // 8b. Contact sheets from the (kept) session frame files
      let sheets: ContactSheet[] = [];
      if (contactSheet && sessionDir) {
        sheets = await buildContactSheets(
          frames.filter((f) => f.sourcePath).map((f) => ({ timestamp: f.timestamp, path: f.sourcePath! })),
          { outputDir: join(sessionDir, "sheets", String(Date.now())), perSheet: sheetSize, columns: 2, tileWidth: resolution },
        );
      }

      // 9. Cleanup temp dir. Session frames were already copied out of it,
      //    and in non-session mode the frame bytes are held in memory.
      rmSync(workDir, { recursive: true, force: true });

      // 10. Return as MCP content
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      if (resolved.source) {
        content.push({ type: "text", text: `## Source\n${JSON.stringify(resolved.source, null, 2)}` });
      }

      // Manifest summary (only when session is active)
      if (manifest) {
        const manifestSummary = {
          video_hash: manifest.video_hash,
          resolutions: Object.fromEntries(
            Object.entries(manifest.resolutions).map(([res, data]) => [
              res,
              // Contact-sheet output lists the kept frames itself; keep the manifest short.
              sheets.length > 0
                ? { frame_count: data.frames.length }
                : { frame_count: data.frames.length, timestamps: data.frames.map((f) => f.timestamp) },
            ]),
          ),
        };
        content.push({ type: "text", text: `## Session Manifest\n${JSON.stringify(manifestSummary, null, 2)}` });
      }

      // Metadata + audio as text
      content.push({
        type: "text",
        text: `## Video Metadata\n${JSON.stringify(metadata, null, 2)}\n\n## Audio Analysis\n${JSON.stringify(audio, null, 2)}`,
      });

      // Frames (dedupeStats is set inside the extraction callbacks)
      const stats = dedupeStats as DedupeStats | null;
      const expectedFrames = params.segments && params.segments.length > 0
        ? 0
        : Math.ceil(((params.end_time ? parseHMS(params.end_time) : metadata.duration_seconds) - (params.start_time ? parseHMS(params.start_time) : 0)) * fps);
      const capNote = expectedFrames > maxFrames && (stats?.extracted ?? frames.length) >= maxFrames
        ? ` Extraction stopped at max_frames (${maxFrames}); later moments are missing — use start_time/end_time or segments.`
        : "";
      const summary = `${dedupeSummary(stats)}${capNote}`.trim();

      if (sheets.length > 0) {
        content.push(
          ...contactSheetContent(
            sheets,
            frames.map((f) => ({ timestamp: f.timestamp, path: f.sourcePath })),
            frameMode,
            `${frames.length} frames at ${Number(fps.toFixed(3))} fps. ${summary}`.trim(),
          ),
        );
      } else if (frameMode === "images") {
        if (summary) content.push({ type: "text", text: summary });
        for (const frame of frames) {
          content.push({
            type: "text",
            text: `### Frame at ${frame.timestamp}`,
          });
          if (frame.image) {
            content.push({
              type: "image",
              data: frame.image,
              mimeType: frameMimeType,
            });
          }
        }
      } else if (frameMode === "paths") {
        // paths mode — list persistent file paths; the host opens them itself
        const lines = frames.map((f) => `${f.timestamp} -> ${f.sourcePath ?? "(file missing)"}`);
        content.push({
          type: "text",
          text: `## Frames (${frames.length} extracted at ${fps} fps)\n${summary ? summary + "\n" : ""}Frame mode is 'paths' — open these image files with your host's image viewing tool (e.g. Codex view_image) to see them.\n\n${lines.join("\n")}`,
        });
      } else {
        // descriptions mode — return frame data for the calling agent to convert to text
        content.push({
          type: "text",
          text: `## Frames (${frames.length} extracted at ${fps} fps)\n${summary ? summary + "\n" : ""}Frame mode is "descriptions" — convert these frames to concise text descriptions in-session per your host's video-perception skill (Claude Code: spawn the frame-describer subagent; Codex: view and describe the images directly), then continue with the text only.\n\n${frames.map((f) => `- ${f.timestamp}`).join("\n")}`,
        });
        // Still include images so the agent can describe them
        for (const frame of frames) {
          if (frame.image) {
            content.push({
              type: "image",
              data: frame.image,
              mimeType: frameMimeType,
            });
          }
        }
      }

      return { content: content as any };
    },
  );
}
