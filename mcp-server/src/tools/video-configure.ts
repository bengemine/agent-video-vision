import { z } from "zod";
import { rmSync, existsSync } from "fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG_PATH, SESSIONS_DIR, loadConfig, saveConfig } from "../config.js";

export function registerVideoConfigure(server: McpServer): void {
  server.tool(
    "video_configure",
    "Configure video perception preferences (engine, resolution, fps, whisper model, fluid speech paths, etc.)",
    {
      engine: z.enum(["unconfigured", "fluid-speech", "whisper-cpp", "whisper-python"]).optional(),
      whisper_model: z.enum(["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3", "auto"]).optional(),
      whisper_at: z.boolean().optional(),
      fluid_model_dir: z.string().min(1).optional(),
      fluid_python: z.string().min(1).optional(),
      frame_mode: z.enum(["images", "descriptions", "paths"]).optional(),
      frame_format: z.enum(["jpeg", "png", "webp"]).optional(),
      frame_resolution: z.number().min(128).max(2048).optional(),
      default_fps: z.union([z.number().positive(), z.literal("auto")]).optional(),
      max_frames: z.number().min(1).max(1000).optional(),
      enable_index: z.boolean().optional(),
      session_max_age_days: z.number().min(1).optional(),
      downloads_max_age_days: z.number().min(1).optional(),
      clear_sessions: z.boolean().optional(),
    },
    async (params) => {
      if (params.clear_sessions) {
        if (existsSync(SESSIONS_DIR)) {
          rmSync(SESSIONS_DIR, { recursive: true, force: true });
        }
      }

      const current = loadConfig(CONFIG_PATH);
      const updated = { ...current };

      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && key !== "clear_sessions") {
          (updated as any)[key] = value;
        }
      }

      saveConfig(CONFIG_PATH, updated);

      let responseText = `Configuration saved to ${CONFIG_PATH}:\n${JSON.stringify(updated, null, 2)}`;
      if (params.clear_sessions) {
        responseText += "\n\nAll sessions have been cleared.";
      }
      return { content: [{ type: "text", text: responseText }] };
    },
  );
}
