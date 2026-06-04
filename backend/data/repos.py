"""Repositories that bake privacy invariants into every read.

The `AgentNoteRepository` exposes only group notes (rule-guide.MD §12.1).
The `UserNoteRepository` requires an owner id and never returns notes
belonging to another user when the scope is personal.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Note


class AgentNoteRepository:
    """The only note repository the agent code is allowed to import."""

    def __init__(self, session: Session, room_id: str) -> None:
        self.session = session
        self.room_id = room_id

    def list_visible(self) -> list[Note]:
        stmt = select(Note).where(
            Note.room_id == self.room_id,
            Note.scope == "group",
        )
        return list(self.session.scalars(stmt))


class UserNoteRepository:
    def __init__(self, session: Session, room_id: str, user_id: str) -> None:
        self.session = session
        self.room_id = room_id
        self.user_id = user_id

    def list_personal(self) -> list[Note]:
        stmt = select(Note).where(
            Note.room_id == self.room_id,
            Note.scope == "personal",
            Note.author_user_id == self.user_id,
        )
        return list(self.session.scalars(stmt))

    def list_group(self) -> list[Note]:
        stmt = select(Note).where(
            Note.room_id == self.room_id,
            Note.scope == "group",
        )
        return list(self.session.scalars(stmt))

    def get(self, note_id: str) -> Optional[Note]:
        note = self.session.get(Note, note_id)
        if note is None:
            return None
        if note.room_id != self.room_id:
            return None
        if note.scope == "personal" and note.author_user_id != self.user_id:
            return None
        return note
