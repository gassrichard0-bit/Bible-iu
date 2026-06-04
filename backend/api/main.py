"""FastAPI app.

Endpoints follow architecture.MD §3 (services) and §4 (request flows).
The WebSocket reasoning endpoint streams reasoning → answer through the
orchestrator, which routes the agent through the citation engine and
then the rule middleware (architecture.MD §2).
"""
from __future__ import annotations

import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Optional

from pydantic import BaseModel, Field

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..agent.orchestrator import (
    AgentOrchestrator,
    HistoryTurn as OrchestratorHistoryTurn,
    ReasoningRequest as OrchestratorReq,
)
from ..agent.provenance import InMemoryLedger, SqlLedger
from ..agent.reasoning import CitationEngine, StreamingEvents
from ..agent.skills import (
    DeepSeekGenerator,
    DeepSeekVerifier,
    PassThroughVerifier,
    PlaceholderGenerator,
    SqlRetriever,
)
from ..agent.skills.web_search import make_searcher
from ..data import get_session, init_db
from ..data.models import (
    ChatMessage,
    CrossReference,
    Note,
    NoteComment,
    NoteLike,
    Room,
    RoomInvite,
    RoomMember,
    Translation,
    User,
    Verse,
)
from ..data.repos import UserNoteRepository
from .auth import require_password
from .auth_users import require_user, router as auth_router
from .rate_limit import rate_limit
from . import yjs_sync
from .schemas import (
    AgentNoteAppended,
    AgentNoteOut,
    BibleBook,
    BibleChapter,
    BibleChapterMulti,
    BibleVerse,
    BibleVerseMulti,
    BibleVerseTranslation,
    CrossRefOut,
    ChatMessageCreate,
    ChatMessageRead,
    HealthResponse,
    NoteCreate,
    NoteRead,
    ReasoningRequest,
    ReasoningResponse,
    RoomCreate,
    RoomRead,
    ClaimOut,
    CitationOut,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_db()
    # Persist provenance to the SQL ledger so the audit trail survives a
    # restart (CLAUDE.md §7.5). The Sql session is created per-write so
    # we don't tangle the citation engine with the request session.
    from ..data import SessionLocal
    app.state.ledger = SqlLedger(session_factory=SessionLocal)
    # Yjs CRDT sync server (architecture.MD §3, CLAUDE.md §8).
    await yjs_sync.startup()
    try:
        yield
    finally:
        await yjs_sync.shutdown()


app = FastAPI(title="Bible IU API", lifespan=lifespan)
app.include_router(auth_router)


def db() -> Session:
    s = get_session()
    try:
        yield s
    finally:
        s.close()


def current_user_id(user: User = Depends(require_user)) -> str:
    """Resolves the X-Session-Token header → User row → id.
    Layered with `require_password` on each endpoint: password gate first,
    then session check."""
    return user.id


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


# ---------------------------------------------------------------------------
# Rooms / chat (architecture.MD §4.3)
# ---------------------------------------------------------------------------
@app.post(
    "/rooms",
    response_model=RoomRead,
    dependencies=[Depends(require_password)],
)
def create_room(
    payload: RoomCreate,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomRead:
    room = Room(id=str(uuid.uuid4()), type=payload.type, name=payload.name)
    session.add(room)
    members = set(payload.member_ids) | {user_id}
    for m in members:
        session.add(
            RoomMember(id=str(uuid.uuid4()), room_id=room.id, user_id=m)
        )
    session.commit()
    return RoomRead(id=room.id, type=room.type, name=room.name, scripture_context=dict(room.scripture_context or {}))


@app.get(
    "/rooms",
    response_model=list[RoomRead],
    dependencies=[Depends(require_password)],
)
def list_rooms(
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[RoomRead]:
    """All rooms the current user is a member of."""
    rooms = session.scalars(
        select(Room)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .where(RoomMember.user_id == user_id)
        .order_by(Room.created_at.desc())
    ).all()
    return [RoomRead(id=r.id, type=r.type, name=r.name, scripture_context=dict(r.scripture_context or {})) for r in rooms]


# ---------------------------------------------------------------------------
# Room invites — shareable join tokens (CLAUDE.md §4.3)
# ---------------------------------------------------------------------------
_DEFAULT_INVITE_TTL = timedelta(days=7)


class InviteCreate(BaseModel):
    """All fields optional — defaults: expires in 7 days, unlimited uses."""
    expires_in_days: Optional[int] = Field(default=7, ge=1, le=365)
    max_uses: Optional[int] = Field(default=None, ge=1, le=10_000)


class InviteOut(BaseModel):
    code: str
    room_id: str
    created_by: str
    expires_at: Optional[str]
    max_uses: Optional[int]
    uses: int
    revoked: bool


class InvitePreview(BaseModel):
    """What a recipient sees before joining — minimal info, no PII."""
    room_id: str
    room_name: Optional[str]
    room_type: str
    inviter_handle: str
    inviter_display_name: str
    expires_at: Optional[str]
    can_join: bool
    reason: Optional[str] = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _is_active(inv: RoomInvite, now: datetime) -> tuple[bool, Optional[str]]:
    if inv.revoked_at is not None:
        return False, "invite revoked"
    if inv.expires_at is not None:
        exp = inv.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < now:
            return False, "invite expired"
    if inv.max_uses is not None and inv.uses >= inv.max_uses:
        return False, "invite has reached its use limit"
    return True, None


def _invite_to_response(inv: RoomInvite) -> InviteOut:
    return InviteOut(
        code=inv.code,
        room_id=inv.room_id,
        created_by=inv.created_by,
        expires_at=inv.expires_at.isoformat() if inv.expires_at else None,
        max_uses=inv.max_uses,
        uses=inv.uses,
        revoked=inv.revoked_at is not None,
    )


def _require_member(session: Session, room_id: str, user_id: str) -> Room:
    room = session.get(Room, room_id)
    if room is None:
        raise HTTPException(404, "room not found")
    member = session.scalar(
        select(RoomMember).where(
            RoomMember.room_id == room_id, RoomMember.user_id == user_id
        )
    )
    if member is None:
        raise HTTPException(403, "not a member of this room")
    return room


@app.post(
    "/rooms/{room_id}/invites",
    response_model=InviteOut,
    dependencies=[Depends(require_password)],
)
def create_invite(
    room_id: str,
    payload: InviteCreate,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> InviteOut:
    _require_member(session, room_id, user_id)
    code = secrets.token_urlsafe(12)
    expires_at: Optional[datetime] = None
    if payload.expires_in_days is not None:
        expires_at = _utcnow() + timedelta(days=payload.expires_in_days)
    inv = RoomInvite(
        code=code,
        room_id=room_id,
        created_by=user_id,
        expires_at=expires_at,
        max_uses=payload.max_uses,
    )
    session.add(inv)
    session.commit()
    return _invite_to_response(inv)


@app.get(
    "/rooms/{room_id}/invites",
    response_model=list[InviteOut],
    dependencies=[Depends(require_password)],
)
def list_invites(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[InviteOut]:
    _require_member(session, room_id, user_id)
    invs = session.scalars(
        select(RoomInvite)
        .where(RoomInvite.room_id == room_id)
        .order_by(RoomInvite.created_at.desc())
    ).all()
    return [_invite_to_response(i) for i in invs]


@app.delete(
    "/invites/{code}",
    dependencies=[Depends(require_password)],
)
def revoke_invite(
    code: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict:
    inv = session.get(RoomInvite, code)
    if inv is None:
        raise HTTPException(404, "invite not found")
    # Either the creator or any current room member can revoke.
    member = session.scalar(
        select(RoomMember).where(
            RoomMember.room_id == inv.room_id, RoomMember.user_id == user_id
        )
    )
    if member is None and inv.created_by != user_id:
        raise HTTPException(403, "not allowed to revoke this invite")
    inv.revoked_at = _utcnow()
    session.commit()
    return {"ok": True}


@app.get(
    "/invites/{code}/preview",
    response_model=InvitePreview,
    dependencies=[Depends(require_password)],
)
def preview_invite(
    code: str,
    session: Session = Depends(db),
) -> InvitePreview:
    """Read-only preview — works for signed-out callers (password gate
    only). The recipient sees the room name and who invited them before
    deciding to sign in / register and accept."""
    inv = session.get(RoomInvite, code)
    if inv is None:
        raise HTTPException(404, "invite not found")
    room = session.get(Room, inv.room_id)
    inviter = session.get(User, inv.created_by)
    if room is None or inviter is None:
        raise HTTPException(404, "invite not found")
    active, reason = _is_active(inv, _utcnow())
    return InvitePreview(
        room_id=room.id,
        room_name=room.name,
        room_type=room.type,
        inviter_handle=inviter.handle,
        inviter_display_name=inviter.display_name,
        expires_at=inv.expires_at.isoformat() if inv.expires_at else None,
        can_join=active,
        reason=reason,
    )


@app.post(
    "/invites/{code}/accept",
    response_model=RoomRead,
    dependencies=[Depends(require_password)],
)
def accept_invite(
    code: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomRead:
    inv = session.get(RoomInvite, code)
    if inv is None:
        raise HTTPException(404, "invite not found")
    active, reason = _is_active(inv, _utcnow())
    if not active:
        raise HTTPException(410, reason or "invite no longer valid")
    room = session.get(Room, inv.room_id)
    if room is None:
        raise HTTPException(404, "room no longer exists")
    existing = session.scalar(
        select(RoomMember).where(
            RoomMember.room_id == inv.room_id, RoomMember.user_id == user_id
        )
    )
    if existing is None:
        session.add(
            RoomMember(
                id=str(uuid.uuid4()),
                room_id=inv.room_id,
                user_id=user_id,
            )
        )
        inv.uses += 1
    # Already a member: idempotent, don't bump uses or error.
    session.commit()
    return RoomRead(id=room.id, type=room.type, name=room.name, scripture_context=dict(room.scripture_context or {}))


@app.post(
    "/rooms/{room_id}/chat",
    response_model=ChatMessageRead,
    dependencies=[Depends(require_password)],
)
def post_chat(
    room_id: str,
    payload: ChatMessageCreate,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ChatMessageRead:
    if not session.get(Room, room_id):
        raise HTTPException(404, "room not found")
    msg = ChatMessage(
        id=str(uuid.uuid4()),
        room_id=room_id,
        author_user_id=user_id,
        author_is_agent=False,  # rule-guide.MD §4.10 — agent never posts to chat
        body=payload.body,
        language=payload.language,
    )
    session.add(msg)
    session.commit()
    return ChatMessageRead(
        id=msg.id,
        room_id=msg.room_id,
        author_user_id=msg.author_user_id,
        author_is_agent=msg.author_is_agent,
        body=msg.body,
        language=msg.language,
    )


# ---------------------------------------------------------------------------
# Notes — privacy boundary at the data layer (rule-guide.MD §12)
# ---------------------------------------------------------------------------
@app.post(
    "/rooms/{room_id}/notes",
    response_model=NoteRead,
    dependencies=[Depends(require_password)],
)
def create_note(
    room_id: str,
    payload: NoteCreate,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> NoteRead:
    note = Note(
        id=str(uuid.uuid4()),
        room_id=room_id,
        author_user_id=user_id,
        author_is_agent=False,
        scope=payload.scope,
        snapshot=payload.snapshot,
        verse_anchors=payload.verse_anchors,
        tags=payload.tags,
        language=payload.language,
    )
    session.add(note)
    session.commit()
    return _note_to_read(note)


@app.get(
    "/rooms/{room_id}/notes",
    response_model=list[NoteRead],
    dependencies=[Depends(require_password)],
)
def list_notes(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[NoteRead]:
    repo = UserNoteRepository(session, room_id, user_id)
    return [
        _note_to_read(n)
        for n in (*repo.list_personal(), *repo.list_group())
    ]


# ---------------------------------------------------------------------------
# Notes-as-posts — likes + flat comments on GROUP notes (Settings →
# Social notes toggle). Group-only by design; personal notes never
# expose any UI here (rule-guide.MD §12). Note IDs are the Yjs UUIDs
# the client manages; the server doesn't validate scope, but the
# frontend only renders the UI on group notes, so this is a
# trust-the-client design with low privacy risk (UUIDs are unguessable).
# ---------------------------------------------------------------------------
class NoteCommentOut(BaseModel):
    id: str
    note_id: str
    author_user_id: str
    author_handle: str
    author_display_name: str
    body: str
    created_at: str


class NoteSocialOut(BaseModel):
    likes: int
    liked_by_me: bool
    comments: list[NoteCommentOut]


class NoteCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


@app.get(
    "/rooms/{room_id}/notes/{note_id}/social",
    response_model=NoteSocialOut,
    dependencies=[Depends(require_password)],
)
def get_note_social(
    room_id: str,
    note_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> NoteSocialOut:
    _require_member(session, room_id, user_id)
    likes = session.scalars(
        select(NoteLike).where(NoteLike.note_id == note_id)
    ).all()
    comments = session.scalars(
        select(NoteComment)
        .where(NoteComment.note_id == note_id)
        .order_by(NoteComment.created_at.asc())
    ).all()
    # Bulk-load comment authors (avoid N+1 on small lists).
    author_ids = {c.author_user_id for c in comments}
    authors = (
        {
            u.id: u
            for u in session.scalars(
                select(User).where(User.id.in_(author_ids))
            ).all()
        }
        if author_ids
        else {}
    )
    return NoteSocialOut(
        likes=len(likes),
        liked_by_me=any(l.user_id == user_id for l in likes),
        comments=[
            NoteCommentOut(
                id=c.id,
                note_id=c.note_id,
                author_user_id=c.author_user_id,
                author_handle=authors[c.author_user_id].handle
                if c.author_user_id in authors
                else "?",
                author_display_name=authors[c.author_user_id].display_name
                if c.author_user_id in authors
                else "(unknown)",
                body=c.body,
                created_at=c.created_at.isoformat()
                if c.created_at.tzinfo
                else c.created_at.replace(tzinfo=timezone.utc).isoformat(),
            )
            for c in comments
        ],
    )


@app.post(
    "/rooms/{room_id}/notes/{note_id}/like",
    response_model=NoteSocialOut,
    dependencies=[Depends(require_password)],
)
def toggle_note_like(
    room_id: str,
    note_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> NoteSocialOut:
    _require_member(session, room_id, user_id)
    existing = session.scalar(
        select(NoteLike).where(
            NoteLike.note_id == note_id, NoteLike.user_id == user_id
        )
    )
    if existing is not None:
        session.delete(existing)
    else:
        session.add(
            NoteLike(
                id=str(uuid.uuid4()),
                note_id=note_id,
                user_id=user_id,
                room_id=room_id,
            )
        )
    session.commit()
    return get_note_social(room_id, note_id, session, user_id)


@app.post(
    "/rooms/{room_id}/notes/{note_id}/comments",
    response_model=NoteSocialOut,
    dependencies=[Depends(require_password)],
)
def add_note_comment(
    room_id: str,
    note_id: str,
    payload: NoteCommentCreate,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> NoteSocialOut:
    _require_member(session, room_id, user_id)
    session.add(
        NoteComment(
            id=str(uuid.uuid4()),
            note_id=note_id,
            author_user_id=user_id,
            room_id=room_id,
            body=payload.body.strip(),
        )
    )
    session.commit()
    return get_note_social(room_id, note_id, session, user_id)


@app.delete(
    "/rooms/{room_id}/notes/{note_id}/comments/{comment_id}",
    response_model=NoteSocialOut,
    dependencies=[Depends(require_password)],
)
def delete_note_comment(
    room_id: str,
    note_id: str,
    comment_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> NoteSocialOut:
    _require_member(session, room_id, user_id)
    row = session.get(NoteComment, comment_id)
    if row is None or row.note_id != note_id:
        raise HTTPException(404, "comment not found")
    if row.author_user_id != user_id:
        raise HTTPException(403, "you can only delete your own comments")
    session.delete(row)
    session.commit()
    return get_note_social(room_id, note_id, session, user_id)


def _note_to_read(n: Note) -> NoteRead:
    return NoteRead(
        id=n.id,
        room_id=n.room_id,
        scope=n.scope,
        author_user_id=n.author_user_id,
        author_is_agent=n.author_is_agent,
        snapshot=n.snapshot,
        verse_anchors=n.verse_anchors,
        tags=n.tags,
    )


# ---------------------------------------------------------------------------
# Bible — read-only scripture access (data-model.MD §3)
# ---------------------------------------------------------------------------
# Book name lookup for display. Source of truth for codes is the seed
# script (backend/data/seed_kjv.py); this map is the inverse.
_BOOK_NAMES: dict[str, str] = {
    "GEN": "Genesis", "EXO": "Exodus", "LEV": "Leviticus", "NUM": "Numbers",
    "DEU": "Deuteronomy", "JOS": "Joshua", "JDG": "Judges", "RUT": "Ruth",
    "1SA": "1 Samuel", "2SA": "2 Samuel", "1KI": "1 Kings", "2KI": "2 Kings",
    "1CH": "1 Chronicles", "2CH": "2 Chronicles", "EZR": "Ezra",
    "NEH": "Nehemiah", "EST": "Esther", "JOB": "Job", "PSA": "Psalms",
    "PRO": "Proverbs", "ECC": "Ecclesiastes", "SNG": "Song of Solomon",
    "ISA": "Isaiah", "JER": "Jeremiah", "LAM": "Lamentations",
    "EZK": "Ezekiel", "DAN": "Daniel", "HOS": "Hosea", "JOL": "Joel",
    "AMO": "Amos", "OBA": "Obadiah", "JON": "Jonah", "MIC": "Micah",
    "NAM": "Nahum", "HAB": "Habakkuk", "ZEP": "Zephaniah", "HAG": "Haggai",
    "ZEC": "Zechariah", "MAL": "Malachi", "MAT": "Matthew", "MRK": "Mark",
    "LUK": "Luke", "JHN": "John", "ACT": "Acts", "ROM": "Romans",
    "1CO": "1 Corinthians", "2CO": "2 Corinthians", "GAL": "Galatians",
    "EPH": "Ephesians", "PHP": "Philippians", "COL": "Colossians",
    "1TH": "1 Thessalonians", "2TH": "2 Thessalonians", "1TI": "1 Timothy",
    "2TI": "2 Timothy", "TIT": "Titus", "PHM": "Philemon", "HEB": "Hebrews",
    "JAS": "James", "1PE": "1 Peter", "2PE": "2 Peter", "1JN": "1 John",
    "2JN": "2 John", "3JN": "3 John", "JUD": "Jude", "REV": "Revelation",
}
_BOOK_ORDER: list[str] = list(_BOOK_NAMES.keys())


@app.get(
    "/bible/books",
    response_model=list[BibleBook],
    dependencies=[Depends(require_password)],
)
def list_books(session: Session = Depends(db)) -> list[BibleBook]:
    """Return books in canonical order with their chapter count."""
    from sqlalchemy import func

    rows = session.execute(
        select(Verse.book, func.max(Verse.chapter)).group_by(Verse.book)
    ).all()
    chapters_by_book = {b: c for b, c in rows}
    return [
        BibleBook(
            code=code,
            name=_BOOK_NAMES.get(code, code),
            chapters=chapters_by_book.get(code, 0),
        )
        for code in _BOOK_ORDER
        if code in chapters_by_book
    ]


@app.get(
    "/bible/xrefs/{verse_id}",
    response_model=list[CrossRefOut],
    dependencies=[Depends(require_password)],
)
def list_cross_references(
    verse_id: str,
    translation: str = "King James Version",
    limit: int = 25,
    session: Session = Depends(db),
) -> list[CrossRefOut]:
    """Cross-references for a verse (CLAUDE.md §7.4). Declared BEFORE
    `/bible/{book}/{chapter}` so the dynamic route doesn't shadow it.
    """
    stmt = (
        select(CrossReference)
        .where(CrossReference.from_verse_id == verse_id)
        .limit(limit)
    )
    xrefs = list(session.scalars(stmt))
    if not xrefs:
        return []
    to_ids = [x.to_verse_id for x in xrefs]
    text_by_verse: dict[str, str] = {}
    for t in session.scalars(
        select(Translation).where(
            Translation.verse_id.in_(to_ids),
            Translation.name == translation,
        )
    ):
        text_by_verse[t.verse_id] = t.text
    return [
        CrossRefOut(
            to_verse_id=x.to_verse_id,
            relation_type=x.relation_type,
            text=text_by_verse.get(x.to_verse_id),
        )
        for x in xrefs
    ]


@app.get(
    "/bible/{book}/{chapter}",
    response_model=BibleChapter,
    dependencies=[Depends(require_password)],
)
def get_chapter(
    book: str,
    chapter: int,
    translation: str = "King James Version",
    session: Session = Depends(db),
) -> BibleChapter:
    code = book.upper()
    if code not in _BOOK_NAMES:
        raise HTTPException(404, f"Unknown book: {book}")
    stmt = (
        select(Translation, Verse)
        .join(Verse, Verse.id == Translation.verse_id)
        .where(Verse.book == code, Verse.chapter == chapter,
               Translation.name == translation)
        .order_by(Verse.verse)
    )
    rows = session.execute(stmt).all()
    if not rows:
        raise HTTPException(404, f"No verses for {code} {chapter}")
    verses = [
        BibleVerse(
            verse_id=v.id,
            book=v.book,
            chapter=v.chapter,
            verse=v.verse,
            text=t.text,
            translation=t.name,
            license=t.license,
        )
        for t, v in rows
    ]
    return BibleChapter(
        book=code, chapter=chapter, translation=translation, verses=verses
    )


# RTL languages (CLAUDE.md §4.9). Mapped by translation name so the UI
# can flip direction without having to know about the underlying script.
_RTL_TRANSLATIONS = {"Hebrew (WLC)", "Arabic (SVD)"}


def _direction(translation_name: str) -> str:
    return "rtl" if translation_name in _RTL_TRANSLATIONS else "ltr"


@app.get(
    "/bible/{book}/{chapter}/multi",
    response_model=BibleChapterMulti,
    dependencies=[Depends(require_password)],
)
def get_chapter_multi(
    book: str,
    chapter: int,
    translations: str,  # comma-separated list of translation names
    session: Session = Depends(db),
) -> BibleChapterMulti:
    """Multiple translations per verse — enables the original-language
    toggle (`CLAUDE.md` §2.1, §7.1) and the divergence display (§2.2).
    """
    code = book.upper()
    if code not in _BOOK_NAMES:
        raise HTTPException(404, f"Unknown book: {book}")
    wanted = [t.strip() for t in translations.split(",") if t.strip()]
    if not wanted:
        raise HTTPException(400, "translations query param required")

    stmt = (
        select(Translation, Verse)
        .join(Verse, Verse.id == Translation.verse_id)
        .where(
            Verse.book == code,
            Verse.chapter == chapter,
            Translation.name.in_(wanted),
        )
        .order_by(Verse.verse)
    )
    by_verse: dict[str, BibleVerseMulti] = {}
    for t, v in session.execute(stmt):
        existing = by_verse.get(v.id)
        if existing is None:
            existing = BibleVerseMulti(
                verse_id=v.id,
                book=v.book,
                chapter=v.chapter,
                verse=v.verse,
                translations=[],
            )
            by_verse[v.id] = existing
        existing.translations.append(
            BibleVerseTranslation(
                name=t.name,
                text=t.text,
                direction=_direction(t.name),
                license=t.license,
            )
        )

    if not by_verse:
        raise HTTPException(404, f"No verses for {code} {chapter}")

    # Order translations within each verse by the order the caller asked.
    rank = {name: i for i, name in enumerate(wanted)}
    verses = sorted(by_verse.values(), key=lambda x: x.verse)
    for v in verses:
        v.translations.sort(key=lambda x: rank.get(x.name, 999))
    return BibleChapterMulti(
        book=code, chapter=chapter, translations=wanted, verses=verses
    )


@app.get(
    "/rooms/{room_id}/agent-notes",
    response_model=list[AgentNoteOut],
    dependencies=[Depends(require_password)],
)
def list_agent_notes(
    room_id: str,
    session: Session = Depends(db),
) -> list[AgentNoteOut]:
    """Notes the agent has appended to this room (`rule-guide.MD` §12.2).

    No personal notes here — the AgentNoteRepository never returns them
    (§12.1 enforced at the data layer in `data/repos.py`).
    """
    from ..data.repos import AgentNoteRepository

    repo = AgentNoteRepository(session, room_id)
    out: list[AgentNoteOut] = []
    for n in repo.list_visible():
        if not n.author_is_agent:
            continue
        snap = n.snapshot or {}
        body = (snap.get("body") if isinstance(snap, dict) else "") or ""
        out.append(
            AgentNoteOut(
                id=n.id,
                body=body,
                verse_anchors=list(n.verse_anchors or []),
                created_at=n.created_at.isoformat() if n.created_at else "",
            )
        )
    # Newest first.
    out.sort(key=lambda x: x.created_at, reverse=True)
    return out


# ---------------------------------------------------------------------------
# Reasoning — the core path (architecture.MD §4.1)
# ---------------------------------------------------------------------------
def _orchestrator(session: Session) -> AgentOrchestrator:
    ledger = app.state.ledger
    # If a DeepSeek key is configured at process start, use the real
    # generator + verifier. Otherwise the placeholder pair keeps the
    # pipeline shape intact for tests and offline dev.
    import os as _os
    has_key = bool(_os.environ.get("DEEPSEEK_API_KEY"))
    generator = DeepSeekGenerator() if has_key else PlaceholderGenerator()
    verifier = DeepSeekVerifier() if has_key else PassThroughVerifier()
    # Web search is opt-in via env (BIBLE_IU_WEB_SEARCH=1). Stays off by
    # default so deployments don't accidentally hit the network without
    # consent (rule-guide.MD §8 — rule-bounded sandbox).
    web_enabled = _os.environ.get("BIBLE_IU_WEB_SEARCH", "").strip() == "1"
    engine = CitationEngine(
        retriever=SqlRetriever(session, web_searcher=make_searcher(web_enabled)),
        generator=generator,
        verifier=verifier,
        ledger=ledger,
    )
    return AgentOrchestrator(engine=engine, ledger=ledger)


@app.post(
    "/reason",
    response_model=ReasoningResponse,
    dependencies=[Depends(require_password), Depends(rate_limit)],
)
def reason(
    payload: ReasoningRequest,
    session: Session = Depends(db),
) -> ReasoningResponse:
    orch = _orchestrator(session)
    turn = orch.reason(
        OrchestratorReq(
            room_id=payload.room_id,
            session_id=str(uuid.uuid4()),
            verse_ref=payload.verse_ref,
            question=payload.question,
            target_language=payload.target_language,
            history=[
                OrchestratorHistoryTurn(
                    verse_ref=h.verse_ref,
                    question=h.question,
                    answer=h.answer,
                )
                for h in payload.history
            ],
            bypass_citation_engine=payload.bypass_citation_engine,
        )
    )
    # Persist the agent's note only if the turn passed the rule layer
    # (Decision.PASS). Refused/revised turns never write notes.
    note_appended = None
    if turn.decision.value == "pass" and turn.note_to_append:
        note_appended = _persist_agent_note(
            session, payload.room_id, turn.note_to_append
        )
    return _turn_to_response(turn, note_appended=note_appended)


@app.websocket("/ws/yjs/{room_id}")
async def yjs_endpoint(ws: WebSocket, room_id: str) -> None:
    """CRDT sync per room. Uses pycrdt's Y-protocol (SyncStep1/2 +
    Updates) so any standard `y-websocket` client speaks it directly.
    Same password gate as the rest of the API via `?password=` query
    param.
    """
    await yjs_sync.handle_yjs(ws, room_id)


@app.websocket("/ws/reason")
async def reason_ws(ws: WebSocket) -> None:
    """Streaming reasoning endpoint (CLAUDE.md §4.5 step 3, §4.9).

    Wire protocol (server → client):
      {type: "stage", name: "retrieving" | "generating" | "verifying", count?: int}
      {type: "reasoning_chunk", text: "..."}        # chain-of-thought delta
      {type: "result", ...full ReasoningResponse}    # post-citation-engine

    Auth: pass the app password as `?password=...` (browsers can't set
    custom headers on WS handshakes). If `BIBLE_IU_PASSWORD` is unset on
    the server, no auth is required (matches the HTTP gate's behavior).
    """
    import asyncio
    import os as _os

    await ws.accept()
    expected = (_os.environ.get("BIBLE_IU_PASSWORD") or "").strip() or None
    if expected is not None:
        provided = ws.query_params.get("password", "")
        if provided != expected:
            await ws.close(code=4001, reason="Unauthorized")
            return

    session = get_session()
    loop = asyncio.get_event_loop()

    try:
        while True:
            payload = await ws.receive_json()
            req = ReasoningRequest(**payload)
            orch = _orchestrator(session)

            queue: asyncio.Queue = asyncio.Queue()

            def on_stage(name: str, count=None) -> None:
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    ("stage", {"name": name, "count": count}),
                )

            def on_chunk(text: str) -> None:
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    ("reasoning_chunk", {"text": text}),
                )

            events = StreamingEvents(
                on_stage=on_stage, on_reasoning_chunk=on_chunk
            )

            async def run_reason() -> None:
                try:
                    turn = await loop.run_in_executor(
                        None,
                        lambda: orch.reason(
                            OrchestratorReq(
                                room_id=req.room_id,
                                session_id=str(uuid.uuid4()),
                                verse_ref=req.verse_ref,
                                question=req.question,
                                target_language=req.target_language,
                                history=[
                                    OrchestratorHistoryTurn(
                                        verse_ref=h.verse_ref,
                                        question=h.question,
                                        answer=h.answer,
                                    )
                                    for h in req.history
                                ],
                                bypass_citation_engine=req.bypass_citation_engine,
                            ),
                            events,
                        ),
                    )
                    queue.put_nowait(("done", turn))
                except Exception as e:  # noqa: BLE001
                    queue.put_nowait(("error", {"message": str(e)}))

            task = asyncio.create_task(run_reason())

            while True:
                kind, data = await queue.get()
                if kind == "done":
                    note_appended = None
                    if data.decision.value == "pass" and data.note_to_append:
                        note_appended = _persist_agent_note(
                            session, req.room_id, data.note_to_append
                        )
                    await ws.send_json(
                        {
                            "type": "result",
                            **_turn_to_response(
                                data, note_appended=note_appended
                            ).model_dump(),
                        }
                    )
                    break
                if kind == "error":
                    await ws.send_json({"type": "error", **data})
                    break
                await ws.send_json({"type": kind, **data})

            await task
    except WebSocketDisconnect:
        return
    finally:
        session.close()


def _persist_agent_note(
    session: Session,
    room_id: str,
    suggestion,
) -> Optional[AgentNoteAppended]:
    """Persist an agent-suggested group note (`rule-guide.MD` §12.2).

    Always: author_is_agent=True, scope='group'. If the room isn't in
    the DB (e.g. demo seed rooms), skip silently — the agent's note
    only ships when there's a real room to anchor it to.
    """
    if suggestion is None:
        return None
    room = session.get(Room, room_id)
    if room is None:
        return None
    body = (suggestion.body or "").strip()
    if not body:
        return None
    anchors = [suggestion.verse_anchor] if suggestion.verse_anchor else []
    note = Note(
        id=str(uuid.uuid4()),
        room_id=room_id,
        author_user_id=None,
        author_is_agent=True,
        scope="group",
        snapshot={"body": body},
        verse_anchors=anchors,
        tags=[],
        language=None,
    )
    session.add(note)
    session.commit()
    return AgentNoteAppended(
        id=note.id,
        body=body,
        verse_anchor=suggestion.verse_anchor,
    )


def _turn_to_response(
    turn,
    note_appended: Optional[AgentNoteAppended] = None,
) -> ReasoningResponse:
    return ReasoningResponse(
        decision=turn.decision.value,
        reasoning=turn.grounded.reasoning,
        answer=turn.grounded.answer,
        claims=[_claim_out(c, turn.grounded.retrieval) for c in turn.grounded.claims],
        dropped=[_claim_out(c, turn.grounded.retrieval) for c in turn.grounded.dropped],
        revision_hints=turn.revision_hints,
        refusal_reason=turn.refusal_reason,
        note_appended=note_appended,
    )


def _claim_out(c, retrieval) -> ClaimOut:
    by_id = {r.citation_id: r for r in retrieval}
    return ClaimOut(
        text=c.text,
        kind=c.kind,
        contradicts_scripture=c.contradicts_scripture,
        citations=[
            CitationOut(
                source_id=cid,
                verse_refs=by_id[cid].verse_refs if cid in by_id else [],
                tradition=by_id[cid].tradition if cid in by_id else None,
                reliability=by_id[cid].reliability if cid in by_id else None,
                verification_result=c.verification,
            )
            for cid in c.citation_ids
        ],
    )
