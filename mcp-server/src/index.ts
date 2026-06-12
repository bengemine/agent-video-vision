#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVideoWatch } from "./tools/video-watch.js";
import { registerVideoInfo } from "./tools/video-info.js";
import { registerVideoSetup } from "./tools/video-setup.js";
import { registerVideoConfigure } from "./tools/video-configure.js";
import { registerVideoAnalyze } from "./tools/video-analyze.js";
import { registerVideoDetail } from "./tools/video-detail.js";
import { CONFIG_PATH, SESSIONS_DIR, loadConfig } from "./config.js";
import { cleanExpiredSessions } from "./session/manager.js";
import { cleanExpiredDownloads, getDownloadsDir } from "./utils/video-source.js";

const server = new McpServer({
  name: "agent-video-vision",
  version: "0.1.0",
});

registerVideoWatch(server);
registerVideoInfo(server);
registerVideoSetup(server);
registerVideoConfigure(server);
registerVideoAnalyze(server);
registerVideoDetail(server);

const config = loadConfig(CONFIG_PATH);
if (config.enable_index) {
  cleanExpiredSessions(SESSIONS_DIR, config.session_max_age_days);
}
cleanExpiredDownloads(getDownloadsDir(), config.downloads_max_age_days);

const transport = new StdioServerTransport();
await server.connect(transport);
