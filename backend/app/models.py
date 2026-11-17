import os
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def new_id() -> str:
    return uuid4().hex


class Provider(Base):
    __tablename__ = "providers"

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    base_url: Mapped[str] = mapped_column(String(2048))
    api_key_env: Mapped[str] = mapped_column(String(100))
    api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)

    @property
    def has_api_key(self) -> bool:
        return bool(
            self.api_key_encrypted or (self.api_key_env and os.environ.get(self.api_key_env))
        )

    @property
    def key_source(self) -> str:
        if self.api_key_encrypted:
            return "encrypted"
        return "environment" if self.has_api_key else "missing"


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (UniqueConstraint("channel", "account_id", "peer_id"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    channel: Mapped[str] = mapped_column(String(32))
    account_id: Mapped[str] = mapped_column(String(200))
    peer_id: Mapped[str] = mapped_column(String(200))
    provider_id: Mapped[str | None] = mapped_column(ForeignKey("providers.id"), nullable=True)
    model_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    reply_mode: Mapped[str] = mapped_column(String(20), default="text")
    voice_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    voice_prompt: Mapped[str] = mapped_column(Text, default="")
    feedback_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    feedback_thinking_text: Mapped[str] = mapped_column(Text, default="收到，我想一想。")
    feedback_waiting_text: Mapped[str] = mapped_column(Text, default="我在准备语音，稍等一下。")
    feedback_thinking_job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    feedback_waiting_job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    system_prompt: Mapped[str] = mapped_column(Text, default="你是菜菜，一个友善自然的聊天助手。")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (UniqueConstraint("conversation_id", "external_id"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    external_id: Mapped[str] = mapped_column(String(200))
    user_text: Mapped[str] = mapped_column(Text)
    assistant_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="processing")
    speech_job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    speech_jobs: Mapped[list["SpeechJob"]] = relationship(
        primaryjoin="Message.id == foreign(SpeechJob.message_id)",
        order_by="(SpeechJob.created_at, SpeechJob.id)",
        viewonly=True,
    )

    @property
    def speech_job_ids(self) -> list[str]:
        jobs = self.speech_jobs
        # A legacy full-message retry supersedes earlier failed attempts.
        start = next((i for i, job in enumerate(jobs) if job.id == self.speech_job_id), 0)
        return [job.id for job in jobs[start:]]


class Voice(Base):
    __tablename__ = "voices"

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    reference_text: Mapped[str] = mapped_column(Text, default="")
    style_prompt: Mapped[str] = mapped_column(Text, default="")
    duration_seconds: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class SpeechJob(Base):
    __tablename__ = "speech_jobs"

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    purpose: Mapped[str] = mapped_column(String(20), default="speech")
    voice_id: Mapped[str] = mapped_column(ForeignKey("voices.id", ondelete="CASCADE"))
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=True, index=True
    )
    text: Mapped[str] = mapped_column(Text)
    style_prompt: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="queued")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    generation_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
