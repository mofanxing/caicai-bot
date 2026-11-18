from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from app.api.routes import get_db, require_admin
from app.models import Task, TaskArtifact, TaskAttempt, TaskEvent, TaskProject
from app.schemas import SpeechJobRead
from app.tasks.contracts import (
    ArtifactRead,
    AttemptRead,
    EventRead,
    InterruptionReview,
    PluginUpdate,
    ProjectCreate,
    ProjectRead,
    TaskCreate,
    TaskRead,
)

task_router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_admin)])


@task_router.get("/task-notifications", response_model=list[SpeechJobRead])
def task_notifications(request: Request, db=Depends(get_db)):
    return request.app.state.task_notifications.pending(db)


@task_router.delete("/task-notifications/{job_id}")
def consume_task_notification(job_id: str, request: Request):
    return request.app.state.task_notifications.consume(job_id)


@task_router.get("/task-runtime")
def task_runtime(request: Request):
    return request.app.state.task_worker_host.status()


@task_router.get("/plugins")
def plugins(request: Request):
    return request.app.state.task_service.plugins()


@task_router.put("/plugins/{plugin_id}")
def update_plugin(plugin_id: str, payload: PluginUpdate, request: Request):
    return request.app.state.task_service.enable(plugin_id, payload.enabled)


@task_router.get("/projects", response_model=list[ProjectRead])
def projects(db=Depends(get_db)):
    return db.scalars(
        select(TaskProject)
        .where(TaskProject.registered.is_(True))
        .order_by(TaskProject.created_at, TaskProject.id)
    ).all()


@task_router.post("/projects", response_model=ProjectRead, status_code=201)
def create_project(payload: ProjectCreate, request: Request):
    return request.app.state.task_service.register_project(payload)


@task_router.delete("/projects/{project_id}")
def delete_project(project_id: str, request: Request):
    return request.app.state.task_service.unregister_project(project_id)


@task_router.post("/tasks", response_model=TaskRead, status_code=201)
def create_task(payload: TaskCreate, request: Request):
    return request.app.state.task_service.create(payload)


@task_router.get("/tasks", response_model=list[TaskRead])
def tasks(
    request: Request,
    conversation_id: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    request.app.state.task_service.prune_history()
    query = select(Task)
    if conversation_id:
        query = query.where(Task.conversation_id == conversation_id)
    rows = db.scalars(query.order_by(Task.created_at.desc(), Task.id.desc()).limit(limit)).all()
    return [request.app.state.task_service.present(db, task) for task in rows]


@task_router.get("/tasks/{task_id}")
def task_detail(task_id: str, request: Request, db=Depends(get_db)):
    task = request.app.state.task_service.find(db, task_id)
    return {
        "task": request.app.state.task_service.present(db, task),
        "attempts": [
            AttemptRead.model_validate(attempt)
            for attempt in db.scalars(
                select(TaskAttempt)
                .where(TaskAttempt.task_id == task_id)
                .order_by(TaskAttempt.number)
            )
        ],
        "artifacts": [
            ArtifactRead.model_validate(artifact)
            for artifact in db.scalars(
                select(TaskArtifact)
                .where(TaskArtifact.task_id == task_id)
                .order_by(TaskArtifact.id)
            )
        ],
    }


@task_router.get("/tasks/{task_id}/events", response_model=list[EventRead])
def events(
    task_id: str,
    request: Request,
    after: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db=Depends(get_db),
):
    request.app.state.task_service.find(db, task_id)
    return db.scalars(
        select(TaskEvent)
        .where(
            TaskEvent.task_id == task_id,
            TaskEvent.seq > after,
        )
        .order_by(TaskEvent.seq)
        .limit(limit)
    ).all()


@task_router.post("/tasks/{task_id}/report")
def report_task(task_id: str, request: Request):
    return request.app.state.task_reports.generate(task_id)


@task_router.post("/tasks/{task_id}/cancel", response_model=TaskRead)
def cancel(task_id: str, request: Request):
    return request.app.state.task_service.cancel(task_id)


@task_router.post("/tasks/{task_id}/acknowledge-interruption", response_model=TaskRead)
def acknowledge(task_id: str, payload: InterruptionReview, request: Request):
    return request.app.state.task_service.acknowledge_interruption(task_id)
