import os
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, String, Text, UniqueConstraint
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


def utc_now():
    return datetime.now(timezone.utc)


class TaskProject(Base):
    __tablename__ = "task_projects"

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    root: Mapped[str] = mapped_column(Text, unique=True)
    registered: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class PluginConfig(Base):
    __tablename__ = "plugin_configs"

    id: Mapped[str] = mapped_column(primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (UniqueConstraint("conversation_scope", "idempotency_key"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    # Preserve deduplication scope even after a conversation is deleted.
    conversation_scope: Mapped[str] = mapped_column(String(32))
    idempotency_key: Mapped[str] = mapped_column(String(200))
    input_hash: Mapped[str] = mapped_column(String(64))
    project_id: Mapped[str] = mapped_column(ForeignKey("task_projects.id"))
    project_root: Mapped[str] = mapped_column(Text)
    goal: Mapped[str] = mapped_column(Text)
    agent_id: Mapped[str] = mapped_column(String(100))
    plugin_version: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    timeout_seconds: Mapped[int] = mapped_column(default=600)
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(String(100), nullable=True)
    event_seq: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class TaskAttempt(Base):
    __tablename__ = "task_attempts"
    __table_args__ = (UniqueConstraint("task_id", "number"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    number: Mapped[int] = mapped_column(default=1)
    executor_id: Mapped[str] = mapped_column(String(100))
    executor_version: Mapped[str] = mapped_column(String(100))
    run_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)
    process_group: Mapped[int | None] = mapped_column(nullable=True)
    status: Mapped[str] = mapped_column(String(32))
    exit_code: Mapped[int | None] = mapped_column(nullable=True)
    reason: Mapped[str | None] = mapped_column(String(100), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TaskEvent(Base):
    __tablename__ = "task_events"
    __table_args__ = (UniqueConstraint("task_id", "seq"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    attempt_id: Mapped[str | None] = mapped_column(ForeignKey("task_attempts.id"), nullable=True)
    seq: Mapped[int] = mapped_column()
    type: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class TaskArtifact(Base):
    __tablename__ = "task_artifacts"

    id: Mapped[str] = mapped_column(primary_key=True, default=new_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    attempt_id: Mapped[str] = mapped_column(ForeignKey("task_attempts.id"))
    path: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(40))
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
