#!/usr/bin/env python3
"""Fluid Speech Mini transcription runner for agent-video-vision.

Loads the Fluid Speech Mini ONNX build (FluidVoice-Labs/fluid-speech-mini-onnx)
with ONNX Runtime, transcribes a 16 kHz mono wav, and prints one JSON object
to stdout:

    {"segments": [{"start": float, "end": float, "text": str}, ...]}

Segment times come from the TDT decoder: every emitted token carries the
encoder frame it was produced at (80 ms per frame), so word times fall out of
the decode loop with no extra voice-activity model. Words are then grouped
into short segments at pauses and sentence ends.

On failure prints {"error": "..."} to stdout AND the message to stderr, then
exits non-zero, so the Node caller gets a useful failure either way.

Only stdlib imports at module level — onnxruntime/numpy/soundfile are imported
lazily so a missing install produces a clean, actionable JSON error.

The feature extraction, model loading and greedy TDT decode follow the
reference transcribe.py shipped with the model ("Fluid Speech Mini by
FluidVoice", CC BY 4.0, https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-onnx).
"""

import argparse
import json
import os
import sys

LOG_ZERO_GUARD = 2.0 ** -24
NORM_EPS = 1e-5

# Segment grouping: start a new segment at a pause this long, after a sentence
# end once the segment is at least SENTENCE_MIN_S long, or when it reaches MAX_S.
PAUSE_SPLIT_S = 1.0
SENTENCE_MIN_S = 3.0
SEGMENT_MAX_S = 15.0
# How long the last word of a segment is assumed to last (nothing after it to measure).
WORD_TAIL_S = 0.4

MIN_ORT_VERSION = (1, 31)

MODEL_FILES = ["encoder.onnx", "decoder.onnx", "joint.onnx", "tokenizer.json", "config.json", "mel_filters.npy"]


def release_memory():
    """glibc keeps freed load-time and activation buffers; hand them back (Linux only, a no-op elsewhere)."""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def load_audio(path, rate):
    import numpy as np
    import soundfile as sf

    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = wav[:, 0] if wav.shape[1] == 1 else wav.mean(axis=1)
    if sr != rate:
        try:
            import soxr
            wav = soxr.resample(wav, sr, rate).astype(np.float32)
        except ImportError:
            from math import gcd
            from scipy.signal import resample_poly
            g = gcd(int(sr), int(rate))
            wav = resample_poly(wav, rate // g, sr // g).astype(np.float32)
    return np.ascontiguousarray(wav, dtype=np.float32)


def log_mel(wav, cfg, filters):
    """Same features as the Hugging Face ParakeetFeatureExtractor: returns ([1, T, mels] fp32, [1, T] int64)."""
    import numpy as np

    n_fft, hop, win = cfg["n_fft"], cfg["hop_length"], cfg["win_length"]
    x = wav.astype(np.float32)
    if cfg.get("preemphasis"):
        x = np.concatenate([x[:1], x[1:] - np.float32(cfg["preemphasis"]) * x[:-1]])
    window = np.zeros(n_fft, dtype=np.float64)
    left = (n_fft - win) // 2
    n = np.arange(win, dtype=np.float64)
    window[left:left + win] = (0.5 - 0.5 * np.cos(2.0 * np.pi * n / (win - 1))).astype(np.float32)
    padded = np.pad(x, n_fft // 2)
    frames = 1 + len(x) // hop
    mel = np.empty((frames, filters.shape[0]), dtype=np.float32)
    offsets = np.arange(n_fft)[None, :]
    for start in range(0, frames, 256):  # in blocks: the STFT of a whole clip at once costs tens of MB
        idx = offsets + hop * np.arange(start, min(start + 256, frames))[:, None]
        spec = np.fft.rfft(padded[idx].astype(np.float64) * window, axis=1)
        power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32)
        mel[start:start + len(idx)] = np.log(power @ filters.T + np.float32(LOG_ZERO_GUARD))
    valid = min(len(x) // hop, frames)
    mean = mel[:valid].sum(axis=0, dtype=np.float32) / np.float32(valid)
    var = ((mel[:valid] - mean) ** 2).sum(axis=0, dtype=np.float32) / np.float32(max(valid - 1, 1))
    out = (mel - mean) / (np.sqrt(var) + np.float32(NORM_EPS))
    out[valid:] = 0.0
    mask = (np.arange(frames) < valid).astype(np.int64)
    return out[None].astype(np.float32), mask[None]


class Tokenizer:
    def __init__(self, path, cfg):
        with open(path, encoding="utf-8") as f:
            t = json.load(f)
        self.pieces = {i: s for s, i in t["model"]["vocab"].items()}
        skip = {cfg["blank_token_id"], cfg["pad_token_id"]}
        for a in t.get("added_tokens", []):
            self.pieces[a["id"]] = a["content"]
            if a.get("special"):
                skip.add(a["id"])
        self.skip = skip
        dec = t.get("decoder") or {}
        self.space = dec.get("replacement", "▁")

    def words(self, timed_tokens):
        """[(token_id, seconds)] -> [(word, seconds)]; a piece starting with the space marker opens a new word."""
        words = []
        for tok, sec in timed_tokens:
            if tok in self.skip:
                continue
            piece = self.pieces.get(tok, "")
            if not piece:
                continue
            if piece.startswith(self.space) or not words:
                text = piece.replace(self.space, "")
                if text:
                    words.append([text, sec])
                elif words:
                    pass  # a bare space marker: the next piece starts the word
            else:
                words[-1][0] += piece.replace(self.space, "")
        return [(w, s) for w, s in words if w]


class Model:
    def __init__(self, model_dir, threads=0):
        import numpy as np
        import onnxruntime as ort

        with open(os.path.join(model_dir, "config.json")) as f:
            self.cfg = json.load(f)
        self.filters = np.load(os.path.join(model_dir, "mel_filters.npy")).astype(np.float32)
        self.tokenizer = Tokenizer(os.path.join(model_dir, "tokenizer.json"), self.cfg)
        providers = ["CPUExecutionProvider"]
        so = ort.SessionOptions()
        # activations of the conv front end dominate memory; without the arena they are freed between runs
        so.enable_cpu_mem_arena = False
        so.enable_mem_pattern = False
        if threads:
            so.intra_op_num_threads = threads
        small = ort.SessionOptions()
        small.intra_op_num_threads = 1
        small.enable_cpu_mem_arena = False
        small.enable_mem_pattern = False
        self.encoder = ort.InferenceSession(os.path.join(model_dir, "encoder.onnx"), so, providers=providers)
        front = os.path.join(model_dir, "frontend.onnx")
        self.frontend = ort.InferenceSession(front, so, providers=providers) if os.path.exists(front) else None
        self.decoder = ort.InferenceSession(os.path.join(model_dir, "decoder.onnx"), small, providers=providers)
        self.joint = ort.InferenceSession(os.path.join(model_dir, "joint.onnx"), small, providers=providers)
        cfg = self.cfg
        self.frame_s = cfg["hop_length"] * (cfg["subsampling_stride"] ** cfg["subsampling_layers"]) / cfg["sampling_rate"]
        release_memory()

    def subsampled(self, frames):
        import numpy as np

        cfg = self.cfg
        pad = (cfg["subsampling_kernel"] - 1) // 2 * 2 - cfg["subsampling_kernel"]
        for _ in range(cfg["subsampling_layers"]):
            frames = int(np.floor((frames + pad) / cfg["subsampling_stride"] + 1.0))
        return frames

    def encode(self, feats, mask):
        """([T', hidden] fp32, valid frames). With frontend.onnx the conv front end runs in time chunks (same
        result, far smaller activations): each chunk carries one output frame of context on both sides."""
        import numpy as np

        if self.frontend is None:
            enc, enc_len = self.encoder.run(None, {"input_features": feats, "attention_mask": mask})
            return enc[0], int(enc_len[0])
        cfg = self.cfg
        factor = cfg["subsampling_stride"] ** cfg["subsampling_layers"]
        frames, total, step = feats.shape[1], self.subsampled(feats.shape[1]), cfg["frontend_chunk_frames"]
        parts = []
        for a in range(0, total, step):
            b = min(a + step, total)
            s = factor * (a - 1) if a else 0
            e = min(frames, factor * (b + 1))
            y = self.frontend.run(None, {"input_features": feats[:, s:e], "attention_mask": mask[:, s:e]})[0]
            skip = 1 if a else 0
            parts.append(y[:, skip:skip + (b - a)])
        hidden = np.concatenate(parts, axis=1) if len(parts) > 1 else parts[0]
        valid = self.subsampled(int(mask.sum()))
        enc = self.encoder.run(None, {"hidden_states": hidden, "length": np.array([valid], dtype=np.int64)})[0]
        return enc[0], valid

    def greedy_tdt(self, enc, valid_len):
        """Greedy token-and-duration decoding. Returns [(token_id, encoder_frame)] for non-blank tokens."""
        import numpy as np

        cfg = self.cfg
        vocab, blank, eos = cfg["vocab_size"], cfg["blank_token_id"], cfg.get("eos_token_id")
        durations = cfg["durations"]
        state = np.zeros((cfg["decoder_layers"], 1, cfg["decoder_hidden_size"]), dtype=np.float32)
        dec_out, h, c = self.decoder.run(None, {"token": np.array([[blank]], dtype=np.int64), "h_in": state, "c_in": state})
        frames = enc.shape[0]
        budget = cfg["max_symbols_per_step"] * frames - 1
        emitted, count, t = [], 0, 0
        while True:
            logits = self.joint.run(None, {"encoder_frame": enc[min(t, frames - 1)][None], "decoder_out": dec_out})[0][0]
            token = int(logits[:vocab].argmax())
            step = durations[int(logits[vocab:].argmax())]
            if token == blank and step == 0:
                step = 1
            count += 1
            if token != blank:
                emitted.append((token, t))
            t += step
            if t >= valid_len or count >= budget or token == eos:
                return emitted
            if token != blank:
                dec_out, h, c = self.decoder.run(None, {"token": np.array([[token]], dtype=np.int64), "h_in": h, "c_in": c})

    def transcribe_pass(self, wav, offset_s):
        """One encoder pass over a clip up to max_single_pass_seconds. Returns [(word, absolute seconds)]."""
        feats, mask = log_mel(wav, self.cfg, self.filters)
        enc, enc_len = self.encode(feats, mask)
        del feats
        release_memory()
        timed = [(tok, offset_s + frame * self.frame_s) for tok, frame in self.greedy_tdt(enc, enc_len)]
        return self.tokenizer.words(timed)

    def split_long(self, wav, target=30.0, search=10.0):
        """Cut audio longer than one pass at quiet points into pieces of about `target` seconds.
        Returns [(piece, start_sample)]."""
        import numpy as np

        rate = self.cfg["sampling_rate"]
        hop = rate // 50
        energy = np.sqrt(np.add.reduceat(wav.astype(np.float64) ** 2, np.arange(0, len(wav), hop)) / hop)
        smooth = np.convolve(energy, np.ones(10) / 10, mode="same")
        pieces, start = [], 0
        while len(wav) - start > self.cfg["max_single_pass_seconds"] * rate:
            lo = (start + int((target - search / 2) * rate)) // hop
            hi = (start + int((target + search / 2) * rate)) // hop
            cut = (lo + int(smooth[lo:hi].argmin())) * hop
            pieces.append((wav[start:cut], start))
            start = cut
        pieces.append((wav[start:], start))
        return pieces

    def transcribe(self, wav):
        """Whole file -> [(word, absolute seconds)]."""
        rate = self.cfg["sampling_rate"]
        if len(wav) < self.cfg["hop_length"] * 2:
            return []
        if len(wav) <= self.cfg["max_single_pass_seconds"] * rate:
            return self.transcribe_pass(wav, 0.0)
        words = []
        for piece, start in self.split_long(wav):
            words.extend(self.transcribe_pass(piece, start / rate))
        return words


def group_segments(words, audio_s):
    """[(word, seconds)] -> [{"start", "end", "text"}] split at pauses, sentence ends and a max length."""
    segments = []
    cur = []
    for word, sec in words:
        if cur:
            seg_start = cur[0][1]
            prev_word, prev_sec = cur[-1]
            pause = sec - prev_sec > PAUSE_SPLIT_S
            sentence_end = prev_word[-1] in ".?!" and (sec - seg_start) >= SENTENCE_MIN_S
            too_long = (sec - seg_start) >= SEGMENT_MAX_S
            if pause or sentence_end or too_long:
                segments.append(cur)
                cur = []
        cur.append((word, sec))
    if cur:
        segments.append(cur)

    out = []
    for i, seg in enumerate(segments):
        start = seg[0][1]
        last = seg[-1][1]
        next_start = segments[i + 1][0][1] if i + 1 < len(segments) else audio_s
        end = min(max(last + WORD_TAIL_S, start), next_start, audio_s)
        out.append({"start": round(float(start), 3), "end": round(float(end), 3), "text": " ".join(w for w, _ in seg)})
    return out


def check_runtime():
    try:
        import onnxruntime as ort  # noqa: F401
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            f"{exc.name} is not installed in this Python environment — run the setup wizard"
        ) from exc
    version = tuple(int(p) for p in ort.__version__.split(".")[:2])
    if version < MIN_ORT_VERSION:
        raise RuntimeError(
            f"onnxruntime {ort.__version__} is too old for Fluid Speech Mini (2-bit weights need "
            f">= {MIN_ORT_VERSION[0]}.{MIN_ORT_VERSION[1]}, which needs Python 3.12+) — run the setup wizard"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe a wav file with Fluid Speech Mini (ONNX Runtime)")
    parser.add_argument("--model-dir", required=True, help="Directory containing the ONNX model files")
    parser.add_argument("--audio", required=True, help="Path to a 16kHz mono PCM wav file")
    parser.add_argument("--threads", type=int, default=0, help="Encoder threads (0 = ONNX Runtime default)")
    args = parser.parse_args()

    try:
        check_runtime()
        missing = [f for f in MODEL_FILES if not os.path.exists(os.path.join(args.model_dir, f))]
        if missing:
            raise RuntimeError(f"model dir {args.model_dir} is missing {', '.join(missing)} — run the setup wizard")
        if not os.path.exists(args.audio):
            raise RuntimeError(f"wav file not found: {args.audio}")

        model = Model(args.model_dir, args.threads)
        wav = load_audio(args.audio, model.cfg["sampling_rate"])
        audio_s = len(wav) / model.cfg["sampling_rate"]
        segments = group_segments(model.transcribe(wav), audio_s)
        json.dump({"segments": segments}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001 — single funnel so Node always gets JSON
        message = str(exc) or exc.__class__.__name__
        json.dump({"error": message}, sys.stdout)
        sys.stdout.write("\n")
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
