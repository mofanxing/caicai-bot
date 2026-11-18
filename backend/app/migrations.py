from sqlalchemy import inspect, text

from app.db import Base


def initialize_database(engine):
    """Additive, idempotent migrations that retain existing prototype data."""
    Base.metadata.create_all(engine)
    columns = {column["name"] for column in inspect(engine).get_columns("providers")}
    if "api_key_encrypted" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE providers ADD COLUMN api_key_encrypted TEXT"))
    additions = {
        "task_projects": {"registered": "BOOLEAN NOT NULL DEFAULT 1"},
        "conversations": {
            "voice_prompt": "TEXT NOT NULL DEFAULT ''",
            "feedback_enabled": "BOOLEAN NOT NULL DEFAULT 1",
            "feedback_thinking_text": "TEXT NOT NULL DEFAULT '收到，我想一想。'",
            "feedback_waiting_text": "TEXT NOT NULL DEFAULT '我在准备语音，稍等一下。'",
            "feedback_thinking_job_id": "VARCHAR(32)",
            "feedback_waiting_job_id": "VARCHAR(32)",
        },
        "messages": {"speech_job_id": "VARCHAR(32)"},
        "speech_jobs": {"purpose": "VARCHAR(20) NOT NULL DEFAULT 'speech'"},
    }
    for table, fields in additions.items():
        existing = {column["name"] for column in inspect(engine).get_columns(table)}
        with engine.begin() as connection:
            for name, definition in fields.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}"))
