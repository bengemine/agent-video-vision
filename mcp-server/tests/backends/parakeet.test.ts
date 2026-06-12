import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture execFile invocations so we can inspect args and control stdout,
// mirroring tests/backends/local.test.ts. promisify(execFile) inside
// src/backends/parakeet.ts resolves to this fake.
const execFileCalls: Array<{ command: string; args: string[]; options: unknown }> = [];

// Each test sets this to control what the fake python process returns.
let execFileResult: {
  err: (Error & { stdout?: string; stderr?: string }) | null;
  stdout: string;
  stderr: string;
} = { err: null, stdout: '{"segments": []}', stderr: "" };

vi.mock("child_process", () => ({
  execFile: (
    command: string,
    args: string[],
    options: unknown,
    callback: (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void,
  ) => {
    execFileCalls.push({ command, args, options });
    callback(execFileResult.err, {
      stdout: execFileResult.stdout,
      stderr: execFileResult.stderr,
    });
  },
}));

// Control the preflight filesystem checks. Default: everything exists and
// the model dir contains an encoder onnx file.
let existsSyncImpl: (path: string) => boolean = () => true;
let readdirSyncImpl: (path: string) => string[] = () => ["encoder-model.int8.onnx"];

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: (path: string) => existsSyncImpl(path),
    readdirSync: (path: string) => readdirSyncImpl(path),
  };
});

import { transcribeWithParakeet, mapParakeetSegments } from "../../src/backends/parakeet.js";

const OPTS = {
  pythonPath: "/home/user/.agent-video-vision/venv/bin/python",
  modelDir: "/home/user/.agent-video-vision/models/parakeet-tdt-0.6b-v3-int8",
  quantization: "int8" as const,
};

describe("transcribeWithParakeet arg construction", () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileResult = { err: null, stdout: '{"segments": []}', stderr: "" };
    existsSyncImpl = () => true;
    readdirSyncImpl = () => ["encoder-model.int8.onnx"];
  });

  it("invokes the configured python with the runner script and flags", async () => {
    await transcribeWithParakeet("/tmp/scratch/audio.wav", OPTS);

    expect(execFileCalls).toHaveLength(1);
    const { command, args, options } = execFileCalls[0];
    expect(command).toBe(OPTS.pythonPath);
    expect(args[0].replace(/\\/g, "/")).toMatch(/\/python\/parakeet_transcribe\.py$/);
    expect(args.slice(1)).toEqual([
      "--model-dir", OPTS.modelDir,
      "--audio", "/tmp/scratch/audio.wav",
      "--quantization", "int8",
    ]);
    expect((options as { timeout: number }).timeout).toBe(3_600_000);
    expect((options as { maxBuffer: number }).maxBuffer).toBe(100 * 1024 * 1024);
  });

  it("passes fp32 quantization through", async () => {
    await transcribeWithParakeet("/tmp/a.wav", { ...OPTS, quantization: "fp32" });
    const { args } = execFileCalls[0];
    expect(args[args.indexOf("--quantization") + 1]).toBe("fp32");
  });

  it("parses script JSON into an AudioResult with HMS timestamps", async () => {
    execFileResult.stdout = JSON.stringify({
      segments: [
        { start: 0.5, end: 4.2, text: "hello world" },
        { start: 65.0, end: 3661.9, text: "later segment" },
      ],
    });

    const result = await transcribeWithParakeet("/tmp/a.wav", OPTS);

    expect(result).toEqual({
      backend: "local",
      transcription: [
        { start: "00:00:00", end: "00:00:04", text: "hello world" },
        { start: "00:01:05", end: "01:01:01", text: "later segment" },
      ],
      audio_tags: [],
      full_analysis: null,
    });
  });
});

describe("transcribeWithParakeet preflight checks", () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileResult = { err: null, stdout: '{"segments": []}', stderr: "" };
    existsSyncImpl = () => true;
    readdirSyncImpl = () => ["encoder-model.int8.onnx"];
  });

  it("throws an actionable error when the python venv is missing, without spawning", async () => {
    existsSyncImpl = (path) => path !== OPTS.pythonPath;

    await expect(transcribeWithParakeet("/tmp/a.wav", OPTS)).rejects.toThrow(
      `Parakeet python venv not found at ${OPTS.pythonPath} — run the setup wizard`,
    );
    expect(execFileCalls).toHaveLength(0);
  });

  it("throws when the model dir has no encoder*.onnx", async () => {
    readdirSyncImpl = () => ["vocab.txt", "._encoder-model.int8.onnx.txt"];

    await expect(transcribeWithParakeet("/tmp/a.wav", OPTS)).rejects.toThrow(
      /missing encoder\*\.onnx — run the setup wizard/,
    );
    expect(execFileCalls).toHaveLength(0);
  });
});

describe("transcribeWithParakeet error propagation", () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileResult = { err: null, stdout: '{"segments": []}', stderr: "" };
    existsSyncImpl = () => true;
    readdirSyncImpl = () => ["encoder-model.int8.onnx"];
  });

  it("surfaces an {\"error\"} payload from the script (zero exit)", async () => {
    execFileResult.stdout = '{"error": "onnx_asr not installed in this Python environment — run the setup wizard"}';
    execFileResult.stderr = "ImportError: onnx_asr";

    await expect(transcribeWithParakeet("/tmp/a.wav", OPTS)).rejects.toThrow(
      /onnx_asr not installed.*\nstderr: ImportError: onnx_asr/s,
    );
  });

  it("surfaces the script's JSON error when the process exits non-zero", async () => {
    const err = new Error("Command failed") as Error & { stdout?: string; stderr?: string };
    err.stdout = '{"error": "wav file not found"}';
    err.stderr = "wav file not found";
    execFileResult.err = err;

    await expect(transcribeWithParakeet("/tmp/a.wav", OPTS)).rejects.toThrow(
      /Parakeet transcription failed: wav file not found/,
    );
  });

  it("includes the stderr tail when stdout is not JSON", async () => {
    execFileResult.stdout = "Traceback (most recent call last): boom";
    execFileResult.stderr = "Segmentation fault";

    await expect(transcribeWithParakeet("/tmp/a.wav", OPTS)).rejects.toThrow(
      /invalid JSON output[\s\S]*Segmentation fault/,
    );
  });
});

describe("mapParakeetSegments", () => {
  it("maps seconds to HMS and filters empty/whitespace text defensively", () => {
    const result = mapParakeetSegments([
      { start: 2.7, end: 5.1, text: "  first  " },
      { start: 10, end: 12, text: "   " },
      { start: 12, end: 13, text: "" },
      { start: 90.2, end: 95.9, text: "second" },
    ]);

    expect(result.backend).toBe("local");
    expect(result.audio_tags).toEqual([]);
    expect(result.full_analysis).toBeNull();
    expect(result.transcription).toEqual([
      { start: "00:00:02", end: "00:00:05", text: "first" },
      { start: "00:01:30", end: "00:01:35", text: "second" },
    ]);
  });
});
