import io
import logging
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy import or_, select, update

from app.core.errors import ServiceError
from app.integrations.local_speech import LocalSpeechEngine
from app.models import Conversation, Message, SpeechJob, Voice, new_id
from app.services.speech_text import speech_boundary

logger = logging.getLogger(__name__)
ACTIVE = ("queued", "running")


class SpeechService:
    def __init__(self, settings):
        self.settings = settings
        self.engine = LocalSpeechEngine(settings)
        self.root = Path(settings.speech_data_dir).resolve()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-tts")
        self.session_factory = None
        self.guard = threading.RLock()
        self.closing = False

    def start(self, session_factory):
        self.session_factory = session_factory
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with session_factory() as db:
            linked = set()
            for thinking, waiting in db.execute(
                select(Conversation.feedback_thinking_job_id, Conversation.feedback_waiting_job_id)
            ):
                linked.update(job_id for job_id in (thinking, waiting) if job_id)
            for job in db.scalars(select(SpeechJob).where(SpeechJob.purpose == "feedback")):
                if job.id not in linked:
                    self.audio_path(job.id).unlink(missing_ok=True)
                    self.audio_path(job.id).with_suffix(".tmp.wav").unlink(missing_ok=True)
                    db.delete(job)
            db.execute(
                update(SpeechJob)
                .where(SpeechJob.status == "running")
                .values(status="failed", error="服务上次退出时合成中断，请手动重试")
            )
            queued = db.scalars(
                select(SpeechJob.id)
                .where(SpeechJob.status == "queued")
                .order_by(SpeechJob.created_at, SpeechJob.id)
            ).all()
            db.commit()
        for job_id in queued:
            self.executor.submit(self._run, job_id)

    def close(self):
        self.closing = True
        self.engine.shutdown()
        self.executor.shutdown(wait=True, cancel_futures=True)

    def reference_path(self, voice_id):
        return self.root / "voices" / f"{voice_id}.wav"

    def audio_path(self, job_id):
        return self.root / "audio" / f"{job_id}.wav"

    def add_voice(self, db, name, reference_text, style_prompt, audio):
        if (
            not name.strip()
            or len(name) > 100
            or len(reference_text) > 2000
            or len(style_prompt) > 500
        ):
            raise ServiceError("invalid_voice", "请检查音色名称、参考文字和语气指令长度", 422)
        if len(audio) > 10 * 1024 * 1024:
            raise ServiceError("audio_too_large", "参考音频不能超过 10 MB", 413)
        try:
            with wave.open(io.BytesIO(audio), "rb") as source:
                if (
                    source.getcomptype() != "NONE"
                    or source.getsampwidth() != 2
                    or source.getnchannels() not in (1, 2)
                    or not 8000 <= source.getframerate() <= 48000
                ):
                    raise ValueError("Expected 16-bit PCM WAV")
                duration = source.getnframes() / source.getframerate()
                if not 3 <= duration <= 30:
                    raise ServiceError(
                        "invalid_audio_duration", "请上传 3～30 秒的清晰参考录音", 422
                    )
                expected = source.getnframes() * source.getsampwidth() * source.getnchannels()
                pcm = source.readframes(source.getnframes())
                if len(pcm) != expected or not any(pcm):
                    raise ValueError("Truncated or silent audio")
        except (wave.Error, EOFError, ValueError) as exc:
            raise ServiceError(
                "invalid_audio", "音频无效，请上传完整、非静音的 16-bit PCM WAV 录音", 422
            ) from exc
        voice = Voice(
            id=new_id(),
            name=name.strip(),
            reference_text=reference_text.strip(),
            style_prompt=style_prompt.strip(),
            duration_seconds=round(duration, 3),
        )
        path = self.reference_path(voice.id)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            path.write_bytes(audio)
            path.chmod(0o600)
            db.add(voice)
            db.commit()
        except Exception:
            db.rollback()
            path.unlink(missing_ok=True)
            raise
        return voice

    def enqueue(self, db, voice, text, style_prompt=None, message=None, *, segment=False):
        with self.guard:
            if message and message.speech_job_id and not segment:
                previous = db.get(SpeechJob, message.speech_job_id)
                if (
                    previous
                    and previous.status != "failed"
                    and (previous.status != "completed" or self.audio_path(previous.id).is_file())
                ):
                    return previous
            if message and not segment and len(text) > 120 and text.strip():
                # Persist independently playable jobs for manual/non-streaming reads too.
                # All segments of this message share one queue admission slot.
                first_job = None
                pending = text
                while pending:
                    cut = speech_boundary(pending, first=first_job is None) or len(pending)
                    part, pending = pending[:cut], pending[cut:]
                    if not part.strip():
                        continue
                    job = self.enqueue(db, voice, part, style_prompt, message, segment=True)
                    if first_job is None:
                        first_job = job
                        message.speech_job_id = job.id
                        db.commit()
                return first_job
            job = SpeechJob(
                id=new_id(),
                voice_id=voice.id,
                message_id=message.id if message else None,
                text=text,
                style_prompt=voice.style_prompt if style_prompt is None else style_prompt,
                status="queued",
            )
            if (
                len(
                    db.scalars(
                        select(SpeechJob.id).where(
                            SpeechJob.status.in_(ACTIVE),
                            SpeechJob.purpose != "feedback",
                            or_(SpeechJob.message_id.is_(None), SpeechJob.message_id != message.id)
                            if segment and message
                            else True,
                        )
                    ).all()
                )
                >= 8
            ):
                job.status, job.error = "failed", "语音队列已满，请稍后手动重试"
            db.add(job)
            if message and (not segment or not message.speech_job_id):
                message.speech_job_id = job.id
            db.commit()
            if job.status == "queued":
                self.executor.submit(self._run, job.id)
            return job

    def feedback_jobs(self, db, conversation, voice):
        """Read only: configuration changes never start synthesis implicitly."""
        prompt = conversation.voice_prompt or voice.style_prompt
        jobs = {}
        for phase in ("thinking", "waiting"):
            job_id = getattr(conversation, f"feedback_{phase}_job_id")
            job = db.get(SpeechJob, job_id) if job_id else None
            if job and (
                job.purpose != "feedback"
                or job.voice_id != voice.id
                or job.style_prompt != prompt
                or job.text != getattr(conversation, f"feedback_{phase}_text")
                or (job.status == "completed" and not self.audio_path(job.id).is_file())
            ):
                job = None
            jobs[phase] = job
        return {"voice_id": voice.id, "style_prompt": prompt, **jobs}

    def ensure_feedback_idle(self, db, conversation):
        jobs = [
            db.get(SpeechJob, job_id)
            for job_id in (
                conversation.feedback_thinking_job_id,
                conversation.feedback_waiting_job_id,
            )
            if job_id
        ]
        jobs = [job for job in jobs if job and job.purpose == "feedback"]
        if any(job.status in ACTIVE for job in jobs):
            raise ServiceError("speech_busy", "提示语音仍在生成，请完成后再操作", 409)
        return jobs

    def clear_feedback(self, db, conversation):
        jobs = self.ensure_feedback_idle(db, conversation)
        for job in jobs:
            self.audio_path(job.id).unlink(missing_ok=True)
            self.audio_path(job.id).with_suffix(".tmp.wav").unlink(missing_ok=True)
            db.delete(job)
        conversation.feedback_thinking_job_id = None
        conversation.feedback_waiting_job_id = None
        db.flush()

    def generate_feedback(self, db, conversation, voice):
        """Replace this conversation's two clips only on an explicit generation request."""
        with self.guard:
            status = self.engine.status()
            if not status["available"]:
                raise ServiceError("tts_not_ready", status["detail"], 503)
            active = db.scalars(select(SpeechJob.id).where(SpeechJob.status.in_(ACTIVE))).all()
            if len(active) + 2 > 8:
                raise ServiceError("speech_busy", "语音队列已满，请稍后重新生成提示语音", 409)
            self.clear_feedback(db, conversation)
            jobs = {}
            for phase in ("thinking", "waiting"):
                job = SpeechJob(
                    id=new_id(),
                    voice_id=voice.id,
                    purpose="feedback",
                    text=getattr(conversation, f"feedback_{phase}_text"),
                    style_prompt=conversation.voice_prompt or voice.style_prompt,
                    status="queued",
                )
                db.add(job)
                setattr(conversation, f"feedback_{phase}_job_id", job.id)
                jobs[phase] = job
            db.commit()
            for job in jobs.values():
                self.executor.submit(self._run, job.id)
            return {
                "voice_id": voice.id,
                "style_prompt": conversation.voice_prompt or voice.style_prompt,
                **jobs,
            }

    def _run(self, job_id):
        with self.session_factory() as db:
            with self.guard:
                job = db.get(SpeechJob, job_id)
                if self.closing or not job or job.status != "queued":
                    return
                if job.purpose == "feedback" and db.scalar(
                    select(SpeechJob.id)
                    .where(SpeechJob.status == "queued", SpeechJob.purpose != "feedback")
                    .limit(1)
                ):
                    # Normal replies may jump ahead of queued cache warming, never interrupt
                    # an inference already running inside the shared local engine.
                    self.executor.submit(self._run, job.id)
                    return
                job.status = "running"
                db.commit()
                reference = self.reference_path(job.voice_id)
                destination = self.audio_path(job.id)
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                # Anchor every segment of one reply to its first completed clip.
                # Never borrow another reply, voice, prompt, or a failed clip.
                continuation = None
                message = db.get(Message, job.message_id) if job.message_id else None
                anchor = (
                    db.get(SpeechJob, message.speech_job_id)
                    if message and message.speech_job_id != job.id
                    else None
                )
                if (
                    anchor
                    and anchor.message_id == job.message_id
                    and anchor.voice_id == job.voice_id
                    and anchor.style_prompt == job.style_prompt
                    and anchor.purpose == job.purpose == "speech"
                    and anchor.status == "completed"
                    and len(anchor.text) <= 120
                    and 0 < (anchor.duration_seconds or 0) <= 30
                    and self.audio_path(anchor.id).is_file()
                ):
                    continuation = {
                        "text": anchor.text,
                        "audio_path": str(self.audio_path(anchor.id)),
                    }
            try:
                args = (job.text, reference, job.style_prompt, destination)
                result = (
                    self.engine.synthesize(*args, continuation)
                    if continuation
                    else self.engine.synthesize(*args)
                )
                with wave.open(str(destination), "rb") as output:
                    if output.getnframes() <= 0:
                        raise ValueError("Empty audio")
                destination.chmod(0o600)
                job.status = "completed"
                job.duration_seconds = result["duration_seconds"]
                job.generation_seconds = result["generation_seconds"]
            except ServiceError as exc:
                job.status, job.error = "failed", exc.message
            except Exception:
                logger.warning("Local speech job failed: id=%s", job.id)
                job.status, job.error = "failed", "本地语音合成异常，请检查环境后手动重试"
            if job.status == "failed":
                destination.unlink(missing_ok=True)
                destination.with_suffix(".tmp.wav").unlink(missing_ok=True)
            db.commit()

    def clear_message_audio(self, db, conversation_id, message_id=None):
        messages = select(Message.id).where(Message.conversation_id == conversation_id)
        if message_id:
            messages = messages.where(Message.id == message_id)
        jobs = db.scalars(select(SpeechJob).where(SpeechJob.message_id.in_(messages))).all()
        if any(job.status in ACTIVE for job in jobs):
            raise ServiceError("speech_busy", "相关语音仍在生成，请完成后再删除", 409)
        for job in jobs:
            self.audio_path(job.id).unlink(missing_ok=True)
            db.delete(job)
        db.flush()

    def delete_voice(self, db, voice):
        with self.guard:
            jobs = db.scalars(select(SpeechJob).where(SpeechJob.voice_id == voice.id)).all()
            if any(job.status in ACTIVE for job in jobs):
                raise ServiceError("speech_busy", "此音色仍有语音任务，请完成后再删除", 409)
            affected = db.execute(
                update(Conversation)
                .where(Conversation.voice_id == voice.id)
                .values(voice_id=None, voice_prompt="", reply_mode="text")
            ).rowcount
            ids = [job.id for job in jobs]
            if ids:
                db.execute(
                    update(Message).where(Message.speech_job_id.in_(ids)).values(speech_job_id=None)
                )
            db.delete(voice)
            db.commit()
            self.reference_path(voice.id).unlink(missing_ok=True)
            for job_id in ids:
                self.audio_path(job_id).unlink(missing_ok=True)
            return affected
