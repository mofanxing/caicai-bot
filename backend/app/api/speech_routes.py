from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.routes import find_local_conversation, get_db, require_admin
from app.core.errors import ServiceError
from app.models import Message, SpeechJob, Voice
from app.schemas import (
    MessageSpeechRead,
    SpeechFeedbackRead,
    SpeechJobRead,
    SpeechPreview,
    VoiceRead,
)
from app.services.speech import ACTIVE

speech_router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_admin)])


def find_voice(db, voice_id):
    if not voice_id:
        raise ServiceError("voice_not_found", "请先在聊天设置选择音色", 404)
    voice = db.get(Voice, voice_id)
    if not voice:
        raise ServiceError("voice_not_found", "音色不存在或已删除", 404)
    return voice


def find_job(db, job_id):
    job = db.get(SpeechJob, job_id)
    if not job:
        raise ServiceError("speech_job_not_found", "语音任务不存在或已删除", 404)
    return job


@speech_router.get("/speech/status")
def speech_status(request: Request):
    return request.app.state.speech_service.engine.status()


@speech_router.get("/voices", response_model=list[VoiceRead])
def list_voices(db=Depends(get_db)):
    return db.scalars(select(Voice).order_by(Voice.created_at.desc(), Voice.id)).all()


@speech_router.post("/voices", response_model=VoiceRead, status_code=201)
def create_voice(
    request: Request,
    name: str = Form(..., min_length=1, max_length=100),
    reference_text: str = Form("", max_length=2000),
    style_prompt: str = Form("", max_length=500),
    audio: UploadFile = File(...),
    db=Depends(get_db),
):
    try:
        data = audio.file.read(10 * 1024 * 1024 + 1)
        return request.app.state.speech_service.add_voice(
            db, name, reference_text, style_prompt, data
        )
    finally:
        audio.file.close()


@speech_router.get("/voices/{voice_id}/reference")
def reference_audio(voice_id: str, request: Request, db=Depends(get_db)):
    voice = find_voice(db, voice_id)
    path = request.app.state.speech_service.reference_path(voice.id)
    if not path.is_file():
        raise ServiceError("audio_missing", "参考音频文件不存在，请重新添加音色", 404)
    return FileResponse(path, media_type="audio/wav")


@speech_router.delete("/voices/{voice_id}")
def delete_voice(voice_id: str, request: Request, db=Depends(get_db)):
    service = request.app.state.speech_service
    with service.guard:
        voice = find_voice(db, voice_id)
        affected = service.delete_voice(db, voice)
    return {"deleted": True, "affected_conversations": affected}


@speech_router.post("/voices/{voice_id}/previews", response_model=SpeechJobRead, status_code=202)
def preview(voice_id: str, payload: SpeechPreview, request: Request, db=Depends(get_db)):
    service = request.app.state.speech_service
    with service.guard:
        voice = find_voice(db, voice_id)
        if not service.engine.status()["available"]:
            raise ServiceError("tts_not_ready", service.engine.status()["detail"], 503)
        return service.enqueue(db, voice, payload.text, payload.style_prompt)


@speech_router.get("/speech/jobs/{job_id}", response_model=SpeechJobRead)
def speech_job(job_id: str, db=Depends(get_db)):
    return find_job(db, job_id)


@speech_router.get(
    "/conversations/{conversation_id}/speech-feedback",
    response_model=SpeechFeedbackRead,
)
def feedback_status(conversation_id: str, request: Request, db=Depends(get_db)):
    service = request.app.state.speech_service
    with service.guard:
        conversation = find_local_conversation(db, conversation_id)
        voice = find_voice(db, conversation.voice_id)
        return service.feedback_jobs(db, conversation, voice)


@speech_router.post(
    "/conversations/{conversation_id}/speech-feedback",
    response_model=SpeechFeedbackRead,
    status_code=202,
)
def generate_feedback(conversation_id: str, request: Request, db=Depends(get_db)):
    service = request.app.state.speech_service
    with request.app.state.chat_service.conversation_guard(conversation_id), service.guard:
        conversation = find_local_conversation(db, conversation_id)
        if conversation.reply_mode == "text":
            raise ServiceError("voice_disabled", "请先为该会话选择语音回复及音色", 409)
        voice = find_voice(db, conversation.voice_id)
        return service.generate_feedback(db, conversation, voice)


@speech_router.post("/speech/jobs/{job_id}/retry", response_model=SpeechJobRead, status_code=202)
def retry_speech_job(job_id: str, request: Request, db=Depends(get_db)):
    service = request.app.state.speech_service
    with service.guard:
        job = find_job(db, job_id)
        if job.status != "failed" and (
            job.status != "completed" or service.audio_path(job.id).is_file()
        ):
            return job
        find_voice(db, job.voice_id)
        active = db.scalars(select(SpeechJob.id).where(SpeechJob.status.in_(ACTIVE))).all()
        if len(active) >= 8:
            raise ServiceError("speech_busy", "语音队列已满，请稍后手动重试", 409)
        job.status, job.error = "queued", None
        db.commit()
        service.executor.submit(service._run, job.id)
        return job


@speech_router.get("/speech/jobs", response_model=list[SpeechJobRead])
def recent_previews(db=Depends(get_db)):
    return db.scalars(
        select(SpeechJob)
        .where(SpeechJob.message_id.is_(None), SpeechJob.purpose == "speech")
        .order_by(SpeechJob.created_at.desc(), SpeechJob.id.desc())
        .limit(20)
    ).all()


@speech_router.get("/speech/jobs/{job_id}/audio")
def speech_audio(job_id: str, request: Request, db=Depends(get_db)):
    job = find_job(db, job_id)
    if job.status != "completed":
        raise ServiceError("audio_not_ready", "语音尚未生成成功，请查看任务状态", 409)
    path = request.app.state.speech_service.audio_path(job.id)
    if not path.is_file():
        raise ServiceError("audio_missing", "音频文件已丢失，请重新合成", 404)
    return FileResponse(path, media_type="audio/wav")


@speech_router.delete("/speech/jobs/{job_id}")
def delete_speech_job(job_id: str, request: Request, db=Depends(get_db)):
    service = request.app.state.speech_service
    with service.guard:
        job = find_job(db, job_id)
        if job.status in ACTIVE:
            raise ServiceError("speech_busy", "语音仍在生成，请完成后再删除", 409)
        if job.message_id:
            message = db.get(Message, job.message_id)
            if message and message.speech_job_id == job.id:
                message.speech_job_id = None
        db.delete(job)
        db.commit()
        service.audio_path(job.id).unlink(missing_ok=True)
    return {"deleted": True}


@speech_router.post(
    "/conversations/{conversation_id}/messages/{message_id}/speech",
    response_model=MessageSpeechRead,
    status_code=202,
)
def retry_message_speech(
    conversation_id: str, message_id: str, request: Request, db=Depends(get_db)
):
    chat, speech = request.app.state.chat_service, request.app.state.speech_service
    with chat.conversation_guard(conversation_id), speech.guard:
        conversation = find_local_conversation(db, conversation_id)
        message = db.get(Message, message_id)
        if not message or message.conversation_id != conversation.id:
            raise ServiceError("message_not_found", "该会话中不存在此条记录", 404)
        if message.status != "completed" or not message.assistant_text:
            raise ServiceError("message_not_ready", "请先完成文字回复", 409)
        voice = find_voice(db, conversation.voice_id)
        job = speech.enqueue(
            db, voice, message.assistant_text, conversation.voice_prompt or None, message
        )
        db.expire(message, ["speech_jobs"])
        return {
            **SpeechJobRead.model_validate(job).model_dump(),
            "speech_job_ids": message.speech_job_ids,
        }
