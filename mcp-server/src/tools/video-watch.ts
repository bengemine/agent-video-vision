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
import { transcribeWithParakeet } from "../backends/parakeet.js";
import { parseHMS, shiftAudioResult } from "../utils/timestamps.js";
import {
  buildCaptionAudioResult,
  getCaptionFallbackReason,
  resolveVideoInputDetailed,
} from "../utils/video-source.js";
import { getSessionDir, loadManifest, saveManifest, computeVideoHash } from "../session/manager.js";
import { createManifest, frameCacheKey, mergeFrames, sampleFrameIndices } from "../session/manifest.js";
import type { AudioResult, VideoWatchResult, Frame, Segment, SessionManifest } from "../types.js";

const HMS_REGEX = /^\d{2}:\d{2}:\d{2}$/;

const UNCONFIGURED_MESSAGE = `## agent-video-vision is not configured yet!

No audio engine is configured. Run the **video_setup** tool to check dependencies, then **video_configure** to pick a local engine.

Available local engines (all fully offline):
- **parakeet** — NVIDIA Parakeet TDT via ONNX. Fast, accurate. Requires a Python venv with onnx_asr and the exported model files.
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

export function registerVideoWatch(server: McpServer): void {
  server.tool(
    "video_watch",
    "Extract frames and process audio from a local video file or YouTube URL. Returns frames (as base64 images or text descriptions) + transcription + audio analysis for the calling agent to understand the video content. IMPORTANT: For videos longer than 30 seconds, call video_analyze FIRST to get structural data (scene changes, silence, transcription) before calling this tool — use that data to set smart segments with variable FPS.",
    {
      path: z.string().describe("Absolute/relative path to the video file, or a YouTube URL"),
      fps: z.union([z.coerce.number().positive(), z.literal("auto")]).default("auto").describe("Frames per second to extract"),
      resolution: z.coerce.number().min(128).max(2048).optional().describe("Frame width in px (maintains aspect ratio)"),
      frame_mode: z.enum(["images", "descriptions"]).optional().describe("Return frames as base64 images or text descriptions"),
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

      // Session support
      const useSession = config.enable_index;
      let sessionDir: string | null = null;
      let manifest: SessionManifest | null = null;

      if (useSession) {
        sessionDir = getSessionDir(SESSIONS_DIR, safePath);
        manifest = loadManifest(sessionDir) ?? createManifest(computeVideoHash(safePath), safePath);
      }

      // 1. Get metadata
      const metadata = await getVideoMetadata(safePath);
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
        const extractDir = useSession ? join(sessionDir!, "frames", frameFormat) : join(workDir, "frames");
        framesPromise = extractFramesBySegments(safePath, params.segments as Segment[], extractDir, frameFormat).then((segmentFrames) => {
          if (useSession && manifest) {
            for (const frame of segmentFrames) {
              if (!frame.sourcePath) continue;

              const res = String(frame.resolution);
              const cacheKey = frameCacheKey(res, frameFormat);
              manifest = mergeFrames(manifest!, cacheKey, [
                { timestamp: frame.timestamp, file: frame.sourcePath },
              ]);
            }
          }
          return segmentFrames;
        });
      } else {
        framesPromise = extractFrames(safePath, {
          fps,
          resolution,
          outputDir: framesDir,
          format: frameFormat,
          startTime: params.start_time,
          endTime: params.end_time,
          maxFrames: config.max_frames,
        }).then((extractedFrames) => {
          if (useSession && manifest && sessionDir) {
            const cacheKey = frameCacheKey(resolution, frameFormat);
            const resDir = join(sessionDir, "frames", frameFormat, String(resolution));
            mkdirSync(resDir, { recursive: true });

            const manifestEntries: { timestamp: string; file: string }[] = [];
            for (const frame of extractedFrames) {
              if (!frame.sourcePath) continue;

              const filePath = join(resDir, timestampToFormattedFilename(frame.timestamp, frameExtension));
              copyFileSync(frame.sourcePath, filePath);
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
      } else if (config.engine === "parakeet") {
        const audioDir = join(workDir, "audio");
        audioPromise = extractAudio(safePath, audioDir, {
          startTime: params.start_time,
          endTime: params.end_time,
        }).then((wavPath) =>
          transcribeWithParakeet(wavPath, {
            pythonPath: config.parakeet_python,
            modelDir: config.parakeet_model_dir,
            quantization: config.parakeet_quantization,
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

      // 9. Cleanup temp dir (only when not using session — session dir is persistent)
      if (!useSession) {
        rmSync(workDir, { recursive: true, force: true });
      }

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
              res, { frame_count: data.frames.length, timestamps: data.frames.map((f) => f.timestamp) },
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

      // Frames
      if (frameMode === "images") {
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
      } else {
        // descriptions mode — return frame data for the calling agent to convert to text
        content.push({
          type: "text",
          text: `## Frames (${frames.length} extracted at ${fps} fps)\nFrame mode is "descriptions" — convert these frames to concise text descriptions in-session per your host's video-perception skill (Claude Code: spawn the frame-describer subagent; Codex: view and describe the images directly), then continue with the text only.\n\n${frames.map((f) => `- ${f.timestamp}`).join("\n")}`,
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
