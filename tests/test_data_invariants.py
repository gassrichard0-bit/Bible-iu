"""Tests for data-model.MD §8 invariants (privacy + immutability + license)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.data.models import (
    Base,
    Note,
    OriginalToken,
    Resource,
    Room,
    Translation,
    User,
    Verse,
)
from backend.data.repos import AgentNoteRepository, UserNoteRepository


@pytest.fixture()
def session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _seed(session: Session) -> tuple[str, str, str]:
    user_a = User(id="u-a", handle="alice", display_name="Alice")
    user_b = User(id="u-b", handle="bob", display_name="Bob")
    room = Room(id="r-1", type="group", name="Study")
    session.add_all([user_a, user_b, room])
    session.add_all([
        Note(id="n-personal-a", room_id="r-1", author_user_id="u-a",
             scope="personal"),
        Note(id="n-personal-b", room_id="r-1", author_user_id="u-b",
             scope="personal"),
        Note(id="n-group-a", room_id="r-1", author_user_id="u-a",
             scope="group"),
    ])
    session.commit()
    return "u-a", "u-b", "r-1"


def test_agent_repo_only_returns_group_notes(session: Session):
    _, _, room_id = _seed(session)
    repo = AgentNoteRepository(session, room_id)
    notes = repo.list_visible()
    assert {n.id for n in notes} == {"n-group-a"}


def test_user_cannot_read_other_users_personal_note(session: Session):
    user_a, _, room_id = _seed(session)
    repo = UserNoteRepository(session, room_id, user_a)
    assert {n.id for n in repo.list_personal()} == {"n-personal-a"}
    assert repo.get("n-personal-b") is None


def test_translation_requires_license(session: Session):
    session.add(Verse(id="GEN.1.1", book="GEN", chapter=1, verse=1))
    session.commit()
    with pytest.raises(ValueError):
        session.add(Translation(
            id="trans-1", name="X", verse_id="GEN.1.1", text="...", license=""
        ))
        session.commit()
    session.rollback()


def test_resource_requires_license(session: Session):
    with pytest.raises(ValueError):
        session.add(Resource(
            id="res-1", type="commentary", source="Anon",
            license_attribution="", body="..."
        ))
        session.commit()
    session.rollback()


def test_scripture_rows_are_immutable(session: Session):
    session.add(Verse(id="GEN.1.1", book="GEN", chapter=1, verse=1))
    session.commit()
    verse = session.get(Verse, "GEN.1.1")
    verse.book = "EXO"
    with pytest.raises(RuntimeError):
        session.commit()
    session.rollback()
