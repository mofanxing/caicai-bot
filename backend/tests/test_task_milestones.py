import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from sqlalchemy import event, func, select
from test_deepseek import deepseek as deepseek
from test_task_experience import HEADERS, configure_model

from app.models import Conversation, Message, SpeechJob, TaskEvent, Voice, utc_now
from app.tasks.contracts import TaskCreate
from app.tasks.milestones import TaskMilestones


@pytest.fixture
def milestone(client, deepseek, monkeypatch):
    service, worker, root, payload = deepseek
    notices = client.app.state.task_notifications
    notices.close()
    notices.stopping.clear()
    with service.transaction() as db:
        voice = Voice(name="selected voice", duration_seconds=4)
        db.add(voice)
        db.flush()
        db.get(Conversation, payload["conversation_id"]).voice_id = voice.id
    monkeypatch.setattr(client.app.state.speech_service.executor, "submit", lambda *_: None)
    task = service.create(TaskCreate(**payload))
    _, attempt = service.claim()
    return service, task, attempt, client.app.state.task_milestones


def reports(service, task):
    with service.session_factory() as db:
        return [
            e
            for e in db.scalars(
                select(TaskEvent).where(TaskEvent.task_id == task.id).order_by(TaskEvent.seq)
            )
            if e.payload.get("automatic")
        ]


def advance(service, task):
    with service.transaction() as db:
        for event in db.scalars(select(TaskEvent).where(TaskEvent.task_id == task.id)):
            event.occurred_at = utc_now() - timedelta(seconds=31)


def test_started_is_durable_once_without_chat_messages(client, milestone):
    service, task, _, monitor = milestone
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: monitor.deliver(task.id), range(2)))
    monitor.tick()
    # A reconstructed process uses the same durable marker.
    TaskMilestones(service, client.app.state.chat_service, monitor.speech).tick()
    saved = reports(service, task)
    assert len(saved) == 1 and saved[0].payload["milestone"] == "started"
    assert saved[0].payload["summary_source"] == "event"
    jobs = client.get("/api/v1/task-notifications", headers=HEADERS).json()
    assert len(jobs) == 1 and jobs[0]["message_id"] is None
    with service.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Message)) == 0
        job = db.get(SpeechJob, jobs[0]["id"])
        assert job.purpose == "task_milestone"
        assert job.voice_id == db.get(Conversation, task.conversation_id).voice_id


def test_coalesces_steps_rate_limits_and_never_repeats_phase(client, milestone):
    service, task, attempt, monitor = milestone
    monitor.tick()
    for _ in range(3):
        service.record(
            task.id,
            attempt.id,
            "progress",
            {"kind": "tool_call", "tool": "bash", "command": "python3 -m unittest -v"},
        )
    monitor.tick()
    assert len(reports(service, task)) == 1
    advance(service, task)
    monitor.tick()
    saved = reports(service, task)
    assert [e.payload["milestone"] for e in saved] == ["started", "checking"]
    assert "还未确认" in saved[-1].payload["message"]
    advance(service, task)
    service.record(
        task.id,
        attempt.id,
        "progress",
        {"kind": "tool_call", "tool": "bash", "command": "pytest -q"},
    )
    monitor.tick()
    assert len(reports(service, task)) == 2


@pytest.mark.parametrize(
    "payload,key",
    [
        ({"kind": "tool_result", "tool": "edit", "phase": "completed"}, "editing"),
        ({"kind": "tool_result", "tool": "bash", "exit_code": 1}, "attention"),
        ({"kind": "tool_result", "tool": "edit", "phase": "error"}, "attention"),
        ({"kind": "agent_message", "message": "我准备开始测试了"}, "started"),
    ],
)
def test_only_structured_evidence_triggers_reports(client, milestone, payload, key):
    service, task, attempt, monitor = milestone
    service.record(task.id, attempt.id, "progress", payload)
    monitor.tick()
    assert reports(service, task)[0].payload["milestone"] == key


def test_report_model_does_not_block_chat_or_worker(client, milestone, monkeypatch):
    service, task, attempt, monitor = milestone
    configure_model(client, service, task.conversation_id)
    service.record(task.id, attempt.id, "progress", {"kind": "tool_call", "command": "pytest -q"})
    entered, release = threading.Event(), threading.Event()

    def complete(*args):
        entered.set()
        assert release.wait(5)
        return "正在运行项目测试，结果尚未返回。"

    monkeypatch.setattr(monitor.llm, "complete", complete)
    chat = client.app.state.chat_service
    monkeypatch.setattr(chat.llm, "complete", lambda *_: '{"action":"chat"}')
    monkeypatch.setattr(chat.llm, "stream", lambda *_: iter(["可以继续聊天。"]))
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(monitor.tick)
        try:
            assert entered.wait(5)
            service.record(task.id, attempt.id, "progress", {"message": "worker still runs"})
            response = client.post(
                f"/api/v1/desktop/conversations/{task.conversation_id}/messages/stream",
                headers=HEADERS,
                json={"external_id": "parallel", "text": "你好"},
            )
            assert response.status_code == 200 and "可以继续聊天" in response.text
        finally:
            release.set()
        future.result()
    assert reports(service, task)[0].payload["summary_source"] == "model"


def test_completion_during_model_call_discards_late_progress(client, milestone, monkeypatch):
    service, task, attempt, monitor = milestone
    configure_model(client, service, task.conversation_id)
    service.record(task.id, attempt.id, "progress", {"kind": "tool_call", "command": "pytest"})

    def complete(*_):
        with service.transaction() as db:
            service.finish(db, service.find(db, task.id), None, "succeeded", None, "done", 0)
        return "检查正在运行。"

    monkeypatch.setattr(monitor.llm, "complete", complete)
    monitor.tick()
    assert reports(service, task) == []
    assert client.get("/api/v1/task-notifications", headers=HEADERS).json() == []


def test_model_failure_falls_back_and_terminal_hides_progress(client, milestone, monkeypatch):
    service, task, attempt, monitor = milestone
    configure_model(client, service, task.conversation_id)
    service.record(task.id, attempt.id, "progress", {"kind": "tool_call", "command": "npm test"})
    monkeypatch.setattr(monitor.llm, "complete", lambda *_: (_ for _ in ()).throw(ValueError()))
    monitor.tick()
    report = reports(service, task)[0]
    assert report.payload["summary_source"] == "event"
    assert len(client.get("/api/v1/task-notifications", headers=HEADERS).json()) == 1
    with service.transaction() as db:
        service.finish(db, service.find(db, task.id), None, "cancelled", "cancelled", None, None)
    assert client.get("/api/v1/task-notifications", headers=HEADERS).json() == []
    assert len(reports(service, task)) == 1


def test_progress_expires_and_can_be_consumed(client, milestone):
    service, task, _, monitor = milestone
    monitor.tick()
    job_id = reports(service, task)[0].payload["speech_job_id"]
    with service.transaction() as db:
        job = db.get(SpeechJob, job_id)
        job.status = "completed"
        job.created_at = utc_now() - timedelta(minutes=3)
    assert client.get("/api/v1/task-notifications", headers=HEADERS).json() == []
    assert client.delete("/api/v1/task-notifications/" + job_id, headers=HEADERS).status_code == 200


def test_no_voice_still_persists_visible_report(client, milestone):
    service, task, _, monitor = milestone
    with service.transaction() as db:
        db.get(Conversation, task.conversation_id).voice_id = None
    monitor.tick()
    assert reports(service, task)[0].payload["speech_job_id"] is None
    detail = client.get("/api/v1/tasks/" + task.id, headers=HEADERS).json()
    assert "已经开始处理" in detail["task"]["current_step"]


def test_queued_obsolete_progress_skips_synthesis(client, milestone, monkeypatch):
    service, task, _, monitor = milestone
    monitor.tick()
    job_id = reports(service, task)[0].payload["speech_job_id"]
    with service.transaction() as db:
        service.finish(db, service.find(db, task.id), None, "cancelled", "cancelled", None, None)
    calls = []
    monkeypatch.setattr(monitor.speech.engine, "synthesize", lambda *_: calls.append(True))
    monitor.speech._run(job_id)
    assert calls == []
    with service.session_factory() as db:
        assert db.get(SpeechJob, job_id) is None


def test_cooldown_and_incremental_scan_skip_old_events(milestone):
    service, task, attempt, monitor = milestone
    with service.transaction() as db:
        current = service.find(db, task.id)
        for _ in range(300):
            service.event(db, current, "progress", {"message": "old output"})
    monitor.tick()
    loaded = []

    def loaded_event(row, context):
        loaded.append(row.seq)

    event.listen(TaskEvent, "load", loaded_event)
    try:
        monitor.tick()
        # During cooldown only the durable report marker is read.
        assert len(loaded) == 1
        advance(service, task)
        service.record(task.id, attempt.id, "progress", {"kind": "tool_call", "command": "pytest"})
        loaded.clear()
        monitor.tick()
        # A new checkpoint can be found without loading the 300 older steps.
        assert len(loaded) < 10
    finally:
        event.remove(TaskEvent, "load", loaded_event)
    assert [e.payload["milestone"] for e in reports(service, task)] == ["started", "checking"]
