import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { join } from "path";
import { existsSync, rmSync } from "fs";
import { deriveFps, registerVideoWatch } from "../../src/tools/video-watch.js";
import { registerVideoConfigure } from "../../src/tools/video-configure.js";
import { CONFIG_PATH, DATA_DIR, SESSIONS_DIR, defaultConfig, loadConfig, saveConfig } from "../../src/config.js";

// Redirect the server's data dir into a temp location so tool-level tests
// never touch the real ~/.agent-video-vision.
vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const DATA_DIR = join(tmpdir(), `cvv-watch-tool-test-${process.pid}`);
  return {
    ...actual,
    DATA_DIR,
    CONFIG_PATH: join(DATA_DIR, "config.json"),
    SESSIONS_DIR: join(DATA_DIR, "sessions"),
  };
});

const FIXTURE = join(import.meta.dirname, "../fixtures/test-3s.mp4");

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolHandler = (params: Record<string, unknown>) => Promise<{ content: ContentBlock[] }>;

function captureTool(register: (server: any) => void): { schema: any; handler: ToolHandler } {
  let captured: { schema: any; handler: ToolHandler } | undefined;
  register({
    tool: (_name: string, _description: string, schema: any, handler: ToolHandler) => {
      captured = { schema, handler };
    },
  });
  return captured!;
}

function pathLines(result: { content: ContentBlock[] }): string[] {
  const block = result.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text" && c.text.includes("Frame mode is 'paths'"),
  );
  expect(block).toBeDefined();
  return block!.text.split("\n").filter((line) => line.includes(" -> "));
}

describe("deriveFps", () => {
  it("respects explicit numeric fps", () => {
    expect(deriveFps({ fps: 2, duration_seconds: 100 })).toBe(2);
    expect(deriveFps({ fps: 0.5, duration_seconds: 1000 })).toBe(0.5);
  });

  it("uses calculateAutoFps when no view_sample and fps=auto", () => {
    // calculateAutoFps for short video (e.g. 10s) gives a higher fps; we just
    // verify that the auto path is taken (returns a non-derived value).
    const result = deriveFps({ fps: "auto", duration_seconds: 100 });
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });

  it("derives fps from view_sample / active duration when fps=auto and view_sample set", () => {
    // 36-min video, view_sample=8 → fps = 8 / 2184 ≈ 0.00366
    const result = deriveFps({ fps: "auto", view_sample: 8, duration_seconds: 2184 });
    expect(result).toBeCloseTo(8 / 2184, 6);
  });

  it("respects start_time and end_time when computing active duration", () => {
    // 36-min video, range 5:00-15:00 (600s), view_sample=10 → fps = 10 / 600
    const result = deriveFps({
      fps: "auto",
      view_sample: 10,
      start_time: "00:05:00",
      end_time: "00:15:00",
      duration_seconds: 2184,
    });
    expect(result).toBeCloseTo(10 / 600, 6);
  });

  it("uses calculateAutoFps when view_sample is set but segments are also provided", () => {
    // Per-segment fps overrides; the view_sample-derived fps shouldn't apply.
    const result = deriveFps({
      fps: "auto",
      view_sample: 8,
      segments: [{ start: "00:00:00", end: "00:01:00" }],
      duration_seconds: 2184,
    });
    // Should fall through to calculateAutoFps, not 8/2184
    expect(result).not.toBeCloseTo(8 / 2184, 6);
  });

  it("clamps active duration to minimum 1 second to avoid div-by-zero", () => {
    // start == end edge case
    const result = deriveFps({
      fps: "auto",
      view_sample: 5,
      start_time: "00:00:30",
      end_time: "00:00:30",
      duration_seconds: 100,
    });
    expect(result).toBe(5); // 5 / 1
  });
});

describe("video_watch paths mode", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("frame_mode param schema accepts 'paths'", () => {
    const { schema } = captureTool(registerVideoWatch);
    expect(schema.frame_mode.safeParse("paths").success).toBe(true);
    expect(schema.frame_mode.safeParse("images").success).toBe(true);
    expect(schema.frame_mode.safeParse("descriptions").success).toBe(true);
    expect(schema.frame_mode.safeParse("bogus").success).toBe(false);
  });

  it("returns frame file paths instead of image blocks", async () => {
    saveConfig(CONFIG_PATH, { ...defaultConfig, frame_mode: "paths" });
    const { handler } = captureTool(registerVideoWatch);
    const result = await handler({ path: FIXTURE, fps: 1, skip_audio: true });

    // No inline image blocks in paths mode.
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);

    // Metadata/audio text block still present (transcription output unchanged).
    const metaBlock = result.content.find((c) => c.type === "text" && c.text.includes("## Video Metadata"));
    expect(metaBlock).toBeDefined();

    const lines = pathLines(result);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const [timestamp, filePath] = line.split(" -> ");
      expect(timestamp).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      // Frames must land in the stable session dir, even with enable_index off,
      // so the host can open them after the call returns.
      expect(filePath.startsWith(SESSIONS_DIR)).toBe(true);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it("respects view_sample in paths mode", async () => {
    saveConfig(CONFIG_PATH, { ...defaultConfig, frame_mode: "paths" });
    const { handler } = captureTool(registerVideoWatch);
    const result = await handler({ path: FIXTURE, fps: 2, skip_audio: true, view_sample: 2 });

    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);
    const lines = pathLines(result);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(existsSync(line.split(" -> ")[1])).toBe(true);
    }
  });

  it("frame_mode='paths' param overrides config frame_mode 'images'", async () => {
    saveConfig(CONFIG_PATH, { ...defaultConfig });
    const { handler } = captureTool(registerVideoWatch);
    const result = await handler({ path: FIXTURE, fps: 1, skip_audio: true, frame_mode: "paths" });

    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);
    const lines = pathLines(result);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(lines[0].split(" -> ")[1])).toBe(true);
  });

  it("images mode still returns inline image blocks", async () => {
    saveConfig(CONFIG_PATH, { ...defaultConfig });
    const { handler } = captureTool(registerVideoWatch);
    const result = await handler({ path: FIXTURE, fps: 1, skip_audio: true });

    const images = result.content.filter((c) => c.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(2);
    const pathsBlock = result.content.find((c) => c.type === "text" && c.text.includes("Frame mode is 'paths'"));
    expect(pathsBlock).toBeUndefined();
  });
});

describe("video_configure frame_mode", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("schema accepts and handler persists frame_mode 'paths'", async () => {
    const { schema, handler } = captureTool(registerVideoConfigure);
    expect(schema.frame_mode.safeParse("paths").success).toBe(true);

    await handler({ frame_mode: "paths" });
    expect(loadConfig(CONFIG_PATH).frame_mode).toBe("paths");
  });
});
