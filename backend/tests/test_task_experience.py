import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from test_deepseek import deepseek as deepseek

from app.models import (
    Conversation,
    Message,
    SpeechJob,
    Task,
    TaskArtifact,
    TaskAttempt,
    TaskEvent,
    Voice,
    utc_now,
)
from app.tasks.contracts import TaskCreate

HEADERS = {"Authorization": "Bearer test-admin-token-at-least-32-characters"}


@pytest.fixture
def experience(client, deepseek):
    # Exercise each maintenance pass explicitly, without a wall-clock race.
    notifications = client.app.state.task_notifications
    notifications.close()
    notifications.stopping.clear()
    return deepseek


def configure_model(client, service, cid):
    provider = client.post(
        "/api/v1/providers",
        headers=HEADERS,
        json={
            "name": "intent-and-reports",
            "base_url": "https://example.test/v1",
            "api_key": "fixture-key",
        },
    ).json()
    with service.transaction() as db:
        conversation = db.get(Conversation, cid)
        conversation.provider_id, conversation.model_id = provider["id"], "chat-model"
    return provider["id"]


def test_unregister_only_removes_registration_and_can_restore(client, experience):
    service, worker, root, payload = experience
    task = service.create(TaskCreate(**payload))
    url = "/api/v1/projects/" + payload["project_id"]
    assert client.delete(url).status_code == 401
    assert client.delete(url, headers=HEADERS).json()["error"]["code"] == "project_busy"
    worker.run_once()
    assert client.delete(url, headers=HEADERS).json() == {"deleted": True}
    assert client.get("/api/v1/projects", headers=HEADERS).json() == []
    assert root.is_dir() and (root / "existing.txt").read_text() == "preexisting user edit"
    assert client.get("/api/v1/tasks/" + task.id, headers=HEADERS).status_code == 200
    response = client.post(
        "/api/v1/tasks",
        headers=HEADERS,
        json={
            **payload,
            "idempotency_key": "after-delete",
        },
    )
    assert response.json()["error"]["code"] == "project_not_found"
    restored = client.post(
        "/api/v1/projects",
        headers=HEADERS,
        json={
            "name": "restored",
            "root": str(root),
        },
    ).json()
    assert restored["id"] == payload["project_id"]
    assert restored["name"] == "restored"


def test_five_day_retention_removes_dependents_without_chat_reports(client, experience):
    service, worker, _, payload = experience
    task = service.create(TaskCreate(**payload))
    worker.run_once()
    client.app.state.task_notifications.deliver(task.id)
    with service.transaction() as db:
        for event in db.scalars(
            select(TaskEvent).where(
                TaskEvent.task_id == task.id,
                TaskEvent.type == "task.finished",
            )
        ):
            event.occurred_at = utc_now() - timedelta(days=6)
        # A fresh report does not reset the five-day clock.
        service.event(db, service.find(db, task.id), "progress", {"message": "new report"})
        assert db.scalar(select(func.count()).select_from(TaskArtifact)) > 0
    assert service.prune_history() == 1
    assert client.get("/api/v1/tasks", headers=HEADERS).json() == []
    with service.session_factory() as db:
        for model in (Task, TaskAttempt, TaskEvent, TaskArtifact):
            assert db.scalar(select(func.count()).select_from(model)) == 0
        assert db.scalar(select(func.count()).select_from(Message)) == 0


@pytest.mark.parametrize(
    "status,reason,removed",
    [
        ("succeeded", None, True),
        ("failed", "error", True),
        ("cancelled", "cancelled", True),
        ("interrupted", "interruption_acknowledged", True),
        ("interrupted", "worker_lost", False),
        ("queued", None, False),
        ("running", None, False),
    ],
)
def test_retention_preserves_live_and_unreviewed_tasks(client, experience, status, reason, removed):
    service, _, _, payload = experience
    task = service.create(TaskCreate(**payload))
    with service.transaction() as db:
        task = service.find(db, task.id)
        task.status, task.reason = status, reason
        service.event(db, task, "task.finished", {"status": status})
        db.flush()
        event = db.scalar(
            select(TaskEvent).where(
                TaskEvent.task_id == task.id,
                TaskEvent.type == "task.finished",
            )
        )
        event.occurred_at = utc_now() - timedelta(days=5, seconds=1)
    assert service.prune_history() == int(removed)


@pytest.mark.parametrize("streaming", [True, False])
def test_natural_language_creates_real_task_once(client, experience, monkeypatch, streaming):
    service, _, _, payload = experience
    configure_model(client, service, payload["conversation_id"])
    calls = []

    def complete(provider, model, messages):
        calls.append((model, messages))
        return json.dumps(
            {
                "action": "task",
                "project_id": payload["project_id"],
                "goal": "修复登录问题并运行测试",
            }
        )

    monkeypatch.setattr(client.app.state.chat_service.llm, "complete", complete)
    suffix = "/stream" if streaming else ""
    url = f"/api/v1/desktop/conversations/{payload['conversation_id']}/messages{suffix}"
    for _ in range(2):
        response = client.post(
            url,
            headers=HEADERS,
            json={
                "external_id": "request-once",
                "text": "帮我修复登录问题并运行测试",
            },
        )
        assert response.status_code == 200
        message = (
            next(
                json.loads(line[6:])["message"]
                for line in response.text.splitlines()
                if line.startswith("data: ") and json.loads(line[6:])["type"] == "done"
            )
            if streaming
            else response.json()
        )
        assert "创建后台任务" in message["assistant_text"]
    with service.session_factory() as db:
        rows = db.scalars(select(Task)).all()
        assert len(rows) == 1 and rows[0].goal == "修复登录问题并运行测试"
        assert rows[0].conversation_id == payload["conversation_id"]
        assert rows[0].id in message["assistant_text"]
    assert len(calls) == 1
    assert calls[0][0] == "chat-model"


@pytest.mark.parametrize(
    "intent",
    [
        {"action": "clarify", "reply": "你想修改哪个项目？"},
        {"action": "task", "project_id": "invented", "goal": "do something"},
    ],
)
def test_ambiguous_or_unknown_project_does_not_create(client, experience, monkeypatch, intent):
    service, _, _, payload = experience
    configure_model(client, service, payload["conversation_id"])
    monkeypatch.setattr(
        client.app.state.chat_service.llm, "complete", lambda *_: json.dumps(intent)
    )
    response = client.post(
        f"/api/v1/desktop/conversations/{payload['conversation_id']}/messages",
        headers=HEADERS,
        json={"external_id": "ambiguous", "text": "帮我修复那个项目"},
    )
    assert response.status_code == 200
    assert "创建后台任务" not in response.json()["assistant_text"]
    with service.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Task)) == 0


def test_capability_question_remains_chat(client, experience, monkeypatch):
    service, _, _, payload = experience
    configure_model(client, service, payload["conversation_id"])
    monkeypatch.setattr(
        client.app.state.chat_service.llm, "complete", lambda *_: '{"action":"chat"}'
    )
    monkeypatch.setattr(
        client.app.state.chat_service.llm, "stream", lambda *_: iter(["可以直接告诉我任务。"])
    )
    response = client.post(
        f"/api/v1/desktop/conversations/{payload['conversation_id']}/messages/stream",
        headers=HEADERS,
        json={"external_id": "question", "text": "我能否用自然语言让你创建任务？"},
    )
    assert "可以直接告诉我任务" in response.text
    assert client.get("/api/v1/tasks", headers=HEADERS).json() == []


def test_completion_is_one_shot_audio_and_consumption_deletes_file(client, experience, monkeypatch):
    service, worker, _, payload = experience
    with service.transaction() as db:
        voice = Voice(name="菜菜", duration_seconds=4, style_prompt="自然")
        db.add(voice)
        db.flush()
        db.get(Conversation, payload["conversation_id"]).voice_id = voice.id
    submits = []
    speech = client.app.state.speech_service
    monkeypatch.setattr(speech.executor, "submit", lambda *args: submits.append(args))
    task = service.create(TaskCreate(**payload))
    worker.run_once()
    notifications = client.app.state.task_notifications
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: notifications.deliver(task.id), range(2)))
    notifications.deliver(task.id)
    assert len(submits) == 1
    assert client.get("/api/v1/task-notifications").status_code == 401
    jobs = client.get("/api/v1/task-notifications", headers=HEADERS).json()
    assert len(jobs) == 1 and jobs[0]["message_id"] is None
    assert "已完成" in jobs[0]["text"]
    job_id = jobs[0]["id"]
    url = "/api/v1/task-notifications/" + job_id
    assert client.delete(url).status_code == 401
    assert client.delete(url, headers=HEADERS).status_code == 409
    with service.transaction() as db:
        assert db.scalar(select(func.count()).select_from(Message)) == 0
        job = db.get(SpeechJob, job_id)
        assert job.purpose == "task_notification"
        job.status = "completed"
    path = speech.audio_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"audio-fixture")
    assert client.get("/api/v1/speech/jobs", headers=HEADERS).json() == []
    assert client.delete(url, headers=HEADERS).json() == {"deleted": True}
    assert not path.exists()
    assert client.delete(url, headers=HEADERS).json() == {"deleted": True}
    notifications.deliver(task.id)
    assert client.get("/api/v1/task-notifications", headers=HEADERS).json() == []
    with service.session_factory() as db:
        assert db.get(SpeechJob, job_id) is None
        assert db.scalar(select(func.count()).select_from(Message)) == 0


def test_no_voice_creates_neither_chat_report_nor_playback_controls(client, experience):
    service, worker, _, payload = experience
    task = service.create(TaskCreate(**payload))
    worker.run_once()
    notifications = client.app.state.task_notifications
    notifications.deliver(task.id)
    notifications.deliver(task.id)
    assert client.get("/api/v1/task-notifications", headers=HEADERS).json() == []
    assert (
        client.get(
            f"/api/v1/conversations/{payload['conversation_id']}/messages", headers=HEADERS
        ).json()
        == []
    )
    with service.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(SpeechJob)) == 0
        assert (
            len(
                db.scalars(
                    select(TaskEvent).where(
                        TaskEvent.task_id == task.id, TaskEvent.type == "notification.sent"
                    )
                ).all()
            )
            == 1
        )


def test_legacy_reports_are_hidden_and_cleaned_without_deleting_normal_chat(client, experience):
    service, _, _, payload = experience
    speech = client.app.state.speech_service
    with service.transaction() as db:
        voice = Voice(name="legacy", duration_seconds=4)
        db.add(voice)
        db.flush()
        legacy = Message(
            conversation_id=payload["conversation_id"],
            external_id="task-report:old",
            user_text="",
            assistant_text="旧完成汇报",
            status="completed",
        )
        normal = Message(
            conversation_id=payload["conversation_id"],
            external_id="normal",
            user_text="你好",
            assistant_text="你好呀",
            status="completed",
        )
        db.add_all([legacy, normal])
        db.flush()
        job = SpeechJob(
            voice_id=voice.id, message_id=legacy.id, text="旧完成汇报", status="completed"
        )
        db.add(job)
        db.flush()
        job_id, legacy_id = job.id, legacy.id
    path = speech.audio_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"legacy audio")
    rows = client.get(
        f"/api/v1/conversations/{payload['conversation_id']}/messages", headers=HEADERS
    ).json()
    assert len(rows) == 1 and rows[0]["external_id"] == "normal"
    client.app.state.task_notifications.cleanup()
    assert not path.exists()
    with service.session_factory() as db:
        assert db.get(Message, legacy_id) is None and db.get(SpeechJob, job_id) is None
        assert db.scalar(select(func.count()).select_from(Message)) == 1


def test_notification_consumption_cannot_delete_normal_chat_audio(client, experience):
    service, _, _, _ = experience
    with service.transaction() as db:
        voice = Voice(name="normal", duration_seconds=4)
        db.add(voice)
        db.flush()
        job = SpeechJob(voice_id=voice.id, text="普通聊天", status="completed")
        db.add(job)
        db.flush()
        job_id = job.id
    response = client.delete("/api/v1/task-notifications/" + job_id, headers=HEADERS)
    assert response.status_code == 404
    with service.session_factory() as db:
        assert db.get(SpeechJob, job_id) is not None


def test_recent_terminal_history_stays_until_five_days(client, experience):
    service, _, _, payload = experience
    task = service.create(TaskCreate(**payload))
    with service.transaction() as db:
        service.finish(db, service.find(db, task.id), None, "cancelled", "cancelled", None, None)
        db.flush()
        event = db.scalar(
            select(TaskEvent).where(
                TaskEvent.task_id == task.id,
                TaskEvent.type == "task.finished",
            )
        )
        event.occurred_at = utc_now() - timedelta(days=4, hours=23)
    assert service.prune_history() == 0
    with service.transaction() as db:
        event = db.scalar(
            select(TaskEvent).where(
                TaskEvent.task_id == task.id,
                TaskEvent.type == "task.finished",
            )
        )
        event.occurred_at = utc_now() - timedelta(days=5, hours=1)
    assert service.prune_history() == 1
