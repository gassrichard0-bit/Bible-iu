"""Privacy regression: personal notes must never reach the agent.

`rule-guide.MD` §12.1: personal notes are invisible to the agent.
The boundary is enforced at the data layer by
`backend/data/repos.py::AgentNoteRepository.list_visible` (only
returns `scope='group'`), and the citation engine's retriever
(`SqlRetriever`) routes all note access through that repository.

This test pins down that contract end-to-end: if a personal note's
body or any of its identifying metadata ever appears in a retrieved
chunk, the test fails. Because the contract is so important and so
easy to break with a careless refactor (the agent code is one
`select(Note)` away from leaking), this regression test sits in the
default suite.
"""
from __future__ import annotations

import uuid

import pytest

from backend.data import get_session, init_db
from backend.data.models import (
    Note,
    Room,
    Translation,
    Verse,
)
from backend.agent.skills.default_backends import SqlRetriever


PERSONAL_BODY = "PERSONAL_NOTE_SECRET_PHRASE_DO_NOT_LEAK_e1f2c3"
PERSONAL_TAG = "PERSONAL_NOTE_TAG_LEAK_PROBE"


@pytest.fixture()
def seeded_session():
    """Bring up the DB and seed a room with one personal note + one
    group note attached to the same verse. Yields a Session; the
    fixture leaves the rows in place — the secret phrase is unique
    enough that we can scan for it cleanly."""
    init_db()
    session = get_session()
    try:
        room_id = f"test-room-{uuid.uuid4()}"
        room = Room(id=room_id, type="group", name="leak-probe")
        session.add(room)
        # Seed a verse + a translation so the retriever has a real
        # anchor to find when called with verse_ref="GEN.1.1".
        if session.get(Verse, "GEN.1.1") is None:
            session.add(Verse(id="GEN.1.1", book="GEN", chapter=1, verse=1))
        if (
            session.query(Translation)
            .filter(
                Translation.verse_id == "GEN.1.1",
                Translation.name == "King James Version",
            )
            .first()
            is None
        ):
            session.add(
                Translation(
                    id=f"KJV:GEN.1.1:{uuid.uuid4().hex[:6]}",
                    name="King James Version",
                    verse_id="GEN.1.1",
                    text="In the beginning God created the heaven and the earth.",
                    license="Public Domain",
                )
            )
        # Personal note — author_user_id intentionally null so the
        # boundary isn't accidentally enforced by an author filter
        # (it should be enforced by scope alone).
        session.add(
            Note(
                id=f"note-personal-{uuid.uuid4()}",
                room_id=room_id,
                author_user_id=None,
                author_is_agent=False,
                scope="personal",
                snapshot={"body": PERSONAL_BODY},
                verse_anchors=["GEN.1.1"],
                tags=[PERSONAL_TAG],
            )
        )
        # Group note — should be visible to the retriever.
        group_body = "GROUP_NOTE_VISIBLE_TO_AGENT_a1b2c3"
        session.add(
            Note(
                id=f"note-group-{uuid.uuid4()}",
                room_id=room_id,
                author_user_id=None,
                author_is_agent=False,
                scope="group",
                snapshot={"body": group_body},
                verse_anchors=["GEN.1.1"],
                tags=[],
            )
        )
        session.commit()
        yield session, room_id, group_body
    finally:
        session.close()


def test_personal_note_text_never_appears_in_retrieval(seeded_session) -> None:
    session, room_id, _group_body = seeded_session
    retriever = SqlRetriever(session)
    chunks = retriever.retrieve(
        verse_ref="GEN.1.1",
        question="What does this verse mean?",
        room_id=room_id,
        scope_kind="verse",
    )
    # Walk every text field of every chunk. The secret phrase must
    # not appear anywhere — body, header, citation id, metadata.
    for c in chunks:
        assert PERSONAL_BODY not in (c.text or ""), (
            f"Personal note body leaked into retrieval (chunk {c.citation_id})."
        )
        assert PERSONAL_TAG not in (c.text or ""), (
            "Personal note tag leaked into retrieval — even metadata "
            "of personal notes is off-limits to the agent."
        )
        # The citation_id is also user-visible (it appears in the
        # Sources panel), so the personal note's id must not leak
        # there either.
        assert "personal" not in (c.citation_id or "").lower() or "note" not in (
            c.citation_id or ""
        ).lower(), (
            "Suspicious: a chunk's citation_id looks like it might "
            f"reference a personal note: {c.citation_id!r}"
        )


def test_group_note_text_does_appear_in_retrieval(seeded_session) -> None:
    """Sanity check the test isn't tautological — group notes
    should still flow through. If this regresses to never finding
    group notes, the personal-leak guard above would also pass
    vacuously."""
    session, room_id, group_body = seeded_session
    retriever = SqlRetriever(session)
    chunks = retriever.retrieve(
        verse_ref="GEN.1.1",
        question="What does this verse mean?",
        room_id=room_id,
        scope_kind="verse",
    )
    # At least one chunk should be a group_note and contain the
    # group body. (`_note_body_text` pulls from snapshot.body.)
    matched = [
        c for c in chunks if c.source_kind == "group_note" and group_body in (c.text or "")
    ]
    assert matched, (
        "Expected the visible group note to appear in retrieval; got "
        f"chunks={[(c.source_kind, c.citation_id) for c in chunks]}"
    )
