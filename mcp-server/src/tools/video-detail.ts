import { z } from "zod";
import { extname, join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG_PATH, SESSIONS_DIR, loadConfig } from "../config.js";
import { resolveVideoInputDetailed } from "../utils/video-source.js";
import { extractFramesBySegments, frameFormatExtension, frameFormatMimeType } from "../extractors/frames.js";
import type { FrameFormat } from "../types.js";
import type { SegmentFrame } from "../extractors/frames.js";
import {
  getSessionDir,
  loadManifest,
  saveManifest,
  computeVideoHash,
} from "../session/manager.js";
import {
  createManifest,
  frameCacheKey,
  mergeFrames,
  sampleFrameIndices,
} from "../session/manifest.js";
import type { SessionManifest } from "../types.js";

const HMS_REGEX = /^\d{2}:\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ViewableFrame {
  timestamp: string;
  image?: string;
  mimeType?: string;
  /** Absolute path of the persisted frame file (paths mode). */
  path?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestampToFormattedFilename(ts: string, format: FrameFormat): string {
  return `${ts.replace(/:/g, "-")}.${frameFormatExtension(format)}`;
}

function mimeTypeFromFrameFile(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Build the flat pool of frames available for viewing.
 *
 * Priority:
 * 1. Frames just extracted in this call (in-memory, no disk I/O needed).
 * 2. If nothing was extracted this call, fall back to reading all manifest
 *    frames from disk, deduplicating by timestamp and preferring the highest
 *    resolution available.
 */
function buildViewablePool(
  extractedFrames: SegmentFrame[],
  manifest: SessionManifest | null,
  format: FrameFormat,
  includeImages = true,
): ViewableFrame[] {
  if (extractedFrames.length > 0) {
    return extractedFrames.map((f) => ({
      timestamp: f.timestamp,
      image: f.image,
      mimeType: frameFormatMimeType(f.format ?? "jpeg"),
      path: f.sourcePath,
    }));
  }

  if (!manifest) return [];

  // Flatten all resolution buckets, deduplicate timestamps by highest res.
  const byTimestamp = new Map<string, { res: number; file: string }>();

  for (const [cacheKey, resData] of Object.entries(manifest.resolutions)) {
    const [resStr, cachedFormat = "jpeg"] = cacheKey.split("/");
    if (cachedFormat !== format) continue;

    const res = parseInt(resStr, 10);
    for (const entry of resData.frames) {
      const current = byTimestamp.get(entry.timestamp);
      if (!current || res > current.res) {
        byTimestamp.set(entry.timestamp, { res, file: entry.file });
      }
    }
  }

  return Array.from(byTimestamp.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, { file }]) => {
      if (!includeImages) {
        // paths mode — no need to read image bytes into memory
        return { timestamp, path: file };
      }
      try {
        const data = readFileSync(file);
        return { timestamp, image: data.toString("base64"), mimeType: mimeTypeFromFrameFile(file), path: file };
      } catch {
        // File missing from disk — still include the entry without image data.
        return { timestamp, path: file };
      }
    });
}

/**
 * Look up specific timestamps from the session manifest.
 * Prefers the highest-resolution copy available for each timestamp.
 */
function lookupTimestampsInManifest(
  manifest: SessionManifest,
  timestamps: string[],
  format: FrameFormat,
  includeImages = true,
): ViewableFrame[] {
  const result: ViewableFrame[] = [];

  for (const ts of timestamps) {
    let bestRes = -1;
    let bestFile: string | null = null;

    for (const [cacheKey, resData] of Object.entries(manifest.resolutions)) {
      const [resStr, cachedFormat = "jpeg"] = cacheKey.split("/");
      if (cachedFormat !== format) continue;

      const res = parseInt(resStr, 10);
      const entry = resData.frames.find((f) => f.timestamp === ts);
      if (entry && res > bestRes) {
        bestRes = res;
        bestFile = entry.file;
      }
    }

    if (bestFile !== null) {
      if (!includeImages) {
        // paths mode — no need to read image bytes into memory
        result.push({ timestamp: ts, path: bestFile });
        continue;
      }
      try {
        const data = readFileSync(bestFile);
        result.push({ timestamp: ts, image: data.toString("base64"), mimeType: mimeTypeFromFrameFile(bestFile), path: bestFile });
      } catch {
        result.push({ timestamp: ts, path: bestFile });
      }
    }
    // Timestamps not found are silently omitted — not an error.
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerVideoDetail(server: McpServer): void {
  server.tool(
    "video_detail",
    "Drill into specific segments of a local video file or YouTube URL. Extracts frames at variable FPS/resolution per segment. Separates extraction from viewing: use segments to extract, view/view_sample to control which frames are returned as images. When enable_index is on, frames are cached and deduplicated across calls.",
    {
      path: z.string().describe("Absolute/relative path to the video file, or a YouTube URL"),
      segments: z
        .array(
          z.object({
            start: z
              .string()
              .regex(HMS_REGEX, "Must be HH:MM:SS format"),
            end: z
              .string()
              .regex(HMS_REGEX, "Must be HH:MM:SS format"),
            fps: z.number().positive(),
            resolution: z.number().min(128).max(2048).optional(),
          }),
        )
        .optional()
        .describe("Segments to extract frames from"),
      view: z
        .array(z.string().regex(HMS_REGEX, "Must be HH:MM:SS format"))
        .optional()
        .describe(
          "Specific timestamps to return as images from the session cache",
        ),
      view_sample: z
        .number()
        .min(1)
        .optional()
        .describe("Return N evenly spaced frames from the extracted set"),
      frame_format: z
        .enum(["jpeg", "png", "webp"])
        .optional()
        .describe("Frame image format for extraction"),
      skip_cached: z
        .boolean()
        .default(true)
        .describe(
          "Skip re-writing of frames already cached at the same resolution",
        ),
    },
    async (params) => {
      // ------------------------------------------------------------------
      // Setup
      // ------------------------------------------------------------------
      const config = loadConfig(CONFIG_PATH);
      const resolved = await resolveVideoInputDetailed(params.path);
      const safePath = resolved.path;
      const frameFormat = params.frame_format || config.frame_format;
      const frameMode = config.frame_mode;
      // Paths mode forces the session dir so frame files survive the call —
      // the host opens them from disk afterwards.
      const useSession = config.enable_index || frameMode === "paths";

      let sessionDir: string | null = null;
      let manifest: SessionManifest | null = null;
      let videoHash: string | null = null;

      if (useSession) {
        videoHash = computeVideoHash(safePath);
        sessionDir = getSessionDir(SESSIONS_DIR, safePath);
        manifest = loadManifest(sessionDir) ?? createManifest(videoHash, safePath);
      }

      // ------------------------------------------------------------------
      // Phase 1: Extraction (if segments provided)
      // ------------------------------------------------------------------
      let extractedFrames: SegmentFrame[] = [];

      if (params.segments && params.segments.length > 0) {
        // Always extract to a temporary directory so ffmpeg's sequential
        // frame_XXXX.* naming never overwrites previously cached files.
        const tmpWorkDir = join(tmpdir(), `cvv-detail-${Date.now()}`);
        mkdirSync(tmpWorkDir, { recursive: true });

        try {
          extractedFrames = await extractFramesBySegments(
            safePath,
            params.segments,
            tmpWorkDir,
            frameFormat,
          );
        } finally {
          rmSync(tmpWorkDir, { recursive: true, force: true });
        }

        // If the session dir is active (indexing enabled, or paths mode),
        // persist frames to the session directory with stable, timestamp-keyed
        // filenames, then merge into the manifest for deduplication.
        if (useSession && manifest && sessionDir) {
          // Group frames by resolution bucket.
          const byResolution = new Map<string, SegmentFrame[]>();
          for (const frame of extractedFrames) {
            const res = String(frame.resolution);
            const bucket = byResolution.get(res) ?? [];
            bucket.push(frame);
            byResolution.set(res, bucket);
          }

          for (const [resolution, frames] of byResolution) {
            const cacheKey = frameCacheKey(resolution, frameFormat);
            const resDir = join(sessionDir, "frames", frameFormat, resolution);
            mkdirSync(resDir, { recursive: true });

            const manifestEntries: { timestamp: string; file: string }[] = [];

            for (const frame of frames) {
              const filePath = join(
                resDir,
                timestampToFormattedFilename(frame.timestamp, frameFormat),
              );

              // Honour skip_cached — if the file already exists on disk, skip
              // writing the frame again (still add to manifestEntries so that
              // mergeFrames has a chance to index it if the manifest was lost).
              if (!(params.skip_cached && existsSync(filePath))) {
                if (frame.image) {
                  writeFileSync(filePath, Buffer.from(frame.image, "base64"));
                }
              }

              // Point the frame at its persistent session copy — the temp
              // extraction dir is already deleted by this point.
              frame.sourcePath = filePath;
              manifestEntries.push({ timestamp: frame.timestamp, file: filePath });
            }

            manifest = mergeFrames(manifest!, cacheKey, manifestEntries);
          }

          saveManifest(sessionDir, manifest);
        }
      }

      // ------------------------------------------------------------------
      // Phase 2: Determine which frames to return as images
      // ------------------------------------------------------------------
      let framesToView: ViewableFrame[] = [];
      const includeImages = frameMode !== "paths";

      if (params.view && params.view.length > 0) {
        // Mode A: caller specified exact timestamps.
        if (manifest) {
          // Look them up in the session cache (highest resolution preferred).
          framesToView = lookupTimestampsInManifest(manifest, params.view, frameFormat, includeImages);
        } else {
          // No session — filter from frames just extracted in this call.
          for (const ts of params.view) {
            const match = extractedFrames.find((f) => f.timestamp === ts);
            if (match) {
              framesToView.push({
                timestamp: match.timestamp,
                image: match.image,
                mimeType: frameFormatMimeType(match.format ?? frameFormat),
              });
            }
          }
        }
      } else if (params.view_sample !== undefined) {
        // Mode B: return N evenly spaced frames.
        const pool = buildViewablePool(extractedFrames, manifest, frameFormat, includeImages);
        const indices = sampleFrameIndices(pool.length, params.view_sample);
        framesToView = indices.map((i) => pool[i]);
      } else {
        // Mode C: return all available frames.
        framesToView = buildViewablePool(extractedFrames, manifest, frameFormat, includeImages);
      }

      // ------------------------------------------------------------------
      // Build MCP response content
      // ------------------------------------------------------------------
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];

      if (resolved.source) {
        content.push({
          type: "text",
          text: `## Source\n${JSON.stringify(resolved.source, null, 2)}`,
        });
      }

      // 1. Manifest summary (if session is active)
      if (manifest && videoHash) {
        const summary = {
          video_hash: videoHash,
          resolutions: Object.fromEntries(
            Object.entries(manifest.resolutions).map(([res, data]) => [
              res,
              {
                frame_count: data.frames.length,
                timestamps: data.frames.map((f) => f.timestamp),
              },
            ]),
          ),
        };
        content.push({
          type: "text",
          text: `## Session Manifest\n${JSON.stringify(summary, null, 2)}`,
        });
      }

      if (frameMode === "paths") {
        // 2+3. paths mode — list persistent file paths; the host opens them itself
        const lines = framesToView.map((f) => `${f.timestamp} -> ${f.path ?? "(file missing)"}`);
        content.push({
          type: "text",
          text: `## Viewing ${framesToView.length} frame(s)\nFrame mode is 'paths' — open these image files with your host's image viewing tool (e.g. Codex view_image) to see them.\n\n${lines.join("\n")}`,
        });
        return { content: content as any };
      }

      // 2. Frame count info
      content.push({
        type: "text",
        text: `## Viewing ${framesToView.length} frame(s)`,
      });

      // 3. Frames as images
      for (const frame of framesToView) {
        content.push({
          type: "text",
          text: `### Frame at ${frame.timestamp}`,
        });
        if (frame.image) {
          content.push({
            type: "image",
            data: frame.image,
            mimeType: frame.mimeType ?? "image/jpeg",
          });
        }
      }

      return { content: content as any };
    },
  );
}
