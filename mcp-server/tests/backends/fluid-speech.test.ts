import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture execFile invocations so we can inspect args and control stdout,
// mirroring tests/backends/local.test.ts. promisify(execFile) inside
// src/backends/fluid-speech.ts resolves to this fake.
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
// the model dir contains the ONNX build's files.
const MODEL_FILES = ["encoder.onnx", "encoder.onnx.data", "decoder.onnx", "joint.onnx", "tokenizer.json", "config.json", "mel_filters.npy"];
let existsSyncImpl: (path: string) => boolean = () => true;
let readdirSyncImpl: (path: string) => string[] = () => MODEL_FILES;

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: (path: string) => existsSyncImpl(path),
    readdirSync: (path: string) => readdirSyncImpl(path),
  };
});

import { transcribeWithFluidSpeech, mapFluidSpeechSegments } from "../../src/backends/fluid-speech.js";

const OPTS = {
  pythonPath: "/home/user/.agent-video-vision/venv/bin/python",
  modelDir: "/home/user/.agent-video-vision/models/fluid-speech-mini-onnx",
};

function resetFakes() {
  execFileCalls.length = 0;
  execFileResult = { err: null, stdout: '{"segments": []}', stderr: "" };
  existsSyncImpl = () => true;
  readdirSyncImpl = () => MODEL_FILES;
}

describe("transcribeWithFluidSpeech arg construction", () => {
  beforeEach(resetFakes);

  it("invokes the configured python with the runner script and flags", async () => {
    await transcribeWithFluidSpeech("/tmp/scratch/audio.wav", OPTS);

    expect(execFileCalls).toHaveLength(1);
    const { command, args, options } = execFileCalls[0];
    expect(command).toBe(OPTS.pythonPath);
    expect(args[0].replace(/\\/g, "/")).toMatch(/\/python\/fluid_speech_transcribe\.py$/);
    expect(args.slice(1)).toEqual([
      "--model-dir", OPTS.modelDir,
      "--audio", "/tmp/scratch/audio.wav",
    ]);
    expect((options as { timeout: number }).timeout).toBe(3_600_000);
    expect((options as { maxBuffer: number }).maxBuffer).toBe(100 * 1024 * 1024);
  });

  it("parses script JSON into an AudioResult with HMS timestamps", async () => {
    execFileResult.stdout = JSON.stringify({
      segments: [
        { start: 0.5, end: 4.2, text: "hello world" },
        { start: 65.0, end: 3661.9, text: "later segment" },
      ],
    });

    const result = await transcribeWithFluidSpeech("/tmp/a.wav", OPTS);

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

describe("transcribeWithFluidSpeech preflight checks", () => {
  beforeEach(resetFakes);

  it("throws an actionable error when the python venv is missing, without spawning", async () => {
    existsSyncImpl = (path) => path !== OPTS.pythonPath;

    await expect(transcribeWithFluidSpeech("/tmp/a.wav", OPTS)).rejects.toThrow(
      `Fluid Speech python venv not found at ${OPTS.pythonPath} — run the setup wizard`,
    );
    expect(execFileCalls).toHaveLength(0);
  });

  it("throws when the model dir lacks encoder.onnx or tokenizer.json", async () => {
    readdirSyncImpl = () => ["encoder.onnx", "config.json"];

    await expect(transcribeWithFluidSpeech("/tmp/a.wav", OPTS)).rejects.toThrow(
      /missing encoder\.onnx \/ tokenizer\.json — run the setup wizard/,
    );
    expect(execFileCalls).toHaveLength(0);
  });

  it("throws when the model dir does not exist", async () => {
    existsSyncImpl = (path) => path !== OPTS.modelDir;

    await expect(transcribeWithFluidSpeech("/tmp/a.wav", OPTS)).rejects.toThrow(/run the setup wizard/);
    expect(execFileCalls).toHaveLength(0);
  });
});

describe("transcribeWithFluidSpeech error propagation", () => {
  beforeEach(resetFakes);

  it("surfaces an {\"error\"} payload from the script (zero exit)", async () => {
    execFileResult.stdout = '{"error": "onnxruntime is not installed in this Python environment — run the setup wizard"}';
    execFileResult.stderr = "ImportError: onnxruntime";

    await expect(transcribeWithFluidSpeech("/tmp/a.wav", OPTS)).rejects.toThrow(
      /onnxruntime is not installed.*\nstderr: ImportError: onnxruntime/s,
    );
  });

  it("surfaces the script's JSON error when the process exits non-zero", async () => {
    const err = new Error("Command failed") as Error & { stdout?: string; stderr?: string };
    err.stdout = '{"error": "wav file not found: /tmp/a.wav"}';
    err.stderr = "wav file not found: /tmp/a.wav";
    execFileResult.err = err;

    await expect(transcribeWithFluidSpeech("/tmp/a.wav", OPTS)).rejects.toThrow(
      /Fluid Speech transcription failed: wav file not found/,
    );
  });

  it("includes the stderr tail when stdout is not JSON", async () => {
    execFileResult.stdout = "Traceback (most recent call last): boom";
    execFileResult.stderr = "Segmentation fault";

    await expect(transcribeWithFluidSpeech("/tmp/a.wav", OPTS)).rejects.toThrow(
      /invalid JSON output[\s\S]*Segmentation fault/,
    );
  });
});

describe("mapFluidSpeechSegments", () => {
  it("maps seconds to HMS and filters empty/whitespace text defensively", () => {
    const result = mapFluidSpeechSegments([
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
