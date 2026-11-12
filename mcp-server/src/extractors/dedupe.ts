import { spawn } from "child_process";
import { getVideoMetadata, inputRangeArgs } from "./frames.js";

/**
 * Near-duplicate frame detection.
 *
 * A second ffmpeg pass decodes the same frames as extractFrames (same
 * -ss / -to / fps / -frames:v), but as raw grayscale at up to 1920 px wide.
 * Each frame is compared with the last KEPT frame: a pixel counts as changed
 * when its brightness moved by more than PIXEL_DELTA (0–255). A frame is
 * dropped only when the changed-pixel fraction is below the threshold.
 *
 * The default threshold (0.00002 ≈ 41 px on 1920x1080) keeps a mouse-cursor
 * move, which changes a few hundred pixels at native resolution, while
 * dropping truly static frames (0 changed pixels in typical screen recordings).
 */

export const DEDUPE_PIXEL_DELTA = 24;
const MAX_COMPARE_WIDTH = 1920;

export interface DedupeOptions {
  fps: number;
  threshold: number;
  startTime?: string;
  endTime?: string;
  maxFrames: number;
}

export interface DedupeMask {
  /** keep[i] is true when frame i (in extraction order) should be kept. */
  keep: boolean[];
  /** Minimum changed pixels (at compare size) needed to keep a frame. */
  minChangedPixels: number;
  compareSize: string;
}

export interface DedupeStats {
  extracted: number;
  kept: number;
  dropped: number;
  threshold: number;
}

export function countChangedPixels(a: Uint8Array, b: Uint8Array, delta = DEDUPE_PIXEL_DELTA): number {
  const n = Math.min(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    if (d > delta || d < -delta) changed++;
  }
  return changed;
}

/** Streaming keep/drop decision against the last kept frame. */
export class KeepTracker {
  private lastKept: Uint8Array | null = null;
  readonly keep: boolean[] = [];

  constructor(private readonly minChangedPixels: number) {}

  push(frame: Uint8Array): boolean {
    let keep = true;
    if (this.lastKept) {
      keep = countChangedPixels(frame, this.lastKept) >= this.minChangedPixels;
    }
    if (keep) this.lastKept = Uint8Array.from(frame);
    this.keep.push(keep);
    return keep;
  }
}

export function minChangedPixelsFor(threshold: number, width: number, height: number): number {
  return Math.max(1, Math.ceil(threshold * width * height));
}

function compareDimensions(width: number, height: number): { w: number; h: number } {
  const srcW = width > 0 ? width : 1280;
  const srcH = height > 0 ? height : 720;
  const w = Math.min(srcW, MAX_COMPARE_WIDTH);
  const h = Math.max(2, Math.round((srcH * w) / srcW / 2) * 2);
  return { w: Math.max(2, Math.round(w / 2) * 2), h };
}

export async function computeKeepMask(videoPath: string, options: DedupeOptions): Promise<DedupeMask> {
  const metadata = await getVideoMetadata(videoPath);
  const { w, h } = compareDimensions(metadata.width, metadata.height);
  const frameBytes = w * h;
  const minChangedPixels = minChangedPixelsFor(options.threshold, w, h);
  const tracker = new KeepTracker(minChangedPixels);

  const args: string[] = ["-v", "error", ...inputRangeArgs(videoPath, options.startTime, options.endTime)];
  args.push(
    "-vf", `fps=${options.fps},scale=${w}:${h}:flags=area,format=gray`,
    "-frames:v", String(options.maxFrames),
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  );

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const frame = Buffer.alloc(frameBytes);
    let filled = 0;
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - offset);
        chunk.copy(frame, filled, offset, offset + take);
        filled += take;
        offset += take;
        if (filled === frameBytes) {
          tracker.push(frame);
          filled = 0;
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg dedupe pass failed (code ${code}): ${stderr.slice(-500)}`));
    });
  });

  return { keep: tracker.keep, minChangedPixels, compareSize: `${w}x${h}` };
}

/**
 * Apply a keep mask to extracted frames. Frames beyond the mask length (if the
 * two ffmpeg passes ever disagree on frame count) are kept, never dropped.
 */
export function applyKeepMask<T>(frames: T[], keep: boolean[]): T[] {
  return frames.filter((_, i) => i >= keep.length || keep[i]);
}
