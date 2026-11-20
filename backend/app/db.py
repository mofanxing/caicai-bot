from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from pydantic import AfterValidator
from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, sessionmaker


def as_utc(value: datetime) -> datetime:
    # SQLite returns stored UTC timestamps without an offset.
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


UtcTimestamp = Annotated[datetime, AfterValidator(as_utc)]


class Base(DeclarativeBase):
    pass


def create_session_factory(database_url: str):
    url = make_url(database_url)
    options = {}
    if url.get_backend_name() == "sqlite":
        if url.database and url.database != ":memory:":
            Path(url.database).parent.mkdir(parents=True, exist_ok=True)
        options["connect_args"] = {"check_same_thread": False}
    engine = create_engine(database_url, **options)
    if url.get_backend_name() == "sqlite":

        @event.listens_for(engine, "connect")
        def enable_foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA secure_delete=ON")

    return engine, sessionmaker(bind=engine, expire_on_commit=False)
