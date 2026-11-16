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
from app.models import Conversation, Message, Provider
from app.schemas import IncomingMessage


class ChatService:
    def __init__(self, settings: Settings, vault: SecretVault | None = None):
        self.settings = settings
        self.llm = OpenAICompatibleClient(settings.llm_timeout_seconds, vault)
        self.wechat = PersonalWechatBridge(settings)
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

    def handle(self, db: Session, conversation: Conversation, incoming: IncomingMessage) -> Message:
        with self.conversation_guard(conversation.id):
            db.refresh(conversation)
            with self.provider_guard(conversation.provider_id):
                db.refresh(conversation)
                return self._handle(db, conversation, incoming)

    def _handle(
        self, db: Session, conversation: Conversation, incoming: IncomingMessage
    ) -> Message:
        previous = db.scalar(
            select(Message).where(
                Message.conversation_id == conversation.id,
                Message.external_id == incoming.external_id,
            )
        )
        if previous:
            return previous
        if conversation.reply_mode != "text":
            raise ServiceError("tts_not_configured", "语音服务尚未接入，请先使用文字模式", 501)
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
            if conversation.provider_id:
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
            return message
        except ServiceError:
            message.status = "delivery_unknown" if message.status == "sending" else "failed"
            db.commit()
            raise
