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
        "conversations": {"voice_prompt": "TEXT NOT NULL DEFAULT ''"},
        "messages": {"speech_job_id": "VARCHAR(32)"},
    }
    for table, fields in additions.items():
        existing = {column["name"] for column in inspect(engine).get_columns(table)}
        with engine.begin() as connection:
            for name, definition in fields.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}"))
