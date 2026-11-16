from sqlalchemy import inspect, text

from app.db import Base


def initialize_database(engine):
    """One additive, idempotent migration for existing prototype databases."""
    Base.metadata.create_all(engine)
    columns = {column["name"] for column in inspect(engine).get_columns("providers")}
    if "api_key_encrypted" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE providers ADD COLUMN api_key_encrypted TEXT"))
