"""Exercise the real local TTS API in a temporary database, using model-provided sample audio."""

import json
import secrets
import subprocess
import tempfile
import time
import wave
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

BACKEND = Path(__file__).resolve().parents[1]


def main():
    output = BACKEND / "data/tts/validation"
    output.mkdir(parents=True, exist_ok=True)
    settings = Settings(_env_file=None, admin_token=secrets.token_urlsafe(32))
    reference = output / "reference.wav"
    subprocess.run(
        [
            settings.local_tts_python,
            "-c",
            "import sys,math; import soundfile as sf; from scipy.signal import resample_poly; "
            "audio,rate=sf.read(sys.argv[1],always_2d=True); "
            "audio=audio[:20*rate].mean(axis=1); common=math.gcd(rate,16000); "
            "audio=resample_poly(audio,16000//common,rate//common); "
            "sf.write(sys.argv[2],audio,16000,subtype='PCM_16')",
            str(Path(settings.local_tts_model_dir) / "test_en.wav"),
            str(reference),
        ],
        check=True,
    )
    with tempfile.TemporaryDirectory(prefix="api-", dir=output) as temporary:
        settings = settings.model_copy(
            update={
                "database_url": f"sqlite:///{temporary}/test.db",
                "speech_data_dir": str(Path(temporary) / "speech"),
                "provider_encryption_key": Fernet.generate_key().decode(),
                "mock_llm_enabled": True,
                "app_env": "test",
            }
        )
        headers = {"Authorization": "Bearer " + settings.admin_token.get_secret_value()}
        report = {"reference": "Official model test_en.wav; QA only", "jobs": []}
        with TestClient(create_app(settings)) as client:
            response = client.post(
                "/api/v1/voices",
                headers=headers,
                data={"name": "QA sample", "style_prompt": "温柔自然"},
                files={"audio": ("reference.wav", reference.read_bytes(), "audio/wav")},
            )
            assert response.status_code == 201, response.text
            voice = response.json()

            def wait(job_id, label):
                deadline = time.monotonic() + settings.local_tts_timeout_seconds + 30
                previous_state = None
                while time.monotonic() < deadline:
                    job = client.get(f"/api/v1/speech/jobs/{job_id}", headers=headers).json()
                    if job["status"] != previous_state:
                        previous_state = job["status"]
                        print(label, previous_state, flush=True)
                    if previous_state == "failed":
                        raise RuntimeError(job["error"])
                    if previous_state == "completed":
                        audio = client.get(f"/api/v1/speech/jobs/{job_id}/audio", headers=headers)
                        assert audio.status_code == 200 and audio.content.startswith(b"RIFF")
                        saved = output / f"api-{label}.wav"
                        saved.write_bytes(audio.content)
                        with wave.open(str(saved), "rb") as stream:
                            assert stream.getnframes() > 0 and stream.getframerate() == 48000
                        report["jobs"].append(
                            {
                                "label": label,
                                "duration_seconds": job["duration_seconds"],
                                "generation_seconds": job["generation_seconds"],
                            }
                        )
                        return job
                    time.sleep(0.3)
                raise TimeoutError("Local generation did not finish")

            preview = client.post(
                f"/api/v1/voices/{voice['id']}/previews",
                headers=headers,
                json={
                    "text": "你好，我是菜菜，今天也很高兴见到你。",
                    "style_prompt": "温柔自然，语速稍慢",
                },
            )
            assert preview.status_code == 202, preview.text
            wait(preview.json()["id"], "preview")
            cid = client.post(
                "/api/v1/conversations", headers=headers, json={"peer_id": "verify"}
            ).json()["id"]
            response = client.put(
                f"/api/v1/conversations/{cid}/settings",
                headers=headers,
                json={"voice_id": voice["id"], "reply_mode": "both", "voice_prompt": "开心自然"},
            )
            assert response.status_code == 200, response.text
            body = {"external_id": "verify-one", "text": "你好，菜菜"}
            url = f"/api/v1/debug/conversations/{cid}/messages"
            response = client.post(url, headers=headers, json=body)
            assert response.status_code == 200, response.text
            message = response.json()
            assert message["status"] == "completed" and message["speech_job_id"]
            wait(message["speech_job_id"], "chat")
            repeated = client.post(url, headers=headers, json=body).json()
            assert (
                repeated["id"] == message["id"]
                and repeated["speech_job_id"] == message["speech_job_id"]
            )
            report["message_dedup"] = True
            report["authenticated_audio"] = (
                client.get(f"/api/v1/speech/jobs/{message['speech_job_id']}/audio").status_code
                == 401
            )
            report["voice_cleanup"] = (
                client.delete(f"/api/v1/voices/{voice['id']}", headers=headers).status_code == 200
            )
        (output / "api-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
