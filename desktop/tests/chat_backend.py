"""Isolated FastAPI integration fixture; model and speech output are deterministic."""

import os
import socket
import tempfile
import time
import wave
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from app.core.config import Settings
from app.main import create_app
from app.models import Conversation, Provider, Voice


def wav(path):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0\0" * 12000)


with tempfile.TemporaryDirectory(prefix="caicai-chat-backend-") as directory:
    root = Path(directory)
    app = create_app(
        Settings(
            _env_file=None,
            app_env="test",
            admin_token=os.environ["CAICAI_CHAT_CHECK_TOKEN"],
            mock_llm_enabled=False,
            database_url=f"sqlite:///{root / 'test.db'}",
            speech_data_dir=str(root / "speech"),
            provider_encryption_key_file=str(root / "key"),
        )
    )
    speech = app.state.speech_service
    speech.engine.status = lambda: {
        "engine": "integration_fixture",
        "model": "silent_wav_fixture",
        "available": True,
        "state": "ready",
        "detail": "isolated test",
        "supports_style_prompt": True,
        "local_only": True,
    }

    def synthesize(text, reference_path, style_prompt, output_path):
        wav(output_path)
        return {"duration_seconds": 0.75, "generation_seconds": 0.01}

    def stream(*args):
        for text in [
            "这是桌面链路验收。",
            "我们正在通过正式桌面接口逐步显示这段回复，同时准备本地语音。",
            "验收还会确认聊天窗口收起后可以恢复，会话和语音状态保持正常。",
        ]:
            time.sleep(0.2)
            yield text

    speech.engine.synthesize = synthesize
    app.state.chat_service.llm.stream = stream
    lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def setup(application):
        async with lifespan(application):
            with application.state.session_factory() as db:
                voice = Voice(name="验收音色（静音夹具）", duration_seconds=0.75)
                provider = Provider(
                    name="验收模型（模拟适配器）",
                    base_url="https://example.invalid/v1",
                    api_key_env="UNUSED",
                )
                db.add_all([voice, provider])
                db.flush()
                reference = speech.reference_path(voice.id)
                reference.parent.mkdir(parents=True, exist_ok=True)
                wav(reference)
                db.add(
                    Conversation(
                        channel="desktop",
                        account_id="desktop",
                        peer_id="桌面自动验收",
                        provider_id=provider.id,
                        model_id="fixture",
                        reply_mode="both",
                        voice_id=voice.id,
                    )
                )
                db.commit()
            yield

    app.router.lifespan_context = setup
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    print(
        "CAICAI_TEST_BACKEND=http://127.0.0.1:" + str(listener.getsockname()[1]),
        flush=True,
    )
    uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(
        sockets=[listener]
    )
