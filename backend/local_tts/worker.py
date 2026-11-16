"""Private JSON-lines worker. Run only in the isolated .tts-venv."""

import argparse
import json
import os
import re
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path


def emit(payload):
    print("CAICAI_TTS:" + json.dumps(payload), flush=True)


def segments(text, limit=120):
    if limit < 1:
        raise ValueError("Segment limit must be positive")
    # Keep whole sentences together where possible. Only split an oversized
    # sentence at a softer boundary before falling back to the hard limit.
    parts = re.split(r"(?<=[。！？；.!?;\n])", text)
    chunks, current = [], ""
    for part in parts:
        if not part:
            continue
        if current and len(current) + len(part) > limit:
            chunks.append(current)
            current = ""
        while len(part) > limit:
            boundaries = list(re.finditer(r"[，、,:：\s]", part[:limit]))
            boundary = boundaries[-1].end() if boundaries else limit
            # Avoid a very short leading fragment for an early comma.
            if boundary < max(1, limit // 2):
                boundary = limit
            chunks.append(part[:boundary])
            part = part[boundary:]
        current += part
    if current.strip():
        chunks.append(current)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    # Downloads belong to setup.py, never an inference request.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        with redirect_stdout(sys.stderr):
            import mlx.core as mx
            import numpy as np
            import soundfile as sf
            from mlx_audio.tts.utils import load_model

            model = load_model(str(Path(args.model).resolve()))
        emit({"type": "ready"})
    except Exception as exc:
        emit({"type": "load_error", "error_type": type(exc).__name__})
        return
    for line in sys.stdin:
        try:
            request = json.loads(line)
            start = time.monotonic()
            audio = []
            with redirect_stdout(sys.stderr):
                for chunk in segments(request["text"]):
                    # Each independent generation starts from the same RNG state,
                    # rather than depending on the previous segment's duration.
                    mx.random.seed(42)
                    result = next(
                        model.generate(
                            text=chunk,
                            ref_audio=request["reference_path"],
                            instruct=request.get("style_prompt") or None,
                            max_tokens=1500,
                            inference_timesteps=10,
                            cfg_value=2.0,
                        )
                    )
                    if getattr(result, "token_count", 0) >= 1500:
                        raise ValueError("Audio generation reached token limit")
                    part = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                    if not len(part) or not np.all(np.isfinite(part)):
                        raise ValueError("Invalid generated audio")
                    audio.append(part)
                    sample_rate = int(result.sample_rate)
                combined = np.concatenate(audio)
                if len(combined) / sample_rate > 240:
                    raise ValueError("Audio duration limit exceeded")
                destination = Path(request["output_path"])
                temporary = destination.with_suffix(".tmp.wav")
                sf.write(str(temporary), combined, sample_rate, subtype="PCM_16")
                temporary.replace(destination)
                mx.clear_cache()
            emit(
                {
                    "type": "result",
                    "ok": True,
                    "duration_seconds": round(len(combined) / sample_rate, 3),
                    "generation_seconds": round(time.monotonic() - start, 3),
                }
            )
        except Exception as exc:
            emit({"type": "result", "ok": False, "error_type": type(exc).__name__})


if __name__ == "__main__":
    main()
