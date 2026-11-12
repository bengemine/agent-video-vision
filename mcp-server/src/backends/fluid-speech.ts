import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { formatHMS } from "../utils/timestamps.js";
import type { AudioResult, TranscriptionSegment } from "../types.js";

const execFileAsync = promisify(execFile);

export interface FluidSpeechOptions {
  /** Python interpreter inside the venv that has onnxruntime >= 1.31 installed. */
  pythonPath: string;
  /** Directory holding the Fluid Speech Mini ONNX build (encoder.onnx, decoder.onnx, joint.onnx, tokenizer.json, ...). */
  modelDir: string;
}

// Compiled location is dist/backends/fluid-speech.js; the runner script ships
// alongside dist in <package root>/python/. Two levels up from this file's
// directory reaches the package root in both dist/ and src/ (vitest) layouts.
// Also works when bundled into a single dist/index.js (one level up).
const HERE = dirname(fileURLToPath(import.meta.url));
// Resolved at call time (not module load) so tests can mock fs first.
function scriptPath(): string {
  const candidates = [
    join(HERE, "..", "..", "python", "fluid_speech_transcribe.py"),
    join(HERE, "..", "python", "fluid_speech_transcribe.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

interface FluidSpeechScriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Map the runner script's JSON segments to the shared AudioResult shape. */
export function mapFluidSpeechSegments(segments: FluidSpeechScriptSegment[]): AudioResult {
  const transcription: TranscriptionSegment[] = [];
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue; // filtered python-side too; defensive
    transcription.push({
      start: formatHMS(seg.start ?? 0),
      end: formatHMS(seg.end ?? 0),
      text,
    });
  }
  return {
    backend: "local",
    transcription,
    audio_tags: [],
    full_analysis: null,
  };
}

function tail(text: string, maxChars = 2000): string {
  const trimmed = (text || "").trim();
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

export async function transcribeWithFluidSpeech(
  wavPath: string,
  options: FluidSpeechOptions,
): Promise<AudioResult> {
  const { pythonPath, modelDir } = options;

  // Preflight: actionable errors instead of cryptic ENOENT / onnx tracebacks.
  if (!existsSync(pythonPath)) {
    throw new Error(
      `Fluid Speech python venv not found at ${pythonPath} — run the setup wizard (see commands/setup-video-vision.md)`,
    );
  }
  const files = existsSync(modelDir) ? readdirSync(modelDir) : [];
  // Two layouts are accepted: the original HuggingFace ONNX build
  // (encoder.onnx + tokenizer.json) and the sherpa-onnx conversion hosted on
  // GitHub (encoder.q4.onnx + tokens.txt), which cloud sessions use because
  // huggingface.co is not reachable there.
  const hasModel =
    (files.includes("encoder.onnx") && files.includes("tokenizer.json")) ||
    (files.includes("encoder.q4.onnx") && files.includes("tokens.txt"));
  if (!hasModel) {
    throw new Error(
      `Fluid Speech model dir ${modelDir} is missing encoder.onnx / tokenizer.json — run the setup wizard (see commands/setup-video-vision.md). ` +
      `The sherpa-onnx layout (encoder.q4.onnx + tokens.txt) also works: a cloud session sets it up at start-up; ` +
      `if it is still missing, run: bash "\${CLAUDE_PLUGIN_ROOT}/bootstrap.sh" (log: ~/.agent-video-vision/bootstrap.log), then retry.`,
    );
  }
  const SCRIPT_PATH = scriptPath();
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(
      `Fluid Speech runner script not found at ${SCRIPT_PATH} — the agent-video-vision install is incomplete`,
    );
  }

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(
      pythonPath,
      [
        SCRIPT_PATH,
        "--model-dir", modelDir,
        "--audio", wavPath,
      ],
      { timeout: 3_600_000, maxBuffer: 100 * 1024 * 1024 },
    ));
  } catch (err) {
    // Non-zero exit: the script still prints {"error": ...} on stdout.
    const e = err as Error & { stdout?: string; stderr?: string };
    const scriptError = extractScriptError(e.stdout ?? "");
    throw new Error(
      `Fluid Speech transcription failed: ${scriptError ?? e.message}` +
        (e.stderr?.trim() ? `\nstderr: ${tail(e.stderr)}` : ""),
    );
  }

  let parsed: { segments?: FluidSpeechScriptSegment[]; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Fluid Speech runner produced invalid JSON output.` +
        (stderr.trim() ? `\nstderr: ${tail(stderr)}` : `\nstdout: ${tail(stdout)}`),
    );
  }

  if (parsed.error) {
    throw new Error(
      `Fluid Speech transcription failed: ${parsed.error}` +
        (stderr.trim() ? `\nstderr: ${tail(stderr)}` : ""),
    );
  }

  return mapFluidSpeechSegments(parsed.segments ?? []);
}

function extractScriptError(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}
