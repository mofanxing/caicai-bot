import base64
import io
import json
import wave
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from conftest import TOKEN

from app.core.errors import ServiceError
from app.integrations.local_recognition import (
    MAX_AUDIO_BYTES,
    LocalRecognitionEngine,
    validate_recording,
)

HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def recording(seconds=1, rate=16000, channels=1, width=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(width)
        audio.setframerate(rate)
        audio.writeframes(b"\0" * int(rate * seconds) * channels * width)
    return output.getvalue()


def test_recognition_endpoints_require_admin(client):
    assert client.get("/api/v1/speech/recognition/status").status_code == 401
    assert client.post("/api/v1/speech/transcriptions").status_code == 401
    status = client.get("/api/v1/speech/recognition/status", headers=HEADERS)
    assert status.status_code == 200
    assert status.json()["local_only"] is True


def test_upload_transcribes_and_does_not_create_chat_or_audio_files(client, monkeypatch):
    received = []

    def recognize(data):
        received.append(data)
        return {"text": "菜菜，早上好。", "duration_seconds": 1, "recognition_seconds": 0.1}

    monkeypatch.setattr(client.app.state.recognition_engine, "transcribe", recognize)
    response = client.post(
        "/api/v1/speech/transcriptions", headers=HEADERS,
        files={"audio": ("recording.wav", recording(), "audio/wav")},
    )
    assert response.status_code == 200
    assert response.json()["text"] == "菜菜，早上好。"
    assert received == [recording()]
    assert client.get("/api/v1/conversations", headers=HEADERS).json() == []


@pytest.mark.parametrize(
    "data", [b"", b"not a wav", recording(0.1), recording(21), recording(rate=44100),
             recording(channels=2), recording(width=1), recording()[:-2]],
)
def test_invalid_microphone_recordings_are_rejected(client, data):
    response = client.post(
        "/api/v1/speech/transcriptions", headers=HEADERS,
        files={"audio": ("recording.wav", data, "audio/wav")},
    )
    assert response.status_code in {413, 422}
    assert response.json()["error"]["code"] in {"invalid_recording", "recording_too_large"}


def test_audio_duration_boundary_and_oversized_upload():
    assert validate_recording(recording(0.2)) == 0.2
    assert validate_recording(recording(20)) == 20
    with pytest.raises(ServiceError) as error:
        validate_recording(b"x" * (MAX_AUDIO_BYTES + 1))
    assert error.value.status_code == 413


@pytest.fixture
def engine(tmp_path):
    model = tmp_path / "model"
    model.mkdir()
    for filename in ("config.json", "tokenizer.json", "model.safetensors"):
        (model / filename).touch()
    return LocalRecognitionEngine(SimpleNamespace(
        local_asr_python=__file__, local_asr_model_dir=str(model), local_asr_timeout_seconds=5,
    ))


def test_model_status_checks_runtime_and_weights(engine, tmp_path):
    assert engine.status()["available"] is True
    engine.settings.local_asr_model_dir = str(tmp_path / "missing")
    assert engine.status()["state"] == "model_missing"
    engine.settings.local_asr_python = str(tmp_path / "missing-python")
    assert engine.status()["state"] == "runtime_missing"


def test_worker_is_reused_and_receives_only_memory_audio(engine, monkeypatch):
    process = SimpleNamespace(stdin=io.BytesIO(), poll=lambda: None)
    start = Mock(return_value=process)
    monkeypatch.setattr("app.integrations.local_recognition.subprocess.Popen", start)
    responses = iter([{"type": "ready"}, {"ok": True, "text": " 菜菜 "},
                      {"ok": True, "text": ""}])
    monkeypatch.setattr(engine, "_read", lambda deadline: next(responses))
    assert engine.transcribe(recording())["text"] == "菜菜"
    assert engine.transcribe(recording())["text"] == ""
    assert start.call_count == 1
    assert start.call_args.kwargs["env"]["HF_HUB_OFFLINE"] == "1"
    assert start.call_args.kwargs["env"]["TRANSFORMERS_OFFLINE"] == "1"
    requests = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
    assert len(requests) == 2
    assert base64.b64decode(requests[0]["audio"]) == recording()
    assert engine.status()["state"] == "ready"


def test_busy_recognizer_rejects_parallel_work(engine):
    with engine._lock:
        with pytest.raises(ServiceError) as error:
            engine.transcribe(recording())
    assert error.value.code == "asr_busy"


def test_worker_error_releases_lock_and_cleans_up(engine, monkeypatch):
    process = Mock()
    process.poll.return_value = None
    engine.process = process
    monkeypatch.setattr(engine, "_read", lambda deadline: {"ok": False})
    with pytest.raises(ServiceError) as error:
        engine.transcribe(recording())
    assert error.value.code == "asr_failed"
    assert not engine._lock.locked()
    process.terminate.assert_called_once()
    process.stdin.close.assert_called_once()
    assert engine.process is None
    assert engine.status()["state"] == "error"


def test_shutdown_does_not_restart_worker(engine):
    engine.shutdown()
    with pytest.raises(ServiceError) as error:
        engine.transcribe(recording())
    assert error.value.code == "asr_stopped"
