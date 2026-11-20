"""Private offline recognition worker; microphone audio exists only in memory."""

import argparse
import base64
import io
import json
import os
import sys
import wave
from contextlib import redirect_stdout
from pathlib import Path


def emit(payload):
    print("CAICAI_ASR:" + json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    try:
        with redirect_stdout(sys.stderr):
            import mlx.core as mx
            import numpy as np
            from mlx_audio.stt import load

            model = load(str(Path(args.model).resolve()))
        emit({"type": "ready"})
    except Exception as exc:
        emit({"type": "load_error", "error_type": type(exc).__name__})
        return
    for line in sys.stdin:
        try:
            data = base64.b64decode(json.loads(line)["audio"], validate=True)
            with wave.open(io.BytesIO(data), "rb") as recording:
                audio = np.frombuffer(
                    recording.readframes(recording.getnframes()), dtype="<i2"
                ).astype(np.float32) / 32768
            with redirect_stdout(sys.stderr):
                # Silence must not be turned into hallucinated wake words or commands.
                if not len(audio) or float(np.sqrt(np.mean(audio**2))) < 0.002:
                    text = ""
                else:
                    result = model.generate(
                        mx.array(audio),
                        language="zh",
                        temperature=0.0,
                        condition_on_previous_text=False,
                        return_timestamps=False,
                    )
                    text = result.text
            emit({"type": "result", "ok": True, "text": text})
        except Exception as exc:
            emit({"type": "result", "ok": False, "error_type": type(exc).__name__})


if __name__ == "__main__":
    main()
