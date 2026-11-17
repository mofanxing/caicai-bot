from contextlib import contextmanager
from threading import Lock

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import ServiceError
from app.core.secrets import SecretVault
from app.integrations.llm import OpenAICompatibleClient
from app.integrations.wechat import PersonalWechatBridge
from app.models import Conversation, Message, Provider, Voice
from app.schemas import IncomingMessage
from app.services.speech_text import speech_boundary


class ChatService:
    def __init__(self, settings: Settings, vault: SecretVault | None = None, speech=None):
        self.settings = settings
        self.llm = OpenAICompatibleClient(settings.llm_timeout_seconds, vault)
        self.wechat = PersonalWechatBridge(settings)
        self.speech = speech
        self._locks = {}
        self._locks_guard = Lock()
        self._provider_locks = {}

    @contextmanager
    def conversation_guard(self, conversation_id: str):
        with self._locks_guard:
            lock = self._locks.setdefault(conversation_id, Lock())
        if not lock.acquire(blocking=False):
            raise ServiceError("conversation_busy", "该会话正在处理上一条消息，请稍后重试", 409)
        try:
            yield
        finally:
            lock.release()

    @contextmanager
    def provider_guard(self, provider_id: str | None):
        if not provider_id:
            yield
            return
        with self._locks_guard:
            lock = self._provider_locks.setdefault(provider_id, Lock())
        if not lock.acquire(blocking=False):
            raise ServiceError("provider_busy", "该中转站正在处理请求，请稍后再操作", 409)
        try:
            yield
        finally:
            lock.release()

    def handle(
        self, db: Session, conversation: Conversation, incoming: IncomingMessage, on_event=None
    ) -> Message:
        with self.conversation_guard(conversation.id):
            db.refresh(conversation)
            with self.provider_guard(conversation.provider_id):
                db.refresh(conversation)
                return self._handle(db, conversation, incoming, on_event)

    def _handle(
        self, db: Session, conversation: Conversation, incoming: IncomingMessage, on_event=None
    ) -> Message:
        previous = db.scalar(
            select(Message).where(
                Message.conversation_id == conversation.id,
                Message.external_id == incoming.external_id,
            )
        )
        if previous:
            return previous
        if conversation.reply_mode != "text" and conversation.channel == "wechat_personal":
            raise ServiceError(
                "wechat_voice_not_supported", "微信语音投递尚未接入，请使用文字模式", 501
            )
        if conversation.channel == "wechat_personal":
            if not self.settings.wechat_bridge_url:
                raise ServiceError("wechat_not_configured", "个人微信桥接服务未配置", 503)
            if not conversation.provider_id:
                raise ServiceError("model_not_configured", "请先为微信会话选择模型", 409)
        if not conversation.provider_id and not self.settings.mock_llm_enabled:
            raise ServiceError("model_not_configured", "请先为会话选择模型", 409)
        # 第一版采用单进程内会话锁；不在 HTTP 请求内自动重试发送。
        message = Message(
            conversation_id=conversation.id,
            external_id=incoming.external_id,
            user_text=incoming.text,
            status="processing",
        )
        db.add(message)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return db.scalars(
                select(Message).where(
                    Message.conversation_id == conversation.id,
                    Message.external_id == incoming.external_id,
                )
            ).one()
        try:
            if on_event:
                on_event({"type": "start", "message_id": message.id})
            history = list(
                reversed(
                    db.scalars(
                        select(Message)
                        .where(
                            Message.conversation_id == conversation.id,
                            Message.status.in_(["completed", "sent"]),
                        )
                        .order_by(Message.created_at.desc(), Message.id.desc())
                        .limit(10)
                    ).all()
                )
            )
            messages = [{"role": "system", "content": conversation.system_prompt}]
            for turn in history:
                messages.extend(
                    [
                        {"role": "user", "content": turn.user_text},
                        {"role": "assistant", "content": turn.assistant_text},
                    ]
                )
            messages.append({"role": "user", "content": incoming.text})
            if on_event:
                provider = (
                    db.get(Provider, conversation.provider_id) if conversation.provider_id else None
                )
                chunks = (
                    self.llm.stream(provider, conversation.model_id, messages)
                    if provider
                    else iter([f"模拟回复：{incoming.text}"])
                )
                message.assistant_text = ""
                pending, spoken = "", 0
                voice = (
                    db.get(Voice, conversation.voice_id)
                    if conversation.reply_mode != "text" and self.speech
                    else None
                )

                def speak(text):
                    nonlocal spoken, voice
                    if not voice or not text.strip() or spoken >= 600:
                        return
                    text = text[: 600 - spoken]
                    with self.speech.guard:
                        if db.scalar(select(Voice.id).where(Voice.id == voice.id)) is None:
                            voice = None
                            db.commit()
                            on_event(
                                {
                                    "type": "notice",
                                    "message": "音色已被删除，后续语音已停止，文字回复继续。",
                                }
                            )
                            return
                        job = self.speech.enqueue(
                            db,
                            voice,
                            text,
                            conversation.voice_prompt or None,
                            message,
                            segment=True,
                        )
                    spoken += len(text)
                    on_event({"type": "speech", "job_id": job.id})

                # Do not hold an autoflushed SQLite write transaction while waiting for LLM.
                db.commit()
                for chunk in chunks:
                    message.assistant_text += chunk
                    on_event({"type": "delta", "text": chunk})
                    if not voice:
                        continue
                    pending += chunk
                    # Keep a short greeting with its next sentence for coherent prosody.
                    while pending:
                        cut = speech_boundary(pending, first=spoken == 0)
                        if not cut:
                            break
                        speak(pending[:cut])
                        pending = pending[cut:]
                speak(pending)
                if voice and len(message.assistant_text) > 600:
                    on_event(
                        {"type": "notice", "message": "回复超过 600 字，仅为前 600 字生成语音。"}
                    )
            elif conversation.provider_id:
                provider = db.get(Provider, conversation.provider_id)
                message.assistant_text = self.llm.complete(
                    provider, conversation.model_id, messages
                )
            else:
                message.assistant_text = f"模拟回复：{incoming.text}"
            message.status = "completed"
            db.commit()
            if conversation.channel == "wechat_personal":
                message.status = "sending"
                db.commit()
                self.wechat.send_text(
                    conversation.account_id,
                    conversation.peer_id,
                    message.assistant_text,
                    message.id,
                )
                message.status = "sent"
                db.commit()
            if not on_event and conversation.reply_mode != "text" and self.speech:
                with self.speech.guard:
                    voice = db.get(Voice, conversation.voice_id)
                    if voice:
                        self.speech.enqueue(
                            db,
                            voice,
                            message.assistant_text,
                            style_prompt=conversation.voice_prompt or None,
                            message=message,
                        )
            return message
        except Exception:
            message.status = "delivery_unknown" if message.status == "sending" else "failed"
            db.commit()
            raise
