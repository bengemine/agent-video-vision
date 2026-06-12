import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG_PATH, loadConfig } from "../config.js";
import { checkDependencies } from "../utils/installer.js";
import { checkCommand, detectPlatform, recommendWhisperModel } from "../utils/platform.js";

export function registerVideoSetup(server: McpServer): void {
  server.tool(
    "video_setup",
    "Check dependencies for video perception (ffmpeg always; whisper-cli, whisper, or the Parakeet venv/model depending on the engine; optional yt-dlp for YouTube URLs). Pure status report — it installs nothing.",
    {
      engine: z.enum(["parakeet", "whisper-cpp", "whisper-python"]).optional().describe("Audio engine to check — defaults to the configured engine"),
      whisper_model: z.enum(["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3", "auto"]).default("auto"),
    },
    async ({ engine, whisper_model }) => {
      const config = loadConfig(CONFIG_PATH);
      const effectiveEngine = engine ?? config.engine;

      const platform = detectPlatform();
      const result = await checkDependencies(effectiveEngine, {
        pythonPath: config.parakeet_python,
        modelDir: config.parakeet_model_dir,
      });
      const hasYtDlp = await checkCommand("yt-dlp");

      const resolvedModel = whisper_model === "auto"
        ? recommendWhisperModel(platform.ram_gb)
        : whisper_model;

      let report = `## Platform Detected\n`;
      report += `- OS: ${platform.os}\n`;
      report += `- Architecture: ${platform.arch}\n`;
      report += `- GPU: ${platform.gpu}\n`;
      report += `- RAM: ${platform.ram_gb}GB (${platform.free_ram_gb}GB free)\n\n`;
      report += `## Engine: ${effectiveEngine}\n\n`;

      if (effectiveEngine === "unconfigured") {
        report += `No engine is configured yet. Pick one with video_configure (engine: "parakeet", "whisper-cpp", or "whisper-python"), or pass engine to this tool to check its dependencies.\n\n`;
      }

      if (effectiveEngine === "whisper-cpp" || effectiveEngine === "whisper-python") {
        report += `- Recommended whisper model: ${resolvedModel}\n\n`;
      }

      if (effectiveEngine === "parakeet") {
        report += `- Python: ${config.parakeet_python}\n`;
        report += `- Model dir: ${config.parakeet_model_dir}\n`;
        report += `- Quantization: ${config.parakeet_quantization}\n\n`;
      }

      report += `## YouTube URL Support\n`;
      if (hasYtDlp) {
        report += `- Status: Ready (\`yt-dlp\` found)\n\n`;
      } else {
        const install = platform.os === "macos" ? "brew install yt-dlp" : "pipx install yt-dlp";
        report += `- Status: Missing optional dependency\n`;
        report += `- Install: \`${install}\`\n\n`;
      }

      if (result.status === "ready") {
        report += `## Status: Ready\nAll dependencies are installed.`;
      } else {
        report += `## Status: Missing Dependencies\n\n`;
        for (let i = 0; i < result.instructions.length; i++) {
          report += `${i + 1}. \`${result.instructions[i]}\`\n`;
        }
        report += `\n**Please install the missing dependencies and run video_setup again.**`;
      }

      return { content: [{ type: "text", text: report }] };
    },
  );
}
