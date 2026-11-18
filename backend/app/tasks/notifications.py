"""One-shot task completion audio, independent of chat history."""

import logging
import threading
from datetime import timedelta

from sqlalchemy import and_, exists, or_, select

from app.core.errors import ServiceError
from app.models import Conversation, Message, SpeechJob, Task, TaskEvent, Voice, new_id, utc_now
from app.tasks.contracts import TERMINAL
from app.tasks.milestones import MAX_AGE
from app.tasks.milestones import PURPOSE as MILESTONE_PURPOSE
from app.tasks.process import safe_text

logger = logging.getLogger(__name__)
PURPOSE = "task_notification"
PURPOSES = {PURPOSE, MILESTONE_PURPOSE}


class TaskNotifications:
    def __init__(self, service, speech):
        self.service, self.speech = service, speech
        self.stopping = threading.Event()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.run, name="task-notifications", daemon=True)
        self.thread.start()

    def close(self):
        self.stopping.set()
        if self.thread:
            self.thread.join()

    def run(self):
        while not self.stopping.is_set():
            try:
                self.tick()
            except Exception:
                logger.exception("Task notification maintenance failed")
            self.stopping.wait(2)

    def tick(self):
        self.cleanup()
        self.service.prune_history()
        with self.service.session_factory() as db:
            ids = list(
                db.scalars(
                    select(Task.id)
                    .where(
                        Task.status.in_(TERMINAL),
                        Task.conversation_id.is_not(None),
                        ~exists().where(
                            TaskEvent.task_id == Task.id, TaskEvent.type == "notification.sent"
                        ),
                    )
                    .order_by(Task.updated_at, Task.id)
                    .limit(10)
                )
            )
        for task_id in ids:
            if self.stopping.is_set():
                break
            try:
                self.deliver(task_id)
            except Exception:
                logger.exception("Task notification failed: task=%s", task_id)

    def deliver(self, task_id):
        job_id = None
        # A durable marker prevents another broadcast after consumption or restart.
        with self.service.transaction() as db:
            task = self.service.find(db, task_id)
            if task.status not in TERMINAL or db.scalar(
                select(TaskEvent.id)
                .where(TaskEvent.task_id == task_id, TaskEvent.type == "notification.sent")
                .limit(1)
            ):
                return
            conversation = db.get(Conversation, task.conversation_id)
            if not conversation:
                return
            voice = db.get(Voice, conversation.voice_id) if conversation.voice_id else None
            if voice:
                labels = {
                    "succeeded": "已完成",
                    "failed": "执行失败",
                    "cancelled": "已取消",
                    "interrupted": "执行中断，请到任务中心核查",
                }
                text = safe_text(f"你的任务「{task.goal[:80]}」{labels[task.status]}。")
                job_id = new_id()
                db.add(
                    SpeechJob(
                        id=job_id,
                        purpose=PURPOSE,
                        voice_id=voice.id,
                        message_id=None,
                        text=text,
                        style_prompt=conversation.voice_prompt or voice.style_prompt,
                        status="queued",
                    )
                )
            self.service.event(db, task, "notification.sent", {"speech_job_id": job_id})
        if job_id:
            self.speech.executor.submit(self.speech._run, job_id)

    def pending(self, db):
        live_milestones = (
            select(TaskEvent.payload["speech_job_id"].as_string())
            .join(Task, Task.id == TaskEvent.task_id)
            .where(Task.status == "running", TaskEvent.payload["automatic"].as_boolean().is_(True))
        )
        return db.scalars(
            select(SpeechJob)
            .where(
                or_(
                    SpeechJob.purpose == PURPOSE,
                    and_(
                        SpeechJob.purpose == MILESTONE_PURPOSE,
                        SpeechJob.id.in_(live_milestones),
                        SpeechJob.created_at >= utc_now() - MAX_AGE,
                    ),
                ),
                SpeechJob.status.in_({"queued", "running", "completed"}),
                SpeechJob.created_at >= utc_now() - timedelta(days=5),
            )
            .order_by(SpeechJob.created_at, SpeechJob.id)
        ).all()

    def consume(self, job_id):
        with self.speech.guard, self.service.session_factory.begin() as db:
            job = db.get(SpeechJob, job_id)
            if job:
                if job.purpose not in PURPOSES:
                    raise ServiceError("notification_not_found", "完成通知不存在", 404)
                if job.status in {"queued", "running"}:
                    raise ServiceError("speech_busy", "完成语音仍在生成", 409)
                db.delete(job)
        # Also remove a leftover file when retrying after a lost HTTP response.
        self.speech.audio_path(job_id).unlink(missing_ok=True)
        self.speech.audio_path(job_id).with_suffix(".tmp.wav").unlink(missing_ok=True)
        return {"deleted": True}

    def cleanup(self):
        cutoff = utc_now() - timedelta(days=5)
        with self.speech.guard, self.service.session_factory.begin() as db:
            jobs = db.scalars(
                select(SpeechJob).where(
                    SpeechJob.purpose.in_(PURPOSES),
                    ~SpeechJob.status.in_({"queued", "running"}),
                    (SpeechJob.created_at < cutoff)
                    | (SpeechJob.status == "failed")
                    | (
                        (SpeechJob.purpose == MILESTONE_PURPOSE)
                        & (SpeechJob.created_at < utc_now() - MAX_AGE)
                    ),
                )
            ).all()
            for job in jobs:
                self.speech.audio_path(job.id).unlink(missing_ok=True)
                db.delete(job)
            # Remove reports produced by the previous chat-message implementation.
            for message in db.scalars(
                select(Message).where(Message.external_id.startswith("task-report:"))
            ):
                linked = db.scalars(
                    select(SpeechJob).where(SpeechJob.message_id == message.id)
                ).all()
                if any(job.status in {"queued", "running"} for job in linked):
                    continue
                for job in linked:
                    self.speech.audio_path(job.id).unlink(missing_ok=True)
                    db.delete(job)
                db.flush()
                db.delete(message)
