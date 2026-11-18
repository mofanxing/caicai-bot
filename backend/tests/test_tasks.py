import copy
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from conftest import TOKEN
from pydantic import ValidationError
from sqlalchemy import select

from app.models import Task, TaskAttempt
from app.task_worker import TaskWorker
from app.tasks.codex import process_group_exists
from app.tasks.contracts import ProjectCreate, TaskCreate
from app.tasks.registry import CODING_MANIFEST, PluginRegistry
from app.tasks.storage import file_lock, lock_path

HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# A real subprocess fixture, not a real model: exercises framing, file changes,
# stdout closure, exit statuses, process group cancellation and secret filtering.
CLI_FIXTURE = r"""
import json, os, signal, subprocess, sys, time
from pathlib import Path
args = sys.argv[1:]
if args == ["--version"]:
    print("codex-cli 0.169.0-alpha.11.1")
    sys.exit(0)
if args == ["exec", "--help"]:
    print("--json --sandbox --ignore-user-config --ephemeral")
    sys.exit(0)
if args == ["login", "status"]:
    sys.exit(0)
assert "--dangerously-bypass-approvals-and-sandbox" not in args
assert args[args.index("--sandbox") + 1] == "workspace-write"
assert 'approval_policy="never"' in args
assert "sandbox_workspace_write.network_access=false" in args
assert "ADMIN_TOKEN" not in os.environ
root = Path(args[args.index("--cd") + 1])
prompt = sys.stdin.read()
def emit(**event):
    print(json.dumps(event), flush=True)
emit(type="thread.started", thread_id="fixture-run-123")
if "malformed" in prompt:
    print("not-json", flush=True)
    time.sleep(60)
if "hang" in prompt:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    (root / "child.pid").write_text(str(child.pid))
    def stop(*_):
        child.terminate()
        child.wait()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    (root / "started").write_text(str(os.getpid()))
    time.sleep(60)
if "no-terminal" in prompt:
    sys.exit(0)
if "failure" in prompt:
    emit(type="turn.failed", error={"message": "sk-do-not-persist-raw-error"})
    sys.exit(1)
(root / "result.txt").write_text("verified fixture result")
emit(type="item.completed", item={"type": "command_execution", "command": "pytest -q",
    "exit_code": 0, "aggregated_output": "1 passed; Bearer private-canary sk-test-secret"})
emit(type="item.completed", item={"type": "file_change", "changes": [
    {"path": "result.txt", "kind": "add"}, {"path": "../outside.txt", "kind": "add"}]})
emit(type="item.completed", item={"type": "agent_message", "text": "Fixture finished"})
emit(type="turn.completed", usage={})
"""


@pytest.fixture
def tasks(client, tmp_path):
    binary = tmp_path / "codex-fixture"
    binary.write_text(f"#!{sys.executable}\n" + CLI_FIXTURE)
    binary.chmod(0o700)
    service = client.app.state.task_service
    service.settings.codex_binary = str(binary)
    root = tmp_path / "project"
    root.mkdir()
    (tmp_path / "outside.txt").write_text("outside")
    project = client.post(
        "/api/v1/projects", headers=HEADERS, json={"name": "验证项目", "root": str(root)}
    ).json()
    assert (
        client.put(
            "/api/v1/plugins/caicai.coding", headers=HEADERS, json={"enabled": True}
        ).status_code
        == 200
    )
    cid = client.post(
        "/api/v1/conversations",
        headers=HEADERS,
        json={
            "channel": "desktop",
            "account_id": "desktop",
            "peer_id": "tasks",
        },
    ).json()["id"]
    payload = {
        "project_id": project["id"],
        "conversation_id": cid,
        "goal": "check fixture",
        "idempotency_key": "first",
    }
    return service, TaskWorker(service), root, payload


def create(client, payload, **changes):
    response = client.post("/api/v1/tasks", headers=HEADERS, json={**payload, **changes})
    assert response.status_code == 201, response.text
    return response.json()


def detail(client, task_id):
    response = client.get(f"/api/v1/tasks/{task_id}", headers=HEADERS)
    assert response.status_code == 200
    return response.json()


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    pytest.fail("Timed out waiting for process state")


def test_real_subprocess_event_persistence_and_dedup(client, tasks):
    service, worker, root, payload = tasks
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(lambda _: service.create(TaskCreate(**payload)).id, range(4)))
    assert len(set(ids)) == 1
    task_id = ids[0]
    assert worker.run_once()
    assert not worker.run_once()
    result = detail(client, task_id)
    assert result["task"]["status"] == "succeeded"
    assert result["task"]["result"] == "Fixture finished"
    assert result["attempts"][0]["run_ref"] == "fixture-run-123"
    assert result["attempts"][0]["exit_code"] == 0
    assert result["artifacts"] == [
        {
            "id": result["artifacts"][0]["id"],
            "attempt_id": result["attempts"][0]["id"],
            "path": "result.txt",
            "kind": "add",
            "sha256": hashlib.sha256((root / "result.txt").read_bytes()).hexdigest(),
        }
    ]
    url = f"/api/v1/tasks/{task_id}/events"
    events = client.get(url, headers=HEADERS).json()
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert events[-1]["type"] == "task.finished"
    assert client.get(url + "?after=2&limit=2", headers=HEADERS).json() == events[2:4]
    assert "private-canary" not in json.dumps(events)
    assert "sk-test-secret" not in json.dumps(events)
    conflict = client.post("/api/v1/tasks", headers=HEADERS, json={**payload, "goal": "different"})
    assert conflict.status_code == 409
    service.enable("caicai.coding", False)
    assert create(client, payload)["id"] == task_id
    # Terminal state and events cannot be overwritten by late cancellation or output.
    assert (
        client.post(f"/api/v1/tasks/{task_id}/cancel", headers=HEADERS).json()["status"]
        == "succeeded"
    )
    service.record(task_id, result["attempts"][0]["id"], "progress", {"message": "late"})
    assert client.get(url, headers=HEADERS).json() == events
    # Conversation deletion preserves task audit history.
    assert (
        client.delete(
            f"/api/v1/conversations/{payload['conversation_id']}", headers=HEADERS
        ).status_code
        == 200
    )
    assert detail(client, task_id)["task"]["conversation_id"] is None


def test_queue_cancel_and_plugin_disabled_before_claim(client, tasks):
    service, worker, _, payload = tasks
    first = create(client, payload)
    second = create(client, payload, idempotency_key="second")
    assert (
        client.post(f"/api/v1/tasks/{first['id']}/cancel", headers=HEADERS).json()["status"]
        == "cancelled"
    )
    assert detail(client, first["id"])["attempts"] == []
    service.enable("caicai.coding", False)
    worker.run_once()
    assert detail(client, second["id"])["task"]["reason"] == "plugin_unavailable"


@pytest.mark.parametrize(
    "mode, expected, reason",
    [
        ("failure", "failed", "executor_failed"),
        ("no-terminal", "failed", "missing_terminal_event"),
        ("malformed", "interrupted", "adapter_error"),
    ],
)
def test_bad_executor_does_not_report_success(client, tasks, mode, expected, reason):
    _, worker, _, payload = tasks
    task = create(client, payload, goal=mode)
    worker.run_once()
    result = detail(client, task["id"])
    assert result["task"]["status"] == expected
    assert result["task"]["reason"] == reason
    assert "sk-do-not-persist" not in json.dumps(result)


@pytest.mark.parametrize("stop", ["cancel", "timeout", "shutdown"])
def test_stops_actual_process_group_and_chat_remains_available(client, tasks, stop):
    service, worker, root, payload = tasks
    task = create(client, payload, goal="hang")
    if stop == "timeout":
        # Exercise the real timer without adding ten seconds to every test run.
        with service.transaction() as db:
            db.get(Task, task["id"]).timeout_seconds = 1
    thread = threading.Thread(target=worker.run_once)
    thread.start()
    try:
        wait_for(lambda: (root / "started").exists())
        pid = int((root / "started").read_text())
        assert process_group_exists(pid)
        # Another worker cannot claim while this attempt runs.
        assert TaskWorker(service).run_once() is False
        second = create(client, payload, idempotency_key="second")
        response = client.post(
            f"/api/v1/desktop/conversations/{payload['conversation_id']}/messages",
            headers=HEADERS,
            json={"external_id": "chat-during-task", "text": "你好"},
        )
        assert response.status_code == 200
        if stop == "cancel":
            assert (
                client.post(f"/api/v1/tasks/{task['id']}/cancel", headers=HEADERS).json()["status"]
                == "cancelling"
            )
        elif stop == "shutdown":
            worker.stopping.set()
        thread.join(timeout=8)
        assert not thread.is_alive()
        assert not process_group_exists(pid)
        with pytest.raises(ProcessLookupError):
            os.kill(int((root / "child.pid").read_text()), 0)
        result = detail(client, task["id"])["task"]
        assert (
            result["status"]
            == {"cancel": "cancelled", "timeout": "failed", "shutdown": "interrupted"}[stop]
        )
        assert detail(client, second["id"])["task"]["status"] == "queued"
    finally:
        worker.stopping.set()
        thread.join(timeout=8)


def test_recovery_blocks_replay_and_requires_process_review(client, tasks):
    service, worker, _, payload = tasks
    task = create(client, payload)
    queued = create(client, payload, idempotency_key="second")
    claimed = service.claim()
    assert claimed[0].id == task["id"]
    service.recover()
    result = detail(client, task["id"])
    assert result["task"]["status"] == "interrupted"
    assert result["attempts"][0]["reason"] == "worker_lost"
    assert not worker.run_once()
    assert (
        client.post(
            "/api/v1/tasks", headers=HEADERS, json={**payload, "idempotency_key": "third"}
        ).status_code
        == 409
    )
    url = f"/api/v1/tasks/{task['id']}/acknowledge-interruption"
    assert client.post(url, headers=HEADERS, json={}).status_code == 422
    assert (
        client.post(url, headers=HEADERS, json={"confirm_no_running_process": True}).status_code
        == 200
    )
    worker.run_once()
    assert detail(client, queued["id"])["task"]["status"] == "succeeded"
    assert len(detail(client, task["id"])["attempts"]) == 1


def test_cannot_acknowledge_live_process_group(client, tasks):
    service, _, _, payload = tasks
    task = create(client, payload)
    _, attempt = service.claim()
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True
    )
    try:
        with service.transaction() as db:
            db.get(TaskAttempt, attempt.id).process_group = process.pid
        service.recover()
        response = client.post(
            f"/api/v1/tasks/{task['id']}/acknowledge-interruption",
            headers=HEADERS,
            json={"confirm_no_running_process": True},
        )
        assert response.status_code == 409
    finally:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def test_worker_exclusivity_in_separate_process(client, tasks):
    service, _, _, _ = tasks
    path = lock_path(service.settings, "worker")
    with file_lock(path):
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from pathlib import Path; from app.tasks.storage import file_lock; "
                "import sys;\nwith file_lock(Path(sys.argv[1]), blocking=False): pass",
                str(path),
            ],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            timeout=5,
        )
        assert result.returncode != 0
        assert b"ServiceError" in result.stderr
    with file_lock(path, blocking=False):
        pass


def test_standalone_worker_lifecycle_and_exclusive_launch(client, tasks):
    service, _, root, payload = tasks
    task = create(client, payload, goal="hang")
    env = {
        **os.environ,
        "DATABASE_URL": service.settings.database_url,
        "CODEX_BINARY": service.settings.codex_binary,
        "ADMIN_TOKEN": TOKEN,
        "APP_ENV": "test",
        "TASK_POLL_SECONDS": "0.05",
    }
    command = [sys.executable, "-m", "app.task_worker"]
    cwd = Path(__file__).resolve().parents[1]
    worker = subprocess.Popen(
        command, env=env, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        wait_for(lambda: (root / "started").exists())
        pid = int((root / "started").read_text())
        second = subprocess.run(command, env=env, cwd=cwd, capture_output=True, timeout=5)
        assert second.returncode == 1
        assert b"worker_already_running" in second.stdout
        worker.terminate()
        worker.communicate(timeout=8)
        assert worker.returncode == 0
        assert not process_group_exists(pid)
        assert detail(client, task["id"])["task"]["status"] == "interrupted"
    finally:
        if worker.poll() is None:
            worker.terminate()
        worker.communicate(timeout=8)


def test_completion_wins_late_cancellation(client, tasks, monkeypatch):
    service, worker, _, payload = tasks
    task = create(client, payload)
    original = service.record

    def record(task_id, attempt_id, kind, value):
        original(task_id, attempt_id, kind, value)
        if value.get("kind") == "agent_message":
            time.sleep(0.1)  # CLI has exited; final JSON may still be buffered.
            service.cancel(task_id)

    monkeypatch.setattr(service, "record", record)
    worker.run_once()
    assert detail(client, task["id"])["task"]["status"] == "succeeded"


@pytest.mark.parametrize(
    "output, code, expected",
    [
        ("codex-cli 0.169.0-alpha.11.1", 1, "codex_not_authenticated"),
        ("codex-cli 0.200.0", 0, "codex_version_unsupported"),
    ],
)
def test_executor_auth_and_version_checks(client, tmp_path, output, code, expected):
    binary = tmp_path / "unavailable-cli"
    binary.write_text(
        f"#!{sys.executable}\nimport sys\n"
        f"print({output!r} if '--version' in sys.argv else "
        "'--json --sandbox --ignore-user-config --ephemeral')\n"
        f"sys.exit({code} if 'login' in sys.argv else 0)\n"
    )
    binary.chmod(0o700)
    service = client.app.state.task_service
    service.settings.codex_binary = str(binary)
    response = client.put("/api/v1/plugins/caicai.coding", headers=HEADERS, json={"enabled": True})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == expected


def test_validation_auth_and_unavailable_executor(client, tasks, tmp_path):
    service, _, root, payload = tasks
    for url in ("plugins", "projects", "tasks", "tasks/unknown", "tasks/unknown/events"):
        assert client.get(f"/api/v1/{url}").status_code == 401
    assert client.post("/api/v1/tasks", json=payload).status_code == 401
    assert (
        client.post(
            "/api/v1/projects", headers=HEADERS, json={"name": "bad", "root": "."}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/projects", headers=HEADERS, json={"name": "bad", "root": "/"}
        ).status_code
        == 422
    )
    link = tmp_path / "project-link"
    link.symlink_to(root)
    assert service.register_project(ProjectCreate(name="alias", root=str(link))).root == str(root)
    (root / ".codex").mkdir()
    (root / ".codex/config.toml").write_text("[mcp_servers]")
    assert client.post("/api/v1/tasks", headers=HEADERS, json=payload).status_code == 422
    (root / ".codex/config.toml").unlink()
    service.settings.codex_binary = str(tmp_path / "missing-codex")
    response = client.post("/api/v1/tasks", headers=HEADERS, json=payload)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "codex_missing"
    assert client.get("/api/v1/plugins", headers=HEADERS).json()[0]["executor"]["ready"] is False


@pytest.mark.parametrize("mutation", ["version", "duplicate", "capability", "executor", "schema"])
def test_registry_rejects_unsupported_declarations(client, mutation):
    executors = client.app.state.task_service.registry.executors
    registry = PluginRegistry(executors)
    declaration = copy.deepcopy(CODING_MANIFEST)
    if mutation == "version":
        declaration["contract_version"] = 2
    elif mutation == "duplicate":
        declaration["agents"].append(copy.deepcopy(declaration["agents"][0]))
    elif mutation == "capability":
        declaration["agents"][0]["required_capabilities"].append("run.resume")
    elif mutation == "executor":
        declaration["agents"][0]["executor_id"] = "missing"
    elif mutation == "schema":
        declaration["agents"][0]["input_schema"] = {"type": "object"}
    with pytest.raises((ValueError, ValidationError)):
        registry.register(declaration)
    assert registry.plugins == {}
    assert registry.agents == {}


def test_existing_database_migration_is_additive_and_idempotent(client):
    from app.migrations import initialize_database

    service = client.app.state.task_service
    engine = service.session_factory.kw["bind"]
    initialize_database(engine)
    initialize_database(engine)
    with service.session_factory() as db:
        assert db.scalars(select(Task)).all() == []
