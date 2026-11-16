import json
import os
import selectors
import subprocess
import threading
import time
from pathlib import Path

from app.core.config import Settings
from app.core.errors import ServiceError


class LocalSpeechEngine:
    """A single persistent inference process; no ML dependencies in the API."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.process = None
        self._state = "idle"
        self._lock = threading.Lock()
        self.stopping = False

    def status(self):
        if not Path(self.settings.local_tts_python).is_file():
            state, detail = "runtime_missing", "本地语音环境未安装，请按本地语音文档运行安装脚本"
        elif not (Path(self.settings.local_tts_model_dir) / "config.json").is_file() or not any(
            Path(self.settings.local_tts_model_dir).glob("*.safetensors")
        ):
            state, detail = "model_missing", "本地模型尚未下载完整，请运行安装脚本"
        else:
            state = self._state if self._state != "idle" else "available"
            detail = {
                "available": "本地模型可用，第一次生成时加载；首次加载和编译可能较慢",
                "loading": "正在加载本地语音模型",
                "running": "正在本机生成语音",
                "ready": "本地语音模型已加载",
                "error": "上次推理失败，可重试；持续失败请检查本地运行环境",
            }.get(state, "本地语音服务")
        return {
            "engine": "voxcpm2_mlx",
            "model": "VoxCPM2-4bit",
            "state": state,
            "detail": detail,
            "available": state not in {"runtime_missing", "model_missing"},
            "supports_style_prompt": True,
            "local_only": True,
        }

    def _read(self, deadline):
        process = self.process
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if selector.select(timeout=min(1, max(0, deadline - time.monotonic()))):
                    line = process.stdout.readline()
                    if not line:
                        break
                    if line.startswith(b"CAICAI_TTS:"):
                        return json.loads(line[len(b"CAICAI_TTS:") :])
                if process.poll() is not None:
                    break
        raise ServiceError("tts_timeout", "本地语音推理超时或进程退出，请重试较短文字", 504)

    def synthesize(self, text, reference_path, style_prompt, output_path):
        with self._lock:
            if self.stopping:
                raise ServiceError("tts_stopped", "语音服务正在退出，稍后可手动重试", 503)
            if not self.status()["available"]:
                raise ServiceError("tts_not_ready", self.status()["detail"], 503)
            deadline = time.monotonic() + self.settings.local_tts_timeout_seconds
            try:
                if self.process is None or self.process.poll() is not None:
                    self._state = "loading"
                    environment = os.environ.copy()
                    environment.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
                    # Keep upstream imports/loggers away from user text and API output.
                    self.process = subprocess.Popen(
                        [
                            self.settings.local_tts_python,
                            "-u",
                            str(Path(__file__).resolve().parents[2] / "local_tts/worker.py"),
                            "--model",
                            str(Path(self.settings.local_tts_model_dir).resolve()),
                        ],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        bufsize=0,
                        env=environment,
                    )
                    if self.stopping:
                        self.close()
                        raise ServiceError("tts_stopped", "语音服务正在退出", 503)
                    if self._read(deadline).get("type") != "ready":
                        raise ServiceError(
                            "tts_load_failed", "本地模型加载失败，请检查依赖版本和模型文件", 503
                        )
                self._state = "running"
                payload = {
                    "text": text,
                    "reference_path": str(reference_path),
                    "style_prompt": style_prompt,
                    "output_path": str(output_path),
                }
                self.process.stdin.write((json.dumps(payload) + "\n").encode())
                self.process.stdin.flush()
                result = self._read(deadline)
                if not result.get("ok"):
                    raise ServiceError(
                        "tts_generation_failed",
                        "本地合成失败，请尝试较短文字或更清晰的参考录音",
                        502,
                    )
                self._state = "ready"
                return result
            except ServiceError:
                self.close()
                self._state = "error"
                raise
            except (OSError, ValueError, KeyError) as exc:
                self.close()
                self._state = "error"
                raise ServiceError(
                    "tts_worker_error", "本地语音进程异常，请检查环境后重试", 503
                ) from exc

    def close(self):
        process = self.process
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
        self.process = None

    def shutdown(self):
        self.stopping = True
        self.close()
