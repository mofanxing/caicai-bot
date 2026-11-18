from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.api.speech_routes import speech_router
from app.api.task_routes import task_router
from app.core.config import Settings
from app.core.errors import ServiceError
from app.core.secrets import SecretVault
from app.db import create_session_factory
from app.migrations import initialize_database
from app.services.chat import ChatService
from app.services.speech import SpeechService
from app.tasks.host import TaskWorkerHost
from app.tasks.intents import TaskIntents
from app.tasks.notifications import TaskNotifications
from app.tasks.reports import TaskReports
from app.tasks.service import TaskService


def create_app(settings: Settings | None = None) -> FastAPI:
    load_dotenv(override=False)
    settings = settings or Settings()
    engine, session_factory = create_session_factory(settings.database_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        initialize_database(engine)
        app.state.speech_service.start(session_factory)
        app.state.task_notifications.start()
        if getattr(app.state, "manage_task_worker", False):
            app.state.task_worker_host.start()
        try:
            yield
        finally:
            app.state.task_worker_host.close()
            app.state.task_notifications.close()
            app.state.speech_service.close()
            engine.dispose()

    app = FastAPI(
        title="Caicai Bot API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if settings.app_env != "production" else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.app_env != "production" else None,
    )
    app.state.settings = settings
    app.state.session_factory = session_factory
    app.state.secret_vault = SecretVault(settings)
    app.state.speech_service = SpeechService(settings)
    app.state.task_service = TaskService(settings, session_factory)
    app.state.task_worker_host = TaskWorkerHost(settings)
    app.state.chat_service = ChatService(settings, app.state.secret_vault, app.state.speech_service)
    app.state.chat_service.task_intents = TaskIntents(
        app.state.task_service, app.state.chat_service.llm
    )
    app.state.task_reports = TaskReports(app.state.task_service, app.state.chat_service)

    app.state.task_notifications = TaskNotifications(
        app.state.task_service, app.state.speech_service
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        # Pydantic's default errors include raw request inputs, which may contain API keys.
        errors = [
            {"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": errors})

    @app.exception_handler(ServiceError)
    async def service_error_handler(request: Request, exc: ServiceError):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    app.include_router(router)
    app.include_router(speech_router)
    app.include_router(task_router)
    return app
