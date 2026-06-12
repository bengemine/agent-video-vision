#!/usr/bin/env python3
"""Parakeet transcription runner for agent-video-vision.

Loads a local NVIDIA Parakeet TDT ONNX export via onnx-asr, runs it through
the mandatory Silero VAD pipeline (raw recognize() crashes on audio longer
than ~30s), and prints a single JSON object to stdout:

    {"segments": [{"start": float, "end": float, "text": str}, ...]}

On failure prints {"error": "..."} to stdout AND the message to stderr,
then exits non-zero, so the Node caller gets a useful failure either way.

Only stdlib imports at module level — onnx_asr is imported lazily so a
missing install produces a clean, actionable JSON error.
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe a wav file with Parakeet (onnx-asr)")
    parser.add_argument("--model-dir", required=True, help="Directory containing the ONNX model files")
    parser.add_argument("--audio", required=True, help="Path to a 16kHz mono PCM wav file")
    parser.add_argument("--quantization", default="int8", choices=["int8", "fp32"],
                        help="Model quantization variant (fp32 maps to the unquantized files)")
    parser.add_argument("--max-speech-duration-s", type=float, default=20,
                        help="Max VAD speech-chunk duration in seconds (passed to with_vad)")
    args = parser.parse_args()

    try:
        try:
            import onnx_asr
        except ImportError:
            raise RuntimeError(
                "onnx_asr not installed in this Python environment — run the setup wizard"
            )

        # onnx-asr uses quantization=None for the unquantized (fp32) files.
        quantization = None if args.quantization == "fp32" else args.quantization

        model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v3", args.model_dir, quantization=quantization
        )
        # VAD pipeline is mandatory: raw recognize() crashes on >30s audio.
        vad = onnx_asr.load_vad("silero")
        pipeline = model.with_vad(
            vad, max_speech_duration_s=args.max_speech_duration_s
        ).with_timestamps()

        # Consume the iterator fully before serializing.
        segments = []
        for seg in pipeline.recognize(args.audio):
            text = (seg.text or "").strip()
            if not text:
                continue  # VAD occasionally yields empty-text segments
            segments.append({"start": float(seg.start), "end": float(seg.end), "text": text})

        segments.sort(key=lambda s: s["start"])
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
