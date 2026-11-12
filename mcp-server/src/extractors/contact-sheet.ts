import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const execFileAsync = promisify(execFile);

/**
 * Contact sheets: tile frames into grid images (default 2 columns x 5 rows),
 * each tile stamped with its timestamp, so an agent can scan dozens of frames
 * in a few images instead of one image per frame.
 */

export interface SheetInputFrame {
  timestamp: string;
  path: string;
}

export interface ContactSheet {
  path: string;
  timestamps: string[];
}

export interface ContactSheetOptions {
  outputDir: string;
  perSheet?: number;
  columns?: number;
  tileWidth?: number;
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
];

function findFont(): string | null {
  return FONT_CANDIDATES.find((f) => existsSync(f)) ?? null;
}

/** Escape a value for use inside a single-quoted ffmpeg filter option. */
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function xstackLayout(count: number, columns: number): string {
  const positions: string[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col === 0 ? "0" : Array(col).fill("w0").join("+");
    const y = row === 0 ? "0" : Array(row).fill("h0").join("+");
    positions.push(`${x}_${y}`);
  }
  return positions.join("|");
}

export function buildSheetFilter(
  timestamps: string[],
  columns: number,
  tileWidth: number,
  fontFile: string | null,
  withLabels = true,
): string {
  const fontSize = Math.max(14, Math.round(tileWidth / 22));
  const font = fontFile ? `fontfile='${escapeFilterValue(fontFile)}':` : "";
  const parts = timestamps.map((ts, i) => {
    const label = withLabels
      ? `,drawtext=${font}text='${escapeFilterValue(ts)}':x=6:y=6:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=5`
      : "";
    return `[${i}:v]scale=${tileWidth}:-2${label},pad=iw+4:ih+4:2:2:color=0x808080[t${i}]`;
  });
  if (timestamps.length === 1) {
    return `${parts[0].replace(/\[t0\]$/, "[out]")}`;
  }
  const inputs = timestamps.map((_, i) => `[t${i}]`).join("");
  parts.push(`${inputs}xstack=inputs=${timestamps.length}:layout=${xstackLayout(timestamps.length, columns)}[out]`);
  return parts.join(";");
}

async function renderSheet(
  frames: SheetInputFrame[],
  outPath: string,
  columns: number,
  tileWidth: number,
  fontFile: string | null,
  withLabels: boolean,
): Promise<void> {
  const args: string[] = ["-v", "error", "-y"];
  for (const frame of frames) args.push("-i", frame.path);
  args.push(
    "-filter_complex", buildSheetFilter(frames.map((f) => f.timestamp), columns, tileWidth, fontFile, withLabels),
    "-map", "[out]",
    "-frames:v", "1",
    "-q:v", "3",
    outPath,
  );
  await execFileAsync("ffmpeg", args);
}

export async function buildContactSheets(
  frames: SheetInputFrame[],
  options: ContactSheetOptions,
): Promise<ContactSheet[]> {
  const perSheet = Math.max(1, Math.floor(options.perSheet ?? 10));
  const columns = Math.max(1, Math.floor(options.columns ?? 2));
  const tileWidth = Math.max(128, Math.round((options.tileWidth ?? 512) / 2) * 2);
  const usable = frames.filter((f) => f.path && existsSync(f.path));
  if (usable.length === 0) return [];

  mkdirSync(options.outputDir, { recursive: true });
  const fontFile = findFont();
  const sheets: ContactSheet[] = [];

  for (let start = 0, n = 1; start < usable.length; start += perSheet, n++) {
    const chunk = usable.slice(start, start + perSheet);
    const outPath = join(options.outputDir, `sheet_${String(n).padStart(2, "0")}.jpg`);
    try {
      await renderSheet(chunk, outPath, columns, tileWidth, fontFile, true);
    } catch {
      // ffmpeg without drawtext (no libfreetype): build the sheet unlabeled;
      // the caller still lists each sheet's timestamps in text.
      await renderSheet(chunk, outPath, columns, tileWidth, fontFile, false);
    }
    sheets.push({ path: outPath, timestamps: chunk.map((f) => f.timestamp) });
  }

  return sheets;
}
