"""Repositories that bake privacy invariants into every read.

The `AgentNoteRepository` exposes only group notes (rule-guide.MD §12.1).
The `UserNoteRepository` requires an owner id and never returns notes
belonging to another user when the scope is personal.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Note, NoteComment, User


class AgentNoteRepository:
    """The only note repository the agent code is allowed to import.

    Reads are restricted to `scope='group'` notes (rule-guide.MD
    §12.1 keeps personal notes invisible to the agent) — and only
    within `room_id`, so a room can't see another room's notes.

    The agent has NO chat read path at all by design: there is no
    `list_chat_messages()` method here, and the retriever in
    `agent/skills/default_backends.py` never imports `ChatMessage`.
    """

    def __init__(self, session: Session, room_id: str) -> None:
        self.session = session
        self.room_id = room_id

    def list_visible(self) -> list[Note]:
        stmt = select(Note).where(
            Note.room_id == self.room_id,
            Note.scope == "group",
        )
        return list(self.session.scalars(stmt))

    def comments_for(self, note_id: str) -> list[tuple[NoteComment, str]]:
        """Flat list of comments on a single group note, paired with
        the commenter's handle for attribution. Comments inherit the
        oversight rule of the parent note — they live alongside a
        group-scope note, so they're visible to the agent. Used by
        the retriever to fold debate threads into agent context."""
        stmt = (
            select(NoteComment, User)
            .outerjoin(User, User.id == NoteComment.author_user_id)
            .where(
                NoteComment.note_id == note_id,
                NoteComment.room_id == self.room_id,
            )
            .order_by(NoteComment.created_at.asc())
        )
        return [
            (c, u.handle if u else "deleted user")
            for c, u in self.session.execute(stmt).all()
        ]


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
