import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyKeepMask,
  computeKeepMask,
  countChangedPixels,
  KeepTracker,
  minChangedPixelsFor,
} from "../../src/extractors/dedupe.js";
import { buildContactSheets, buildSheetFilter } from "../../src/extractors/contact-sheet.js";
import { extractFrames, getVideoMetadata } from "../../src/extractors/frames.js";
import { formatFrameTimestamp, parseHMS } from "../../src/utils/timestamps.js";
import { keptFramesText } from "../../src/tools/sheet-output.js";

const WORK = join(tmpdir(), `cvv-dedupe-test-${process.pid}`);
// 1920x1080 static screen; a 12x19 "cursor" sits at (200,200) for t<2s, then
// at (600,400). At 2 fps: frames 0–3 identical, frame 4 moved, 5–11 identical.
const CURSOR_VIDEO = join(WORK, "cursor.mp4");

beforeAll(() => {
  mkdirSync(WORK, { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x202020:s=1920x1080:d=6:r=30",
    "-vf",
    "drawbox=x=200:y=200:w=12:h=19:color=white:t=fill:enable='lt(t,2)'," +
      "drawbox=x=600:y=400:w=12:h=19:color=white:t=fill:enable='gte(t,2)'",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    CURSOR_VIDEO,
  ]);
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe("dedupe helpers", () => {
  it("counts pixels whose brightness moved by more than the delta", () => {
    const a = Uint8Array.from([0, 10, 100, 200]);
    const b = Uint8Array.from([0, 30, 140, 199]);
    expect(countChangedPixels(a, b, 24)).toBe(1);
  });

  it("compares against the last KEPT frame, so slow drift is eventually kept", () => {
    const tracker = new KeepTracker(2);
    const base = new Uint8Array(10);
    const step1 = Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 1 px vs base: drop
    const step2 = Uint8Array.from([255, 255, 0, 0, 0, 0, 0, 0, 0, 0]); // 2 px vs base: keep
    expect([base, step1, step2].map((f) => tracker.push(f))).toEqual([true, false, true]);
  });

  it("default threshold needs ~41 px on 1080p, well under a cursor move", () => {
    expect(minChangedPixelsFor(0.00002, 1920, 1080)).toBe(42);
  });

  it("keeps frames past the mask length", () => {
    expect(applyKeepMask([1, 2, 3, 4], [true, false])).toEqual([1, 3, 4]);
  });
});

describe("computeKeepMask on a synthetic screen recording", () => {
  it("keeps the cursor move and drops the static frames", async () => {
    const mask = await computeKeepMask(CURSOR_VIDEO, { fps: 2, threshold: 0.00002, maxFrames: 100 });
    expect(mask.keep.length).toBe(12);
    expect(mask.keep.filter(Boolean).length).toBe(2);
    expect(mask.keep[0]).toBe(true);
    expect(mask.keep[4]).toBe(true);
  });

  it("matches extractFrames frame count and timestamps, including half seconds", async () => {
    const frames = await extractFrames(CURSOR_VIDEO, { fps: 2, resolution: 256, outputDir: join(WORK, "frames"), maxFrames: 100 });
    expect(frames.length).toBe(12);
    expect(frames.slice(0, 3).map((f) => f.timestamp)).toEqual(["00:00:00", "00:00:00.5", "00:00:01"]);
  });

  it("a high threshold drops the small cursor move too (threshold is configurable)", async () => {
    const mask = await computeKeepMask(CURSOR_VIDEO, { fps: 2, threshold: 0.01, maxFrames: 100 });
    expect(mask.keep.filter(Boolean).length).toBe(1);
  });
});

describe("start/end window", () => {
  it("honours end_time as an end, not a duration, when start_time is set", async () => {
    const frames = await extractFrames(CURSOR_VIDEO, {
      fps: 2, resolution: 256, outputDir: join(WORK, "window"), startTime: "00:00:02", endTime: "00:00:03", maxFrames: 100,
    });
    expect(frames.map((f) => f.timestamp)).toEqual(["00:00:02", "00:00:02.5"]);
    const mask = await computeKeepMask(CURSOR_VIDEO, { fps: 2, threshold: 0.00002, startTime: "00:00:02", endTime: "00:00:03", maxFrames: 100 });
    expect(mask.keep.length).toBe(2);
  });
});

describe("contact sheets", () => {
  it("tiles frames into 2-column sheets of N, last sheet partial", async () => {
    const frames = await extractFrames(CURSOR_VIDEO, { fps: 2, resolution: 256, outputDir: join(WORK, "sheet-frames"), maxFrames: 100 });
    const sheets = await buildContactSheets(
      frames.map((f) => ({ timestamp: f.timestamp, path: f.sourcePath! })),
      { outputDir: join(WORK, "sheets"), perSheet: 10, columns: 2, tileWidth: 256 },
    );
    expect(sheets.length).toBe(2);
    expect(sheets[0].timestamps.length).toBe(10);
    expect(sheets[1].timestamps).toEqual(["00:00:05", "00:00:05.5"]);
    expect(existsSync(sheets[0].path)).toBe(true);
    const meta = await getVideoMetadata(sheets[0].path);
    // 2 tiles wide (256 + 4 px border each), 5 rows
    expect(meta.width).toBe(520);
    expect(meta.height).toBe(5 * (144 + 4));
  });

  it("escapes colons in the drawtext label", () => {
    expect(buildSheetFilter(["00:00:01"], 2, 256, null)).toContain("text='00\\:00\\:01'");
  });
});

describe("frame timestamps and listing", () => {
  it("formats sub-second timestamps and parses them back", () => {
    expect(formatFrameTimestamp(40)).toBe("00:00:40");
    expect(formatFrameTimestamp(40.5)).toBe("00:00:40.5");
    expect(formatFrameTimestamp(10 / 3)).toBe("00:00:03.33");
    expect(formatFrameTimestamp(38.25)).toBe("00:00:38.25");
    expect(formatFrameTimestamp(0.05)).toBe("00:00:00.05");
    expect(parseHMS("00:00:40.5")).toBe(40.5);
  });

  it("lists session-layout frames as one folder plus timestamps", () => {
    const text = keptFramesText([
      { timestamp: "00:00:00", path: "/s/frames/00-00-00.jpg" },
      { timestamp: "00:00:00.5", path: "/s/frames/00-00-00.5.jpg" },
    ]);
    expect(text).toContain("Folder: /s/frames/");
    expect(text).toContain("00:00:00, 00:00:00.5");
  });
});
