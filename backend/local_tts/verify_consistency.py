"""Real-model smoke check with temporary audio and the official sample.

Run from backend: .venv/bin/python -m local_tts.verify_consistency
Validates continuation and peak protection, not perceptual similarity.
"""

import json
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from types import SimpleNamespace

from app.integrations.local_speech import LocalSpeechEngine

BACKEND = Path(__file__).resolve().parents[1]


def main():
    settings = SimpleNamespace(
        local_tts_python=str(BACKEND / ".tts-venv/bin/python"),
        local_tts_model_dir=str(BACKEND / "data/tts/models/VoxCPM2-4bit"),
        local_tts_timeout_seconds=180,
    )
    engine = LocalSpeechEngine(settings)
    report = {
        "reference": "Official test_en.wav, first 5 seconds; not a target voice evaluation",
        "clips": [],
    }
    with tempfile.TemporaryDirectory(prefix="caicai-consistency-") as temporary:
        folder = Path(temporary)
        reference = folder / "reference.wav"
        subprocess.run([
            settings.local_tts_python, "-c",
            "import sys,soundfile as sf; a,r=sf.read(sys.argv[1],always_2d=True); "
            "sf.write(sys.argv[2],a[:5*r].mean(axis=1),r,subtype='PCM_16')",
            str(Path(settings.local_tts_model_dir) / "test_en.wav"), str(reference),
        ], check=True)
        first_text = "你好，我们慢慢聊。"
        cases = [
            ("anchor", first_text, None),
            ("continued", "接下来一起看看这个问题。", {
                "text": first_text, "audio_path": str(folder / "anchor.wav"),
            }),
            (
                "internal_chunks",
                "今天我们一起整理一下接下来的安排。先把最重要的事情记下来，"
                "不用着急一次完成所有任务。遇到不清楚的地方，可以停下来问我，"
                "我们逐步找出合适的办法。忙了一会儿以后，也记得喝口水，"
                "让眼睛休息一下。等你准备好了，再继续说说今天发生的趣事吧。"
                "我会认真听，也会陪你把没讲完的故事慢慢聊完。",
                None,
            ),
        ]
        try:
            for name, text, context in cases:
                print(json.dumps({"starting": name, "characters": len(text)}), flush=True)
                started = time.monotonic()
                result = engine.synthesize(
                    text, reference, "平静清晰，自然叙述", folder / f"{name}.wav", context,
                )
                with wave.open(str(folder / f"{name}.wav"), "rb") as audio:
                    assert audio.getframerate() == 48000 and audio.getnframes() > 0
                item = {
                    "name": name, **result,
                    "wall_seconds": round(time.monotonic() - started, 3),
                }
                report["clips"].append(item)
                print(json.dumps(item, ensure_ascii=False), flush=True)
            measurement = subprocess.run([
                settings.local_tts_python, "-c",
                "import sys,json,numpy as np,soundfile as sf\n"
                "for path in sys.argv[1:]:\n"
                " a,r=sf.read(path); peak=float(np.max(np.abs(a)))\n"
                " assert peak <= 10**(-1/20)+1/32768\n"
                " print(json.dumps({'file':path.rsplit('/',1)[-1],"
                "'peak_dbfs':round(20*np.log10(max(peak,1e-12)),2)}))\n",
                *[str(folder / f"{name}.wav") for name, _, _ in cases],
            ], capture_output=True, text=True, check=True)
            report["peaks"] = [json.loads(line) for line in measurement.stdout.splitlines()]
            output = BACKEND / "data/tts/validation/consistency-report.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps(report["peaks"], ensure_ascii=False), flush=True)
        finally:
            engine.shutdown()


if __name__ == "__main__":
    main()
