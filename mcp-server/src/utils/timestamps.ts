import type { AudioResult, AudioTag, TranscriptionSegment } from "../types.js";

/** HH:MM:SS with an optional fractional part (e.g. 00:00:40.5). */
export const HMS_REGEX = /^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;

export function parseHMS(timestamp: string): number {
  const parts = timestamp.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid HH:MM:SS timestamp: ${timestamp}`);
  }
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s;
}

export function formatHMS(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Frame timestamp: HH:MM:SS for whole seconds, else HH:MM:SS plus up to two
 * decimals (00:00:40.5, 00:00:38.25), so frames sampled faster than 1 fps
 * (up to 30+ fps) never share a timestamp or a file name.
 */
export function formatFrameTimestamp(seconds: number): string {
  const hundredths = Math.round(Math.max(0, seconds) * 100);
  const whole = formatHMS(Math.floor(hundredths / 100));
  const frac = hundredths % 100;
  if (frac === 0) return whole;
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export function shiftAudioResult(
  result: AudioResult,
  offsetSeconds: number,
): AudioResult {
  if (offsetSeconds === 0) {
    return result;
  }

  const shiftSegment = <T extends TranscriptionSegment | AudioTag>(entry: T): T => ({
    ...entry,
    start: formatHMS(parseHMS(entry.start) + offsetSeconds),
    end: formatHMS(parseHMS(entry.end) + offsetSeconds),
  });

  return {
    ...result,
    transcription: result.transcription.map(shiftSegment),
    audio_tags: result.audio_tags.map(shiftSegment),
  };
}
