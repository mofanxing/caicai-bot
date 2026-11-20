"""Bounded, offline microphone transcription in the existing isolated MLX runtime."""

import base64
import io
import json
import os
import selectors
import subprocess
import threading
import time
import wave
from pathlib import Path

from app.core.errors import ServiceError

MAX_AUDIO_BYTES = 16000 * 2 * 20 + 4096


def validate_recording(data: bytes) -> float:
    if len(data) > MAX_AUDIO_BYTES:
        raise ServiceError("recording_too_large", "每段录音不能超过 20 秒", 413)
    try:
        with wave.open(io.BytesIO(data), "rb") as recording:
            duration = recording.getnframes() / recording.getframerate()
            if (
                recording.getnchannels() != 1
                or recording.getsampwidth() != 2
                or recording.getframerate() != 16000
                or recording.getcomptype() != "NONE"
                or not 0.2 <= duration <= 20
                or len(recording.readframes(recording.getnframes()))
                != recording.getnframes() * 2
            ):
                raise ValueError("Unsupported recording")
    except (wave.Error, EOFError, ValueError, ZeroDivisionError) as exc:
        raise ServiceError(
            "invalid_recording", "请上传 0.2～20 秒、16 kHz 单声道 PCM16 WAV 录音", 422
        ) from exc
    return duration


class LocalRecognitionEngine:
    def __init__(self, settings):
        self.settings = settings
        self.process = None
        self._lock = threading.Lock()
        self._state = "available"
        self.stopping = False

    def status(self):
        model = Path(self.settings.local_asr_model_dir)
        state = self._state
        if not Path(self.settings.local_asr_python).is_file():
            state = "runtime_missing"
        elif not (
            all((model / name).is_file() for name in ("config.json", "tokenizer.json"))
            and any(model.glob("*.safetensors"))
        ):
            state = "model_missing"
        return {
            "engine": "whisper_mlx",
            "model": "Whisper-small",
            "state": state,
            "available": state not in {"runtime_missing", "model_missing"},
            "local_only": True,
            "detail": {
                "runtime_missing": "本地识别环境未安装，请运行 backend/local_asr/setup.py",
                "model_missing": "本地识别模型未安装，请运行 backend/local_asr/setup.py",
                "available": "本地中文语音识别可用，首次识别时加载模型",
                "loading": "正在加载本地语音识别模型",
                "running": "正在本机识别语音",
                "ready": "本地语音识别已就绪",
                "error": "上次识别失败，可重新开始语音聊天",
            }.get(state, "本地语音识别"),
        }

    def _read(self, deadline):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if selector.select(timeout=min(1, max(0, deadline - time.monotonic()))):
                    line = self.process.stdout.readline()
                    if line.startswith(b"CAICAI_ASR:"):
                        return json.loads(line[len(b"CAICAI_ASR:") :])
                    if not line:
                        break
                if self.process.poll() is not None:
                    break
        raise ServiceError("asr_timeout", "本地识别超时或进程退出，请重新开始语音聊天", 504)

    def transcribe(self, data):
        duration = validate_recording(data)
        if not self._lock.acquire(blocking=False):
            raise ServiceError("asr_busy", "本地识别正忙，请稍后再说", 409)
        try:
            if self.stopping:
                raise ServiceError("asr_stopped", "语音识别服务正在退出", 503)
            status = self.status()
            if not status["available"]:
                raise ServiceError("asr_not_ready", status["detail"], 503)
            started = time.monotonic()
            deadline = started + self.settings.local_asr_timeout_seconds
            try:
                if self.process is None or self.process.poll() is not None:
                    self._state = "loading"
                    environment = os.environ.copy()
                    environment.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
                    self.process = subprocess.Popen(
                        [
                            self.settings.local_asr_python,
                            "-u",
                            str(Path(__file__).resolve().parents[2] / "local_asr/worker.py"),
                            "--model",
                            str(Path(self.settings.local_asr_model_dir).resolve()),
                        ],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        bufsize=0,
                        env=environment,
                    )
                    if self.stopping:
                        raise ServiceError("asr_stopped", "语音识别服务正在退出", 503)
                    if self._read(deadline).get("type") != "ready":
                        raise ServiceError(
                            "asr_load_failed", "识别模型加载失败，请重新运行本地识别安装脚本", 503
                        )
                self._state = "running"
                payload = json.dumps({"audio": base64.b64encode(data).decode("ascii")})
                self.process.stdin.write((payload + "\n").encode())
                self.process.stdin.flush()
                result = self._read(deadline)
                if not result.get("ok") or not isinstance(result.get("text"), str):
                    raise ServiceError("asr_failed", "语音识别失败，请重新开始后再说一次", 502)
                self._state = "ready"
                return {
                    "text": result["text"].strip(),
                    "language": "zh",
                    "duration_seconds": round(duration, 3),
                    "recognition_seconds": round(time.monotonic() - started, 3),
                }
            except ServiceError:
                self.close()
                self._state = "error"
                raise
            except (OSError, ValueError, KeyError, AttributeError) as exc:
                self.close()
                self._state = "error"
                raise ServiceError(
                    "asr_worker_error", "本地识别进程异常，请重新开始语音聊天", 503
                ) from exc
        finally:
            self._lock.release()

    def close(self):
        process, self.process = self.process, None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for stream in (process.stdin, process.stdout):
                if stream:
                    stream.close()

    def shutdown(self):
        self.stopping = True
        self.close()
