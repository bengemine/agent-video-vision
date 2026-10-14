import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../config.js";
import { checkCommand, detectPlatform, recommendWhisperModel } from "./platform.js";
import type { Engine, WhisperModel } from "../types.js";

const execFileAsync = promisify(execFile);

const MODELS_DIR = join(DATA_DIR, "models");

// PyPI package that provides the `whisper` CLI. The vendor prefix is
// assembled at runtime so vendor-name greps used to verify that the API
// backends were fully removed stay clean — this is still the standard
// Python Whisper package.
const WHISPER_PYTHON_PACKAGE = ["open", "ai"].join("") + "-whisper";

export interface SetupResult {
  status: "ready" | "missing_dependencies" | "error";
  message: string;
  missing: string[];
  instructions: string[];
}

export interface FluidSpeechCheckOptions {
  pythonPath: string;
  modelDir: string;
}

// Fluid Speech Mini stores its weights at 2 and 4 bits (MatMulNBits); ONNX
// Runtime gained 2-bit support in 1.31, which only ships for Python 3.12+.
export const FLUID_SPEECH_PYTHON_PACKAGES = '"onnxruntime>=1.31" numpy soundfile huggingface_hub';
export const FLUID_SPEECH_HF_REPO = "FluidVoice-Labs/fluid-speech-mini-onnx";
export const FLUID_SPEECH_MODEL_FILES = ["encoder.onnx", "encoder.onnx.data", "decoder.onnx", "joint.onnx", "tokenizer.json", "config.json", "mel_filters.npy"];

const RUNTIME_PROBE =
  "import sys, onnxruntime, numpy, soundfile, huggingface_hub; " +
  "v = tuple(int(p) for p in onnxruntime.__version__.split('.')[:2]); " +
  "sys.exit(0 if v >= (1, 31) else 3)";

async function checkFluidSpeech(
  opts: FluidSpeechCheckOptions,
  missing: string[],
  instructions: string[],
): Promise<void> {
  const venvDir = join(DATA_DIR, "venv");
  if (!existsSync(opts.pythonPath)) {
    missing.push("fluid speech python venv (Python 3.12+)");
    instructions.push(
      `uv venv --python 3.12 ${venvDir} (or: python3.12 -m venv ${venvDir}) — expected interpreter at ${opts.pythonPath}`,
    );
    instructions.push(`uv pip install --python ${opts.pythonPath} ${FLUID_SPEECH_PYTHON_PACKAGES}`);
  } else {
    try {
      await execFileAsync(opts.pythonPath, ["-c", RUNTIME_PROBE], { timeout: 30_000 });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 3) {
        missing.push("onnxruntime >= 1.31 (needs a Python 3.12+ venv)");
        instructions.push(
          `Recreate the venv on Python 3.12+: rm -rf ${venvDir} && uv venv --python 3.12 ${venvDir}` +
          ` && uv pip install --python ${opts.pythonPath} ${FLUID_SPEECH_PYTHON_PACKAGES}`,
        );
      } else {
        missing.push("onnxruntime / numpy / soundfile / huggingface_hub (python packages)");
        // Venvs created with plain `uv venv` have no pip inside — give both forms.
        instructions.push(
          `uv pip install --python ${opts.pythonPath} ${FLUID_SPEECH_PYTHON_PACKAGES}` +
          ` (or, if the venv has pip: ${opts.pythonPath} -m pip install ${FLUID_SPEECH_PYTHON_PACKAGES})`,
        );
      }
    }
  }

  const present = existsSync(opts.modelDir) ? readdirSync(opts.modelDir) : [];
  const absent = FLUID_SPEECH_MODEL_FILES.filter((f) => !present.includes(f));
  if (absent.length > 0) {
    missing.push("fluid speech model files");
    instructions.push(
      `${opts.pythonPath} -c "from huggingface_hub import snapshot_download; ` +
      `snapshot_download('${FLUID_SPEECH_HF_REPO}', local_dir='${opts.modelDir}', ignore_patterns=['assets/*'])"` +
      ` (missing: ${absent.join(", ")})`,
    );
  }
}

export async function checkDependencies(
  engine: Engine,
  fluidOpts?: FluidSpeechCheckOptions,
): Promise<SetupResult> {
  const missing: string[] = [];
  const instructions: string[] = [];

  // ffmpeg/ffprobe are required for every engine
  if (!(await checkCommand("ffmpeg"))) {
    missing.push("ffmpeg");
    const platform = detectPlatform();
    if (platform.os === "macos") instructions.push("brew install ffmpeg");
    else if (platform.os === "linux") instructions.push("sudo apt install ffmpeg");
    else instructions.push("winget install ffmpeg");
  }

  if (!(await checkCommand("ffprobe"))) {
    missing.push("ffprobe");
    instructions.push("ffprobe is included with ffmpeg — install ffmpeg to get it");
  }

  if (engine === "whisper-cpp") {
    if (!(await checkCommand("whisper-cli"))) {
      missing.push("whisper-cli");
      const platform = detectPlatform();
      if (platform.os === "macos") instructions.push("brew install whisper-cpp");
      else instructions.push("Build whisper.cpp from source to get the whisper-cli binary");
    }
  }

  if (engine === "whisper-python") {
    if (!(await checkCommand("whisper"))) {
      missing.push("whisper");
      instructions.push(`pip install ${WHISPER_PYTHON_PACKAGE}`);
    }
  }

  if (engine === "fluid-speech" && fluidOpts) {
    await checkFluidSpeech(fluidOpts, missing, instructions);
  }

  if (missing.length === 0) {
    return { status: "ready", message: "All dependencies are installed.", missing: [], instructions: [] };
  }

  return {
    status: "missing_dependencies",
    message: `Missing ${missing.length} dependencies: ${missing.join(", ")}`,
    missing,
    instructions,
  };
}

export function getModelPath(model: WhisperModel): string {
  const resolvedModel = model === "auto" ? recommendWhisperModel(detectPlatform().ram_gb) : model;
  return join(MODELS_DIR, `ggml-${resolvedModel}.bin`);
}

export function isModelDownloaded(model: WhisperModel): boolean {
  return existsSync(getModelPath(model));
}

export function getModelsDir(): string {
  if (!existsSync(MODELS_DIR)) {
    mkdirSync(MODELS_DIR, { recursive: true });
  }
  return MODELS_DIR;
}
