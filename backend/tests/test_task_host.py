from app.core.config import Settings
from app.tasks.host import TaskWorkerHost
from app.tasks.storage import file_lock, lock_path


def test_desktop_worker_lease_and_external_ownership(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", "isolated-worker-host")
    monkeypatch.setenv("APP_ENV", "test")
    settings = Settings(
        _env_file=None,
        admin_token="isolated-worker-host",
        database_url=f"sqlite:///{tmp_path / 'host.db'}",
    )
    host = TaskWorkerHost(settings)
    assert host.status()["state"] == "stopped"
    try:
        host.start()
        assert host.status() == {"mode": "managed", "state": "running"}
        process = host.process
        other = TaskWorkerHost(settings)
        try:
            other.start()
            assert other.process is None
            assert other.status() == {"mode": "external", "state": "running"}
        finally:
            other.close()
        assert process.poll() is None  # Closing a reuser never stops the actual owner.
        # Same EOF delivered by an API process crash; the worker exits without GUI cooperation.
        process.stdin.close()
        process.wait(timeout=8)
        assert host.status()["state"] == "failed"
    finally:
        host.close()
    with file_lock(lock_path(settings, "worker"), blocking=False):
        pass  # The exited process released the exclusive lock.


def test_worker_host_normal_shutdown_and_authenticated_status(client, tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", "isolated-worker-host")
    settings = Settings(
        _env_file=None,
        admin_token="isolated-worker-host",
        database_url=f"sqlite:///{tmp_path / 'shutdown.db'}",
    )
    host = TaskWorkerHost(settings)
    try:
        host.start()
        process = host.process
        assert process and process.poll() is None
    finally:
        host.close()
    assert process.poll() == 0
    assert client.get("/api/v1/task-runtime").status_code == 401
    from conftest import TOKEN

    assert (
        client.get("/api/v1/task-runtime", headers={"Authorization": f"Bearer {TOKEN}"}).json()[
            "state"
        ]
        == "stopped"
    )
