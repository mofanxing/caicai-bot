"""Private JSON-lines worker. Run only in the isolated .tts-venv."""

import argparse
import json
import os
import re
import sys
import time
from collections import OrderedDict
from contextlib import redirect_stdout
from pathlib import Path


def emit(payload):
    print("CAICAI_TTS:" + json.dumps(payload), flush=True)


def cache_reference_encoding(model, evaluate, max_entries=4):
    """Reuse reference VAE features in this worker, bounded to four recordings."""
    encode = model._encode_wav
    cache = OrderedDict()

    def cached(audio_input, padding_mode="right", trim_silence_vad=False):
        if not isinstance(audio_input, str):
            return encode(audio_input, padding_mode, trim_silence_vad)
        path = Path(audio_input)
        stat = path.stat()
        key = (str(path.resolve()), stat.st_mtime_ns, stat.st_size, padding_mode, trim_silence_vad)
        if key not in cache:
            value = encode(audio_input, padding_mode, trim_silence_vad)
            evaluate(value)
            cache[key] = value
            if len(cache) > max_entries:
                cache.popitem(last=False)
        cache.move_to_end(key)
        return cache[key]

    model._encode_wav = cached


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


def match_speech_level(audio, sample_rate, np):
    """Apply one bounded gain per clip, measuring active 20 ms frames, not silence.

    This is RMS matching, not perceptual LUFS normalization. Keep natural
    within-sentence dynamics; cap amplification at 6 dB and peaks at -1 dBFS.
    """
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not len(audio) or not np.all(np.isfinite(audio)) or sample_rate <= 0:
        raise ValueError("Invalid generated audio")
    frame_size = max(1, int(sample_rate * 0.02))
    # Do not let padding dilute the last frame's energy.
    squares = np.square(audio.astype(np.float64))
    starts = np.arange(0, len(audio), frame_size)
    counts = np.minimum(frame_size, len(audio) - starts)
    energy = np.add.reduceat(squares, starts) / counts
    frame_rms = np.sqrt(energy)
    active = frame_rms >= max(float(frame_rms.max()) * 0.1, 1e-4)
    gain = 1.0
    if np.any(active):
        rms = float(np.sqrt(np.average(energy[active], weights=counts[active])))
        gain = float(np.clip(0.1 / rms, 10 ** (-12 / 20), 10 ** (6 / 20)))
    peak = float(np.max(np.abs(audio)))
    if peak:
        gain = min(gain, 10 ** (-1 / 20) / peak)
    return (audio * gain).astype(np.float32)


def synthesize_request(model, request, mx, np, sf):
    """Use a fixed reply anchor, with the original voice reference on every call.

    A fixed anchor avoids recursively adopting drift from each new segment.
    Continuation audio is conditioning only; it is never added to the output.
    """
    chunks = segments(request["text"])
    if not chunks:
        raise ValueError("Empty speech text")
    context = request.get("continuation")
    anchor = None
    anchor_text = None
    if context:
        anchor_text = context["text"]
        anchor = context["audio_path"]
        info = sf.info(anchor)
        if not anchor_text.strip() or len(anchor_text) > 120 or not 0 < info.duration <= 30:
            raise ValueError("Invalid continuation anchor")
    audio, sample_rate, duration = [], None, 0.0
    for chunk in chunks:
        mx.random.seed(42)
        options = {
            "text": chunk,
            "ref_audio": request["reference_path"],
            "max_tokens": 1500,
            "inference_timesteps": 10,
            "cfg_value": 2.0,
        }
        # MLX VoxCPM2 implements instruct by prepending it to text. In reference
        # cloning this can speak the instruction aloud. Keep cloning text-only;
        # style_prompt remains saved metadata, never model transcript input.
        if anchor is not None:
            options.update(prompt_text=anchor_text, prompt_audio=anchor)
        result = next(model.generate(**options))
        if getattr(result, "token_count", 0) >= 1500:
            raise ValueError("Audio generation reached token limit")
        rate = int(result.sample_rate)
        if sample_rate is not None and rate != sample_rate:
            raise ValueError("Inconsistent sample rates")
        sample_rate = rate
        part = match_speech_level(result.audio, sample_rate, np)
        duration += len(part) / sample_rate
        audio.append(part)
        if anchor is None and len(part) / sample_rate <= 30:
            # VoxCPM2 expects array input at its output sample rate. Its encoder
            # resamples internally; keep the complete clip and matching transcript.
            anchor, anchor_text = part, chunk
    combined = np.concatenate(audio)
    destination = Path(request["output_path"])
    temporary = destination.with_suffix(".tmp.wav")
    sf.write(str(temporary), combined, sample_rate, subtype="PCM_16")
    temporary.replace(destination)
    return round(duration, 3)


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
            cache_reference_encoding(model, mx.eval)
        emit({"type": "ready"})
    except Exception as exc:
        emit({"type": "load_error", "error_type": type(exc).__name__})
        return
    for line in sys.stdin:
        try:
            request = json.loads(line)
            start = time.monotonic()
            with redirect_stdout(sys.stderr):
                duration = synthesize_request(model, request, mx, np, sf)
                # Keep the allocator warm between sentences; reference features are bounded.
            emit(
                {
                    "type": "result",
                    "ok": True,
                    "duration_seconds": duration,
                    "generation_seconds": round(time.monotonic() - start, 3),
                }
            )
        except Exception as exc:
            emit({"type": "result", "ok": False, "error_type": type(exc).__name__})


if __name__ == "__main__":
    main()
