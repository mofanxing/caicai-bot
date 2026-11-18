import fcntl
import os
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy.engine import make_url

from app.core.errors import ServiceError


def lock_path(settings, kind):
    url = make_url(settings.database_url)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise ServiceError("task_storage_unsupported", "任务运行时需要文件型 SQLite 数据库", 503)
    path = Path(url.database).resolve()
    return path.with_name(path.name + f".{kind}.lock")


@contextmanager
def file_lock(path, *, blocking=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        os.fchmod(handle.fileno(), 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError as exc:
            raise ServiceError("worker_already_running", "该数据库已有任务 worker", 409) from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
