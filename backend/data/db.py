"""Database connection. Local-first default: SQLite file under ./data."""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Base


def _default_url() -> str:
    db_dir = Path(__file__).resolve().parent.parent / "data"
    db_dir.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_dir / 'bible-iu.sqlite'}"


DATABASE_URL = os.environ.get("BIBLE_IU_DATABASE_URL", _default_url())

engine = create_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_session() -> Session:
    return SessionLocal()
