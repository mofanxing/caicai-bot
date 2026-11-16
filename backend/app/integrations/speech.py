from typing import Protocol

from app.core.errors import ServiceError


class SpeechSynthesizer(Protocol):
    def synthesize(self, text: str, voice_id: str) -> bytes: ...


class SpeechRecognizer(Protocol):
    def transcribe(self, audio: bytes) -> str: ...


class UnconfiguredSpeechSynthesizer:
    def synthesize(self, text: str, voice_id: str) -> bytes:
        raise ServiceError("tts_not_configured", "尚未接入音色及语音合成服务", 501)
