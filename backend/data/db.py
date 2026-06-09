"""Database connection. Local-first default: SQLite file under ./data.

Sizing notes
------------
The default pool (size=5, overflow=10) was hit during the hard
stress test: 8 concurrent writers + image uploads exhausted the 15
available connections and downstream requests timed out at 30s.
Bumped to 50 + 50 overflow so a small congregation hammering at once
plus background subscribers stays well under the ceiling, with a
shorter `pool_timeout` so any future genuine starvation fails fast
instead of stalling the worker.

WAL mode on SQLite is enabled at first connection so concurrent
reads don't block on a writer holding the database lock — critical
when WS subscribers, chat list endpoints, and a writer hit at once.
"""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .models import Base


def _default_url() -> str:
    db_dir = Path(__file__).resolve().parent.parent / "data"
    db_dir.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_dir / 'bible-iu.sqlite'}"


DATABASE_URL = os.environ.get("BIBLE_IU_DATABASE_URL", _default_url())
_IS_SQLITE = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    connect_args={"check_same_thread": False} if _IS_SQLITE else {},
    pool_size=50,
    max_overflow=50,
    pool_timeout=10,
    pool_recycle=1800,
)


if _IS_SQLITE:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record) -> None:  # type: ignore[no-redef]
        """Per-connection pragmas: WAL for concurrent reads + writer,
        NORMAL synchronous for ~3× write throughput vs FULL (still
        crash-safe — we trade an OS crash window for speed; power-loss
        could lose the last write but never corrupt the DB)."""
        cur = dbapi_connection.cursor()
        try:
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA busy_timeout=8000")
            cur.execute("PRAGMA foreign_keys=ON")
        finally:
            cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_session() -> Session:
    return SessionLocal()
