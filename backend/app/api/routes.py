import json
import logging
from queue import Empty, Queue
from secrets import compare_digest
from threading import Thread

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.core.errors import ServiceError
from app.models import Conversation, Message, Provider, Voice
from app.schemas import (
    ConversationCreate,
    ConversationRead,
    ConversationSettings,
    IncomingMessage,
    MessageRead,
    ProviderCreate,
    ProviderKeyUpdate,
    ProviderRead,
    WechatIncoming,
)

router = APIRouter()


def get_db(request: Request):
    with request.app.state.session_factory() as session:
        yield session


def require_admin(request: Request, authorization: str = Header(default="")):
    expected = request.app.state.settings.admin_token.get_secret_value()
    if not compare_digest(authorization.encode(), f"Bearer {expected}".encode()):
        raise ServiceError("unauthorized", "需要有效的管理员令牌", 401)


admin = APIRouter(prefix="/api/v1", dependencies=[Depends(require_admin)])


@router.get("/health")
def health():
    return {"status": "ok"}


@admin.get("/capabilities")
def capabilities(request: Request):
    return {
        "llm": ["openai_compatible"],
        "debug_mock_enabled": request.app.state.settings.mock_llm_enabled,
        "wechat_personal": "bridge_contract_only",
        "tts": "local_voxcpm2",
        "asr": "not_configured",
    }


@admin.post("/providers", response_model=ProviderRead, status_code=201)
def create_provider(payload: ProviderCreate, request: Request, db=Depends(get_db)):
    provider = Provider(
        name=payload.name,
        base_url=str(payload.base_url).rstrip("/"),
        api_key_env=payload.api_key_env or "",
        api_key_encrypted=(
            request.app.state.secret_vault.encrypt(payload.api_key.get_secret_value())
            if payload.api_key
            else None
        ),
    )
    db.add(provider)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ServiceError("provider_exists", "站点名称已存在", 409) from exc
    return provider


@admin.get("/providers", response_model=list[ProviderRead])
def list_providers(db=Depends(get_db)):
    return db.scalars(select(Provider).order_by(Provider.name)).all()


@admin.get("/providers/{provider_id}/models")
def list_models(provider_id: str, request: Request, db=Depends(get_db)):
    with request.app.state.chat_service.provider_guard(provider_id):
        provider = find_provider(db, provider_id)
        return {"models": request.app.state.chat_service.llm.list_models(provider)}


def find_provider(db, provider_id: str):
    provider = db.get(Provider, provider_id)
    if not provider:
        raise ServiceError("provider_not_found", "中转站不存在", 404)
    return provider


@admin.put("/providers/{provider_id}/key", response_model=ProviderRead)
def replace_provider_key(
    provider_id: str, payload: ProviderKeyUpdate, request: Request, db=Depends(get_db)
):
    with request.app.state.chat_service.provider_guard(provider_id):
        provider = find_provider(db, provider_id)
        provider.api_key_encrypted = request.app.state.secret_vault.encrypt(
            payload.api_key.get_secret_value()
        )
        provider.api_key_env = ""
        db.commit()
        request.app.state.chat_service.llm.forget_provider(provider_id)
        return provider


@admin.delete("/providers/{provider_id}")
def delete_provider(provider_id: str, request: Request, db=Depends(get_db)):
    with request.app.state.chat_service.provider_guard(provider_id):
        provider = find_provider(db, provider_id)
        affected = db.execute(
            update(Conversation)
            .where(Conversation.provider_id == provider_id)
            .values(provider_id=None, model_id=None)
        ).rowcount
        db.delete(provider)
        db.commit()
        request.app.state.chat_service.llm.forget_provider(provider_id)
        return {"deleted": True, "affected_conversations": affected}


@admin.post("/conversations", response_model=ConversationRead, status_code=201)
def create_conversation(payload: ConversationCreate, db=Depends(get_db)):
    conversation = Conversation(**payload.model_dump())
    db.add(conversation)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ServiceError("conversation_exists", "该账号与好友的会话已存在", 409) from exc
    return conversation


@admin.get("/conversations", response_model=list[ConversationRead])
def list_conversations(db=Depends(get_db)):
    return db.scalars(select(Conversation).order_by(Conversation.id)).all()


def find_conversation(db, conversation_id: str):
    conversation = db.get(Conversation, conversation_id)
    if not conversation:
        raise ServiceError("conversation_not_found", "会话不存在", 404)
    return conversation


@admin.put("/conversations/{conversation_id}/settings", response_model=ConversationRead)
def set_conversation(
    conversation_id: str, payload: ConversationSettings, request: Request, db=Depends(get_db)
):
    service = request.app.state.chat_service
    with service.conversation_guard(conversation_id), service.provider_guard(payload.provider_id):
        conversation = find_conversation(db, conversation_id)
        if payload.provider_id:
            find_provider(db, payload.provider_id)
        with request.app.state.speech_service.guard:
            if payload.voice_id and not db.get(Voice, payload.voice_id):
                raise ServiceError("voice_not_found", "所选音色不存在，请重新选择", 404)
            if conversation.channel == "wechat_personal" and payload.reply_mode != "text":
                raise ServiceError("wechat_voice_not_supported", "微信语音投递尚未接入", 501)
            for key, value in payload.model_dump().items():
                setattr(conversation, key, value)
            db.commit()
        return conversation


@admin.get("/conversations/{conversation_id}/messages", response_model=list[MessageRead])
def get_messages(conversation_id: str, db=Depends(get_db)):
    find_conversation(db, conversation_id)
    return db.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .options(selectinload(Message.speech_jobs))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(100)
    ).all()


def find_local_conversation(db, conversation_id: str):
    conversation = find_conversation(db, conversation_id)
    if conversation.channel not in {"debug", "desktop"}:
        raise ServiceError("wrong_channel", "该操作只适用于本地聊天会话", 409)
    return conversation


@admin.delete("/conversations/{conversation_id}/messages")
def clear_messages(conversation_id: str, request: Request, db=Depends(get_db)):
    with request.app.state.chat_service.conversation_guard(conversation_id):
        find_local_conversation(db, conversation_id)
        request.app.state.speech_service.clear_message_audio(db, conversation_id)
        removed = db.execute(delete(Message).where(Message.conversation_id == conversation_id))
        db.commit()
        return {"deleted_count": removed.rowcount}


@admin.delete("/conversations/{conversation_id}/messages/{message_id}")
def delete_message(conversation_id: str, message_id: str, request: Request, db=Depends(get_db)):
    with request.app.state.chat_service.conversation_guard(conversation_id):
        find_local_conversation(db, conversation_id)
        message = db.get(Message, message_id)
        if not message or message.conversation_id != conversation_id:
            raise ServiceError("message_not_found", "该会话中不存在此条记录", 404)
        request.app.state.speech_service.clear_message_audio(db, conversation_id, message_id)
        db.delete(message)
        db.commit()
        return {"deleted": True}


@admin.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, request: Request, db=Depends(get_db)):
    with request.app.state.chat_service.conversation_guard(conversation_id):
        conversation = find_local_conversation(db, conversation_id)
        request.app.state.speech_service.clear_message_audio(db, conversation_id)
        db.execute(delete(Message).where(Message.conversation_id == conversation_id))
        db.delete(conversation)
        db.commit()
        return {"deleted": True}


@admin.post("/debug/conversations/{conversation_id}/messages", response_model=MessageRead)
def debug_message(
    conversation_id: str, payload: IncomingMessage, request: Request, db=Depends(get_db)
):
    if request.app.state.settings.app_env == "production":
        raise ServiceError("not_found", "接口不存在", 404)
    conversation = find_conversation(db, conversation_id)
    if conversation.channel != "debug":
        raise ServiceError("wrong_channel", "调试接口只接受 debug 会话", 409)
    return request.app.state.chat_service.handle(db, conversation, payload)


@admin.post("/debug/conversations/{conversation_id}/messages/stream")
def debug_message_stream(
    conversation_id: str, payload: IncomingMessage, request: Request, db=Depends(get_db)
):
    if request.app.state.settings.app_env == "production":
        raise ServiceError("not_found", "接口不存在", 404)
    conversation = find_conversation(db, conversation_id)
    if conversation.channel != "debug":
        raise ServiceError("wrong_channel", "调试接口只接受 debug 会话", 409)
    return stream_message(conversation_id, payload, request)


@admin.post("/desktop/conversations/{conversation_id}/messages", response_model=MessageRead)
def desktop_message(
    conversation_id: str, payload: IncomingMessage, request: Request, db=Depends(get_db)
):
    conversation = find_conversation(db, conversation_id)
    if conversation.channel != "desktop":
        raise ServiceError("wrong_channel", "桌面接口只接受 desktop 会话", 409)
    return request.app.state.chat_service.handle(db, conversation, payload)


@admin.post("/desktop/conversations/{conversation_id}/messages/stream")
def desktop_message_stream(
    conversation_id: str, payload: IncomingMessage, request: Request, db=Depends(get_db)
):
    conversation = find_conversation(db, conversation_id)
    if conversation.channel != "desktop":
        raise ServiceError("wrong_channel", "桌面接口只接受 desktop 会话", 409)
    return stream_message(conversation_id, payload, request)


def stream_message(conversation_id: str, payload: IncomingMessage, request: Request):
    events = Queue()

    def generate():
        # Own the session for the whole generation, including after a browser disconnect.
        with request.app.state.session_factory() as session:
            try:
                current = find_conversation(session, conversation_id)
                result = request.app.state.chat_service.handle(
                    session, current, payload, on_event=events.put
                )
                session.refresh(result)
                session.expire(result, ["speech_jobs"])
                events.put(
                    {"type": "done", "message": MessageRead.model_validate(result).model_dump()}
                )
            except ServiceError as exc:
                events.put({"type": "error", "message": exc.message, "code": exc.code})
            except Exception as exc:
                logging.getLogger(__name__).warning(
                    "Streaming chat failed: kind=%s", type(exc).__name__
                )
                events.put({"type": "error", "message": "回复生成失败，请刷新记录后重试"})
            finally:
                events.put(None)

    def stream():
        Thread(target=generate, name="chat-stream", daemon=True).start()
        while True:
            try:
                event = events.get(timeout=10)
            except Empty:
                yield ": keepalive\n\n"
                continue
            if event is None:
                break
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def require_wechat_token(request: Request, authorization: str = Header(default="")):
    expected = request.app.state.settings.wechat_inbound_token.get_secret_value()
    if not expected or not compare_digest(authorization.encode(), f"Bearer {expected}".encode()):
        raise ServiceError("unauthorized", "无效的微信桥接令牌", 401)


@router.post(
    "/api/v1/channels/wechat-personal/inbound",
    response_model=MessageRead,
    dependencies=[Depends(require_wechat_token)],
)
def wechat_inbound(payload: WechatIncoming, request: Request, db=Depends(get_db)):
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.channel == "wechat_personal",
            Conversation.account_id == payload.account_id,
            Conversation.peer_id == payload.peer_id,
        )
    )
    if not conversation:
        raise ServiceError("conversation_not_found", "请先创建并配置该好友会话", 404)
    return request.app.state.chat_service.handle(db, conversation, payload)


router.include_router(admin)
