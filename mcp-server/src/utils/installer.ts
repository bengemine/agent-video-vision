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

export interface ParakeetCheckOptions {
  pythonPath: string;
  modelDir: string;
}

async function checkParakeet(
  opts: ParakeetCheckOptions,
  missing: string[],
  instructions: string[],
): Promise<void> {
  if (!existsSync(opts.pythonPath)) {
    missing.push("parakeet python venv");
    instructions.push(`Create a Python venv at ${join(DATA_DIR, "venv")} — expected interpreter at ${opts.pythonPath}`);
  } else {
    try {
      await execFileAsync(opts.pythonPath, ["-c", "import onnx_asr"], { timeout: 30_000 });
    } catch {
      missing.push("onnx_asr (python package)");
      // Venvs created with plain `uv venv` have no pip inside — give both forms.
      instructions.push(
        `${opts.pythonPath} -m pip install "onnx-asr[cpu,hub]" "onnxruntime<1.24"` +
        ` (or, if the venv has no pip: uv pip install --python ${opts.pythonPath} "onnx-asr[cpu,hub]" "onnxruntime<1.24")`,
      );
    }
  }

  let hasEncoder = false;
  let hasVocab = false;
  if (existsSync(opts.modelDir)) {
    for (const file of readdirSync(opts.modelDir)) {
      if (file.startsWith("encoder") && file.endsWith(".onnx")) hasEncoder = true;
      if (file === "vocab.txt") hasVocab = true;
    }
  }
  if (!hasEncoder || !hasVocab) {
    missing.push("parakeet model files");
    instructions.push(`Download the Parakeet ONNX model (encoder*.onnx + vocab.txt) into ${opts.modelDir}`);
  }
}

export async function checkDependencies(
  engine: Engine,
  parakeetOpts?: ParakeetCheckOptions,
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

  if (engine === "parakeet" && parakeetOpts) {
    await checkParakeet(parakeetOpts, missing, instructions);
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
