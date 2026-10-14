import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { Config } from "./types.js";

// Single source of truth for the on-disk data directory used by the server
// (config, models, sessions, downloads, python venv).
export const DATA_DIR = join(homedir(), ".agent-video-vision");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const SESSIONS_DIR = join(DATA_DIR, "sessions");

export const defaultConfig: Config = {
  engine: "unconfigured",
  whisper_model: "auto",
  whisper_at: false,
  fluid_model_dir: join(DATA_DIR, "models", "fluid-speech-mini-onnx"),
  fluid_python: join(DATA_DIR, "venv", "bin", "python"),
  frame_mode: "images",
  frame_format: "jpeg",
  frame_resolution: 512,
  default_fps: "auto",
  max_frames: 100,
  enable_index: false,
  session_max_age_days: 7,
  downloads_max_age_days: 7,
};

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    return { ...defaultConfig };
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  migrateLegacyConfig(raw);
  return { ...defaultConfig, ...raw };
}

// Configs written before the Fluid Speech switch name the removed Parakeet
// engine and its keys. Map the engine over (same venv path, new model dir
// default) and drop the dead keys so they never shadow the new defaults.
function migrateLegacyConfig(raw: Record<string, unknown>): void {
  if (raw.engine === "parakeet") {
    raw.engine = "fluid-speech";
    if (typeof raw.parakeet_python === "string") raw.fluid_python = raw.parakeet_python;
  }
  delete raw.parakeet_model_dir;
  delete raw.parakeet_quantization;
  delete raw.parakeet_python;
}

export function saveConfig(configPath: string, config: Config): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
