"""Prepare the existing Apple Silicon runtime and a pinned Chinese-capable Whisper model."""

import os
import subprocess
import sys
from pathlib import Path

MODEL_ID = "mlx-community/whisper-small-asr-fp16"
MODEL_REVISION = "42fc41c2ab1c78e844fd01477cf398eec6801c47"
BACKEND = Path(__file__).resolve().parents[1]


def main():
    python = Path(os.environ.get("LOCAL_ASR_PYTHON", BACKEND / ".tts-venv/bin/python"))
    if not python.is_file():
        subprocess.run(
            [sys.executable, str(BACKEND / "local_tts/setup.py"), "--skip-download"],
            check=True,
        )
    destination = Path(
        os.environ.get("LOCAL_ASR_MODEL_DIR", BACKEND / "data/asr/models/Whisper-small")
    )
    environment = os.environ.copy()
    environment.setdefault("HF_HUB_DISABLE_XET", "1")
    subprocess.run(
        [
            str(python),
            "-c",
            "from huggingface_hub import snapshot_download; import sys; "
            "snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], "
            "local_dir=sys.argv[3], max_workers=2, allow_patterns=['*.json', '*.safetensors', "
            "'*.txt', '*.tiktoken'])",
            MODEL_ID,
            MODEL_REVISION,
            str(destination),
        ],
        check=True,
        env=environment,
    )
    print("Local speech recognition is ready. No audio is sent to a cloud ASR service.")


if __name__ == "__main__":
    main()
