import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { join } from "path";
import { existsSync, rmSync } from "fs";
import { registerVideoDetail } from "../../src/tools/video-detail.js";
import { CONFIG_PATH, DATA_DIR, SESSIONS_DIR, defaultConfig, saveConfig } from "../../src/config.js";

// Redirect the server's data dir into a temp location so tool-level tests
// never touch the real ~/.agent-video-vision.
vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const DATA_DIR = join(tmpdir(), `cvv-detail-tool-test-${process.pid}`);
  return {
    ...actual,
    DATA_DIR,
    CONFIG_PATH: join(DATA_DIR, "config.json"),
    SESSIONS_DIR: join(DATA_DIR, "sessions"),
  };
});

const FIXTURE = join(import.meta.dirname, "../fixtures/test-3s.mp4");
const SEGMENTS = [{ start: "00:00:00", end: "00:00:03", fps: 1 }];

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolHandler = (params: Record<string, unknown>) => Promise<{ content: ContentBlock[] }>;

function captureHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  registerVideoDetail({
    tool: (_name: string, _description: string, _schema: any, h: ToolHandler) => {
      handler = h;
    },
  } as any);
  return handler!;
}

function pathLines(result: { content: ContentBlock[] }): string[] {
  const block = result.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text" && c.text.includes("Frame mode is 'paths'"),
  );
  expect(block).toBeDefined();
  return block!.text.split("\n").filter((line) => line.includes(" -> "));
}

describe("video_detail paths mode", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("returns frame file paths instead of image blocks", async () => {
    saveConfig(CONFIG_PATH, { ...defaultConfig, frame_mode: "paths" });
    const handler = captureHandler();
    const result = await handler({ path: FIXTURE, segments: SEGMENTS, skip_cached: true });

    // No inline image blocks in paths mode.
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);

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
    const handler = captureHandler();
    const result = await handler({ path: FIXTURE, segments: SEGMENTS, skip_cached: true, view_sample: 1 });

    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);
    const lines = pathLines(result);
    expect(lines).toHaveLength(1);
    expect(existsSync(lines[0].split(" -> ")[1])).toBe(true);
  });

  it("serves view timestamps from the session cache as paths", async () => {
    saveConfig(CONFIG_PATH, { ...defaultConfig, frame_mode: "paths" });
    const handler = captureHandler();

    // First call extracts and persists frames into the session dir.
    await handler({ path: FIXTURE, segments: SEGMENTS, skip_cached: true });

    // Second call (no extraction) looks up a cached timestamp.
    const result = await handler({ path: FIXTURE, view: ["00:00:01"], skip_cached: true });
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);

    const lines = pathLines(result);
    expect(lines).toHaveLength(1);
    const [timestamp, filePath] = lines[0].split(" -> ");
    expect(timestamp).toBe("00:00:01");
    expect(existsSync(filePath)).toBe(true);
  });

  it("images mode still returns inline image blocks", async () => {
    saveConfig(CONFIG_PATH, { ...defaultConfig });
    const handler = captureHandler();
    const result = await handler({ path: FIXTURE, segments: SEGMENTS, skip_cached: true });

    const images = result.content.filter((c) => c.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(2);
    const pathsBlock = result.content.find((c) => c.type === "text" && c.text.includes("Frame mode is 'paths'"));
    expect(pathsBlock).toBeUndefined();
  });
});
