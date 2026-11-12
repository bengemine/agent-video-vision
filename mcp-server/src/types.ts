export type Backend = "local" | "youtube-captions" | "unconfigured" | "none";
export type Engine = "unconfigured" | "fluid-speech" | "whisper-cpp" | "whisper-python";
export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3-turbo" | "large-v3" | "auto";
export type FrameMode = "images" | "descriptions" | "paths";
export type FrameFormat = "jpeg" | "png" | "webp";

export interface Config {
  engine: Engine;
  whisper_model: WhisperModel;
  whisper_at: boolean;
  fluid_model_dir: string;
  fluid_python: string;
  frame_mode: FrameMode;
  frame_format: FrameFormat;
  frame_resolution: number;
  default_fps: number | "auto";
  max_frames: number;
  enable_index: boolean;
  session_max_age_days: number;
  downloads_max_age_days: number;
  /** Drop a frame when fewer than this fraction of its pixels differ from the last kept frame (0.00002 ≈ 41 px on 1920x1080). */
  dedupe_threshold: number;
  /** Frames per contact sheet (tiled 2 columns wide). */
  contact_sheet_size: number;
  /** video_watch with fps "auto" on a clip up to this many seconds uses dense mode: 1–2 fps + dedupe + contact sheets. 0 turns it off. */
  dense_max_seconds: number;
}

export interface VideoMetadata {
  duration: string;
  duration_seconds: number;
  resolution: string;
  width: number;
  height: number;
  codec: string;
  original_fps: number;
  file_size: string;
  has_audio: boolean;
}

export interface Frame {
  timestamp: string;
  image?: string;
  format?: FrameFormat;
  sourcePath?: string;
  description?: string;
}

export interface TranscriptionSegment {
  start: string;
  end: string;
  text: string;
}

export interface AudioTag {
  start: string;
  end: string;
  tag: string;
}

export interface AudioResult {
  backend: Backend;
  transcription: TranscriptionSegment[];
  audio_tags: AudioTag[];
  full_analysis: string | null;
  transcription_source?: "youtube_subtitles" | "youtube_auto_captions" | "local_whisper" | "none";
  transcription_source_detail?: string;
  transcription_fallback_reason?: string;
}

export interface VideoWatchResult {
  metadata: VideoMetadata;
  frames: Frame[];
  audio: AudioResult;
}

export interface AnalysisFilters {
  scene_changes: boolean;
  black_intervals: boolean;
  silence: boolean;
  freeze: boolean;
  motion: boolean;
  blur: boolean;
  exposure: boolean;
  loudness: boolean;
  transcription: boolean;
}

export interface SceneChange {
  time: string;
  score: number;
}

export interface Interval {
  start: string;
  end: string;
  duration: number;
}

export interface FrameStats {
  timestamp: string;
  si?: number;
  ti?: number;
  blur?: number;
  brightness?: number;
  saturation?: number;
}

export interface VideoAnalysis {
  scenes: SceneChange[];
  black_intervals: Interval[];
  silence_intervals: Interval[];
  freeze_intervals: Interval[];
  frame_stats: FrameStats[];
  loudness_summary?: { mean_lufs: number; range_lu: number };
  transcription?: TranscriptionSegment[];
  content_profile: string;
}

export interface SessionManifest {
  video_hash: string;
  video_path: string;
  created_at: string;
  resolutions: Record<string, {
    frames: Array<{ timestamp: string; file: string }>;
  }>;
  analysis?: VideoAnalysis;
}

export interface Segment {
  start: string;
  end: string;
  fps: number;
  resolution?: number;
}
