import hashlib
import json
from contextlib import contextmanager
from datetime import timedelta

from sqlalchemy import and_, delete, select

from app.core.errors import ServiceError
from app.models import (
    Conversation,
    PluginConfig,
    Task,
    TaskArtifact,
    TaskAttempt,
    TaskEvent,
    TaskProject,
    new_id,
    utc_now,
)
from app.tasks.codex import CodexExecutor
from app.tasks.contracts import ACTIVE, TERMINAL, TaskRead
from app.tasks.deepseek import DeepSeekExecutor
from app.tasks.process import process_group_exists, project_root
from app.tasks.registry import CODING_MANIFEST, DEEPSEEK_MANIFEST, PluginRegistry
from app.tasks.storage import file_lock, lock_path


class TaskService:
    def __init__(self, settings, session_factory):
        self.settings = settings
        self.session_factory = session_factory
        self.registry = PluginRegistry(
            {"codex-cli": CodexExecutor(settings), "deepseek-harness": DeepSeekExecutor(settings)}
        )
        self.registry.register(CODING_MANIFEST)
        self.registry.register(DEEPSEEK_MANIFEST)

    @contextmanager
    def transaction(self):
        # A short cross-process mutex protects lifecycle changes and event sequence allocation.
        # No model calls or process waits are performed while holding this lock.
        with file_lock(lock_path(self.settings, "tasks")):
            with self.session_factory.begin() as db:
                yield db

    def event(self, db, task, kind, payload, attempt=None):
        task.event_seq += 1
        task.updated_at = utc_now()
        db.add(
            TaskEvent(
                task_id=task.id,
                attempt_id=attempt.id if attempt else None,
                seq=task.event_seq,
                type=kind,
                payload=payload,
            )
        )

    def find(self, db, task_id):
        task = db.get(Task, task_id)
        if not task:
            raise ServiceError("task_not_found", "任务不存在", 404)
        return task

    def present(self, db, task):
        step = {"queued": "等待 worker 领取", "cancelling": "正在停止执行进程"}.get(task.status)
        if task.status in ACTIVE and not step:
            recent = db.scalars(
                select(TaskEvent)
                .where(TaskEvent.task_id == task.id)
                .order_by(TaskEvent.seq.desc())
                .limit(20)
            )
            for event in recent:
                payload = event.payload
                if payload.get("kind") in {"tool_call", "tool_result"}:
                    step = (
                        "正在执行：" if payload["kind"] == "tool_call" else "工具已返回："
                    ) + str(payload.get("command") or payload.get("tool") or "工具调用")[:200]
                    break
                if payload.get("kind") in {"agent_message", "caicai_report"}:
                    step = str(payload.get("message", ""))[:200]
                    break
        return TaskRead.model_validate(task).model_copy(update={"current_step": step})

    def plugins(self):
        with self.session_factory() as db:
            result = []
            for manifest in self.registry.plugins.values():
                config = db.get(PluginConfig, manifest.id)
                executor = self.registry.resolve(f"{manifest.id}/{manifest.agents[0].id}")[2]
                result.append(
                    {
                        "manifest": manifest.model_dump(mode="json"),
                        "enabled": bool(config and config.enabled),
                        "executor": {
                            "id": executor.id,
                            "capabilities": sorted(executor.capabilities),
                            "limitations": executor.limitations,
                            **executor.check_availability(),
                        },
                    }
                )
            return result

    def enable(self, plugin_id, enabled):
        if plugin_id not in self.registry.plugins:
            raise ServiceError("plugin_not_found", "插件未注册", 404)
        manifest = self.registry.plugins[plugin_id]
        if enabled:
            for agent in manifest.agents:
                self.ensure_available(self.registry.executors[agent.executor_id])
        with self.transaction() as db:
            config = db.get(PluginConfig, plugin_id)
            if not config:
                config = PluginConfig(id=plugin_id)
                db.add(config)
            config.enabled = enabled
        return {"id": plugin_id, "enabled": enabled}

    def ensure_available(self, executor):
        status = executor.check_availability()
        if not status["ready"]:
            raise ServiceError(status["code"], status["message"], 503)
        return status

    def register_project(self, payload):
        root = str(project_root(payload.root))
        with self.transaction() as db:
            project = db.scalar(select(TaskProject).where(TaskProject.root == root))
            if not project:
                project = TaskProject(id=new_id(), root=root, name=payload.name)
                db.add(project)
                db.flush()
            else:
                project.registered, project.name = True, payload.name
        return project

    def unregister_project(self, project_id):
        with self.transaction() as db:
            project = db.get(TaskProject, project_id)
            if not project or not project.registered:
                raise ServiceError("project_not_found", "项目尚未登记", 404)
            if db.scalar(
                select(Task.id)
                .where(Task.project_id == project_id, Task.status.in_(ACTIVE | {"queued"}))
                .limit(1)
            ):
                raise ServiceError("project_busy", "项目仍有待执行任务，请先取消或等待完成", 409)
            project.registered = False
        return {"deleted": True}

    @staticmethod
    def expired_history():
        # Later reports do not extend retention. Keep interruptions until reviewed.
        finished = select(TaskEvent.id).where(
            TaskEvent.task_id == Task.id,
            TaskEvent.type == "task.finished",
            TaskEvent.occurred_at < utc_now() - timedelta(days=5),
        )
        return and_(
            Task.status.in_(TERMINAL),
            (Task.status != "interrupted")
            | Task.reason.is_not_distinct_from("interruption_acknowledged"),
            finished.exists(),
        )

    def prune_history(self):
        with self.transaction() as db:
            ids = db.scalars(select(Task.id).where(self.expired_history())).all()
            if ids:
                for model in (TaskArtifact, TaskEvent, TaskAttempt, Task):
                    key = model.id if model is Task else model.task_id
                    db.execute(delete(model).where(key.in_(ids)))
        return len(ids)

    def _existing(self, db, payload, fingerprint):
        task = db.scalar(
            select(Task).where(
                Task.conversation_scope == payload.conversation_id,
                Task.idempotency_key == payload.idempotency_key,
            )
        )
        if task and task.input_hash != fingerprint:
            raise ServiceError("idempotency_conflict", "同一幂等键不能用于不同任务参数", 409)
        return task

    def create(self, payload):
        fingerprint = hashlib.sha256(
            json.dumps(
                payload.model_dump(exclude={"idempotency_key"}),
                sort_keys=True,
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        with self.session_factory() as db:
            existing = self._existing(db, payload, fingerprint)
            if existing:
                return existing
        manifest, agent, executor = self.registry.resolve(payload.agent_id)
        # Availability can involve subprocesses, so check outside the storage mutex.
        self.ensure_available(executor)
        with self.transaction() as db:
            existing = self._existing(db, payload, fingerprint)
            if existing:
                return existing
            conversation = db.get(Conversation, payload.conversation_id)
            if not conversation:
                raise ServiceError("conversation_not_found", "会话不存在", 404)
            if conversation.channel not in {"desktop", "debug"}:
                raise ServiceError("wrong_channel", "首版任务仅支持本地会话", 409)
            config = db.get(PluginConfig, manifest.id)
            if not config or not config.enabled:
                raise ServiceError("plugin_disabled", "请先启用编程插件", 409)
            project = db.get(TaskProject, payload.project_id)
            if not project or not project.registered:
                raise ServiceError("project_not_found", "项目尚未登记", 404)
            if str(executor.validate_project(project.root)) != project.root:
                raise ServiceError("project_changed", "登记项目目录已改变", 409)
            self.ensure_no_unreviewed_interruption(db)
            task = Task(
                id=new_id(),
                conversation_id=conversation.id,
                conversation_scope=conversation.id,
                idempotency_key=payload.idempotency_key,
                input_hash=fingerprint,
                project_id=project.id,
                project_root=project.root,
                goal=payload.goal,
                agent_id=payload.agent_id,
                plugin_version=manifest.version,
                status="queued",
                timeout_seconds=payload.timeout_seconds,
                event_seq=0,
            )
            db.add(task)
            db.flush()
            self.event(db, task, "task.queued", {"message": "任务已排队"})
        return task

    def ensure_no_unreviewed_interruption(self, db):
        if db.scalar(
            select(Task.id)
            .where(
                Task.status == "interrupted",
                Task.reason != "interruption_acknowledged",
            )
            .limit(1)
        ):
            raise ServiceError(
                "interrupted_run_unreviewed", "存在中断任务，请核查执行进程后解除阻塞", 409
            )

    def cancel(self, task_id):
        with self.transaction() as db:
            task = self.find(db, task_id)
            if task.status in TERMINAL or task.status == "cancelling":
                return task
            if task.status == "queued":
                task.status, task.reason = "cancelled", "cancelled"
                self.event(
                    db, task, "task.finished", {"status": "cancelled", "reason": "cancelled"}
                )
            else:
                task.status = "cancelling"
                attempt = db.scalar(
                    select(TaskAttempt).where(
                        TaskAttempt.task_id == task.id,
                        TaskAttempt.status.in_(ACTIVE),
                    )
                )
                self.event(
                    db, task, "cancellation.requested", {"message": "正在停止执行进程"}, attempt
                )
        return task

    def acknowledge_interruption(self, task_id):
        with self.transaction() as db:
            task = self.find(db, task_id)
            if task.status != "interrupted":
                raise ServiceError("invalid_task_state", "只有中断任务可以核查", 409)
            attempts = db.scalars(select(TaskAttempt).where(TaskAttempt.task_id == task.id)).all()
            if any(process_group_exists(attempt.process_group) for attempt in attempts):
                raise ServiceError(
                    "execution_still_present", "记录的执行进程组仍存在，请先核查并停止", 409
                )
            if task.reason != "interruption_acknowledged":
                task.reason = "interruption_acknowledged"
                self.event(
                    db, task, "progress", {"message": "管理员已确认没有遗留执行，允许后续派发"}
                )
        return task

    def recover(self):
        # Called only by the exclusive worker, never by API startup.
        with self.transaction() as db:
            for task in db.scalars(select(Task).where(Task.status.in_(ACTIVE))):
                attempt = db.scalar(
                    select(TaskAttempt).where(
                        TaskAttempt.task_id == task.id,
                        TaskAttempt.status.in_(ACTIVE),
                    )
                )
                self.finish(db, task, attempt, "interrupted", "worker_lost", None, None)

    def claim(self):
        with self.transaction() as db:
            try:
                self.ensure_no_unreviewed_interruption(db)
            except ServiceError:
                return None
            if db.scalar(select(Task.id).where(Task.status.in_(ACTIVE)).limit(1)):
                return None
            task = db.scalar(
                select(Task)
                .where(Task.status == "queued")
                .order_by(
                    Task.created_at,
                    Task.id,
                )
                .limit(1)
            )
            if not task:
                return None
            manifest, agent, executor = self.registry.resolve(task.agent_id)
            config = db.get(PluginConfig, manifest.id)
            if not config or not config.enabled or manifest.version != task.plugin_version:
                self.finish(db, task, None, "failed", "plugin_unavailable", None, None)
                return None
            task.status = "running"
            attempt = TaskAttempt(
                id=new_id(),
                task_id=task.id,
                number=1,
                executor_id=agent.executor_id,
                executor_version="pending_check",
                status="running",
            )
            db.add(attempt)
            db.flush()
            self.event(db, task, "attempt.started", {"message": "worker 已领取任务"}, attempt)
        return task, attempt

    def finish(self, db, task, attempt, status, reason, summary, exit_code):
        if task.status in TERMINAL:
            return
        task.status, task.reason, task.result = status, reason, summary
        if attempt:
            attempt.status, attempt.reason = status, reason
            attempt.finished_at, attempt.exit_code = utc_now(), exit_code
            self.event(db, task, "attempt.finished", {"status": status, "reason": reason}, attempt)
        self.event(db, task, "task.finished", {"status": status, "reason": reason}, attempt)

    def record(self, task_id, attempt_id, kind, payload):
        with self.transaction() as db:
            task = self.find(db, task_id)
            attempt = db.get(TaskAttempt, attempt_id)
            if task.status in TERMINAL or not attempt or attempt.status in TERMINAL:
                return
            if kind == "run_reference":
                attempt.run_ref = payload["run_ref"]
                return
            if task.event_seq >= 10000:
                raise ServiceError("task_event_limit", "执行事件过多，已停止任务", 409)
            if kind == "artifact.created":
                db.add(TaskArtifact(task_id=task.id, attempt_id=attempt.id, **payload))
            self.event(db, task, kind, payload, attempt)
