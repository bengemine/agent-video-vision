import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, saveConfig, defaultConfig, DATA_DIR } from "../src/config.js";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), "avv-test-" + Date.now());

describe("config", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns default config when no file exists", () => {
    const config = loadConfig(join(TEST_DIR, "config.json"));
    expect(config.engine).toBe("unconfigured");
    expect(config.frame_mode).toBe("images");
    expect(config.frame_format).toBe("jpeg");
    expect(config.frame_resolution).toBe(512);
    expect(config.default_fps).toBe("auto");
    expect(config.max_frames).toBe(100);
    expect(config.whisper_model).toBe("auto");
  });

  it("saves and loads config", () => {
    const configPath = join(TEST_DIR, "config.json");
    const custom = { ...defaultConfig, engine: "whisper-cpp" as const, frame_resolution: 768 };
    saveConfig(configPath, custom);
    const loaded = loadConfig(configPath);
    expect(loaded.engine).toBe("whisper-cpp");
    expect(loaded.frame_resolution).toBe(768);
  });

  it("merges partial config with defaults", () => {
    const configPath = join(TEST_DIR, "config.json");
    writeFileSync(configPath, JSON.stringify({ engine: "parakeet" }));
    const loaded = loadConfig(configPath);
    expect(loaded.engine).toBe("parakeet");
    expect(loaded.frame_mode).toBe("images");
    expect(loaded.frame_format).toBe("jpeg");
    expect(loaded.max_frames).toBe(100);
  });

  it("returns new defaults for enable_index and session_max_age_days", () => {
    const config = loadConfig(join(TEST_DIR, "config.json"));
    expect(config.enable_index).toBe(false);
    expect(config.session_max_age_days).toBe(7);
    expect(config.downloads_max_age_days).toBe(7);
  });

  it("preserves enable_index when set", () => {
    const configPath = join(TEST_DIR, "config.json");
    writeFileSync(configPath, JSON.stringify({ enable_index: true }));
    const loaded = loadConfig(configPath);
    expect(loaded.enable_index).toBe(true);
    expect(loaded.session_max_age_days).toBe(7);
    expect(loaded.downloads_max_age_days).toBe(7);
  });

  it("defaults parakeet paths under the data dir", () => {
    const config = loadConfig(join(TEST_DIR, "config.json"));
    expect(config.parakeet_model_dir).toBe(join(DATA_DIR, "models", "parakeet-tdt-0.6b-v3-int8"));
    expect(config.parakeet_python).toBe(join(DATA_DIR, "venv", "bin", "python"));
    expect(config.parakeet_quantization).toBe("int8");
  });

  it("preserves parakeet overrides when set", () => {
    const configPath = join(TEST_DIR, "config.json");
    writeFileSync(configPath, JSON.stringify({ parakeet_quantization: "fp32", parakeet_python: "/opt/venv/bin/python" }));
    const loaded = loadConfig(configPath);
    expect(loaded.parakeet_quantization).toBe("fp32");
    expect(loaded.parakeet_python).toBe("/opt/venv/bin/python");
    expect(loaded.parakeet_model_dir).toBe(join(DATA_DIR, "models", "parakeet-tdt-0.6b-v3-int8"));
  });

  it("data dir points at ~/.agent-video-vision", () => {
    expect(DATA_DIR.endsWith(".agent-video-vision")).toBe(true);
  });
});
