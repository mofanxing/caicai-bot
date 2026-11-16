import os
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
