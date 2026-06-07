"""FastAPI app.

Endpoints follow architecture.MD §3 (services) and §4 (request flows).
The WebSocket reasoning endpoint streams reasoning → answer through the
orchestrator, which routes the agent through the citation engine and
then the rule middleware (architecture.MD §2).
"""
from __future__ import annotations

import asyncio
import os
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

from pydantic import BaseModel, Field

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text
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
    ChatReaction,
    CrossReference,
    Note,
    NoteComment,
    NoteLike,
    ReadingPlanEnrollment,
    ReadingPlanProgress,
    RegisteredGroupNote,
    Room,
    RoomInvite,
    RoomMember,
    Translation,
    User,
    Verse,
)
from ..data.repos import UserNoteRepository
from .auth import require_password
from .auth_users import require_user, router as auth_router, resolve_user
from .observability import configure_logging, configure_sentry
from .rate_limit import rate_limit
from . import chat_hub, reading_plans, yjs_sync
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
    configure_logging()
    configure_sentry()
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


@app.get("/healthz")
def healthz(session: Session = Depends(db)) -> JSONResponse:
    """Deep readiness probe. Verifies the DB is reachable and reports
    whether the reasoning backend has a real API key configured. Used
    by Fly's healthcheck + the password-gate's pre-flight check."""
    db_ok = False
    try:
        session.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return JSONResponse(
        {
            "ok": db_ok,
            "db": db_ok,
            "reasoning": bool(os.getenv("DEEPSEEK_API_KEY")),
            "yjs": yjs_sync.is_running(),
        },
        status_code=200 if db_ok else 503,
    )


# ---------------------------------------------------------------------------
# Rooms / chat (architecture.MD §4.3)
# ---------------------------------------------------------------------------
def _room_image_url(room: Room) -> Optional[str]:
    """Public URL the frontend uses to render this room's avatar. The
    `?v=` query string is the `image_token` so the URL changes on
    every upload — without it, browsers happily cache the prior image
    for hours after a replacement. None when no image is set."""
    if not getattr(room, "image_token", None):
        return None
    return f"/rooms/{room.id}/image?v={room.image_token}"


def _room_read(
    room: Room,
    role: Optional[str],
    unread_count: int = 0,
) -> RoomRead:
    return RoomRead(
        id=room.id,
        type=room.type,
        name=room.name,
        scripture_context=dict(room.scripture_context or {}),
        role=role,
        image_url=_room_image_url(room),
        accent_color=getattr(room, "accent_color", None),
        unread_count=unread_count,
    )


def _unread_count(session: Session, room_id: str, user_id: str) -> int:
    """How many chat messages in `room_id` are newer than the user's
    `last_read_at` and weren't written by them. Treats null
    last_read_at as the room-member's join time so a brand-new member
    sees a (potentially huge) backlog as zero, not all-of-history."""
    member = (
        session.query(RoomMember)
        .filter(
            RoomMember.room_id == room_id, RoomMember.user_id == user_id
        )
        .one_or_none()
    )
    if member is None:
        return 0
    cutoff = member.last_read_at or member.created_at
    if cutoff is None:
        # Defensive fallback — shouldn't happen since TimestampMixin
        # supplies created_at, but if it does treat as fully read.
        return 0
    return (
        session.query(ChatMessage)
        .filter(
            ChatMessage.room_id == room_id,
            ChatMessage.created_at > cutoff,
            ChatMessage.author_user_id != user_id,
        )
        .count()
    )


# Palette of accent colors an admin can pick for their group. Keep the
# server-side allow-list small + literal so a malformed client can't
# inject arbitrary CSS via the column. The frontend maps each key to
# real CSS values (see `frontend/src/lib/accentColors.ts`).
ROOM_ACCENT_PALETTE: tuple[str, ...] = (
    "amber",
    "rose",
    "violet",
    "sky",
    "emerald",
    "lime",
    "fuchsia",
    "slate",
)


class AccentPatch(BaseModel):
    """`null` clears the override and the frontend reverts to the
    auto-derived color. Any other value must be in the palette."""
    accent_color: Optional[str]


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
    # Group rooms get an admin; direct (1:1) rooms don't need the
    # concept since there's nothing to administrate between two
    # equals.
    my_role = "admin" if payload.type == "group" else "member"
    for m in members:
        role = "admin" if (m == user_id and payload.type == "group") else "member"
        session.add(
            RoomMember(
                id=str(uuid.uuid4()),
                room_id=room.id,
                user_id=m,
                role=role,
            )
        )
    session.commit()
    return _room_read(room, my_role)


@app.post(
    "/dm/{target_user_id}",
    response_model=RoomRead,
    dependencies=[Depends(require_password)],
)
def open_direct_message(
    target_user_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomRead:
    """Find-or-create the direct room between the caller and `target_user_id`.

    Idempotent: tapping the same user twice returns the same room.
    The two participants are stored as `RoomMember(role="member")`
    rows on a `type="direct"` room — same shape as group rooms, so
    chat / unread / image features all just work.
    """
    if target_user_id == user_id:
        raise HTTPException(400, "Can't DM yourself.")
    target = session.get(User, target_user_id)
    if target is None:
        raise HTTPException(404, "User not found.")
    # Look for an existing direct room that contains exactly both
    # users. SQLite's GROUP BY is fine here; the row count per room
    # is tiny (1:1 rooms have 2 members).
    self_rooms = {
        r.room_id
        for r in session.query(RoomMember)
        .filter(RoomMember.user_id == user_id)
        .all()
    }
    if self_rooms:
        candidate = (
            session.query(Room)
            .filter(Room.id.in_(self_rooms), Room.type == "direct")
            .all()
        )
        for room in candidate:
            members = {
                m.user_id
                for m in session.query(RoomMember).filter(
                    RoomMember.room_id == room.id
                )
            }
            if members == {user_id, target_user_id}:
                return _room_read(
                    room, "member", _unread_count(session, room.id, user_id)
                )
    # No existing room — create a fresh direct room.
    room = Room(
        id=str(uuid.uuid4()),
        type="direct",
        name=target.display_name or target.handle,
    )
    session.add(room)
    session.add(
        RoomMember(
            id=str(uuid.uuid4()),
            room_id=room.id,
            user_id=user_id,
            role="member",
        )
    )
    session.add(
        RoomMember(
            id=str(uuid.uuid4()),
            room_id=room.id,
            user_id=target_user_id,
            role="member",
        )
    )
    session.commit()
    return _room_read(room, "member", 0)


@app.get(
    "/rooms",
    response_model=list[RoomRead],
    dependencies=[Depends(require_password)],
)
def list_rooms(
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[RoomRead]:
    """All rooms the current user is a member of, with the user's role
    in each room so the Profile UI can flag the ones they administrate."""
    rows = (
        session.query(Room, RoomMember.role)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .filter(RoomMember.user_id == user_id)
        .order_by(Room.created_at.desc())
        .all()
    )
    return [
        _room_read(r, role, _unread_count(session, r.id, user_id))
        for r, role in rows
    ]


# ---------------------------------------------------------------------------
# Room administration — admin-only endpoints for member + agent control.
#
# Authority model:
#   • The room creator is auto-promoted to 'admin' on `POST /rooms`.
#   • Admins can: list members (with roles), promote/demote, remove
#     anyone except the last admin, and edit per-room agent settings.
#   • Members can: see who's in the room (via /members), but not change
#     anyone or anything.
#   • Direct (1:1) rooms have no admin concept; all admin endpoints
#     return 400 there.
# ---------------------------------------------------------------------------
class RoomMemberOut(BaseModel):
    user_id: str
    handle: str
    display_name: str
    role: str  # 'admin' | 'member'
    joined_at: str


class RoomMemberPatch(BaseModel):
    role: str = Field(pattern=r"^(admin|member)$")


class AgentSettings(BaseModel):
    """Per-room agent + safety controls. Conservative defaults so a
    fresh room is safe out of the box. Admins relax as needed."""
    agent_enabled: bool = True
    allow_web_search: bool = False
    allow_external_links: bool = False
    bypass_citation_engine_allowed: bool = False
    max_questions_per_user_per_day: Optional[int] = None


def _agent_settings(room: Room) -> AgentSettings:
    return AgentSettings(**dict(room.agent_settings or {}))


@app.get(
    "/rooms/{room_id}/members",
    response_model=list[RoomMemberOut],
    dependencies=[Depends(require_password)],
)
def list_members(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[RoomMemberOut]:
    """Every member of the room can see the membership list. Names + roles
    only — no email, phone, or session data."""
    _require_member(session, room_id, user_id)
    rows = (
        session.query(RoomMember, User)
        .join(User, User.id == RoomMember.user_id)
        .filter(RoomMember.room_id == room_id)
        .order_by(RoomMember.created_at.asc())
        .all()
    )
    out: list[RoomMemberOut] = []
    for m, u in rows:
        joined = m.created_at
        if joined.tzinfo is None:
            joined = joined.replace(tzinfo=timezone.utc)
        out.append(
            RoomMemberOut(
                user_id=u.id,
                handle=u.handle,
                display_name=u.display_name,
                role=m.role,
                joined_at=joined.isoformat(),
            )
        )
    return out


@app.patch(
    "/rooms/{room_id}/members/{target_user_id}",
    response_model=RoomMemberOut,
    dependencies=[Depends(require_password)],
)
def patch_member(
    room_id: str,
    target_user_id: str,
    payload: RoomMemberPatch,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomMemberOut:
    """Promote a member to admin, or demote an admin to member.
    Refuses to demote the last admin so the room can't get stranded."""
    _require_admin(session, room_id, user_id)
    target = session.scalar(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.user_id == target_user_id,
        )
    )
    if target is None:
        raise HTTPException(404, "user is not a member of this room")
    if payload.role == "member" and target.role == "admin":
        # Don't strand the room — at least one admin must remain.
        other_admins = session.scalar(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.role == "admin",
                RoomMember.user_id != target_user_id,
            )
        )
        if other_admins is None:
            raise HTTPException(
                400, "promote another member first; can't demote the last admin"
            )
    target.role = payload.role
    session.commit()
    session.refresh(target)
    user = session.get(User, target.user_id)
    assert user is not None  # FK guarantee
    joined = target.created_at
    if joined.tzinfo is None:
        joined = joined.replace(tzinfo=timezone.utc)
    return RoomMemberOut(
        user_id=user.id,
        handle=user.handle,
        display_name=user.display_name,
        role=target.role,
        joined_at=joined.isoformat(),
    )


@app.delete(
    "/rooms/{room_id}/members/{target_user_id}",
    dependencies=[Depends(require_password)],
)
def remove_member(
    room_id: str,
    target_user_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict:
    """Admin removes a member. Removing the last admin is rejected for
    the same stranding reason as demotion. Admins removing themselves
    is allowed only if another admin exists."""
    _require_admin(session, room_id, user_id)
    target = session.scalar(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.user_id == target_user_id,
        )
    )
    if target is None:
        raise HTTPException(404, "user is not a member of this room")
    if target.role == "admin":
        other_admins = session.scalar(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.role == "admin",
                RoomMember.user_id != target_user_id,
            )
        )
        if other_admins is None:
            raise HTTPException(
                400, "promote another member to admin first"
            )
    session.delete(target)
    session.commit()
    return {"ok": True}


@app.get(
    "/rooms/{room_id}/agent_settings",
    response_model=AgentSettings,
    dependencies=[Depends(require_password)],
)
def get_agent_settings(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> AgentSettings:
    """All members can read settings (they need to know whether the
    agent is on, web search is enabled, etc.). Only admins can change."""
    room = _require_member(session, room_id, user_id)
    return _agent_settings(room)


@app.patch(
    "/rooms/{room_id}/agent_settings",
    response_model=AgentSettings,
    dependencies=[Depends(require_password)],
)
def patch_agent_settings(
    room_id: str,
    payload: AgentSettings,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> AgentSettings:
    room = _require_admin(session, room_id, user_id)
    room.agent_settings = payload.model_dump()
    session.commit()
    session.refresh(room)
    return _agent_settings(room)


# ---------------------------------------------------------------------------
# Room avatar — admin-managed image, served back to all members.
# Files live on the local filesystem; uploads are re-encoded to webp
# at a sane max dimension so we don't hand the network a 10MB iPhone
# photo every time a chat row scrolls into view.
# ---------------------------------------------------------------------------
_UPLOADS_DIR = (
    Path(os.environ.get("BIBLE_IU_UPLOADS_DIR", ""))
    if os.environ.get("BIBLE_IU_UPLOADS_DIR")
    else Path(__file__).resolve().parent.parent / "data" / "uploads"
)
_ROOM_IMAGES_DIR = _UPLOADS_DIR / "rooms"
# Upload cap is generous because modern phone cameras emit 10-20MB
# JPEGs and the server downscales + re-encodes everything to WebP at
# 512px anyway. The on-disk artifact is < 50KB regardless of input.
_ROOM_IMAGE_MAX_BYTES = 20 * 1024 * 1024
_ROOM_IMAGE_MAX_SIDE = 512  # px — plenty for a chat-row avatar


def _room_image_path(room_id: str) -> Path:
    return _ROOM_IMAGES_DIR / f"{room_id}.webp"


class RoomImageOut(BaseModel):
    image_url: Optional[str]


@app.post(
    "/rooms/{room_id}/image",
    response_model=RoomImageOut,
    dependencies=[Depends(require_password)],
)
async def upload_room_image(
    room_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomImageOut:
    """Admin-only. Accepts JPEG/PNG/WebP up to 4MB, re-encodes to
    WebP at ≤512px on the longest side. The token bump invalidates
    the browser cache for every member viewing the room list."""
    room = _require_admin(session, room_id, user_id)
    raw = await file.read()
    if len(raw) > _ROOM_IMAGE_MAX_BYTES:
        raise HTTPException(413, "Image too large (max 4MB).")
    # Lazy import — Pillow isn't needed by the rest of the API and
    # adds ~10MB of process memory we only want paid for on upload.
    from io import BytesIO
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(BytesIO(raw)) as im:
            im.load()
            # EXIF rotate so portraits taken on a phone aren't
            # rendered sideways. iPhone photos rely on this.
            from PIL.ImageOps import exif_transpose

            im = exif_transpose(im)
            im.thumbnail((_ROOM_IMAGE_MAX_SIDE, _ROOM_IMAGE_MAX_SIDE))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            _ROOM_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
            out_path = _room_image_path(room.id)
            im.save(out_path, format="WEBP", quality=82, method=4)
    except UnidentifiedImageError:
        raise HTTPException(415, "Unsupported image format.")

    room.image_token = uuid.uuid4().hex[:12]
    session.commit()
    return RoomImageOut(image_url=_room_image_url(room))


@app.delete(
    "/rooms/{room_id}/image",
    response_model=RoomImageOut,
    dependencies=[Depends(require_password)],
)
def delete_room_image(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomImageOut:
    """Admin-only. Removes the file and clears the token so the
    frontend falls back to the gradient/initials avatar."""
    room = _require_admin(session, room_id, user_id)
    path = _room_image_path(room.id)
    if path.exists():
        try:
            path.unlink()
        except OSError:
            # Best-effort; token clear below is the actual source of
            # truth for the UI.
            pass
    room.image_token = None
    session.commit()
    return RoomImageOut(image_url=None)


@app.get("/rooms/{room_id}/image")
def get_room_image(
    room_id: str,
    request: Request,
    session: Session = Depends(db),
) -> FileResponse:
    """Members only — the image is private to the room. Browser
    `<img>` loaders can't send custom headers, so this handler accepts
    the deployment password + session token via either header OR query
    string (`?password=...&session=...`). Clients also append
    `?v=<image_token>` for cache busting; the server ignores its value.
    """
    pw = request.headers.get("X-App-Password") or request.query_params.get("password")
    expected = os.getenv("BIBLE_IU_PASSWORD") or ""
    if expected and pw != expected:
        raise HTTPException(401, "App password required.")
    token = request.headers.get("X-Session-Token") or request.query_params.get("session")
    user = resolve_user(token) if token else None
    if user is None:
        raise HTTPException(401, "not signed in")
    _require_member(session, room_id, user.id)
    path = _room_image_path(room_id)
    if not path.exists():
        raise HTTPException(404, "No image set for this room.")
    return FileResponse(
        str(path),
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400"},
    )


class ReadAck(BaseModel):
    """Response from POST /rooms/{id}/read."""
    unread_count: int


@app.post(
    "/rooms/{room_id}/read",
    response_model=ReadAck,
    dependencies=[Depends(require_password)],
)
def mark_room_read(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ReadAck:
    """Bumps the caller's `last_read_at` to now in `room_id`. Idempotent.
    Frontend calls this when the user opens a room's Chat tab so the
    in-app unread badge clears."""
    member = (
        session.query(RoomMember)
        .filter(
            RoomMember.room_id == room_id, RoomMember.user_id == user_id
        )
        .one_or_none()
    )
    if member is None:
        raise HTTPException(403, "Not a member of this room.")
    member.last_read_at = datetime.now(timezone.utc)
    session.commit()
    return ReadAck(unread_count=_unread_count(session, room_id, user_id))


@app.patch(
    "/rooms/{room_id}/accent",
    response_model=RoomRead,
    dependencies=[Depends(require_password)],
)
def patch_room_accent(
    room_id: str,
    payload: AccentPatch,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomRead:
    """Admin-only. Sets or clears the room's accent color. Validates
    the value against `ROOM_ACCENT_PALETTE` so the column can never
    hold an arbitrary string the frontend doesn't know about."""
    room = _require_admin(session, room_id, user_id)
    value = payload.accent_color
    if value is not None and value not in ROOM_ACCENT_PALETTE:
        raise HTTPException(400, f"accent_color must be one of {', '.join(ROOM_ACCENT_PALETTE)} or null")
    room.accent_color = value
    session.commit()
    session.refresh(room)
    # Caller's role doesn't change here, but the response reflects the
    # caller's perspective so just re-read it.
    role = (
        session.query(RoomMember.role)
        .filter(RoomMember.room_id == room.id, RoomMember.user_id == user_id)
        .scalar()
    )
    return _room_read(room, role)


class QuotaStatus(BaseModel):
    """Per-room, per-day quota snapshot for the caller. `limit=None`
    means the room admin has not set a cap (unlimited)."""
    limit: Optional[int]
    used: int
    remaining: Optional[int]


@app.get(
    "/rooms/{room_id}/quota",
    response_model=QuotaStatus,
    dependencies=[Depends(require_password)],
)
def get_room_quota(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> QuotaStatus:
    """Mirrors the in-memory counter that `_enforce_daily_quota` writes
    to. Best-effort and single-instance only — the frontend uses it for
    a hint ("3 questions left today") not for hard enforcement."""
    room = _require_member(session, room_id, user_id)
    settings = _agent_settings(room)
    limit = settings.max_questions_per_user_per_day
    today = datetime.now(timezone.utc).date().isoformat()
    used = _DAILY_COUNTS.get((user_id, room_id, today), 0)
    remaining = max(limit - used, 0) if limit is not None else None
    return QuotaStatus(limit=limit, used=used, remaining=remaining)


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


def _require_admin(session: Session, room_id: str, user_id: str) -> Room:
    """Gate for admin-only endpoints. Verifies membership AND admin role
    in a single round-trip. Direct (1:1) rooms have no admin concept —
    every operation that would require admin is rejected on those."""
    room = session.get(Room, room_id)
    if room is None:
        raise HTTPException(404, "room not found")
    if room.type != "group":
        raise HTTPException(400, "this room has no admin role")
    member = session.scalar(
        select(RoomMember).where(
            RoomMember.room_id == room_id, RoomMember.user_id == user_id
        )
    )
    if member is None:
        raise HTTPException(403, "not a member of this room")
    if member.role != "admin":
        raise HTTPException(403, "admin only")
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
    # Reflect the joiner's resolved role so the UI's role-gated chrome
    # (admin badge, settings access) is correct on the very first
    # /rooms/{id}/join response — no extra GET required.
    joined_role = (
        session.query(RoomMember.role)
        .filter(RoomMember.room_id == room.id, RoomMember.user_id == user_id)
        .scalar()
    )
    return _room_read(
        room, joined_role, _unread_count(session, room.id, user_id)
    )


def _chat_reactions_for(
    session: Session,
    message_ids: list[str],
    viewer_id: str,
) -> dict[str, list[dict]]:
    """Aggregate reactions by message_id into [{emoji, count, mine}]."""
    if not message_ids:
        return {}
    rows = (
        session.query(ChatReaction)
        .filter(ChatReaction.message_id.in_(message_ids))
        .all()
    )
    bucket: dict[str, dict[str, dict]] = {}
    for r in rows:
        msg_bucket = bucket.setdefault(r.message_id, {})
        cell = msg_bucket.setdefault(
            r.emoji, {"emoji": r.emoji, "count": 0, "mine": False}
        )
        cell["count"] += 1
        if r.user_id == viewer_id:
            cell["mine"] = True
    return {mid: list(cells.values()) for mid, cells in bucket.items()}


def _chat_attachment_url(msg: ChatMessage) -> Optional[str]:
    """Cache-busted URL for the message's image attachment, if any.
    Same auth-via-query-string pattern used elsewhere."""
    token = getattr(msg, "attachment_image_token", None)
    if not token:
        return None
    return f"/rooms/{msg.room_id}/chat/{msg.id}/image?v={token}"


def _serialize_chat(
    msg: ChatMessage,
    author: User | None,
    parent: ChatMessage | None = None,
    parent_author: User | None = None,
    reactions: list[dict] | None = None,
) -> ChatMessageRead:
    created = msg.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return ChatMessageRead(
        id=msg.id,
        room_id=msg.room_id,
        author_user_id=msg.author_user_id,
        author_is_agent=msg.author_is_agent,
        body=msg.body,
        language=msg.language,
        author_handle=(author.handle if author else None),
        author_display_name=(author.display_name if author else None),
        author_avatar_url=_resolved_user_avatar_url(author) if author else None,
        attachment_image_url=_chat_attachment_url(msg),
        reply_to_id=getattr(msg, "reply_to_id", None),
        reply_to_body=parent.body if parent else None,
        reply_to_author_handle=(
            parent_author.handle if parent_author else None
        ),
        reply_to_has_image=(
            bool(getattr(parent, "attachment_image_token", None))
            if parent
            else False
        ),
        reactions=reactions or [],
        created_at=created.isoformat(),
    )


def _resolved_user_avatar_url(user: User) -> Optional[str]:
    """Mirror of `auth_users._resolved_avatar_url`. Re-implemented
    here to avoid a circular import — the chat hub already pulls user
    rows through this serializer thousands of times an hour, so we
    keep the helper free of any extra dependencies."""
    token = getattr(user, "avatar_image_token", None)
    if token:
        return f"/auth/users/{user.id}/image?v={token}"
    return user.avatar_url


@app.get(
    "/rooms/{room_id}/chat",
    response_model=list[ChatMessageRead],
    dependencies=[Depends(require_password)],
)
def list_chat(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
    limit: int = 100,
) -> list[ChatMessageRead]:
    """Return the most recent `limit` messages in chronological order.
    Members only. Capped at 500 so a single fetch can't blow up the
    client."""
    _require_member(session, room_id, user_id)
    limit = max(1, min(limit, 500))
    rows = (
        session.query(ChatMessage)
        .filter(ChatMessage.room_id == room_id)
        .order_by(ChatMessage.created_at.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    # Build the author map AND the parent map in one shot. The parent
    # map covers any reply_to_id pointing at a message older than our
    # current window — we still want a preview, just not the whole
    # parent's payload.
    author_ids = {r.author_user_id for r in rows if r.author_user_id}
    parent_ids = {r.reply_to_id for r in rows if r.reply_to_id}
    parents: dict[str, ChatMessage] = {}
    if parent_ids:
        for p in session.scalars(
            select(ChatMessage).where(ChatMessage.id.in_(parent_ids))
        ):
            parents[p.id] = p
            if p.author_user_id:
                author_ids.add(p.author_user_id)
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
    reactions_by_msg = _chat_reactions_for(
        session, [r.id for r in rows], user_id
    )
    out: list[ChatMessageRead] = []
    for m in rows:
        parent = parents.get(m.reply_to_id) if m.reply_to_id else None
        parent_author = (
            authors.get(parent.author_user_id)
            if parent and parent.author_user_id
            else None
        )
        out.append(
            _serialize_chat(
                m,
                authors.get(m.author_user_id) if m.author_user_id else None,
                parent,
                parent_author,
                reactions_by_msg.get(m.id, []),
            )
        )
    return out


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
    _require_member(session, room_id, user_id)
    # Validate the reply target — must exist and belong to the same
    # room (otherwise a malicious client could quote a private DM in
    # a public group).
    parent: ChatMessage | None = None
    if payload.reply_to_id:
        parent = session.get(ChatMessage, payload.reply_to_id)
        if parent is None or parent.room_id != room_id:
            raise HTTPException(400, "Invalid reply_to_id for this room.")
    msg = ChatMessage(
        id=str(uuid.uuid4()),
        room_id=room_id,
        author_user_id=user_id,
        author_is_agent=False,  # rule-guide.MD §4.10 — agent never posts to chat
        body=payload.body,
        language=payload.language,
        reply_to_id=payload.reply_to_id,
    )
    session.add(msg)
    session.commit()
    session.refresh(msg)
    author = session.get(User, user_id)
    parent_author = (
        session.get(User, parent.author_user_id)
        if parent and parent.author_user_id
        else None
    )
    out = _serialize_chat(msg, author, parent, parent_author)
    # Fan out to anyone currently subscribed via /ws/chat/{room_id}.
    # The hub is process-local; multi-instance deployments need Redis
    # pub/sub (see WORKSTREAM.md scale-out section).
    chat_hub.publish(room_id, out.model_dump())
    return out


class ReactionToggleBody(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


@app.post(
    "/rooms/{room_id}/chat/{message_id}/react",
    response_model=ChatMessageRead,
    dependencies=[Depends(require_password)],
)
def toggle_reaction(
    room_id: str,
    message_id: str,
    payload: ReactionToggleBody,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ChatMessageRead:
    """Toggle one emoji reaction on a chat message. Tap once to add,
    tap the same emoji again to remove. Re-broadcasts the updated
    message on the room's chat hub so other tabs/devices refresh."""
    _require_member(session, room_id, user_id)
    msg = session.get(ChatMessage, message_id)
    if msg is None or msg.room_id != room_id:
        raise HTTPException(404, "Message not found.")
    emoji = payload.emoji.strip()
    if not emoji:
        raise HTTPException(400, "Emoji can't be empty.")
    existing = (
        session.query(ChatReaction)
        .filter(
            ChatReaction.message_id == message_id,
            ChatReaction.user_id == user_id,
            ChatReaction.emoji == emoji,
        )
        .one_or_none()
    )
    if existing is not None:
        session.delete(existing)
    else:
        session.add(
            ChatReaction(
                id=str(uuid.uuid4()),
                message_id=message_id,
                user_id=user_id,
                emoji=emoji,
            )
        )
    session.commit()
    # Re-serialize with the latest reactions; viewer perspective is
    # baked into `mine`, so each subscriber will need to recompute
    # their own — for now we just publish the canonical payload and
    # the WS handler accepts that other tabs will refetch on next
    # render.
    author = session.get(User, msg.author_user_id) if msg.author_user_id else None
    parent = (
        session.get(ChatMessage, msg.reply_to_id)
        if msg.reply_to_id
        else None
    )
    parent_author = (
        session.get(User, parent.author_user_id)
        if parent and parent.author_user_id
        else None
    )
    reactions = _chat_reactions_for(session, [msg.id], user_id).get(msg.id, [])
    out = _serialize_chat(msg, author, parent, parent_author, reactions)
    chat_hub.publish(room_id, out.model_dump())
    return out


# ---------------------------------------------------------------------------
# Chat image attachments
# ---------------------------------------------------------------------------
_CHAT_IMAGES_DIR = _UPLOADS_DIR / "chat"
_CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
_CHAT_IMAGE_MAX_SIDE = 1280  # px — generous for chat photos; webp keeps them light


def _chat_image_path(message_id: str) -> Path:
    return _CHAT_IMAGES_DIR / f"{message_id}.webp"


@app.post(
    "/rooms/{room_id}/chat/image",
    response_model=ChatMessageRead,
    dependencies=[Depends(require_password)],
)
async def post_chat_image(
    room_id: str,
    file: UploadFile = File(...),
    body: str = Form(""),
    reply_to_id: str = Form(""),
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ChatMessageRead:
    """Member-only. Sends a chat message with an image attachment.
    `body` is an optional caption; `reply_to_id` is an optional parent
    message id when this is a reply. The image is re-encoded to webp."""
    _require_member(session, room_id, user_id)
    raw = await file.read()
    if len(raw) > _CHAT_IMAGE_MAX_BYTES:
        raise HTTPException(413, "Image too large (max 20MB).")
    parent: ChatMessage | None = None
    if reply_to_id:
        parent = session.get(ChatMessage, reply_to_id)
        if parent is None or parent.room_id != room_id:
            raise HTTPException(400, "Invalid reply_to_id for this room.")
    from io import BytesIO
    from PIL import Image, UnidentifiedImageError

    msg = ChatMessage(
        id=str(uuid.uuid4()),
        room_id=room_id,
        author_user_id=user_id,
        author_is_agent=False,
        body=body or "",
        language=None,
        reply_to_id=reply_to_id or None,
    )
    try:
        with Image.open(BytesIO(raw)) as im:
            im.load()
            from PIL.ImageOps import exif_transpose

            im = exif_transpose(im)
            im.thumbnail((_CHAT_IMAGE_MAX_SIDE, _CHAT_IMAGE_MAX_SIDE))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            _CHAT_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
            im.save(_chat_image_path(msg.id), format="WEBP", quality=82, method=4)
    except UnidentifiedImageError:
        raise HTTPException(415, "Unsupported image format.")

    msg.attachment_image_token = uuid.uuid4().hex[:12]
    session.add(msg)
    session.commit()
    session.refresh(msg)
    author = session.get(User, user_id)
    parent_author = (
        session.get(User, parent.author_user_id)
        if parent and parent.author_user_id
        else None
    )
    out = _serialize_chat(msg, author, parent, parent_author)
    chat_hub.publish(room_id, out.model_dump())
    return out


@app.get("/rooms/{room_id}/chat/{message_id}/image")
def get_chat_image(
    room_id: str,
    message_id: str,
    request: Request,
    session: Session = Depends(db),
) -> FileResponse:
    """Members only — same query-string auth fallback as room/user
    avatars so browser <img> loaders work."""
    pw = request.headers.get("X-App-Password") or request.query_params.get("password")
    expected = os.getenv("BIBLE_IU_PASSWORD") or ""
    if expected and pw != expected:
        raise HTTPException(401, "App password required.")
    token = request.headers.get("X-Session-Token") or request.query_params.get("session")
    user = resolve_user(token) if token else None
    if user is None:
        raise HTTPException(401, "not signed in")
    _require_member(session, room_id, user.id)
    path = _chat_image_path(message_id)
    if not path.exists():
        raise HTTPException(404, "No image for this message.")
    return FileResponse(
        str(path),
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400"},
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
    # Null when the author deleted their account — body stays for
    # room history, but the row tombstones to "deleted user" in the UI.
    author_user_id: Optional[str]
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


class GroupNoteRegister(BaseModel):
    """Frontend asks the server "this UUID is for a group-scope note
    in this room." The server doesn't trust it blindly — registration
    is keyed on (author_user_id, room_id) so only the actual author
    of the room's shared-doc note can register, and only if the user
    is a member of the room."""
    pass


@app.post(
    "/rooms/{room_id}/notes/{note_id}/register_group",
    dependencies=[Depends(require_password)],
)
def register_group_note(
    room_id: str,
    note_id: str,
    _payload: GroupNoteRegister | None = None,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict:
    """Frontend calls this every time it `add()`s a GROUP-scope note
    via Yjs (yjsNotes.ts). Idempotent — re-registering the same ID is
    a no-op. Personal-scope notes MUST NOT be registered here; the
    UI calls this only on the group path."""
    _require_member(session, room_id, user_id)
    existing = session.get(RegisteredGroupNote, note_id)
    if existing is not None:
        # Idempotent re-register from the same user in the same room
        # is fine; cross-user / cross-room attempts are rejected so
        # nobody can claim someone else's note ID as their own.
        if existing.room_id != room_id or existing.author_user_id != user_id:
            raise HTTPException(409, "note already registered elsewhere")
        return {"ok": True}
    session.add(
        RegisteredGroupNote(
            note_id=note_id,
            room_id=room_id,
            author_user_id=user_id,
        )
    )
    session.commit()
    return {"ok": True}


def _require_group_note(
    session: Session, note_id: str, room_id: str
) -> RegisteredGroupNote:
    row = session.get(RegisteredGroupNote, note_id)
    if row is None or row.room_id != room_id:
        # 404 instead of 403 so we don't even confirm the note exists
        # to a probing attacker.
        raise HTTPException(404, "note not found in this room")
    return row


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
    _require_group_note(session, note_id, room_id)
    likes = session.scalars(
        select(NoteLike).where(NoteLike.note_id == note_id)
    ).all()
    comments = session.scalars(
        select(NoteComment)
        .where(NoteComment.note_id == note_id)
        .order_by(NoteComment.created_at.asc())
    ).all()
    # Bulk-load comment authors (avoid N+1 on small lists).
    # Drop None (tombstoned author) before the IN-query — SQLAlchemy
    # otherwise translates it to `IN (NULL)` which matches nothing
    # and warns about unhashable types in some backends.
    author_ids = {c.author_user_id for c in comments if c.author_user_id}
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
                # A null author_user_id (the deletion tombstone path)
                # renders as the "deleted user" sentinel; an unknown
                # but non-null id falls back to "?".
                author_handle=(
                    authors[c.author_user_id].handle
                    if c.author_user_id and c.author_user_id in authors
                    else ("deleted" if c.author_user_id is None else "?")
                ),
                author_display_name=(
                    authors[c.author_user_id].display_name
                    if c.author_user_id and c.author_user_id in authors
                    else (
                        "(deleted user)"
                        if c.author_user_id is None
                        else "(unknown)"
                    )
                ),
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
    _require_group_note(session, note_id, room_id)
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
    _require_group_note(session, note_id, room_id)
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
def _orchestrator(session: Session, allow_web: bool = False) -> AgentOrchestrator:
    ledger = app.state.ledger
    # If a DeepSeek key is configured at process start, use the real
    # generator + verifier. Otherwise the placeholder pair keeps the
    # pipeline shape intact for tests and offline dev.
    import os as _os
    has_key = bool(_os.environ.get("DEEPSEEK_API_KEY"))
    generator = DeepSeekGenerator() if has_key else PlaceholderGenerator()
    verifier = DeepSeekVerifier() if has_key else PassThroughVerifier()
    engine = CitationEngine(
        retriever=SqlRetriever(session, web_searcher=make_searcher(allow_web)),
        generator=generator,
        verifier=verifier,
        ledger=ledger,
    )
    return AgentOrchestrator(engine=engine, ledger=ledger)


# Per-user, per-room daily question counter — used by
# `_enforce_daily_quota` to honor `agent_settings.max_questions_per_user_per_day`.
# In-memory, single-instance only (resets on restart). For multi-instance
# deployments swap to Redis INCR with a TTL until next UTC midnight.
_DAILY_COUNTS: dict[tuple[str, str, str], int] = {}
_DAILY_LOCK = __import__("threading").Lock()


def _enforce_daily_quota(
    session: Session, room_id: str, user_id: str, limit: int
) -> None:
    """Raise 429 when the user has already used their quota for this
    room today (UTC). The increment happens here, before the expensive
    reasoning call, so a refused turn doesn't burn a quota slot."""
    today = datetime.now(timezone.utc).date().isoformat()
    key = (user_id, room_id, today)
    with _DAILY_LOCK:
        used = _DAILY_COUNTS.get(key, 0)
        if used >= limit:
            raise HTTPException(
                429,
                f"Daily question quota reached ({limit}/day in this room). "
                "Resets at midnight UTC.",
            )
        _DAILY_COUNTS[key] = used + 1


def _web_search_allowed(room: Room) -> bool:
    """Two-layer gate:
      env BIBLE_IU_WEB_SEARCH="0"  → deployment kill-switch; web is off
                                     for the whole instance regardless of
                                     room settings. Useful for offline
                                     dev or for the rule-bounded sandbox
                                     (rule-guide.MD §8).
      room.agent_settings.allow_web_search → the admin's per-room
                                     opt-in. False by default; admins
                                     enable via PATCH /agent_settings.
    Both must be on for the room to actually hit the network."""
    import os as _os

    env_kill = _os.environ.get("BIBLE_IU_WEB_SEARCH", "1").strip() == "0"
    if env_kill:
        return False
    settings = AgentSettings(**dict(room.agent_settings or {}))
    return bool(settings.allow_web_search)


@app.post(
    "/reason",
    response_model=ReasoningResponse,
    dependencies=[Depends(require_password), Depends(rate_limit)],
)
def reason(
    payload: ReasoningRequest,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ReasoningResponse:
    # Gate every reasoning request through the room's admin settings.
    room = _require_member(session, payload.room_id, user_id)
    settings = _agent_settings(room)
    # User-level override: when the user's Settings has bypassAgentGate
    # enabled, the room-level gate is skipped for that account only.
    user = session.get(User, user_id)
    ui_prefs = (dict(user.preferences or {}).get("ui", {}) or {})
    bypass_gate = bool(ui_prefs.get("bypassAgentGate", False))
    if not settings.agent_enabled and not bypass_gate:
        raise HTTPException(403, "the agent is disabled in this room")
    # Per-user daily quota — set by the admin via PATCH /agent_settings.
    # Counts SQL ledger rows for this user in this room since UTC midnight.
    if settings.max_questions_per_user_per_day:
        _enforce_daily_quota(
            session, payload.room_id, user_id, settings.max_questions_per_user_per_day,
        )
    # The user-facing toggle in Settings can ASK to bypass the citation
    # engine; whether the request honors it is the admin's call.
    effective_bypass = (
        payload.bypass_citation_engine
        and settings.bypass_citation_engine_allowed
    )
    orch = _orchestrator(session, allow_web=_web_search_allowed(room))
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
            bypass_citation_engine=effective_bypass,
            scope_kind=payload.scope_kind,
        )
    )
    # Persist the agent's note only if the turn passed the rule layer
    # (Decision.PASS). Refused/revised turns never write notes.
    note_appended = None
    if turn.decision.value == "pass" and turn.note_to_append:
        note_appended = _persist_agent_note(
            session, payload.room_id, turn.note_to_append
        )
    return _turn_to_response(
        turn,
        note_appended=note_appended,
        allow_links=settings.allow_external_links,
    )


# ---------------------------------------------------------------------------
# Reading plans (CLAUDE.md §4.7 — daily plans drive retention)
#
# Plans are hardcoded in `backend.api.reading_plans`; users opt into
# them and the server tracks (a) when they started + (b) which days
# they've ticked off. "Today" is derived from
# `(today - started_at).days + 1`, capped at plan length.
# ---------------------------------------------------------------------------
class ReadingPlanSummary(BaseModel):
    id: str
    name: str
    summary: str
    length_days: int
    # Caller-scoped — null when the user isn't enrolled.
    enrolled: bool = False
    current_day: Optional[int] = None
    completed_days: int = 0


class ReadingPlanDayOut(BaseModel):
    plan_id: str
    day_index: int
    refs: list[str]
    completed: bool


def _plan_status(
    session: Session, user_id: str, plan_id: str
) -> tuple[bool, Optional[int], int]:
    """(enrolled, current_day_index, completed_days)."""
    enr = session.scalar(
        select(ReadingPlanEnrollment).where(
            ReadingPlanEnrollment.user_id == user_id,
            ReadingPlanEnrollment.plan_id == plan_id,
        )
    )
    completed = session.query(ReadingPlanProgress).filter(
        ReadingPlanProgress.user_id == user_id,
        ReadingPlanProgress.plan_id == plan_id,
    ).count()
    if enr is None:
        return False, None, completed
    started = enr.started_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    delta = (datetime.now(timezone.utc) - started).days
    plan = reading_plans.PLANS.get(plan_id)
    length = len(plan["days"]) if plan else 1
    current = max(1, min(length, delta + 1))
    return True, current, completed


@app.get(
    "/reading-plans",
    response_model=list[ReadingPlanSummary],
    dependencies=[Depends(require_password)],
)
def list_reading_plans(
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[ReadingPlanSummary]:
    out: list[ReadingPlanSummary] = []
    for plan_id in reading_plans.plan_ids():
        s = reading_plans.plan_summary(plan_id)
        enrolled, current, done = _plan_status(session, user_id, plan_id)
        out.append(
            ReadingPlanSummary(
                **s,
                enrolled=enrolled,
                current_day=current,
                completed_days=done,
            )
        )
    return out


@app.post(
    "/reading-plans/{plan_id}/enroll",
    response_model=ReadingPlanSummary,
    dependencies=[Depends(require_password)],
)
def enroll_reading_plan(
    plan_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ReadingPlanSummary:
    if plan_id not in reading_plans.PLANS:
        raise HTTPException(404, "unknown plan")
    existing = session.scalar(
        select(ReadingPlanEnrollment).where(
            ReadingPlanEnrollment.user_id == user_id,
            ReadingPlanEnrollment.plan_id == plan_id,
        )
    )
    if existing is None:
        session.add(
            ReadingPlanEnrollment(
                id=str(uuid.uuid4()),
                user_id=user_id,
                plan_id=plan_id,
            )
        )
        session.commit()
    return list_reading_plans(session, user_id)[
        next(i for i, s in enumerate(reading_plans.plan_ids()) if s == plan_id)
    ]


@app.delete(
    "/reading-plans/{plan_id}/enroll",
    dependencies=[Depends(require_password)],
)
def leave_reading_plan(
    plan_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict:
    """Unenroll. Progress rows are kept so re-enrolling resumes where
    the user left off; pass `?wipe=1` to scrub progress too."""
    session.query(ReadingPlanEnrollment).filter(
        ReadingPlanEnrollment.user_id == user_id,
        ReadingPlanEnrollment.plan_id == plan_id,
    ).delete(synchronize_session=False)
    session.commit()
    return {"ok": True}


@app.get(
    "/reading-plans/{plan_id}/today",
    response_model=ReadingPlanDayOut,
    dependencies=[Depends(require_password)],
)
def reading_plan_today(
    plan_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ReadingPlanDayOut:
    if plan_id not in reading_plans.PLANS:
        raise HTTPException(404, "unknown plan")
    enrolled, current, _ = _plan_status(session, user_id, plan_id)
    if not enrolled or current is None:
        raise HTTPException(400, "enroll in this plan first")
    try:
        refs = reading_plans.plan_day(plan_id, current)
    except IndexError:
        raise HTTPException(404, "no day for this index")
    completed = (
        session.query(ReadingPlanProgress)
        .filter(
            ReadingPlanProgress.user_id == user_id,
            ReadingPlanProgress.plan_id == plan_id,
            ReadingPlanProgress.day_index == current,
        )
        .first()
        is not None
    )
    return ReadingPlanDayOut(
        plan_id=plan_id,
        day_index=current,
        refs=refs,
        completed=completed,
    )


@app.post(
    "/reading-plans/{plan_id}/days/{day_index}/complete",
    response_model=ReadingPlanDayOut,
    dependencies=[Depends(require_password)],
)
def complete_reading_plan_day(
    plan_id: str,
    day_index: int,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ReadingPlanDayOut:
    if plan_id not in reading_plans.PLANS:
        raise HTTPException(404, "unknown plan")
    try:
        refs = reading_plans.plan_day(plan_id, day_index)
    except IndexError:
        raise HTTPException(404, "no day for this index")
    existing = session.scalar(
        select(ReadingPlanProgress).where(
            ReadingPlanProgress.user_id == user_id,
            ReadingPlanProgress.plan_id == plan_id,
            ReadingPlanProgress.day_index == day_index,
        )
    )
    if existing is None:
        session.add(
            ReadingPlanProgress(
                id=str(uuid.uuid4()),
                user_id=user_id,
                plan_id=plan_id,
                day_index=day_index,
            )
        )
        session.commit()
    return ReadingPlanDayOut(
        plan_id=plan_id,
        day_index=day_index,
        refs=refs,
        completed=True,
    )


@app.websocket("/ws/chat/{room_id}")
async def chat_ws(ws: WebSocket, room_id: str) -> None:
    """Live chat feed for a room. The browser opens this after the
    initial `GET /chat` and receives one JSON line per new message.

    Auth: app password via `?password=...`, session token via
    `?session=...`. Membership is enforced on connect — a sign-in
    that isn't a room member is rejected with 4401 (a custom Fly /
    nginx-friendly close code, matching the yjs endpoint's style)."""
    await ws.accept()
    expected_pw = (os.environ.get("BIBLE_IU_PASSWORD") or "").strip() or None
    if expected_pw is not None and ws.query_params.get("password") != expected_pw:
        await ws.close(code=4001, reason="Unauthorized")
        return
    token = ws.query_params.get("session", "").strip()
    user = resolve_user(token) if token else None
    if user is None:
        await ws.close(code=4001, reason="Unauthorized")
        return
    s = get_session()
    try:
        room = s.get(Room, room_id)
        if room is None:
            await ws.close(code=4404, reason="room not found")
            return
        member = s.scalar(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.user_id == user.id,
            )
        )
        if member is None:
            await ws.close(code=4403, reason="not a member")
            return
    finally:
        s.close()

    queue = await chat_hub.subscribe(room_id)
    try:
        while True:
            # We don't actually expect inbound frames — the client
            # posts via HTTP. But we run a reader so the connection
            # detects close from the browser side promptly.
            recv = asyncio.create_task(ws.receive_text())
            send = asyncio.create_task(queue.get())
            done, pending = await asyncio.wait(
                {recv, send}, return_when=asyncio.FIRST_COMPLETED
            )
            for p in pending:
                p.cancel()
            if recv in done and not recv.cancelled():
                try:
                    recv.result()
                except WebSocketDisconnect:
                    return
            if send in done and not send.cancelled():
                msg = send.result()
                await ws.send_text(msg)
    except WebSocketDisconnect:
        pass
    finally:
        await chat_hub.unsubscribe(room_id, queue)


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
    await ws.accept()
    expected = (os.environ.get("BIBLE_IU_PASSWORD") or "").strip() or None
    if expected is not None:
        provided = ws.query_params.get("password", "")
        if provided != expected:
            await ws.close(code=4001, reason="Unauthorized")
            return

    # Resolve the user from the session token (same pattern as chat WS).
    token = ws.query_params.get("session", "").strip()
    user = resolve_user(token) if token else None
    if user is None:
        await ws.close(code=4001, reason="Unauthorized")
        return

    session = get_session()
    loop = asyncio.get_event_loop()

    try:
        while True:
            payload = await ws.receive_json()
            req = ReasoningRequest(**payload)

            # Validate room membership + agent_enabled gate.
            room = session.get(Room, req.room_id)
            if room is None:
                await ws.send_json({"type": "error", "message": "room not found"})
                break
            member = session.scalar(
                select(RoomMember).where(
                    RoomMember.room_id == req.room_id,
                    RoomMember.user_id == user.id,
                )
            )
            if member is None:
                await ws.send_json({"type": "error", "message": "not a member of this room"})
                break
            ag_settings = _agent_settings(room)
            ui_prefs = (dict(user.preferences or {}).get("ui", {}) or {})
            bypass_gate = bool(ui_prefs.get("bypassAgentGate", False))
            if not ag_settings.agent_enabled and not bypass_gate:
                await ws.send_json({"type": "error", "message": "the agent is disabled in this room"})
                break
            if ag_settings.max_questions_per_user_per_day:
                try:
                    _enforce_daily_quota(
                        session, req.room_id, user.id,
                        ag_settings.max_questions_per_user_per_day,
                    )
                except HTTPException as e:
                    await ws.send_json({"type": "error", "message": e.detail})
                    break

            orch = _orchestrator(session, allow_web=_web_search_allowed(room))

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
                                scope_kind=req.scope_kind,
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
                                data,
                                note_appended=note_appended,
                                allow_links=ag_settings.allow_external_links,
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


_URL_RE = __import__("re").compile(
    r"https?://[^\s)\]>}\"']+|www\.[^\s)\]>}\"']+",
    __import__("re").IGNORECASE,
)


def _strip_links(text: str) -> str:
    """Replace inline URLs with `[link removed]` when the room's
    `allow_external_links` is off. Doesn't touch markdown citation
    pills — those go through structured `claims`, not the answer body."""
    if not text:
        return text
    return _URL_RE.sub("[link removed]", text)


def _turn_to_response(
    turn,
    note_appended: Optional[AgentNoteAppended] = None,
    allow_links: bool = True,
) -> ReasoningResponse:
    answer = turn.grounded.answer
    reasoning = turn.grounded.reasoning
    if not allow_links:
        answer = _strip_links(answer)
        reasoning = _strip_links(reasoning)
    return ReasoningResponse(
        decision=turn.decision.value,
        reasoning=reasoning,
        answer=answer,
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


# ---------------------------------------------------------------------------
# Static frontend assets — when BIBLE_IU_STATIC_DIR points at the Vite
# build output (Dockerfile copies it from the frontend builder stage),
# serve the SPA from the same FastAPI process. In dev this var is
# unset and the frontend runs separately on port 5173.
# ---------------------------------------------------------------------------
_STATIC_DIR = os.getenv("BIBLE_IU_STATIC_DIR", "").strip()
if _STATIC_DIR:
    _STATIC_PATH = Path(_STATIC_DIR)
    if _STATIC_PATH.is_dir():
        # Mount /assets, etc. The catch-all below routes everything
        # else through index.html so client-side routing works on
        # deep-links like /room/abc.
        app.mount(
            "/assets",
            StaticFiles(directory=str(_STATIC_PATH / "assets")),
            name="assets",
        )

        @app.get("/")
        def _serve_root() -> FileResponse:
            return FileResponse(str(_STATIC_PATH / "index.html"))

        @app.get("/{full_path:path}")
        def _serve_spa(full_path: str) -> FileResponse:
            # API + WS routes register first, so this only matches
            # unknown paths — exactly what we want for SPA routing.
            candidate = _STATIC_PATH / full_path
            if candidate.is_file():
                return FileResponse(str(candidate))
            return FileResponse(str(_STATIC_PATH / "index.html"))
