import { readFileSync } from "fs";
import { basename, dirname, extname } from "path";
import type { ContactSheet } from "../extractors/contact-sheet.js";
import type { DedupeStats } from "../extractors/dedupe.js";
import type { FrameMode } from "../types.js";

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function dedupeSummary(stats: DedupeStats | null): string {
  if (!stats) return "";
  return `Dedupe: kept ${stats.kept} of ${stats.extracted} frames; dropped ${stats.dropped} near-identical to the previous kept frame (threshold ${stats.threshold} of pixels changed).`;
}

/**
 * MCP content for contact-sheet mode: the sheets (inline images, or paths in
 * paths mode) plus the list of individual kept frames so any one of them can
 * be zoomed with video_detail.
 */
export function contactSheetContent(
  sheets: ContactSheet[],
  frames: Array<{ timestamp: string; path?: string }>,
  frameMode: FrameMode,
  summary: string,
): ContentBlock[] {
  const content: ContentBlock[] = [];
  const sheetLines = sheets.map((s, i) => {
    const first = s.timestamps[0];
    const last = s.timestamps[s.timestamps.length - 1];
    return `Sheet ${i + 1}: ${first} to ${last} (${s.timestamps.length} frames) -> ${s.path}`;
  });
  const guide =
    `Each tile is stamped with its timestamp; tiles read left to right, top to bottom. Look at EVERY sheet: the cursor position matters. ` +
    `To zoom on one moment, call video_detail with view: ["<timestamp>"], or with a 1-second segment at resolution 1280 plus view.`;

  if (frameMode === "paths") {
    content.push({
      type: "text",
      text: `## Contact sheets (${sheets.length})\n${summary}\nFrame mode is 'paths' — open these sheet images with your host's image viewing tool. ${guide}\n\n${sheetLines.join("\n")}`,
    });
  } else {
    content.push({
      type: "text",
      text: `## Contact sheets (${sheets.length})\n${summary}\n${guide}` +
        (frameMode === "descriptions"
          ? `\nFrame mode is "descriptions" — describe each tile (by its timestamp) in text per your host's video-perception skill, then continue with the text only.`
          : ""),
    });
    sheets.forEach((sheet, i) => {
      content.push({ type: "text", text: `### ${sheetLines[i]}` });
      try {
        content.push({ type: "image", data: readFileSync(sheet.path).toString("base64"), mimeType: "image/jpeg" });
      } catch {
        // sheet file missing — the path line above still says where it should be
      }
    });
  }

  content.push({ type: "text", text: keptFramesText(frames) });
  return content;
}

/**
 * List kept frames compactly: when every file sits in one folder and is named
 * after its timestamp (the session layout), give the folder once plus the
 * timestamps; otherwise one "timestamp -> path" line per frame.
 */
export function keptFramesText(frames: Array<{ timestamp: string; path?: string }>): string {
  const dirs = new Set(frames.map((f) => (f.path ? dirname(f.path) : "")));
  const ext = frames[0]?.path ? extname(frames[0].path) : "";
  const timestampNamed =
    dirs.size === 1 &&
    !dirs.has("") &&
    frames.every((f) => f.path && basename(f.path) === `${f.timestamp.replace(/:/g, "-")}${ext}`);
  if (frames.length > 0 && timestampNamed) {
    return `## Kept frames (${frames.length})\nFolder: ${[...dirs][0]}/ (file name = timestamp with ':' as '-', e.g. ${basename(frames[0].path!)})\n${frames.map((f) => f.timestamp).join(", ")}`;
  }
  return `## Kept frames (${frames.length})\n${frames.map((f) => `${f.timestamp} -> ${f.path ?? "(file missing)"}`).join("\n")}`;
}
