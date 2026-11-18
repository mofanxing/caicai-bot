"""Desktop API's owned worker, with an EOF lease independent of GUI windows."""

import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

from sqlalchemy.engine import make_url

from app.core.errors import ServiceError
from app.tasks.storage import file_lock, lock_path


class TaskWorkerHost:
    def __init__(self, settings):
        self.settings = settings
        self.process = None
        self.mode = "unmanaged"
        self.state = "stopped"

    def start(self):
        url = make_url(self.settings.database_url)
        if url.get_backend_name() == "sqlite" and url.database and url.database != ":memory:":
            url = url.set(database=str(Path(url.database).resolve()))
        env = {
            **os.environ,
            "DATABASE_URL": url.render_as_string(hide_password=False),
            "PYTHONUNBUFFERED": "1",
            "ADMIN_TOKEN": self.settings.admin_token.get_secret_value(),
            "APP_ENV": self.settings.app_env,
            "CODEX_BINARY": self.settings.codex_binary,
            "DEEPSEEK_BINARY": self.settings.deepseek_binary,
            "DEEPSEEK_HOME": self.settings.deepseek_home,
            "DEEPSEEK_MODEL_PROFILE": self.settings.deepseek_model_profile,
            "TASK_POLL_SECONDS": str(self.settings.task_poll_seconds),
        }
        for name in ("PYTHONHOME", "PYTHONPATH", "ELECTRON_RUN_AS_NODE"):
            env.pop(name, None)
        self.process = subprocess.Popen(
            [sys.executable, "-m", "app.task_worker", "--desktop-lease"],
            cwd=Path(__file__).resolve().parents[2],
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        output = queue.Queue()
        process = self.process

        def read():
            # Only a fixed bounded startup line crosses this control channel.
            try:
                output.put(process.stdout.readline(128).strip())
            finally:
                process.stdout.close()

        threading.Thread(target=read, daemon=True, name="task-worker-startup").start()
        try:
            line = output.get(timeout=8)
        except queue.Empty:
            self.state = "failed"
            self.close()
            return
        if line == b"CAICAI_WORKER_READY":
            self.mode, self.state = "managed", "running"
        elif line == b"CAICAI_WORKER_EXTERNAL":
            self.process.wait(timeout=3)
            self.process.stdin.close()
            self.process = None
            self.mode, self.state = "external", "running"
        else:
            self.state = "failed"
            self.close()

    def status(self):
        if self.mode == "managed":
            if self.process and self.process.poll() is None:
                return {"mode": "managed", "state": "running"}
            return {"mode": "managed", "state": "failed"}
        try:
            with file_lock(lock_path(self.settings, "worker"), blocking=False):
                return {
                    "mode": self.mode,
                    "state": "failed" if self.state == "failed" else "stopped",
                }
        except ServiceError as exc:
            if exc.code == "worker_already_running":
                return {"mode": "external", "state": "running"}
            return {"mode": self.mode, "state": "unavailable"}

    def close(self):
        process = self.process
        if not process:
            return
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            # Preserve interrupted-run evidence; never kill an unowned/shared worker.
            process.terminate()
            try:
                process.wait(timeout=7)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        self.process = None
        if self.state != "failed":
            self.state = "stopped"
