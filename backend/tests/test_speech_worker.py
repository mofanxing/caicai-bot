"""API/worker protocol checks; numerical tests run in the isolated TTS runtime."""

import io
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.integrations.local_speech import LocalSpeechEngine

BACKEND = Path(__file__).resolve().parents[1]
RUNTIME = BACKEND / ".tts-venv/bin/python"


def test_reference_cloning_reports_free_text_style_as_unsupported():
    engine = LocalSpeechEngine(SimpleNamespace(
        local_tts_python="/does/not/exist", local_tts_model_dir="/does/not/exist",
    ))
    assert engine.status()["supports_style_prompt"] is False


@pytest.mark.parametrize("context", [None, {"text": "前一句。", "audio_path": "/tmp/anchor.wav"}])
def test_engine_sends_continuation_only_when_supplied(monkeypatch, context):
    engine = LocalSpeechEngine(SimpleNamespace(local_tts_timeout_seconds=10))
    stream = io.BytesIO()
    engine.process = SimpleNamespace(stdin=stream, poll=lambda: None)
    monkeypatch.setattr(engine, "status", lambda: {"available": True})
    monkeypatch.setattr(engine, "_read", lambda deadline: {"ok": True})
    assert engine.synthesize("下一句。", "voice.wav", "温柔", "out.wav", context) == {"ok": True}
    request = json.loads(stream.getvalue())
    assert request["text"] == "下一句。"
    assert request["reference_path"] == "voice.wav"
    assert request["style_prompt"] == "温柔"
    if context is None:
        assert "continuation" not in request
    else:
        assert request["continuation"] == context


@pytest.mark.skipif(
    not RUNTIME.is_file(), reason="Optional isolated local TTS runtime not installed",
)
def test_isolated_worker_numerical_and_continuation_regressions():
    result = subprocess.run(
        [str(RUNTIME), "-m", "unittest", "local_tts/test_worker.py"],
        cwd=BACKEND, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
