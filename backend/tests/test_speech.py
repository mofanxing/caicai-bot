import io
import json
import math
import runpy
import struct
import threading
import time
import wave
from pathlib import Path

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.errors import ServiceError
from app.main import create_app
from app.models import Conversation, Message, Provider, SpeechJob


def stream_send(client, cid, text="你好。下一句。", external_id="stream-one", channel="debug"):
    response = client.post(
        f"/api/v1/{channel}/conversations/{cid}/messages/stream",
        headers=HEADERS,
        json={"text": text, "external_id": external_id},
    )
    assert response.status_code == 200, response.text
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


@pytest.mark.parametrize("channel", ["debug", "desktop"])
def test_stream_synthesizes_first_sentence_before_llm_finishes(
    client, engine, monkeypatch, channel
):
    local, calls, synthesize = engine
    started = threading.Event()
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both", channel=channel)
    with client.app.state.session_factory() as db:
        provider = Provider(name="stream", base_url="https://example.test", api_key_env="TEST")
        db.add(provider)
        db.flush()
        current = db.get(Conversation, cid)
        current.provider_id, current.model_id = provider.id, "demo"
        db.commit()

    def generate(*args):
        yield "你好呀。我们先把第一件事情慢慢讲清楚，再一起讨论你刚才提到的问题。"
        assert started.wait(3), "TTS must begin before requesting the next LLM chunk"
        yield "这是稍后才生成的第二句。"

    def tracked(*args):
        started.set()
        return synthesize(*args)

    monkeypatch.setattr(local, "synthesize", tracked)
    monkeypatch.setattr(client.app.state.chat_service.llm, "stream", generate)
    events = stream_send(client, cid, channel=channel)
    assert events[0]["type"] == "start" and events[0]["message_id"]
    assert events[-1]["type"] == "done", events
    ids = [event["job_id"] for event in events if event["type"] == "speech"]
    assert len(ids) == 2
    assert all(wait_job(client, job_id)["status"] == "completed" for job_id in ids)
    result = events[-1]["message"]
    assert result["speech_job_ids"] == ids
    assert result["assistant_text"] == (
        "你好呀。我们先把第一件事情慢慢讲清楚，再一起讨论你刚才提到的问题。这是稍后才生成的第二句。"
    )
    assert "".join(call[0] for call in calls) == result["assistant_text"]
    repeated = stream_send(client, cid, channel=channel)
    assert repeated == [{"type": "done", "message": result}]
    assert len(calls) == 2
    history = client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json()
    assert history[0]["speech_job_ids"] == ids
    assert (
        client.delete(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).status_code == 200
    )
    assert all(not client.app.state.speech_service.audio_path(job_id).exists() for job_id in ids)


def test_stream_caps_speech_explicitly_and_keeps_full_text(client, engine):
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both")
    events = stream_send(client, cid, "好" * 700)
    assert events[-1]["type"] == "done"
    assert any(event["type"] == "notice" for event in events)
    ids = events[-1]["message"]["speech_job_ids"]
    jobs = [wait_job(client, job_id) for job_id in ids]
    assert all(job["status"] == "completed" for job in jobs)
    assert sum(len(job["text"]) for job in jobs) == 600
    assert len(events[-1]["message"]["assistant_text"]) > 700


def test_retry_segment_and_missing_audio_reuses_job(client, engine, monkeypatch):
    local, calls, synthesize = engine
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both")
    monkeypatch.setattr(
        local, "synthesize", lambda *args: (_ for _ in ()).throw(ServiceError("test", "失败", 503))
    )
    events = stream_send(client, cid)
    job_id = events[-1]["message"]["speech_job_ids"][0]
    assert wait_job(client, job_id)["status"] == "failed"
    monkeypatch.setattr(local, "synthesize", synthesize)
    url = f"/api/v1/speech/jobs/{job_id}/retry"
    assert client.post(url).status_code == 401
    assert client.post(url, headers=HEADERS).json()["id"] == job_id
    assert wait_job(client, job_id)["status"] == "completed"
    client.app.state.speech_service.audio_path(job_id).unlink()
    assert client.post(url, headers=HEADERS).status_code == 202
    assert wait_job(client, job_id)["status"] == "completed"


def test_reference_encoding_cache_is_bounded_and_invalidates(tmp_path):
    install = runpy.run_path(str(Path(__file__).resolve().parents[1] / "local_tts/worker.py"))[
        "cache_reference_encoding"
    ]
    calls, evaluated = [], []

    class Model:
        def _encode_wav(self, path, padding_mode, trim_silence_vad):
            calls.append(path)
            return object()

    model = Model()
    install(model, evaluated.append, max_entries=2)
    paths = [tmp_path / f"{i}.wav" for i in range(3)]
    for path in paths:
        path.write_bytes(b"reference")
    first = model._encode_wav(str(paths[0]))
    assert model._encode_wav(str(paths[0])) is first
    paths[0].write_bytes(b"changed reference")
    assert model._encode_wav(str(paths[0])) is not first
    model._encode_wav(str(paths[1]))
    model._encode_wav(str(paths[2]))
    model._encode_wav(str(paths[0]))
    assert len(calls) == len(evaluated) == 5


segments = runpy.run_path(str(Path(__file__).resolve().parents[1] / "local_tts/worker.py"))[
    "segments"
]

HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def wav_bytes(seconds=3.2):
    audio = io.BytesIO()
    with wave.open(audio, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(
            b"".join(
                struct.pack("<h", int(3000 * math.sin(index * 0.08)))
                for index in range(int(seconds * 16000))
            )
        )
    return audio.getvalue()


@pytest.fixture
def engine(client, monkeypatch):
    calls = []
    local = client.app.state.speech_service.engine
    monkeypatch.setattr(
        local,
        "status",
        lambda: {
            "engine": "voxcpm2_mlx",
            "model": "VoxCPM2-4bit",
            "available": True,
            "state": "ready",
            "detail": "test",
            "supports_style_prompt": True,
            "local_only": True,
        },
    )

    def synthesize(text, reference_path, style_prompt, output_path):
        assert reference_path.is_file()
        calls.append((text, style_prompt))
        output_path.write_bytes(wav_bytes())
        return {"duration_seconds": 3.2, "generation_seconds": 0.05}

    monkeypatch.setattr(local, "synthesize", synthesize)
    return local, calls, synthesize


def add_voice(client, **data):
    response = client.post(
        "/api/v1/voices",
        headers=HEADERS,
        data={
            "name": "参考音色",
            "style_prompt": "温柔自然",
            **data,
        },
        files={"audio": ("../../escape.wav", wav_bytes(), "audio/wav")},
    )
    assert response.status_code == 201, response.text
    return response.json()


def wait_job(client, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/speech/jobs/{job_id}", headers=HEADERS)
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.01)
    pytest.fail("Speech job did not finish")


def conversation(client, voice_id=None, mode="text", prompt="", channel="debug"):
    response = client.post(
        "/api/v1/conversations", headers=HEADERS, json={"peer_id": "speech", "channel": channel}
    )
    cid = response.json()["id"]
    settings = client.put(
        f"/api/v1/conversations/{cid}/settings",
        headers=HEADERS,
        json={
            "voice_id": voice_id,
            "reply_mode": mode,
            "voice_prompt": prompt,
        },
    )
    assert settings.status_code == 200, settings.text
    return cid


def send(client, cid, external_id="one"):
    return client.post(
        f"/api/v1/debug/conversations/{cid}/messages",
        headers=HEADERS,
        json={"external_id": external_id, "text": "你好"},
    )


def test_voice_upload_list_reference_and_auth(client):
    assert client.get("/api/v1/voices").status_code == 401
    assert client.get("/api/v1/speech/status").status_code == 401
    voice = add_voice(client)
    assert voice["duration_seconds"] == 3.2
    assert "path" not in voice
    assert client.get("/api/v1/voices", headers=HEADERS).json()[0]["id"] == voice["id"]
    assert client.get(f"/api/v1/voices/{voice['id']}/reference").status_code == 401
    response = client.get(f"/api/v1/voices/{voice['id']}/reference", headers=HEADERS)
    assert response.content == wav_bytes()
    assert response.headers["content-type"] == "audio/wav"
    assert "no-store" in response.headers["cache-control"]
    root = client.app.state.speech_service.root
    assert (root / "voices" / f"{voice['id']}.wav").is_file()
    assert not (root.parent / "escape.wav").exists()


@pytest.mark.parametrize(
    "data,code",
    [
        (b"not audio", "invalid_audio"),
        (wav_bytes(0.2), "invalid_audio_duration"),
        (wav_bytes(30.1), "invalid_audio_duration"),
        (wav_bytes()[:-2000], "invalid_audio"),
        (b"x" * (10 * 1024 * 1024 + 1), "audio_too_large"),
    ],
)
def test_invalid_audio_is_rejected_without_creating_voice(client, data, code):
    response = client.post(
        "/api/v1/voices",
        headers=HEADERS,
        data={"name": "test"},
        files={"audio": ("test.wav", data, "audio/wav")},
    )
    assert response.status_code in (413, 422)
    assert response.json()["error"]["code"] == code
    assert client.get("/api/v1/voices", headers=HEADERS).json() == []


def test_blank_name_and_excessive_prompt_are_rejected(client):
    for data in ({"name": "   "}, {"name": "test", "style_prompt": "a" * 501}):
        assert (
            client.post(
                "/api/v1/voices",
                headers=HEADERS,
                data=data,
                files={"audio": ("test.wav", wav_bytes())},
            ).status_code
            == 422
        )


def test_preview_uses_style_prompt_and_authenticated_audio(client, engine):
    voice = add_voice(client)
    result = client.post(
        f"/api/v1/voices/{voice['id']}/previews",
        headers=HEADERS,
        json={"text": "你好", "style_prompt": "开心活泼"},
    )
    assert result.status_code == 202
    job = wait_job(client, result.json()["id"])
    assert job["status"] == "completed", job
    assert engine[1] == [("你好", "开心活泼")]
    assert client.get(f"/api/v1/speech/jobs/{job['id']}/audio").status_code == 401
    assert (
        client.get(f"/api/v1/speech/jobs/{job['id']}/audio", headers=HEADERS).content == wav_bytes()
    )
    assert client.get("/api/v1/speech/jobs/missing", headers=HEADERS).status_code == 404


def test_preview_inherits_default_and_empty_prompt_means_natural(client, engine):
    voice = add_voice(client)
    for payload, expected in [
        ({"text": "第一句"}, "温柔自然"),
        ({"text": "第二句", "style_prompt": ""}, ""),
    ]:
        result = client.post(
            f"/api/v1/voices/{voice['id']}/previews", headers=HEADERS, json=payload
        )
        assert wait_job(client, result.json()["id"])["status"] == "completed"
        assert engine[1][-1][1] == expected


def test_preview_validates_text_and_missing_runtime(client, engine, monkeypatch):
    voice = add_voice(client)
    url = f"/api/v1/voices/{voice['id']}/previews"
    for text in (" ", "x" * 601):
        assert client.post(url, headers=HEADERS, json={"text": text}).status_code == 422
    monkeypatch.setattr(engine[0], "status", lambda: {"available": False, "detail": "尚未安装"})
    response = client.post(url, headers=HEADERS, json={"text": "你好"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "tts_not_ready"


def test_chat_enqueues_speech_and_repeated_message_does_not_regenerate(client, engine):
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both", "轻声慢说")
    message = send(client, cid).json()
    assert message["status"] == "completed"
    assert wait_job(client, message["speech_job_id"])["status"] == "completed"
    assert engine[1] == [("模拟回复：你好", "轻声慢说")]
    repeated = send(client, cid).json()
    assert repeated["speech_job_id"] == message["speech_job_id"]
    assert len(engine[1]) == 1


def test_speech_failure_preserves_chat_and_retry_only_synthesizes(client, engine, monkeypatch):
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both")

    def fail(*args):
        raise ServiceError("tts_test", "本地推理失败", 503)

    monkeypatch.setattr(engine[0], "synthesize", fail)
    response = send(client, cid)
    assert response.status_code == 200
    message = response.json()
    job = wait_job(client, message["speech_job_id"])
    assert job["status"] == "failed" and job["error"] == "本地推理失败"
    assert message["assistant_text"] == "模拟回复：你好"
    monkeypatch.setattr(engine[0], "synthesize", engine[2])
    url = f"/api/v1/conversations/{cid}/messages/{message['id']}/speech"
    retried = client.post(url, headers=HEADERS).json()
    assert retried["id"] != job["id"]
    assert wait_job(client, retried["id"])["status"] == "completed"
    assert client.post(url, headers=HEADERS).json()["id"] == retried["id"]
    history = client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json()
    assert len(history) == 1
    assert history[0]["speech_job_ids"] == [retried["id"]]


def test_stream_failure_preserves_partial_text(client, monkeypatch):
    cid = conversation(client)
    with client.app.state.session_factory() as db:
        provider = Provider(name="stream", base_url="https://example.test", api_key_env="TEST")
        db.add(provider)
        db.flush()
        current = db.get(Conversation, cid)
        current.provider_id, current.model_id = provider.id, "demo"
        db.commit()

    def generate(*args):
        yield "这是已收到的文字。"
        raise ServiceError("llm_timeout", "模型超时", 504)

    monkeypatch.setattr(client.app.state.chat_service.llm, "stream", generate)
    events = stream_send(client, cid)
    assert events[-1]["type"] == "error"
    history = client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json()
    assert history[0]["assistant_text"] == "这是已收到的文字。"
    assert history[0]["status"] == "failed"
    assert history[0]["speech_job_ids"] == []


def test_voice_deleted_before_first_stream_sentence_keeps_text(client, monkeypatch):
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both")
    # Delete while the stream waits for upstream text, before enqueue can retain the voice.
    with client.app.state.session_factory() as db:
        provider = Provider(name="stream", base_url="https://example.test", api_key_env="TEST")
        db.add(provider)
        db.flush()
        current = db.get(Conversation, cid)
        current.provider_id, current.model_id = provider.id, "demo"
        db.commit()

    def generate(*args):
        assert client.delete(f"/api/v1/voices/{voice['id']}", headers=HEADERS).status_code == 200
        yield "这是仍然保留的文字。"

    monkeypatch.setattr(client.app.state.chat_service.llm, "stream", generate)
    events = stream_send(client, cid)
    assert events[-1]["type"] == "done", events
    assert events[-1]["message"]["assistant_text"] == "这是仍然保留的文字。"
    assert events[-1]["message"]["speech_job_ids"] == []
    assert any(event["type"] == "notice" for event in events)


def test_manual_speech_checks_message_ownership(client, engine):
    voice = add_voice(client)
    cid = conversation(client, voice["id"])
    message = send(client, cid).json()
    assert message["speech_job_id"] is None
    other = client.post("/api/v1/conversations", headers=HEADERS, json={"peer_id": "other"}).json()
    assert (
        client.post(
            f"/api/v1/conversations/{other['id']}/messages/{message['id']}/speech", headers=HEADERS
        ).status_code
        == 404
    )
    result = client.post(
        f"/api/v1/conversations/{cid}/messages/{message['id']}/speech", headers=HEADERS
    )
    assert result.status_code == 202
    assert wait_job(client, result.json()["id"])["status"] == "completed"


def test_active_speech_blocks_deletion_and_duplicate_jobs(client, engine, monkeypatch):
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both")
    started, release = threading.Event(), threading.Event()

    def blocking(*args):
        started.set()
        assert release.wait(5)
        return engine[2](*args)

    monkeypatch.setattr(engine[0], "synthesize", blocking)
    try:
        message = send(client, cid).json()
        assert started.wait(2)
        assert client.delete(f"/api/v1/voices/{voice['id']}", headers=HEADERS).status_code == 409
        assert (
            client.delete(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).status_code
            == 409
        )
        assert (
            client.get(
                f"/api/v1/speech/jobs/{message['speech_job_id']}/audio", headers=HEADERS
            ).status_code
            == 409
        )
        result = client.post(
            f"/api/v1/conversations/{cid}/messages/{message['id']}/speech", headers=HEADERS
        )
        assert result.json()["id"] == message["speech_job_id"]
    finally:
        release.set()
    assert wait_job(client, message["speech_job_id"])["status"] == "completed"


def test_deleting_voice_removes_audio_and_resets_conversation(client, engine):
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both")
    message = send(client, cid).json()
    job = wait_job(client, message["speech_job_id"])
    service = client.app.state.speech_service
    assert service.audio_path(job["id"]).is_file()
    assert (
        client.delete(f"/api/v1/voices/{voice['id']}", headers=HEADERS).json()[
            "affected_conversations"
        ]
        == 1
    )
    assert not service.audio_path(job["id"]).exists()
    assert not service.reference_path(voice["id"]).exists()
    assert client.get(f"/api/v1/speech/jobs/{job['id']}", headers=HEADERS).status_code == 404
    settings = client.get("/api/v1/conversations", headers=HEADERS).json()[0]
    assert settings["voice_id"] is None and settings["reply_mode"] == "text"
    kept = client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json()[0]
    assert kept["assistant_text"] == "模拟回复：你好" and kept["speech_job_id"] is None


@pytest.mark.parametrize("target", ["turn", "history", "conversation"])
def test_chat_deletion_cleans_related_audio(client, engine, target):
    voice = add_voice(client)
    cid = conversation(client, voice["id"], "both")
    message = send(client, cid).json()
    job = wait_job(client, message["speech_job_id"])
    urls = {
        "turn": f"/api/v1/conversations/{cid}/messages/{message['id']}",
        "history": f"/api/v1/conversations/{cid}/messages",
        "conversation": f"/api/v1/conversations/{cid}",
    }
    assert client.delete(urls[target], headers=HEADERS).status_code == 200
    assert not client.app.state.speech_service.audio_path(job["id"]).exists()
    assert client.get(f"/api/v1/speech/jobs/{job['id']}", headers=HEADERS).status_code == 404


def test_delete_preview_job_removes_its_file(client, engine):
    voice = add_voice(client)
    response = client.post(
        f"/api/v1/voices/{voice['id']}/previews", headers=HEADERS, json={"text": "你好"}
    )
    job = wait_job(client, response.json()["id"])
    assert client.delete(f"/api/v1/speech/jobs/{job['id']}", headers=HEADERS).status_code == 200
    assert not client.app.state.speech_service.audio_path(job["id"]).exists()


def test_interrupted_running_job_is_not_blindly_replayed(client):
    service = client.app.state.speech_service
    voice = add_voice(client)
    with service.session_factory() as db:
        job = SpeechJob(voice_id=voice["id"], text="interrupted", status="running")
        db.add(job)
        db.commit()
        job_id = job.id
    # A fresh app sharing the persisted database performs recovery on startup.
    app = create_app(client.app.state.settings)
    with TestClient(app) as restarted:
        job = restarted.get(f"/api/v1/speech/jobs/{job_id}", headers=HEADERS).json()
        assert job["status"] == "failed" and "中断" in job["error"]


def test_long_chat_text_is_retained_without_silent_audio_truncation(client, engine):
    voice = add_voice(client)
    cid = conversation(client, voice["id"])
    service = client.app.state.speech_service
    with service.session_factory() as db:
        from app.models import Voice

        message = Message(
            conversation_id=cid,
            external_id="long",
            user_text="test",
            assistant_text="长" * 601,
            status="completed",
        )
        db.add(message)
        db.flush()
        job = service.enqueue(
            db, db.get(Voice, voice["id"]), message.assistant_text, message=message
        )
        assert job.status == "failed" and "600" in job.error
        assert len(db.scalar(select(Message)).assistant_text) == 601
    assert engine[1] == []


def test_sentence_chunks_preserve_text_with_a_bounded_size():
    text = "a" * 260 + "。" + "b" * 70 + "！"
    chunks = segments(text)
    assert "".join(chunks) == text
    assert all(0 < len(chunk) <= 120 for chunk in chunks)


def test_sentence_chunks_do_not_cut_a_sentence_that_fits_alone():
    first = "甲" * 49 + "。"
    second = "乙" * 79 + "。"
    assert segments(first + second) == [first, second]


def test_sentence_chunks_pack_short_sentences_to_reduce_restarts():
    sentence = "甲" * 29 + "。"
    assert segments(sentence * 4) == [sentence * 4]


def test_sentence_chunks_prefer_a_comma_for_an_oversized_sentence():
    first = "甲" * 89 + "，"
    second = "乙" * 49 + "。"
    assert segments(first + second) == [first, second]


@pytest.mark.parametrize("limit", [1, 2, 17, 120])
def test_sentence_chunks_handle_custom_limits_without_losing_content(limit):
    text = "甲，乙。" * 75
    chunks = segments(text, limit)
    assert "".join(chunks) == text
    assert all(0 < len(chunk) <= limit for chunk in chunks)


def test_sentence_chunks_reject_an_invalid_limit():
    with pytest.raises(ValueError, match="positive"):
        segments("你好", 0)
