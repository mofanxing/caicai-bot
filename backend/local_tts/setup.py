"""Install the isolated Mac runtime and download a pinned local model."""

import argparse
import os
import platform
import subprocess
import sys
import venv
from pathlib import Path

MODEL_ID = "mlx-community/VoxCPM2-4bit"
MODEL_REVISION = "dc9e5c187858da5f4a13dc4c247e297339216381"
BACKEND = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("This runtime requires an Apple Silicon Mac.")
    if sys.version_info < (3, 12):
        raise SystemExit("Use Python 3.12+ (the existing backend/.venv is suitable).")
    environment = BACKEND / ".tts-venv"
    if not (environment / "bin/python").exists():
        venv.create(environment, with_pip=True)
    python = str(environment / "bin/python")
    subprocess.run(
        [
            python,
            "-m",
            "pip",
            "install",
            "-c",
            str(Path(__file__).with_name("constraints-macos-arm64.txt")),
            "-r",
            str(Path(__file__).with_name("requirements.txt")),
        ],
        check=True,
    )
    if not args.skip_download:
        destination = BACKEND / "data/tts/models/VoxCPM2-4bit"
        environment_variables = os.environ.copy()
        environment_variables.setdefault("HF_HUB_DISABLE_XET", "1")
        subprocess.run(
            [
                python,
                "-c",
                "from huggingface_hub import snapshot_download; "
                "import sys; snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], "
                "local_dir=sys.argv[3], max_workers=2, "
                "allow_patterns=['*.json', '*.safetensors', 'README.md', 'test_*.wav'])",
                MODEL_ID,
                MODEL_REVISION,
                str(destination),
            ],
            check=True,
            env=environment_variables,
        )
    print("Local TTS environment prepared. Restart the API to refresh its status.")


if __name__ == "__main__":
    main()
