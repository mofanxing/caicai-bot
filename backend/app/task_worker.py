"""Run with: python -m app.task_worker (same cwd / settings as the API)."""

import argparse
import logging
import signal
import sys
import threading

from app.core.config import Settings
from app.core.errors import ServiceError
from app.db import create_session_factory
from app.migrations import initialize_database
from app.models import TaskAttempt
from app.tasks.process import ExecutionResult
from app.tasks.service import TaskService
from app.tasks.storage import file_lock, lock_path

logger = logging.getLogger(__name__)


class TaskWorker:
    def __init__(self, service):
        self.service = service
        self.stopping = threading.Event()

    def run_forever(self, on_ready=None):
        with file_lock(lock_path(self.service.settings, "worker"), blocking=False):
            self.service.recover()
            if on_ready:
                on_ready()
            while not self.stopping.is_set():
                if not self.run_once():
                    self.stopping.wait(self.service.settings.task_poll_seconds)

    def run_once(self):
        self.service.prune_history()
        claimed = self.service.claim()
        if not claimed:
            return False
        task, attempt = claimed
        executor = self.service.registry.resolve(task.agent_id)[2]

        def should_stop():
            if self.stopping.is_set():
                return "shutdown"
            with self.service.session_factory() as db:
                current = self.service.find(db, task.id)
                return "cancelled" if current.status == "cancelling" else None

        def on_started(pgid):
            with self.service.transaction() as db:
                db.get(TaskAttempt, attempt.id).process_group = pgid

        try:
            status = self.service.ensure_available(executor)
            with self.service.transaction() as db:
                db.get(TaskAttempt, attempt.id).executor_version = status["version"]
            stop = should_stop()
            if stop:
                result = ExecutionResult(
                    "cancelled" if stop == "cancelled" else "interrupted", stop
                )
            else:
                result = executor.run(
                    task,
                    on_started,
                    lambda kind, payload: self.service.record(task.id, attempt.id, kind, payload),
                    should_stop,
                )
        except ServiceError as exc:
            result = ExecutionResult("failed", exc.code)
        except Exception:
            # An adapter error may occur after launch; it is never safe to auto-replay.
            logger.warning("Task adapter failed: task=%s", task.id)
            result = ExecutionResult("interrupted", "adapter_error")
        with self.service.transaction() as db:
            current = self.service.find(db, task.id)
            running = db.get(TaskAttempt, attempt.id)
            self.service.finish(
                db, current, running, result.status, result.reason, result.summary, result.exit_code
            )
        return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--desktop-lease", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    engine, factory = create_session_factory(settings.database_url)
    initialize_database(engine)
    service = TaskService(settings, factory)
    worker = TaskWorker(service)
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: worker.stopping.set())
    if args.desktop_lease:

        def watch_parent():
            try:
                while sys.stdin.buffer.read(1):
                    pass
            finally:
                worker.stopping.set()

        threading.Thread(target=watch_parent, daemon=True, name="task-worker-lease").start()
    try:
        worker.run_forever(
            (lambda: print("CAICAI_WORKER_READY", flush=True)) if args.desktop_lease else None
        )
    except ServiceError as exc:
        if args.desktop_lease:
            print(
                "CAICAI_WORKER_EXTERNAL"
                if exc.code == "worker_already_running"
                else "CAICAI_WORKER_FAILED",
                flush=True,
            )
            return 0 if exc.code == "worker_already_running" else 1
        print(f"任务 worker 未启动：{exc.code} — {exc.message}")
        return 1
    finally:
        engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
