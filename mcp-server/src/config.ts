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
  parakeet_model_dir: join(DATA_DIR, "models", "parakeet-tdt-0.6b-v3-int8"),
  parakeet_quantization: "int8",
  parakeet_python: join(DATA_DIR, "venv", "bin", "python"),
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
  return { ...defaultConfig, ...raw };
}

export function saveConfig(configPath: string, config: Config): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
