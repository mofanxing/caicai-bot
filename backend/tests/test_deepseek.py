"""Real child-process protocol fixtures; no model or user credentials needed."""

import json
import os
import subprocess
import sys
import threading
import time

import pytest
import yaml
from conftest import TOKEN

from app.core.config import Settings
from app.task_worker import TaskWorker
from app.tasks.contracts import TaskCreate
from app.tasks.deepseek import DeepSeekProjection
from app.tasks.process import process_group_exists

HEADERS = {"Authorization": f"Bearer {TOKEN}"}

DSH_FIXTURE = r"""
import json,os,signal,subprocess,sys,time
from pathlib import Path
args=sys.argv[1:]
if args==['--version']:
 print('0.2.2-rc.3');sys.exit(0)
if args==['headless','--help']:
 print('--json --permission-mode --approval-policy');sys.exit(0)
assert args[:2]==['--profile','headless']
assert args[args.index('--permission-mode')+1]=='workspace-write'
assert args[args.index('--approval-policy')+1]=='never'
assert '--session-id' not in args and '--add-dir' not in args
assert 'ADMIN_TOKEN' not in os.environ and 'OPENAI_API_KEY' not in os.environ
assert 'CAICAI_PROVIDER_KEY' not in os.environ and 'DSH_PERMISSION_MODE' not in os.environ
assert Path(args[args.index('--patch')+1]).is_file()
root=Path.cwd();prompt=sys.stdin.read()
def emit(**event): print(json.dumps(event),flush=True)
if 'malformed' in prompt:
 print('not-json',flush=True);time.sleep(60)
if 'startup-error' in prompt:
 emit(type='error',message='Bearer private-canary sk-error-secret');sys.exit(1)
emit(type='session',sessionId='session-fixture',cwd=str(root))
if 'hang' in prompt:
 child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
 (root/'child.pid').write_text(str(child.pid))
 def stop(*_):
  child.terminate();child.wait();sys.exit(0)
 signal.signal(signal.SIGTERM,stop)
 (root/'started').write_text(str(os.getpid()))
 time.sleep(60)
emit(type='thinking',text='do-not-store-private-thinking')
emit(type='status',phase='turn_start')
emit(type='tool_call',callId='call-1',tool='bash',input={'command':'python3 -m unittest -v'})
emit(type='tool_result',callId='call-1',status='completed',
 result='1 failed; Bearer private-canary sk-tool-secret\n[exit code: 1]')
(root/'result.txt').write_text('changed by subprocess fixture')
if 'no-terminal' in prompt: sys.exit(0)
if 'null-reason' in prompt:
 emit(type='final',sessionId='session-fixture',reason=None,text='not completed');sys.exit(0)
if 'bad-session' in prompt:
 emit(type='final',sessionId='different',reason={'kind':'completed'},text='wrong');sys.exit(0)
if 'failure' in prompt:
 emit(type='final',sessionId='session-fixture',reason={'kind':'error'},text='failed');sys.exit(1)
emit(type='final',sessionId='session-fixture',reason={'kind':'completed'},text='Fixture finished')
if 'nonzero' in prompt: sys.exit(2)
if 'after-final' in prompt: emit(type='text',text='late')
"""


@pytest.fixture
def deepseek(client, tmp_path, monkeypatch):
    home = tmp_path / "dsh-home"
    profile = home / "profiles/desktop"
    profile.mkdir(parents=True)
    (profile / "cordis.patch.yml").write_text(
        yaml.safe_dump(
            [
                {
                    "id": "agent-default-model",
                    "config": {
                        "provider": "deepseek-account",
                        "model": "deepseek-flash",
                        "reasoningEffort": "high",
                    },
                },
                {"id": "unrelated-third-party-plugin", "config": {"secret": "must-not-copy"}},
            ]
        )
    )
    binary = tmp_path / "dsh"
    binary.write_text(f"#!{sys.executable}\n" + DSH_FIXTURE)
    binary.chmod(0o700)
    service = client.app.state.task_service
    service.settings.deepseek_binary = str(binary)
    service.settings.deepseek_home = str(home)
    for key in ("ADMIN_TOKEN", "OPENAI_API_KEY", "CAICAI_PROVIDER_KEY", "DSH_PERMISSION_MODE"):
        monkeypatch.setenv(key, "private-backend-canary")
    root = tmp_path / "project"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / "existing.txt").write_text("preexisting user edit")
    project = client.post(
        "/api/v1/projects", headers=HEADERS, json={"name": "DSH fixture", "root": str(root)}
    ).json()
    enabled = client.put("/api/v1/plugins/caicai.deepseek", headers=HEADERS, json={"enabled": True})
    assert enabled.status_code == 200, enabled.text
    cid = client.post(
        "/api/v1/conversations",
        headers=HEADERS,
        json={"channel": "desktop", "account_id": "fixture", "peer_id": "deepseek"},
    ).json()["id"]
    payload = {
        "conversation_id": cid,
        "project_id": project["id"],
        "goal": "fixture",
        "idempotency_key": "deepseek-fixture",
    }
    return service, TaskWorker(service), root, payload


def submit(client, payload, **changes):
    response = client.post("/api/v1/tasks", headers=HEADERS, json={**payload, **changes})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def read(client, task_id):
    return client.get(f"/api/v1/tasks/{task_id}", headers=HEADERS).json()


def test_default_harness_task_preserves_config_events_and_artifacts(client, deepseek):
    service, worker, root, payload = deepseek
    executor = service.registry.executors["deepseek-harness"]
    profile = executor.home() / "profiles/desktop/cordis.patch.yml"
    original = profile.read_bytes()
    with executor.overlay() as patch:
        overlay = yaml.safe_load(patch.read_text())
        assert overlay[-1]["config"] == executor.selection()
        assert "must-not-copy" not in patch.read_text()
        assert patch.stat().st_mode & 0o777 == 0o600
    assert not patch.exists()
    assert profile.read_bytes() == original
    # Unlike Codex, the Harness project can contain Codex configuration.
    (root / ".codex").mkdir()
    (root / ".codex/config.toml").write_text("[mcp_servers]\n")
    task_id = submit(client, payload)
    assert submit(client, payload) == task_id
    assert worker.run_once()
    assert not worker.run_once()
    result = read(client, task_id)
    assert result["task"]["agent_id"] == "caicai.deepseek/coding"
    assert result["task"]["status"] == "succeeded"
    assert result["attempts"][0]["executor_id"] == "deepseek-harness"
    assert result["attempts"][0]["run_ref"] == "session-fixture"
    assert [a["path"] for a in result["artifacts"]] == ["result.txt"]
    assert result["artifacts"][0]["sha256"]
    events = client.get(f"/api/v1/tasks/{task_id}/events", headers=HEADERS).json()
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    check = next(e["payload"] for e in events if e["payload"].get("kind") == "tool_result")
    assert check["exit_code"] == 1  # Tool completion never turns a failed check into a pass.
    assert check["command"] == "python3 -m unittest -v"
    encoded = json.dumps(events)
    for secret in ("private-canary", "sk-tool-secret", "do-not-store-private-thinking"):
        assert secret not in encoded
    assert profile.read_bytes() == original


@pytest.mark.parametrize(
    "mode,status,reason",
    [
        ("failure", "failed", "executor_failed"),
        ("nonzero", "failed", "executor_failed"),
        ("startup-error", "failed", "executor_failed"),
        ("no-terminal", "failed", "missing_terminal_event"),
        ("null-reason", "failed", "missing_terminal_event"),
        ("bad-session", "interrupted", "adapter_error"),
        ("malformed", "interrupted", "adapter_error"),
        ("after-final", "interrupted", "adapter_error"),
    ],
)
def test_harness_failure_cannot_become_success(client, deepseek, mode, status, reason):
    _, worker, _, payload = deepseek
    task_id = submit(client, payload, goal=mode)
    worker.run_once()
    result = read(client, task_id)
    assert result["task"]["status"] == status
    assert result["task"]["reason"] == reason
    assert "sk-error-secret" not in json.dumps(result)


@pytest.mark.parametrize("mode", ["cancel", "timeout", "shutdown"])
def test_harness_stops_process_tree(client, deepseek, mode):
    _, worker, root, payload = deepseek
    task_id = submit(client, payload, goal="hang")
    if mode == "timeout":
        from app.models import Task

        with worker.service.transaction() as db:
            db.get(Task, task_id).timeout_seconds = 1
    thread = threading.Thread(target=worker.run_once)
    thread.start()
    try:
        deadline = time.monotonic() + 8
        while not (root / "started").exists():
            assert time.monotonic() < deadline
            time.sleep(0.02)
        if mode == "cancel":
            assert (
                client.post(f"/api/v1/tasks/{task_id}/cancel", headers=HEADERS).status_code == 200
            )
        elif mode == "shutdown":
            worker.stopping.set()
        thread.join(8)
        assert not thread.is_alive()
        result = read(client, task_id)
        assert (
            result["task"]["status"]
            == {"cancel": "cancelled", "timeout": "failed", "shutdown": "interrupted"}[mode]
        )
        pgid = int((root / "started").read_text())
        assert not process_group_exists(pgid)
        with pytest.raises(ProcessLookupError):
            os.kill(int((root / "child.pid").read_text()), 0)
    finally:
        worker.stopping.set()
        thread.join(8)


@pytest.mark.parametrize(
    "change,expected",
    [
        ("missing", "deepseek_missing"),
        ("version", "deepseek_version_unsupported"),
        ("help", "deepseek_protocol_unsupported"),
        ("model", "deepseek_model_not_configured"),
        ("route", "deepseek_route_unsupported"),
    ],
)
def test_harness_availability_errors_are_actionable(client, deepseek, tmp_path, change, expected):
    service, _, _, _ = deepseek
    executor = service.registry.executors["deepseek-harness"]
    binary = tmp_path / "probe"
    if change == "missing":
        service.settings.deepseek_binary = str(binary)
    elif change in {"version", "help"}:
        binary.write_text(
            f"#!{sys.executable}\nimport sys\nprint("
            + repr("0.2.3" if change == "version" else "0.2.2-rc.3")
            + ")\n"
        )
        binary.chmod(0o700)
        service.settings.deepseek_binary = str(binary)
    else:
        path = executor.home() / "profiles/desktop/cordis.patch.yml"
        path.write_text(
            "[]"
            if change == "model"
            else yaml.safe_dump(
                [{"id": "agent-default-model", "config": {"provider": "unknown", "model": "x"}}]
            )
        )
    status = executor.check_availability()
    assert status["ready"] is False
    assert status["code"] == expected


def test_harness_profile_validation_and_no_external_artifacts(client, deepseek, tmp_path):
    service, _, root, _ = deepseek
    with pytest.raises(ValueError):
        Settings(_env_file=None, admin_token="test-token", deepseek_model_profile="../desktop")
    executor = service.registry.executors["deepseek-harness"]
    external = tmp_path / "outside.txt"
    external.write_text("private")
    (root / "outside-link").symlink_to(external)
    assert "outside-link" not in executor.snapshot(root)
    assert (
        TaskCreate(conversation_id="x", project_id="x", goal="x", idempotency_key="x").agent_id
        == "caicai.deepseek/coding"
    )


def test_projection_rejects_wrong_cwd_and_unmatched_final(tmp_path):
    projection = DeepSeekProjection(tmp_path, lambda *_: None)
    with pytest.raises(ValueError):
        projection.accept({"type": "session", "sessionId": "x", "cwd": "/different"})
    with pytest.raises(ValueError):
        projection.accept({"type": "final", "sessionId": "x", "text": "not started"})


def test_caicai_report_is_incremental_cached_and_separate_from_executor(
    client, deepseek, monkeypatch
):
    service, worker, _, payload = deepseek
    task_id = submit(client, payload)
    worker.run_once()
    url = f"/api/v1/tasks/{task_id}/report"
    assert client.post(url).status_code == 401
    assert client.post(url, headers=HEADERS).json()["error"]["code"] == "report_model_missing"
    provider = client.post(
        "/api/v1/providers",
        headers=HEADERS,
        json={
            "name": "report model",
            "base_url": "https://report.example/v1",
            "api_key": "report-only-key",
        },
    ).json()
    from app.models import Conversation

    with service.transaction() as db:
        conversation = db.get(Conversation, payload["conversation_id"])
        conversation.provider_id = provider["id"]
        conversation.model_id = "caicai-reporter"
    calls = []

    def complete(provider, model, messages):
        calls.append((model, messages))
        return "已修复；检查输出记录了一次失败，执行器结束不等于全部检查通过。"

    monkeypatch.setattr(client.app.state.chat_service.llm, "complete", complete)
    first = client.post(url, headers=HEADERS).json()
    assert first["cached"] is False
    assert client.post(url, headers=HEADERS).json()["cached"] is True
    assert len(calls) == 1
    assert calls[0][0] == "caicai-reporter"
    assert len(json.loads(calls[0][1][-1]["content"])["new_events"]) <= 32
    with service.transaction() as db:
        task = service.find(db, task_id)
        service.event(db, task, "progress", {"message": "人工补充核查结果"})
    assert client.post(url, headers=HEADERS).json()["cached"] is False
    data = json.loads(calls[1][1][-1]["content"])
    assert data["previous_report"] == first["text"]
    assert [e["payload"]["message"] for e in data["new_events"]] == ["人工补充核查结果"]
    assert read(client, task_id)["task"]["result"] == "Fixture finished"
    assert read(client, task_id)["task"]["status"] == "succeeded"


def test_report_failure_does_not_change_task_result(client, deepseek, monkeypatch):
    service, worker, _, payload = deepseek
    task_id = submit(client, payload)
    worker.run_once()
    provider = client.post(
        "/api/v1/providers",
        headers=HEADERS,
        json={
            "name": "report model",
            "base_url": "https://report.example/v1",
            "api_key": "report-only-key",
        },
    ).json()
    from app.models import Conversation

    with service.transaction() as db:
        conversation = db.get(Conversation, payload["conversation_id"])
        conversation.provider_id, conversation.model_id = provider["id"], "reporter"
    from app.core.errors import ServiceError

    def fail(*_):
        raise ServiceError("llm_timeout", "汇报模型超时", 504)

    monkeypatch.setattr(client.app.state.chat_service.llm, "complete", fail)
    response = client.post(f"/api/v1/tasks/{task_id}/report", headers=HEADERS)
    assert response.status_code == 504
    result = read(client, task_id)["task"]
    assert result["status"] == "succeeded" and result["result"] == "Fixture finished"


def test_desktop_pet_home_does_not_replace_harness_configuration(client, deepseek, monkeypatch):
    service, _, _, _ = deepseek
    executor = service.registry.executors["deepseek-harness"]
    monkeypatch.setenv("DSH_HOME", "/isolated-pet/home")
    assert executor.environment()["DSH_HOME"] == str(executor.home())
    assert executor.selection()["model"] == "deepseek-flash"
    service.settings.deepseek_home = ""
    from pathlib import Path

    assert executor.home() == (Path.home() / ".dsh").resolve()
