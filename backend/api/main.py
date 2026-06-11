"""FastAPI app.

Endpoints follow architecture.MD §3 (services) and §4 (request flows).
The WebSocket reasoning endpoint streams reasoning → answer through the
orchestrator, which routes the agent through the citation engine and
then the rule middleware (architecture.MD §2).
"""
from __future__ import annotations

import asyncio
import os
import re
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
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select, text
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
    LocalNLIVerifier,
    OllamaGenerator,
    PassThroughVerifier,
    PlaceholderGenerator,
    SqlRetriever,
    StackedVerifier,
    ollama_configured,
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
    NoteMention,
    PushSubscription,
    ReadingPlanEnrollment,
    ReadingPlanProgress,
    RegisteredGroupNote,
    Room,
    RoomInvite,
    RoomMember,
    RoomStatus,
    RoomStatusView,
    Translation,
    User,
    Verse,
)
from ..data.repos import UserNoteRepository
from .auth import require_password
from .auth_users import require_user, router as auth_router, resolve_user
from .push import (
    fanout_to_room,
    send_push_to_user,
    send_room_push_to_user,
    vapid_public_key,
)
from .observability import configure_logging, configure_sentry
from .rate_limit import rate_limit, search_rate_limit, tts_rate_limit
from . import chat_hub, reading_plan_scheduler, reading_plans, yjs_sync
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
    StatusCreate,
    StatusRead,
    StatusImageToken,
    ClaimOut,
    CitationOut,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    configure_sentry()
    # Bump the anyio threadpool. FastAPI routes sync handlers through
    # `run_in_threadpool` → anyio's default limiter (40 tokens). Our
    # handlers are sync + I/O-bound (SQLAlchemy + DeepSeek), so when
    # /reason calls park 4-6 tokens for 20-30s each, the rest of the
    # cohort head-of-lines waiting for a worker. Lift to 200 so a
    # saturated agent path doesn't stall chat / reads / status posts.
    # Surfaced by the MiroFish multi-group stress (every endpoint's
    # p50 jumped from ~30ms to ~2500ms despite zero backend errors).
    import anyio
    anyio.to_thread.current_default_thread_limiter().total_tokens = 200
    init_db()
    # Persist provenance to the SQL ledger so the audit trail survives a
    # restart (CLAUDE.md §7.5). The Sql session is created per-write so
    # we don't tangle the citation engine with the request session.
    from ..data import SessionLocal
    app.state.ledger = SqlLedger(session_factory=SessionLocal)
    # Yjs CRDT sync server (architecture.MD §3, CLAUDE.md §8).
    await yjs_sync.startup()
    # Daily reading-plan reminders. Single-instance scheduler; swap
    # for a job queue when we scale out (see module docstring).
    await reading_plan_scheduler.startup()
    # Sweep orphaned note-image files left over from group-note
    # deletes that happened while this lifespan worker was down,
    # plus personal-note image files whose host notes were torn out
    # of the per-user Y.Doc on a different device. Best-effort —
    # purely storage hygiene; serving an orphan file isn't a
    # privacy bug because the serve endpoint still requires room
    # membership.
    try:
        n = sweep_orphaned_note_images()
        if n:
            import logging as _logging
            _logging.getLogger("bible_iu.notes").info(
                "swept %d orphaned note-image files", n
            )
    except Exception:  # noqa: BLE001
        pass
    try:
        n = sweep_orphaned_status_images()
        if n:
            import logging as _logging
            _logging.getLogger("bible_iu.statuses").info(
                "swept %d orphaned status-image files", n
            )
    except Exception:  # noqa: BLE001
        pass
    # Cross-process chat fan-out via Redis when REDIS_URL is set;
    # falls back to in-process only otherwise (see chat_hub docstring).
    await chat_hub.setup()
    try:
        yield
    finally:
        await chat_hub.teardown()
        await reading_plan_scheduler.shutdown()
        await yjs_sync.shutdown()


app = FastAPI(title="Bible IU API", lifespan=lifespan)
app.include_router(auth_router)


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    """Emit standard security headers on every response.

    - **HSTS** forces HTTPS for one year. Only sent when the request
      arrived on https so dev (http://localhost) isn't accidentally
      pinned. `includeSubDomains` extends to bible.access-term.com's
      apex too.
    - **CSP** allows same-origin scripts/styles + the data: URIs the
      avatar gradients use; blocks everything else. `connect-src`
      also allows the ws/wss self origin for the chat + yjs sockets.
      No `unsafe-inline` for scripts — Vite injects modules with the
      right type so this stays clean. Style needs `unsafe-inline` for
      Tailwind's inlined utility styles to work.
    - **X-Content-Type-Options: nosniff** disables MIME sniffing so
      a misnamed `.js` can't be served as text/html and rendered.
    - **X-Frame-Options: DENY** blocks clickjacking — the app never
      runs in a frame.
    - **Referrer-Policy: strict-origin-when-cross-origin** keeps the
      Referer minimal on outbound clicks (Blue Letter Bible lookups,
      web search results) without breaking same-origin analytics.
    - **Permissions-Policy** disables interfaces the app doesn't use
      so a future XSS can't reach the mic / camera / geolocation.
    """
    response = await call_next(request)
    if request.url.scheme == "https":
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains",
        )
    response.headers.setdefault(
        "Content-Security-Policy",
        # `'self'` everywhere, plus the bits the actual UI needs.
        "default-src 'self'; "
        "script-src 'self' 'unsafe-eval'; "  # eval — needed by Vite dev HMR; drop in a prod-only branch when we have one
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self' ws: wss: https://api.deepseek.com; "
        "worker-src 'self' blob:; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault(
        "Referrer-Policy", "strict-origin-when-cross-origin"
    )
    response.headers.setdefault(
        "Permissions-Policy",
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
        "magnetometer=(), microphone=(), payment=(), usb=()",
    )
    return response


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
    last_message_body: Optional[str] = None,
    last_message_at: Optional[datetime] = None,
    last_message_author_handle: Optional[str] = None,
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
        last_message_body=last_message_body,
        last_message_at=(
            last_message_at.isoformat() if last_message_at is not None else None
        ),
        last_message_author_handle=last_message_author_handle,
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


class RoomNamePatch(BaseModel):
    """Admin rename. Length-bounded the same way NewRoom enforces on
    create so a renamed room can't end up wider than what the picker
    would have produced."""
    name: str


# ---------------------------------------------------------------------------
# Web Push — phone notifications for chat + group notes
# ---------------------------------------------------------------------------
class PushSubscribeBody(BaseModel):
    endpoint: str
    p256dh: str
    auth: str


@app.get("/push/vapid-key", dependencies=[Depends(require_password)])
def push_vapid_key() -> dict[str, Optional[str]]:
    """Returns the URL-safe base64 public key the browser passes to
    `pushManager.subscribe({ applicationServerKey })`. Null when the
    server isn't configured for push (dev box without VAPID keys)."""
    return {"public_key": vapid_public_key()}


@app.post("/push/subscribe", dependencies=[Depends(require_password)])
def push_subscribe(
    payload: PushSubscribeBody,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict[str, str]:
    """Upserts a Web Push subscription for the current user. Endpoint
    is the unique key — re-subscribing on the same device just refreshes
    the keys instead of accumulating dead rows."""
    existing = session.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if existing is not None:
        existing.user_id = user_id
        existing.p256dh = payload.p256dh
        existing.auth = payload.auth
    else:
        session.add(
            PushSubscription(
                id=str(uuid.uuid4()),
                user_id=user_id,
                endpoint=payload.endpoint,
                p256dh=payload.p256dh,
                auth=payload.auth,
            )
        )
    session.commit()
    return {"ok": "subscribed"}


class PushUnsubscribeBody(BaseModel):
    endpoint: str


@app.post("/push/unsubscribe", dependencies=[Depends(require_password)])
def push_unsubscribe(
    payload: PushUnsubscribeBody,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict[str, str]:
    row = session.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if row is not None and row.user_id == user_id:
        session.delete(row)
        session.commit()
    return {"ok": "unsubscribed"}


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


class ContactView(BaseModel):
    id: str
    handle: str
    display_name: str
    avatar_url: Optional[str] = None


@app.get(
    "/contacts",
    response_model=list[ContactView],
    dependencies=[Depends(require_password)],
)
def list_contacts(
    room_id: Optional[str] = None,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[ContactView]:
    """Members the caller shares a room with. With `?room_id=...` the
    list is scoped to just that room's members (which is what the chat
    Contacts sheet wants — it should match the active group). Without
    `room_id` we fall back to the full cross-room contact set (used by
    Settings / future address-book surfaces).

    Returns deduped, sorted by display_name."""
    if room_id is not None:
        # Demo / pre-seed rooms (`local-…`, `seed-…`) don't exist
        # server-side. Returning [] is the truthful answer here —
        # the user genuinely shares no real-room membership with
        # anyone via that placeholder room.
        room = session.get(Room, room_id)
        if room is None:
            return []
        # Caller must actually be a member of the room they're asking
        # about — otherwise we'd leak membership lists.
        _require_member(session, room_id, user_id)
        target_room_ids: set[str] = {room_id}
    else:
        target_room_ids = {
            r.room_id
            for r in session.query(RoomMember.room_id).filter(
                RoomMember.user_id == user_id
            )
        }
    if not target_room_ids:
        return []
    other_ids = {
        m.user_id
        for m in session.query(RoomMember).filter(
            RoomMember.room_id.in_(target_room_ids),
            RoomMember.user_id != user_id,
        )
    }
    if not other_ids:
        return []
    users = session.scalars(
        select(User).where(User.id.in_(other_ids))
    ).all()
    users.sort(key=lambda u: (u.display_name or u.handle).lower())
    return [
        ContactView(
            id=u.id,
            handle=u.handle,
            display_name=u.display_name,
            avatar_url=_resolved_user_avatar_url(u),
        )
        for u in users
    ]


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
    """All rooms the current user is a member of. Each row carries:
       - the caller's role in that room (so the Profile UI can flag
         administrated rooms),
       - the unread count for the caller,
       - the most-recent chat message body/timestamp/author handle
         (used by the rooms rail to render previews + sort by activity).
    """
    rows = (
        session.query(Room, RoomMember.role)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .filter(RoomMember.user_id == user_id)
        .order_by(Room.created_at.desc())
        .all()
    )
    if not rows:
        return []
    room_ids = [r.id for r, _ in rows]
    # Latest message per room. Subquery picks MAX(created_at) for
    # each room id, then we join back to ChatMessage + User to get
    # the body/handle. Single round trip — much cheaper than per-row.
    from sqlalchemy import func
    latest_at_subq = (
        session.query(
            ChatMessage.room_id.label("rid"),
            func.max(ChatMessage.created_at).label("max_at"),
        )
        .filter(ChatMessage.room_id.in_(room_ids))
        .group_by(ChatMessage.room_id)
        .subquery()
    )
    latest_rows = (
        session.query(ChatMessage, User)
        .join(
            latest_at_subq,
            (ChatMessage.room_id == latest_at_subq.c.rid)
            & (ChatMessage.created_at == latest_at_subq.c.max_at),
        )
        .outerjoin(User, User.id == ChatMessage.author_user_id)
        .all()
    )
    latest_by_room: dict[str, tuple[ChatMessage, Optional[User]]] = {}
    for msg, author in latest_rows:
        # If two messages share the exact MAX timestamp (rare, but
        # possible with the seed script), keep whichever the
        # iteration hands us — the body/timestamp will still be
        # accurate; only the author tie-breaks.
        latest_by_room.setdefault(msg.room_id, (msg, author))
    out: list[RoomRead] = []
    for r, role in rows:
        last_msg, last_author = latest_by_room.get(r.id, (None, None))
        # `📷 Photo` placeholder when the message is an image with no
        # caption — matches the chat reply-preview style.
        if last_msg is not None:
            body = last_msg.body or ""
            if not body.strip() and last_msg.attachment_image_token:
                body = "📷 Photo"
        else:
            body = None
        out.append(
            _room_read(
                r,
                role,
                _unread_count(session, r.id, user_id),
                last_message_body=body,
                last_message_at=last_msg.created_at if last_msg else None,
                last_message_author_handle=(
                    last_author.handle if last_author else None
                ),
            )
        )
    return out


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


@app.delete(
    "/rooms/{room_id}",
    dependencies=[Depends(require_password)],
)
def delete_room(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict:
    """Admin-only delete of a group room. Cascades onto members,
    chat messages, notes, reactions, comments, likes, invites,
    and the room's Yjs ystore rows are best-effort cleaned up by
    the lifespan worker — they can't be safely deleted while a
    sync session is open. Direct rooms can't be deleted this way;
    use the per-room hide instead."""
    room = session.get(Room, room_id)
    if room is None:
        raise HTTPException(404, "room not found")
    if room.type == "direct":
        raise HTTPException(
            400,
            "direct rooms can't be deleted — hide them from the rail instead",
        )
    _require_admin(session, room_id, user_id)
    # Manual cascade — SQLite FKs aren't all configured ON DELETE
    # CASCADE on this schema. Order matters: kill rows that point AT
    # this room before the room itself. Comments + likes hang off
    # notes via note_id (no room_id), so we drop them by joining
    # their notes' room_id.
    from ..data.models import (
        ChatReaction,
        ChatMessage,
        Note,
        NoteComment,
        NoteLike,
        Provenance,
        ReasoningSession,
        RegisteredGroupNote,
        RoomInvite,
    )
    note_ids = [
        n_id
        for (n_id,) in session.query(Note.id).filter(Note.room_id == room_id)
    ]
    msg_ids = [
        m_id
        for (m_id,) in session.query(ChatMessage.id).filter(
            ChatMessage.room_id == room_id
        )
    ]
    if msg_ids:
        session.query(ChatReaction).filter(
            ChatReaction.message_id.in_(msg_ids)
        ).delete(synchronize_session=False)
    if note_ids:
        session.query(NoteComment).filter(
            NoteComment.note_id.in_(note_ids)
        ).delete(synchronize_session=False)
        session.query(NoteLike).filter(
            NoteLike.note_id.in_(note_ids)
        ).delete(synchronize_session=False)
        session.query(RegisteredGroupNote).filter(
            RegisteredGroupNote.note_id.in_(note_ids)
        ).delete(synchronize_session=False)
    # 24h status panel: drop view rows first (FK → statuses), then
    # the statuses themselves (FK → rooms). Pre-load the image tokens
    # so we can unlink the webp files after the SQL transaction commits.
    status_rows = session.query(
        RoomStatus.id, RoomStatus.attachment_image_token
    ).filter(RoomStatus.room_id == room_id).all()
    status_ids = [sid for (sid, _) in status_rows]
    status_tokens = [tok for (_, tok) in status_rows if tok]
    if status_ids:
        session.query(RoomStatusView).filter(
            RoomStatusView.status_id.in_(status_ids)
        ).delete(synchronize_session=False)
        session.query(RoomStatus).filter(
            RoomStatus.room_id == room_id
        ).delete(synchronize_session=False)
    session.query(ChatMessage).filter(ChatMessage.room_id == room_id).delete(
        synchronize_session=False
    )
    session.query(Note).filter(Note.room_id == room_id).delete(
        synchronize_session=False
    )
    session.query(RoomInvite).filter(RoomInvite.room_id == room_id).delete(
        synchronize_session=False
    )
    session.query(RoomMember).filter(RoomMember.room_id == room_id).delete(
        synchronize_session=False
    )
    # Agent activity: /reason creates ReasoningSession rows tied to the
    # room, and Provenance rows tied to the session. Surfaced by the
    # MiroFish stress test (room with active asker personas couldn't
    # be deleted: FK constraint failed on rooms.id).
    rs_ids = [
        rs_id
        for (rs_id,) in session.query(ReasoningSession.id).filter(
            ReasoningSession.room_id == room_id
        )
    ]
    if rs_ids:
        session.query(Provenance).filter(
            Provenance.session_id.in_(rs_ids)
        ).delete(synchronize_session=False)
        session.query(ReasoningSession).filter(
            ReasoningSession.room_id == room_id
        ).delete(synchronize_session=False)
    session.delete(room)
    session.commit()
    # Post-commit: drop the orphan webp files for any deleted statuses.
    for tok in status_tokens:
        try:
            _status_image_path(tok).unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True}


@app.post(
    "/rooms/{room_id}/leave",
    dependencies=[Depends(require_password)],
)
def leave_room(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict:
    """A member removes themselves from a room. Admins must promote
    another member to admin first — same stranding rule as
    `DELETE /rooms/{id}/members/{id}`. Direct rooms don't expose
    this endpoint because there's no meaningful "leave a 1:1"
    semantic; hide the room from the rail instead."""
    room = session.get(Room, room_id)
    if room is None:
        raise HTTPException(404, "room not found")
    if room.type == "direct":
        raise HTTPException(
            400,
            "direct rooms can't be left — hide them from the rail instead",
        )
    member = session.scalar(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.user_id == user_id,
        )
    )
    if member is None:
        raise HTTPException(404, "you're not a member of this room")
    if member.role == "admin":
        other_admins = session.scalar(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.role == "admin",
                RoomMember.user_id != user_id,
            )
        )
        if other_admins is None:
            raise HTTPException(
                400,
                "promote another member to admin first so the room isn't "
                "left without an admin",
            )
    session.delete(member)
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
    "/rooms/{room_id}/name",
    response_model=RoomRead,
    dependencies=[Depends(require_password)],
)
def patch_room_name(
    room_id: str,
    payload: RoomNamePatch,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> RoomRead:
    """Admin-only group rename. DMs are auto-named from their members
    and don't accept this endpoint. Length cap matches NewRoomModal so
    the rail row layout stays bounded."""
    room = _require_admin(session, room_id, user_id)
    if room.type != "group":
        raise HTTPException(400, "Only group rooms can be renamed.")
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "Name can't be empty.")
    if len(name) > 60:
        raise HTTPException(400, "Name must be 60 characters or fewer.")
    room.name = name
    session.commit()
    session.refresh(room)
    role = (
        session.query(RoomMember.role)
        .filter(RoomMember.room_id == room.id, RoomMember.user_id == user_id)
        .scalar()
    )
    return _room_read(room, role)


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
        pinned_at=(
            msg.pinned_at.replace(tzinfo=timezone.utc).isoformat()
            if msg.pinned_at and msg.pinned_at.tzinfo is None
            else (msg.pinned_at.isoformat() if msg.pinned_at else None)
        ),
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
    # Wake phones that aren't currently watching this room. We push to
    # every member except the sender — the SW notification tag uses
    # the room_id so multiple messages collapse into one banner.
    room = session.get(Room, room_id)
    fanout_to_room(
        session, room_id,
        exclude_user_id=user_id,
        payload={
            "kind": "chat",
            "room_id": room_id,
            "room_name": (room.name if room else "Bible IU"),
            "sender": (author.display_name or author.handle) if author else "Someone",
            "body": (payload.body or "")[:140],
            "url": f"/?room={room_id}",
        },
    )
    return out


class ReactionToggleBody(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


@app.post(
    "/rooms/{room_id}/chat/{message_id}/pin",
    response_model=ChatMessageRead,
    dependencies=[Depends(require_password)],
)
def pin_chat_message(
    room_id: str,
    message_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> ChatMessageRead:
    """Admin-only pin/unpin of a chat message. Toggles — calling
    this on a pinned message unpins it. Group rooms only; DMs have
    no admin concept. The chat hub re-broadcasts the updated
    message so other tabs see the pin state change live."""
    _require_admin(session, room_id, user_id)
    msg = session.get(ChatMessage, message_id)
    if msg is None or msg.room_id != room_id:
        raise HTTPException(404, "message not found")
    if msg.pinned_at is None:
        msg.pinned_at = datetime.now(timezone.utc)
    else:
        msg.pinned_at = None
    session.commit()
    session.refresh(msg)
    author = (
        session.get(User, msg.author_user_id) if msg.author_user_id else None
    )
    parent = (
        session.get(ChatMessage, msg.reply_to_id) if msg.reply_to_id else None
    )
    parent_author = (
        session.get(User, parent.author_user_id)
        if parent and parent.author_user_id
        else None
    )
    out = _serialize_chat(msg, author, parent, parent_author)
    chat_hub.publish(room_id, out.model_dump())
    return out


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


@app.delete(
    "/rooms/{room_id}/chat/{message_id}",
    status_code=204,
    dependencies=[Depends(require_password)],
)
def delete_chat_message(
    room_id: str,
    message_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> Response:
    """Delete one of the caller's own chat messages.

    Authorship is the only allow-rule: senders can remove their own
    posts; admins use the room-level wipe for moderation. Reactions
    cascade away; replies that pointed at this message have their
    `reply_to_id` cleared so they don't dangle on a missing FK. The
    chat hub broadcasts an `_op: "delete"` envelope so subscribed
    tabs drop the row from their local list immediately.
    """
    _require_member(session, room_id, user_id)
    msg = session.get(ChatMessage, message_id)
    if msg is None or msg.room_id != room_id:
        raise HTTPException(404, "message not found")
    if msg.author_user_id != user_id:
        raise HTTPException(403, "not your message")
    # Drop reactions first so the FK on chat_reactions doesn't trip.
    session.query(ChatReaction).filter(
        ChatReaction.message_id == message_id
    ).delete(synchronize_session=False)
    # Orphan replies: clear their reply_to_id rather than cascading
    # the deletion. Losing the parent context is gentler than losing
    # the reply itself, especially in long threads.
    session.query(ChatMessage).filter(
        ChatMessage.reply_to_id == message_id
    ).update({ChatMessage.reply_to_id: None}, synchronize_session=False)
    # Best-effort attachment cleanup — missing file is fine.
    if msg.attachment_image_token:
        try:
            _chat_image_path(message_id).unlink(missing_ok=True)
        except OSError:
            pass
    session.delete(msg)
    session.commit()
    # Tell every connected tab to drop this id from its local list.
    chat_hub.publish(
        room_id, {"_op": "delete", "id": message_id, "room_id": room_id}
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Chat image attachments
# ---------------------------------------------------------------------------
_CHAT_IMAGES_DIR = _UPLOADS_DIR / "chat"
_CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
_CHAT_IMAGE_MAX_SIDE = 1280  # px — generous for chat photos; webp keeps them light

_NOTE_IMAGES_DIR = _UPLOADS_DIR / "notes"
_NOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024
_NOTE_IMAGE_MAX_SIDE = 1600  # px — larger than chat; notes are studied

_STATUS_IMAGES_DIR = _UPLOADS_DIR / "status"
_STATUS_IMAGE_MAX_BYTES = 15 * 1024 * 1024
_STATUS_IMAGE_MAX_SIDE = 1280  # px — same envelope as chat photos


def _chat_image_path(message_id: str) -> Path:
    return _CHAT_IMAGES_DIR / f"{message_id}.webp"


def _status_image_path(token: str) -> Path:
    return _STATUS_IMAGES_DIR / f"{token}.webp"


def _note_image_path(token: str) -> Path:
    return _NOTE_IMAGES_DIR / f"{token}.webp"


_NOTE_IMG_TOKEN_RE = re.compile(
    r'/rooms/[A-Za-z0-9_-]+/notes/image/([A-Za-z0-9]+)'
)


def _note_image_tokens_in_body(body: str) -> set[str]:
    """Extract the image-token set from a note body. Used both by the
    delete path (to wipe files immediately) and the startup sweep (to
    determine which files are still referenced by *something*)."""
    if not body:
        return set()
    return set(_NOTE_IMG_TOKEN_RE.findall(body))


def _delete_image_files(tokens: set[str]) -> int:
    """Remove the WebP file for each token. Returns count deleted.
    Missing files don't count as failures — idempotent."""
    n = 0
    for token in tokens:
        try:
            path = _note_image_path(token)
            if path.exists():
                path.unlink()
                n += 1
        except Exception:  # noqa: BLE001
            pass
    return n


def sweep_orphaned_status_images() -> int:
    """Status uploads are two-step: client POSTs the file → gets a
    token → posts the status carrying the token. If the second step
    never lands (user backed out, network died, server 500'd) the
    file orphans because the token was never written into a
    RoomStatus row.

    Sweep policy: any webp in the status uploads dir older than the
    grace window AND not referenced by an active RoomStatus row is
    deleted. The grace window keeps in-flight uploads safe; the row
    filter handles the legitimate-but-deleted-status case where the
    delete endpoint already cleaned up but the sweep should still
    drop any siblings the user re-tried during the same session."""
    if not _STATUS_IMAGES_DIR.exists():
        return 0
    session = get_session()
    try:
        referenced: set[str] = set()
        for (tok,) in session.query(RoomStatus.attachment_image_token).filter(
            RoomStatus.attachment_image_token.is_not(None)
        ):
            if tok:
                referenced.add(tok)
    finally:
        session.close()
    # 1h grace for unposted uploads; below that and the user might
    # still be filling in the composer.
    grace_seconds = 60 * 60
    now = datetime.now(timezone.utc).timestamp()
    deleted = 0
    for path in _STATUS_IMAGES_DIR.glob("*.webp"):
        if path.stem in referenced:
            continue
        try:
            age = now - path.stat().st_mtime
        except OSError:
            continue
        if age < grace_seconds:
            continue
        try:
            path.unlink()
            deleted += 1
        except Exception:  # noqa: BLE001
            pass
    return deleted


def sweep_orphaned_note_images() -> int:
    """One-shot sweep: list every WebP file on disk, build the set of
    tokens still referenced by any Note.snapshot.body, delete the
    rest. Only personal+server-snapshotted bodies are visible here
    — live Yjs-only edits won't be in `snapshot`. For our deployment
    (single-instance, snapshot reasonably current) this catches the
    realistic orphan cases without needing a Y.Doc walk.

    Safe to run on startup; cheap (one Note table scan + one dir
    listing). Returns count deleted for logging."""
    if not _NOTE_IMAGES_DIR.exists():
        return 0
    session = get_session()
    try:
        # Gather every token referenced by any persisted note body.
        referenced: set[str] = set()
        for (snap,) in session.query(Note.snapshot):
            body = (dict(snap or {}).get("body") or "")
            referenced |= _note_image_tokens_in_body(body)
    finally:
        session.close()
    deleted = 0
    for path in _NOTE_IMAGES_DIR.glob("*.webp"):
        if path.stem not in referenced:
            try:
                path.unlink()
                deleted += 1
            except Exception:  # noqa: BLE001
                pass
    return deleted


class NoteImageOut(BaseModel):
    """Returned by POST /rooms/{room}/notes/image. The client embeds
    the `serve_url` as an `<img src=…>` inside the note body, and
    the sanitizer allows that specific path prefix."""
    token: str
    serve_url: str


@app.post(
    "/rooms/{room_id}/notes/image",
    response_model=NoteImageOut,
    dependencies=[Depends(require_password)],
)
async def post_note_image(
    room_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> NoteImageOut:
    """Member-only upload of an image to use inside a note body.

    Decoupled from any specific note row — the client gets a stable
    serve URL it can drop into the editor; the note's Yjs body
    references that URL. Image lifecycle is detached from the note
    lifecycle for now (orphan cleanup is a future sweep), which is
    acceptable on a single-instance deploy."""
    _require_member(session, room_id, user_id)
    raw = await file.read()
    if len(raw) > _NOTE_IMAGE_MAX_BYTES:
        raise HTTPException(413, "Image too large (max 20MB).")
    from io import BytesIO
    from PIL import Image, UnidentifiedImageError
    token = uuid.uuid4().hex[:16]
    try:
        with Image.open(BytesIO(raw)) as im:
            im.load()
            from PIL.ImageOps import exif_transpose
            im = exif_transpose(im)
            im.thumbnail((_NOTE_IMAGE_MAX_SIDE, _NOTE_IMAGE_MAX_SIDE))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            _NOTE_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
            im.save(_note_image_path(token), format="WEBP", quality=85, method=4)
    except UnidentifiedImageError:
        raise HTTPException(415, "Unsupported image format.")
    serve_url = f"/rooms/{room_id}/notes/image/{token}"
    return NoteImageOut(token=token, serve_url=serve_url)


@app.get("/rooms/{room_id}/notes/image/{token}")
def get_note_image(
    room_id: str,
    token: str,
    request: Request,
    session: Session = Depends(db),
) -> FileResponse:
    """Member-only fetch of a note's image. Auth follows the same
    query-string fallback as room avatars so browser `<img>` loaders
    work without custom headers."""
    pw = request.headers.get("X-App-Password") or request.query_params.get(
        "password"
    )
    expected = os.getenv("BIBLE_IU_PASSWORD") or ""
    if expected and pw != expected:
        raise HTTPException(401, "App password required.")
    sess = request.headers.get("X-Session-Token") or request.query_params.get(
        "session"
    )
    user = resolve_user(sess) if sess else None
    if user is None:
        raise HTTPException(401, "not signed in")
    _require_member(session, room_id, user.id)
    # Token-only filename — no traversal possible.
    if not all(c.isalnum() for c in token) or len(token) > 64:
        raise HTTPException(400, "bad token")
    path = _note_image_path(token)
    if not path.exists():
        raise HTTPException(404, "image not found")
    return FileResponse(
        str(path),
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400"},
    )


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
    room = session.get(Room, room_id)
    fanout_to_room(
        session, room_id,
        exclude_user_id=user_id,
        payload={
            "kind": "chat",
            "room_id": room_id,
            "room_name": (room.name if room else "Bible IU"),
            "sender": (author.display_name or author.handle) if author else "Someone",
            "body": (body or "📷 Photo")[:140],
            "url": f"/?room={room_id}",
        },
    )
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
# Room statuses — 24h ephemeral "stories" panel above chat
# ---------------------------------------------------------------------------

def _serialize_status(
    s: RoomStatus,
    author: Optional[User],
    view_count: int,
    viewer_has_viewed: bool,
) -> StatusRead:
    image_url = (
        f"/rooms/{s.room_id}/statuses/{s.id}/image?v={s.attachment_image_token}"
        if s.attachment_image_token
        else None
    )
    return StatusRead(
        id=s.id,
        room_id=s.room_id,
        author_user_id=s.author_user_id,
        author_handle=(author.handle if author else None),
        author_display_name=(author.display_name if author else None),
        author_avatar_url=(
            _resolved_user_avatar_url(author) if author else None
        ),
        body=s.body or "",
        image_url=image_url,
        created_at=s.created_at.isoformat(),
        expires_at=s.expires_at.isoformat(),
        view_count=view_count,
        viewer_has_viewed=viewer_has_viewed,
    )


@app.post(
    "/rooms/{room_id}/statuses/image",
    response_model=StatusImageToken,
    dependencies=[Depends(require_password)],
)
async def post_status_image(
    room_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> StatusImageToken:
    """Two-step image upload: client first POSTs the file here to get
    a token, then includes the token in the StatusCreate. Keeps the
    create endpoint pure JSON. The token doubles as the storage file
    name + the cache-bust value embedded in `image_url`."""
    _require_member(session, room_id, user_id)
    raw = await file.read()
    if len(raw) > _STATUS_IMAGE_MAX_BYTES:
        raise HTTPException(413, "Image too large (max 15MB).")
    from io import BytesIO
    from PIL import Image, UnidentifiedImageError
    from PIL.ImageOps import exif_transpose

    token = uuid.uuid4().hex[:16]
    try:
        with Image.open(BytesIO(raw)) as im:
            im.load()
            im = exif_transpose(im)
            im.thumbnail((_STATUS_IMAGE_MAX_SIDE, _STATUS_IMAGE_MAX_SIDE))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            _STATUS_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
            im.save(_status_image_path(token), format="WEBP", quality=82, method=4)
    except UnidentifiedImageError:
        raise HTTPException(415, "Unsupported image format.")
    return StatusImageToken(attachment_image_token=token)


@app.post(
    "/rooms/{room_id}/statuses",
    response_model=StatusRead,
    dependencies=[Depends(require_password)],
)
def create_status(
    room_id: str,
    payload: StatusCreate,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> StatusRead:
    """Post a 24h status to the room. Either `body` or an image token
    must be present — empty statuses get a 400. The status WS hub
    broadcasts the new row so peer tabs see it without a refetch."""
    _require_member(session, room_id, user_id)
    body = (payload.body or "").strip()
    token = (payload.attachment_image_token or "").strip()
    if not body and not token:
        raise HTTPException(400, "Status needs text or an image.")
    now = datetime.now(timezone.utc)
    s = RoomStatus(
        id=str(uuid.uuid4()),
        room_id=room_id,
        author_user_id=user_id,
        body=body,
        attachment_image_token=token or None,
        expires_at=now + timedelta(hours=24),
    )
    session.add(s)
    session.commit()
    session.refresh(s)
    author = session.get(User, user_id)
    out = _serialize_status(s, author, view_count=0, viewer_has_viewed=False)
    chat_hub.publish(
        room_id, {"_op": "status:create", "status": out.model_dump()}
    )
    return out


@app.get(
    "/rooms/{room_id}/statuses",
    response_model=list[StatusRead],
    dependencies=[Depends(require_password)],
)
def list_statuses(
    room_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[StatusRead]:
    """All non-expired statuses in the room, oldest-first per author.
    The strip groups by author client-side, so server order is just a
    stable secondary; expires_at filtering is the only thing the
    client can't fix up later."""
    _require_member(session, room_id, user_id)
    now = datetime.now(timezone.utc)
    rows = (
        session.query(RoomStatus)
        .filter(RoomStatus.room_id == room_id, RoomStatus.expires_at > now)
        .order_by(RoomStatus.created_at.asc())
        .all()
    )
    if not rows:
        return []
    # Bulk-load authors + view counts so we don't N+1.
    author_ids = {r.author_user_id for r in rows}
    authors = {
        u.id: u
        for u in session.query(User).filter(User.id.in_(author_ids)).all()
    }
    status_ids = [r.id for r in rows]
    view_counts: dict[str, int] = {}
    for sid, c in (
        session.query(RoomStatusView.status_id, func.count(RoomStatusView.id))
        .filter(RoomStatusView.status_id.in_(status_ids))
        .group_by(RoomStatusView.status_id)
        .all()
    ):
        view_counts[sid] = c
    viewed_ids = {
        sid
        for (sid,) in session.query(RoomStatusView.status_id)
        .filter(
            RoomStatusView.status_id.in_(status_ids),
            RoomStatusView.viewer_user_id == user_id,
        )
        .distinct()
    }
    return [
        _serialize_status(
            r,
            authors.get(r.author_user_id),
            view_count=view_counts.get(r.id, 0),
            viewer_has_viewed=r.id in viewed_ids,
        )
        for r in rows
    ]


@app.delete(
    "/rooms/{room_id}/statuses/{status_id}",
    status_code=204,
    dependencies=[Depends(require_password)],
)
def delete_status(
    room_id: str,
    status_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> Response:
    """Author-only delete. Drops view rows + the image file, then
    broadcasts a delete envelope so other tabs remove the strip slot."""
    _require_member(session, room_id, user_id)
    s = session.get(RoomStatus, status_id)
    if s is None or s.room_id != room_id:
        raise HTTPException(404, "status not found")
    if s.author_user_id != user_id:
        raise HTTPException(403, "not your status")
    session.query(RoomStatusView).filter(
        RoomStatusView.status_id == status_id
    ).delete(synchronize_session=False)
    if s.attachment_image_token:
        try:
            _status_image_path(s.attachment_image_token).unlink(missing_ok=True)
        except OSError:
            pass
    session.delete(s)
    session.commit()
    chat_hub.publish(
        room_id, {"_op": "status:delete", "id": status_id, "room_id": room_id}
    )
    return Response(status_code=204)


@app.post(
    "/rooms/{room_id}/statuses/{status_id}/view",
    status_code=204,
    dependencies=[Depends(require_password)],
)
def mark_status_viewed(
    room_id: str,
    status_id: str,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> Response:
    """Idempotent. UNIQUE(status_id, viewer) means we just swallow the
    integrity error on the second view."""
    _require_member(session, room_id, user_id)
    s = session.get(RoomStatus, status_id)
    if s is None or s.room_id != room_id:
        raise HTTPException(404, "status not found")
    if s.author_user_id == user_id:
        # Authors don't count themselves.
        return Response(status_code=204)
    existing = (
        session.query(RoomStatusView)
        .filter(
            RoomStatusView.status_id == status_id,
            RoomStatusView.viewer_user_id == user_id,
        )
        .first()
    )
    if existing is None:
        session.add(
            RoomStatusView(
                id=str(uuid.uuid4()),
                status_id=status_id,
                viewer_user_id=user_id,
            )
        )
        try:
            session.commit()
        except Exception:
            session.rollback()
        else:
            # Tell the author's tabs the count moved.
            chat_hub.publish(
                room_id,
                {
                    "_op": "status:view",
                    "id": status_id,
                    "room_id": room_id,
                },
            )
    return Response(status_code=204)


@app.get("/rooms/{room_id}/statuses/{status_id}/image")
def get_status_image(
    room_id: str,
    status_id: str,
    request: Request,
    session: Session = Depends(db),
) -> FileResponse:
    """Members-only image fetch. Same query-string auth fallback as
    other media endpoints so browser <img> loaders work without
    custom headers."""
    pw = request.headers.get("X-App-Password") or request.query_params.get("password")
    expected = os.getenv("BIBLE_IU_PASSWORD") or ""
    if expected and pw != expected:
        raise HTTPException(401, "App password required.")
    token = request.headers.get("X-Session-Token") or request.query_params.get("session")
    user = resolve_user(token) if token else None
    if user is None:
        raise HTTPException(401, "not signed in")
    _require_member(session, room_id, user.id)
    s = session.get(RoomStatus, status_id)
    if s is None or s.room_id != room_id or not s.attachment_image_token:
        raise HTTPException(404, "No image for this status.")
    path = _status_image_path(s.attachment_image_token)
    if not path.exists():
        raise HTTPException(404, "No image for this status.")
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
    # Push only on GROUP notes — personal notes are private to the
    # author (rule-guide.MD §12) and must never reach another device.
    if payload.scope == "group":
        author = session.get(User, user_id)
        room = session.get(Room, room_id)
        anchor = (payload.verse_anchors[0] if payload.verse_anchors else None)
        # NoteCreate.snapshot is the Tiptap doc dict, not a string —
        # surfaced by MiroFish multi-group stress (28x KeyError(slice)
        # when scholars posted group notes). Coerce to JSON so the push
        # preview never crashes; the body is just a tease in the
        # notification anyway.
        import json as _json
        preview = (_json.dumps(payload.snapshot) if payload.snapshot else "")[:140]
        fanout_to_room(
            session, room_id,
            exclude_user_id=user_id,
            payload={
                "kind": "note",
                "room_id": room_id,
                "room_name": (room.name if room else "Bible IU"),
                "sender": (author.display_name or author.handle) if author else "Someone",
                "body": preview or (f"shared a note on {anchor}" if anchor else "shared a note"),
                "url": f"/?room={room_id}&tab=notes",
            },
        )
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


# ----------------------------- group-note delete ---------------------------
# Author-only delete enforced server-side. Personal notes don't need
# this — the personal Y.Doc is per-user, so no one else can connect
# to it. For GROUP notes the shared Y.Doc is read/write to every
# member, so the client UI gate alone is bypassable. This endpoint
# is the authoritative check: validate authorship from the shared
# doc, then apply the Y delete on the server's copy. The yjs sync
# layer broadcasts the change to every connected client, including
# the originator.
@app.delete(
    "/rooms/{room_id}/notes/{note_id}",
    dependencies=[Depends(require_password)],
)
async def delete_group_note(
    room_id: str,
    note_id: str,
    user_id: str = Depends(current_user_id),
    session: Session = Depends(db),
) -> dict[str, str]:
    _require_member(session, room_id, user_id)
    if yjs_sync._server_ctx is None:
        raise HTTPException(503, "sync server not ready")
    # Open (or hydrate) the room's shared notes doc.
    yjs_room = await yjs_sync._server.get_room(room_id)
    doc = yjs_room.ydoc
    from pycrdt import Array  # lazy — pycrdt is a runtime dep
    notes_arr = doc.get("notes", type=Array)
    target_index: Optional[int] = None
    target_author: Optional[str] = None
    target_by_agent = False
    for i in range(len(notes_arr)):
        m = notes_arr[i]
        try:
            cur_id = m["id"]
        except Exception:
            continue
        if cur_id == note_id:
            target_index = i
            try:
                target_author = m["author_user_id"]
            except KeyError:
                target_author = None
            try:
                target_by_agent = bool(m["by_agent"])
            except KeyError:
                target_by_agent = False
            break
    if target_index is None:
        raise HTTPException(404, "note not found in shared doc")
    # Authorship gate. Agent notes have no human owner — allow any
    # member to remove them (matches the client UI rule). Legacy
    # notes without `author_user_id` were created before authorship
    # was recorded; we refuse delete on those to avoid an attacker
    # wiping pre-rollout notes. The author can re-create them.
    if not target_by_agent:
        if target_author is None:
            raise HTTPException(
                403,
                "this note has no recorded author; only the original "
                "writer could delete it, and they need to re-save it "
                "first to record ownership",
            )
        if target_author != user_id:
            raise HTTPException(403, "only the author may delete this note")
    # Read the body BEFORE the delete so we can wipe any image
    # files it embedded. Y.Text → str via str(); empty when missing.
    body_tokens: set[str] = set()
    try:
        body_text = str(notes_arr[target_index]["body"])
        body_tokens = _note_image_tokens_in_body(body_text)
    except Exception:  # noqa: BLE001
        body_tokens = set()
    # Authorized. Apply the delete inside a transaction so the
    # yjs sync layer ships one clean update to every connected
    # client.
    with doc.transaction():
        del notes_arr[target_index]
    if body_tokens:
        _delete_image_files(body_tokens)
    return {"ok": "deleted"}


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
    # `likes` / `liked_by_me` are the heart count + flag — kept for
    # backward compatibility with PWA bundles cached in the SW before
    # the thumbs-up kind shipped. New fields cover the thumbsup kind.
    likes: int
    liked_by_me: bool
    thumbsups: int = 0
    thumbsuped_by_me: bool = False
    comments: list[NoteCommentOut]


_NOTE_REACTION_KINDS = {"heart", "thumbsup"}


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


_MENTION_RE = __import__("re").compile(
    r"(?:^|\s)@([a-zA-Z0-9_]{1,32})",
)


def _extract_mention_handles(text: str) -> list[str]:
    """Pull `@handle` substrings out of a free-text body. Leading
    whitespace or start-of-string before the `@` is required so
    email addresses (foo@bar) don't match. Case-folded so the
    resolver downstream can match against User.handle without per-
    handle lower() work."""
    if not text:
        return []
    seen: set[str] = set()
    for m in _MENTION_RE.finditer(text):
        seen.add(m.group(1).lower())
    return sorted(seen)


def _notify_note_mentions(
    session: Session,
    *,
    room_id: str,
    note_id: str,
    author_user_id: str,
    handles: list[str],
    dedupe: bool = True,
    push_body: str | None = None,
    log: "__import__('logging').Logger | None" = None,
) -> int:
    """Resolve handles to room members and Web-Push each tag with the
    same delivery semantics as chat / note-create fanout (room-mute +
    quiet-hours respected). Returns the count of NEW notifications
    that actually fired.

    `dedupe=True` (the default, used for note-body tags): inserts a
    NoteMention row per (note_id, user_id). Repeated POSTs for the
    same body are no-ops thanks to the unique constraint — the user
    can type @willy, save, save again, and Willy is pushed once.

    `dedupe=False` (used for note comments): each comment is its own
    discrete event so the dedupe table is skipped entirely. If the
    same person is tagged in two separate comments, two pushes fire.
    Otherwise a comment tag would be eaten by an earlier body tag of
    the same person, which is the wrong UX.

    `push_body` overrides the notification body text — defaults to
    "<author> tagged you in a note" which fits both call sites."""
    import logging
    if log is None:
        log = logging.getLogger("bible_iu.notes")
    if not handles:
        return 0
    handles = [h for h in handles if h]
    members = (
        session.query(User, RoomMember)
        .join(RoomMember, RoomMember.user_id == User.id)
        .filter(RoomMember.room_id == room_id)
        .filter(func.lower(User.handle).in_(handles))
        .all()
    )
    resolved = [(u, m) for (u, m) in members if u.id != author_user_id]
    log.info(
        "note_mention: room=%s note=%s dedupe=%s author=%s handles=%s resolved=%d",
        room_id, note_id, dedupe, author_user_id, handles, len(resolved),
    )
    if not resolved:
        return 0
    author = session.get(User, author_user_id)
    room = session.get(Room, room_id)
    sender_name = (
        (author.display_name or author.handle) if author else "Someone"
    )
    room_name = room.name if room else "Bible IU"
    body_text = push_body or f"{sender_name} tagged you in a note"
    sent = 0
    for (target_user, _member) in resolved:
        if dedupe:
            existing = (
                session.query(NoteMention)
                .filter(
                    NoteMention.note_id == note_id,
                    NoteMention.user_id == target_user.id,
                )
                .first()
            )
            if existing is not None:
                log.info(
                    "note_mention: skip (already notified) user=%s handle=%s",
                    target_user.id, target_user.handle,
                )
                continue
            session.add(
                NoteMention(
                    id=str(uuid.uuid4()),
                    note_id=note_id,
                    user_id=target_user.id,
                    room_id=room_id,
                )
            )
            try:
                session.commit()
            except Exception as commit_err:
                session.rollback()
                msg = str(commit_err).lower()
                if "unique" in msg or "uq_note_mentions" in msg:
                    continue
                log.warning(
                    "note_mention commit failed (note=%s user=%s): %s",
                    note_id, target_user.id, commit_err,
                )
                continue
        count = send_room_push_to_user(
            session,
            room_id,
            target_user.id,
            {
                "kind": "note_mention",
                "room_id": room_id,
                "room_name": room_name,
                "sender": sender_name,
                "body": body_text,
                "url": f"/?room={room_id}",
            },
        )
        log.info(
            "note_mention: pushed to user=%s handle=%s count=%d",
            target_user.id, target_user.handle, count,
        )
        if count > 0:
            sent += 1
    log.info("note_mention: total sent=%d", sent)
    return sent


class NoteMentionBody(BaseModel):
    """Handles the frontend extracted from the note body (e.g. @willy).
    Capped at 10 to bound the resolution + push cost per request; the
    backend silently drops anything past that. Personal notes never
    notify (rule-guide §12.1), so the endpoint refuses non-group note
    ids via _require_group_note."""
    handles: list[str]


@app.post(
    "/rooms/{room_id}/notes/{note_id}/mention",
    dependencies=[Depends(require_password)],
)
def post_note_mention(
    room_id: str,
    note_id: str,
    payload: NoteMentionBody,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> dict:
    """Resolve each handle to a room member, then insert one
    NoteMention row per (note, user) the FIRST time they're tagged.
    Repeated POSTs are no-ops thanks to the unique constraint. Each
    new mention fires a Web Push notification so the tagged member
    can jump back into the room and find the note.

    Authorization: caller must be a member of the room (targets must
    also be room members). We deliberately do NOT require the note
    to be registered as a group note here — yjsNotes' /register_group
    POST is fire-and-forget and can race the mention POST that fires
    after a 1.5s debounce. The membership check is the real
    authorization."""
    _require_member(session, room_id, user_id)
    raw = (payload.handles or [])[:10]
    handles = sorted({h.strip().lower() for h in raw if h and h.strip()})
    sent = _notify_note_mentions(
        session,
        room_id=room_id,
        note_id=note_id,
        author_user_id=user_id,
        handles=handles,
    )
    return {"sent": sent}


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
    hearts = [l for l in likes if (l.kind or "heart") == "heart"]
    thumbs = [l for l in likes if l.kind == "thumbsup"]
    return NoteSocialOut(
        likes=len(hearts),
        liked_by_me=any(l.user_id == user_id for l in hearts),
        thumbsups=len(thumbs),
        thumbsuped_by_me=any(l.user_id == user_id for l in thumbs),
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
    kind: str = "heart",
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> NoteSocialOut:
    """Toggle a (kind) reaction for (note, user). `kind` defaults to
    "heart" so the path stays backward-compatible with PWA bundles
    that shipped before thumbs-up — they post without a query string
    and get the original heart behavior. New PWA passes `?kind=thumbsup`
    for the second reaction."""
    if kind not in _NOTE_REACTION_KINDS:
        raise HTTPException(400, f"unknown reaction kind: {kind!r}")
    _require_member(session, room_id, user_id)
    _require_group_note(session, note_id, room_id)
    existing = session.scalar(
        select(NoteLike).where(
            NoteLike.note_id == note_id,
            NoteLike.user_id == user_id,
            NoteLike.kind == kind,
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
                kind=kind,
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
    body = payload.body.strip()
    session.add(
        NoteComment(
            id=str(uuid.uuid4()),
            note_id=note_id,
            author_user_id=user_id,
            room_id=room_id,
            body=body,
        )
    )
    session.commit()
    # Tag any `@handle`s in the comment body. Each comment is its own
    # event so dedupe is OFF: a person tagged in two separate comments
    # gets two pushes. Otherwise a comment tag would be eaten by an
    # earlier body tag of the same person (the dedupe was scoped
    # per note, not per source). Push body distinguishes comment vs
    # body so the recipient knows which to look at.
    handles = _extract_mention_handles(body)
    if handles:
        author_row = session.get(User, user_id)
        sender_name = (
            (author_row.display_name or author_row.handle)
            if author_row
            else "Someone"
        )
        _notify_note_mentions(
            session,
            room_id=room_id,
            note_id=note_id,
            author_user_id=user_id,
            handles=handles,
            dedupe=False,
            push_body=f"{sender_name} tagged you in a comment",
        )
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


class ProvenanceRow(BaseModel):
    """One audit-log entry from the agent's reasoning ledger. Mirrors
    the Provenance table; surfaced read-only to the Settings →
    Advanced auditor for users running with debug mode on."""
    id: str
    claim_id: str
    session_id: str
    verse_refs: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    tradition: Optional[str] = None
    reliability: Optional[str] = None
    verification_result: str
    kind: str
    created_at: str


@app.get(
    "/admin/provenance",
    response_model=list[ProvenanceRow],
    dependencies=[Depends(require_password)],
)
def list_provenance(
    limit: int = 100,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[ProvenanceRow]:
    """Last `limit` ledger rows, newest first. Gated by the
    deployment password (same gate as every other endpoint) plus a
    signed-in session — the Provenance table is global, not
    per-room, so any signed-in user with the deployment password can
    audit the agent's decisions. If multi-tenant separation is ever
    needed, scope by session.room_id on the join."""
    from ..data.models import Provenance as _P
    # `user_id` is consumed by the dependency injection so the
    # session token is checked — the auditing surface stays behind
    # signed-in users only.
    _ = user_id
    limit = max(1, min(500, int(limit)))
    rows = list(
        session.scalars(
            select(_P).order_by(_P.created_at.desc()).limit(limit)
        )
    )
    return [
        ProvenanceRow(
            id=r.id,
            claim_id=r.claim_id,
            session_id=r.session_id,
            verse_refs=list(r.verse_refs or []),
            source_refs=list(r.source_refs or []),
            tradition=r.tradition,
            reliability=r.reliability,
            verification_result=r.verification_result,
            kind=r.kind,
            created_at=(
                r.created_at.isoformat() if r.created_at is not None else ""
            ),
        )
        for r in rows
    ]


class ChatSearchHit(BaseModel):
    """One chat message that matched a cross-room search. Returned by
    GET /chat/search; carries enough room context for the client to
    navigate to it."""
    message_id: str
    room_id: str
    room_name: Optional[str] = None
    author_user_id: Optional[str] = None
    author_handle: Optional[str] = None
    body: str
    created_at: str


@app.get(
    "/chat/search",
    response_model=list[ChatSearchHit],
    dependencies=[Depends(require_password), Depends(search_rate_limit)],
)
def chat_search(
    q: str,
    room_id: Optional[str] = None,
    limit: int = 50,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[ChatSearchHit]:
    """Plain-text substring search across the caller's chat messages.

    Privacy: scoped to rooms the caller is a member of — same gate
    as the rest of the chat API. Pass `room_id` to narrow to a
    single room; omit for the cross-room sweep. Up to 50 hits,
    newest first."""
    needle = (q or "").strip()
    if not needle:
        return []
    if room_id is not None:
        _require_member(session, room_id, user_id)
        target_rooms = [room_id]
    else:
        target_rooms = [
            r.room_id
            for r in session.query(RoomMember.room_id).filter(
                RoomMember.user_id == user_id
            )
        ]
        if not target_rooms:
            return []
    from sqlalchemy import func
    rows = list(
        session.query(ChatMessage, User, Room)
        .join(Room, Room.id == ChatMessage.room_id)
        .outerjoin(User, User.id == ChatMessage.author_user_id)
        .filter(
            ChatMessage.room_id.in_(target_rooms),
            func.lower(ChatMessage.body).like(f"%{needle.lower()}%"),
        )
        .order_by(ChatMessage.created_at.desc())
        .limit(max(1, min(200, int(limit))))
        .all()
    )
    return [
        ChatSearchHit(
            message_id=m.id,
            room_id=m.room_id,
            room_name=(room.name if room else None),
            author_user_id=m.author_user_id,
            author_handle=(author.handle if author else None),
            body=m.body or "",
            created_at=(
                m.created_at.isoformat() if m.created_at is not None else ""
            ),
        )
        for m, author, room in rows
    ]


class NoteSearchHit(BaseModel):
    """One note that matched a cross-room search. Includes minimal
    room context so the client can navigate to it. `body` is the
    plain-text extract from `snapshot.body` truncated to ~240 chars
    for the preview."""
    note_id: str
    room_id: str
    room_name: Optional[str] = None
    scope: str  # 'personal' | 'group'
    body: str
    verse_anchors: list[str] = Field(default_factory=list)
    by_agent: bool = False
    updated_at: Optional[str] = None


@app.get(
    "/notes/all",
    response_model=list[NoteSearchHit],
    dependencies=[Depends(require_password)],
)
def notes_list_all(
    scope: Optional[str] = None,
    limit: int = 200,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[NoteSearchHit]:
    """All of the caller's visible notes across every room they're a
    member of. Same privacy boundary as `/notes/search`: personal
    notes are author-only, group notes are member-only. Newest-
    updated first; default 200 cap to keep payloads tame."""
    my_rooms = [
        r.room_id
        for r in session.query(RoomMember.room_id).filter(
            RoomMember.user_id == user_id
        )
    ]
    if not my_rooms:
        return []
    from sqlalchemy import or_ as _or
    clauses = []
    if scope in (None, "personal"):
        clauses.append(
            and_cond(Note.scope == "personal", Note.author_user_id == user_id)
        )
    if scope in (None, "group"):
        clauses.append(
            and_cond(Note.scope == "group", Note.room_id.in_(my_rooms))
        )
    if not clauses:
        return []
    rows = list(
        session.scalars(
            select(Note)
            .where(_or(*clauses))
            .order_by(Note.updated_at.desc())
            .limit(max(1, min(500, int(limit))))
        )
    )
    room_ids = {r.room_id for r in rows}
    rooms_by_id: dict[str, Room] = {}
    if room_ids:
        for room in session.scalars(select(Room).where(Room.id.in_(room_ids))):
            rooms_by_id[room.id] = room
    hits: list[NoteSearchHit] = []
    for r in rows:
        body_raw = (dict(r.snapshot or {}).get("body") or "").strip()
        body_text = _strip_html(body_raw)[:240]
        room = rooms_by_id.get(r.room_id)
        hits.append(
            NoteSearchHit(
                note_id=r.id,
                room_id=r.room_id,
                room_name=(room.name if room else None),
                scope=r.scope,
                body=body_text,
                verse_anchors=list(r.verse_anchors or []),
                by_agent=bool(r.author_is_agent),
                updated_at=(
                    r.updated_at.isoformat() if r.updated_at is not None else None
                ),
            )
        )
    return hits


@app.get(
    "/notes/search",
    response_model=list[NoteSearchHit],
    dependencies=[Depends(require_password), Depends(search_rate_limit)],
)
def notes_search(
    q: str,
    scope: Optional[str] = None,  # None = both; "personal" | "group"
    limit: int = 50,
    session: Session = Depends(db),
    user_id: str = Depends(current_user_id),
) -> list[NoteSearchHit]:
    """Cross-room note search. Privacy boundary identical to the
    repository contract (`rule-guide.MD` §12.1):
      - Personal notes: only the caller's own. Never anyone else's.
      - Group notes: visible across every room the caller is in.

    Match is plain-text substring (case-insensitive) on the note's
    `snapshot.body`. Up to 50 hits, newest-updated first."""
    needle = (q or "").strip()
    if not needle:
        return []
    # Caller's room memberships drive the group scope.
    my_rooms = [
        r.room_id
        for r in session.query(RoomMember.room_id).filter(
            RoomMember.user_id == user_id
        )
    ]
    if not my_rooms:
        return []
    # SQLAlchemy's JSON.contains is dialect-specific; for SQLite the
    # cleanest way is a LIKE on the json_extract'd body. We use the
    # `snapshot` JSON column's `.body` field — every note created by
    # the app stores its rich-text body under that key.
    from sqlalchemy import func, or_
    conditions = []
    if scope in (None, "personal"):
        conditions.append(
            and_cond(
                Note.scope == "personal",
                Note.author_user_id == user_id,
            )
        )
    if scope in (None, "group"):
        conditions.append(
            and_cond(
                Note.scope == "group",
                Note.room_id.in_(my_rooms),
            )
        )
    scope_clause = or_(*conditions) if conditions else None
    if scope_clause is None:
        return []
    body_match = func.lower(
        func.json_extract(Note.snapshot, "$.body")
    ).like(f"%{needle.lower()}%")
    rows = list(
        session.scalars(
            select(Note)
            .where(scope_clause, body_match)
            .order_by(Note.updated_at.desc())
            .limit(max(1, min(200, int(limit))))
        )
    )
    # Pull the room names in one round-trip.
    room_ids = {r.room_id for r in rows}
    rooms_by_id: dict[str, Room] = {}
    if room_ids:
        for room in session.scalars(
            select(Room).where(Room.id.in_(room_ids))
        ):
            rooms_by_id[room.id] = room
    hits: list[NoteSearchHit] = []
    for r in rows:
        body_raw = (dict(r.snapshot or {}).get("body") or "").strip()
        body_text = _strip_html(body_raw)[:240]
        room = rooms_by_id.get(r.room_id)
        hits.append(
            NoteSearchHit(
                note_id=r.id,
                room_id=r.room_id,
                room_name=(room.name if room else None),
                scope=r.scope,
                body=body_text,
                verse_anchors=list(r.verse_anchors or []),
                by_agent=bool(r.author_is_agent),
                updated_at=(
                    r.updated_at.isoformat() if r.updated_at is not None else None
                ),
            )
        )
    return hits


def and_cond(*conds):
    """Tiny shim so the call sites read clearly inside the
    `or_()` composition above without importing SQLAlchemy's
    `and_` separately."""
    from sqlalchemy import and_
    return and_(*conds)


def _strip_html(html: str) -> str:
    """Cheap HTML-tag stripper for the preview. The note bodies
    come from a sanitized HTML editor, so just removing angle-bracket
    spans is enough — no need for a real parser."""
    import re as _re
    return _re.sub(r"<[^>]+>", " ", html or "").replace("&nbsp;", " ").strip()


class BibleSearchHit(BaseModel):
    """One verse that matched a full-text query. The reader's search
    page renders these as a scrollable list. `text` is excerpted +
    has the matched terms wrapped with `**...**` so the client can
    style them without re-running the matcher."""
    verse_id: str
    book: str
    chapter: int
    verse: int
    text: str
    translation: str


@app.get(
    "/bible/search",
    response_model=list[BibleSearchHit],
    dependencies=[Depends(require_password), Depends(search_rate_limit)],
)
def bible_search(
    q: str,
    translation: str = "King James Version",
    limit: int = 50,
    session: Session = Depends(db),
) -> list[BibleSearchHit]:
    """Smart Bible search. Three modes:

    1. **Quoted phrase** — query wrapped in double quotes ("for God
       so loved") matches the exact substring, in order.
    2. **FTS5 stemming** — when the `translations_fts` virtual table
       is present (migration 0012) we run a MATCH query with the
       porter tokenizer so "loving" finds "love", "saved" finds
       "save". Ranked by FTS relevance.
    3. **LIKE fallback** — token AND substring search across the
       chosen translation (the original behavior). Used when FTS5 is
       unavailable or the query has wildcards.

    Empty `q` returns nothing (no full-Bible dumps).
    """
    needle = (q or "").strip()
    if not needle:
        return []

    cap = max(1, min(200, int(limit)))
    from sqlalchemy import and_, func, text as sa_text

    # --- Mode 1: quoted phrase ----------------------------------------
    if len(needle) >= 2 and needle.startswith('"') and needle.endswith('"'):
        phrase = needle[1:-1].strip()
        if not phrase:
            return []
        rows = list(
            session.scalars(
                select(Translation)
                .where(
                    Translation.name == translation,
                    func.lower(Translation.text).like(f"%{phrase.lower()}%"),
                )
                .order_by(Translation.verse_id)
                .limit(cap)
            )
        )
        return _hits_from_rows(rows)

    # --- Mode 2: FTS5 MATCH (if available) ----------------------------
    # The FTS5 virtual table is built off the `translations` table;
    # check for it lazily so this endpoint stays functional even on a
    # database that hasn't run migration 0012 yet.
    try:
        has_fts = bool(
            session.execute(
                sa_text(
                    "SELECT 1 FROM sqlite_master "
                    "WHERE type='table' AND name='translations_fts'"
                )
            ).first()
        )
    except Exception:
        has_fts = False

    if has_fts:
        # Build a MATCH expression. Each whitespace-separated token
        # becomes a prefix match (token*) so "lov" finds "love" too.
        tokens = [t for t in needle.lower().split() if t and t.isalnum()]
        if not tokens:
            return []
        match_expr = " ".join(f"{t}*" for t in tokens)
        try:
            rows = list(
                session.execute(
                    sa_text(
                        "SELECT verse_id, translation_name AS name, text "
                        "FROM translations_fts "
                        "WHERE text MATCH :match "
                        "  AND translation_name = :name "
                        "ORDER BY rank "
                        "LIMIT :cap"
                    ),
                    {"match": match_expr, "name": translation, "cap": cap},
                ).all()
            )
            hits: list[BibleSearchHit] = []
            for r in rows:
                parts = r.verse_id.split(".")
                if len(parts) != 3:
                    continue
                try:
                    ch = int(parts[1])
                    ve = int(parts[2])
                except ValueError:
                    continue
                hits.append(
                    BibleSearchHit(
                        verse_id=r.verse_id,
                        book=parts[0],
                        chapter=ch,
                        verse=ve,
                        text=r.text,
                        translation=r.name,
                    )
                )
            return hits
        except Exception:
            # If the FTS query fails (malformed token, etc.) fall
            # through to the LIKE path.
            pass

    # --- Mode 3: LIKE fallback ----------------------------------------
    tokens = [t for t in needle.lower().split() if t]
    if not tokens:
        return []
    conds = [func.lower(Translation.text).like(f"%{t}%") for t in tokens]
    rows = list(
        session.scalars(
            select(Translation)
            .where(Translation.name == translation, and_(*conds))
            .order_by(Translation.verse_id)
            .limit(cap)
        )
    )
    return _hits_from_rows(rows)


def _hits_from_rows(rows: list[Translation]) -> list[BibleSearchHit]:
    """Translate Translation ORM rows into BibleSearchHit (parsing the
    `BOOK.CH.V` verse_id). Shared by the phrase / FTS5 / LIKE paths
    so the response shape stays identical regardless of search mode."""
    out: list[BibleSearchHit] = []
    for r in rows:
        parts = r.verse_id.split(".")
        if len(parts) != 3:
            continue
        try:
            ch = int(parts[1])
            ve = int(parts[2])
        except ValueError:
            continue
        out.append(
            BibleSearchHit(
                verse_id=r.verse_id,
                book=parts[0],
                chapter=ch,
                verse=ve,
                text=r.text,
                translation=r.name,
            )
        )
    return out


class AdvancedSearchHit(BibleSearchHit):
    """AI-assisted suggestion. Same shape as a regular search hit but
    carries the model's rationale so the UI can label it as a guess."""

    rationale: str = ""
    confidence: str = "medium"  # high | medium | low


class AdvancedSearchRequest(BaseModel):
    query: str
    translation: str = "King James Version"


@app.post(
    "/bible/advanced_search",
    response_model=list[AdvancedSearchHit],
    dependencies=[Depends(require_password), Depends(search_rate_limit)],
)
def bible_advanced_search(
    payload: AdvancedSearchRequest,
    session: Session = Depends(db),
) -> list[AdvancedSearchHit]:
    """AI-assisted Bible search. The user types a fragment, misquote,
    or paraphrase ("love thy neeibor", "valley of shadow death") and
    the agent suggests up to 5 likely verses. Each suggestion is then
    VERIFIED against the database — the model only points; the verse
    text comes from `translations`, so even if the LLM hallucinates a
    reference we never return fake scripture (rule-guide.MD §2.4).

    Falls back silently to empty when:
      - The DeepSeek key isn't configured.
      - The query is too short to be meaningful (< 3 chars).
      - The LLM response can't be parsed as the expected JSON list.
      - None of the suggested references exist in the chosen translation.
    """
    q = (payload.query or "").strip()
    if len(q) < 3:
        return []

    import json
    import re
    from ..agent.skills.deepseek_backends import (
        DEEPSEEK_BASE,
        DEEPSEEK_MODEL,
        DEEPSEEK_TIMEOUT,
        _api_key,
    )
    import httpx

    key = _api_key()
    if not key:
        return []

    system = (
        "You are a Bible-reference assistant. The user is searching for "
        "a verse but may be misremembering words, paraphrasing, or "
        "typing fragments with typos. Identify the 1-5 MOST LIKELY "
        "verses they mean. Return ONLY a JSON array (no markdown, no "
        "prose) of objects with this exact shape:\n"
        '[{"book":"OSIS_CODE","chapter":3,"verse":16,'
        '"rationale":"matches the paraphrase","confidence":"high"}]\n\n'
        "OSIS codes are 3-letter book codes (GEN, EXO, MAT, MRK, JHN, "
        "ROM, etc.); 1-3 prefix for numbered books (1SA, 2KI, 1CO, "
        "2CO, 1JN, etc.). confidence is one of: high, medium, low. "
        "If no verse plausibly matches, return []. Never invent verses; "
        "return only canonical references."
    )
    user_msg = f"User search: {q!r}\n\nWhich verses are they probably looking for?"

    try:
        with httpx.Client(timeout=DEEPSEEK_TIMEOUT) as client:
            resp = client.post(
                f"{DEEPSEEK_BASE}/chat/completions",
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": DEEPSEEK_MODEL,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user_msg},
                    ],
                    "temperature": 0.2,
                    "response_format": {"type": "json_object"},
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
    except Exception:
        return []

    # The model may wrap its array in `{"suggestions": [...]}` because of
    # response_format=json_object. Accept either shape.
    try:
        parsed = json.loads(content)
    except Exception:
        # Last-ditch: extract the first [...] from the string.
        m = re.search(r"\[.*\]", content, re.DOTALL)
        if not m:
            return []
        try:
            parsed = json.loads(m.group(0))
        except Exception:
            return []

    if isinstance(parsed, dict):
        # Common keys: suggestions, results, verses.
        for k in ("suggestions", "results", "verses", "items", "data"):
            if isinstance(parsed.get(k), list):
                parsed = parsed[k]
                break
        else:
            return []
    if not isinstance(parsed, list):
        return []

    # Verify each suggestion against the database. The model points;
    # the DB provides the actual verse text. Silently drop any
    # reference that doesn't exist in this translation.
    out: list[AdvancedSearchHit] = []
    for item in parsed[:5]:
        if not isinstance(item, dict):
            continue
        book = str(item.get("book", "")).upper().strip()
        try:
            ch = int(item.get("chapter", 0))
            ve = int(item.get("verse", 0))
        except (TypeError, ValueError):
            continue
        if not book or ch <= 0 or ve <= 0:
            continue
        verse_id = f"{book}.{ch}.{ve}"
        row = session.scalar(
            select(Translation).where(
                Translation.name == payload.translation,
                Translation.verse_id == verse_id,
            )
        )
        if row is None:
            continue
        rationale = str(item.get("rationale", "")).strip()[:200]
        conf = str(item.get("confidence", "medium")).strip().lower()
        if conf not in ("high", "medium", "low"):
            conf = "medium"
        out.append(
            AdvancedSearchHit(
                verse_id=verse_id,
                book=book,
                chapter=ch,
                verse=ve,
                text=row.text,
                translation=row.name,
                rationale=rationale,
                confidence=conf,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Voice reader — Deepgram Aura TTS proxy
# ---------------------------------------------------------------------------
class TTSRequest(BaseModel):
    text: str
    # Deepgram Aura voice ID. aura-athena-en is articulate + clear,
    # well-suited to scripture. The frontend can override via this
    # field if a different voice is preferred.
    voice: str = "aura-athena-en"


@app.post(
    "/tts/speak",
    dependencies=[Depends(require_password), Depends(tts_rate_limit)],
)
def tts_speak(payload: TTSRequest) -> Response:
    """Proxy to Deepgram Aura for human-sounding TTS. Long inputs are
    chunked at sentence boundaries (Deepgram Aura caps each request
    around 2000 chars); the per-chunk MP3 streams are concatenated and
    returned as a single audio response. MP3 frames are independently
    decodable so byte-concatenation is safe.

    Returns MP3 audio bytes. On any failure (missing key, Deepgram
    error, etc.) returns 502 with a JSON body describing the failure,
    so the frontend can show a useful diagnostic instead of staring
    at a blank 204.
    """
    text = (payload.text or "").strip()
    if not text:
        return Response(status_code=204)
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        return JSONResponse(
            {"error": "DEEPGRAM_API_KEY not configured on the server"},
            status_code=502,
        )
    voice = payload.voice or "aura-athena-en"

    # Chunk at sentence boundaries. Deepgram Aura rejects inputs above
    # ~2000 chars; we target 1800 to leave headroom for added spaces
    # at join points.
    chunks = _chunk_for_tts(text, max_chars=1800)

    import httpx as _httpx
    audio_parts: list[bytes] = []
    try:
        with _httpx.Client(timeout=60.0) as client:
            for chunk in chunks:
                resp = client.post(
                    f"https://api.deepgram.com/v1/speak?model={voice}&encoding=mp3",
                    headers={
                        "Authorization": f"Token {key}",
                        "Content-Type": "application/json",
                    },
                    json={"text": chunk},
                )
                if resp.status_code >= 400:
                    return JSONResponse(
                        {
                            "error": "deepgram-failed",
                            "status": resp.status_code,
                            "body": resp.text[:500],
                            "chunk_len": len(chunk),
                        },
                        status_code=502,
                    )
                audio_parts.append(resp.content)
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {"error": "deepgram-exception", "detail": str(e)[:500]},
            status_code=502,
        )
    return Response(content=b"".join(audio_parts), media_type="audio/mpeg")


def _chunk_for_tts(text: str, max_chars: int = 1800) -> list[str]:
    """Split `text` into chunks ≤ max_chars, preferring sentence-end
    breaks (. ! ?) over paragraph or comma breaks. Each chunk is
    self-contained so Deepgram can render it without losing prosody."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    remaining = text
    while len(remaining) > max_chars:
        cut = max_chars
        # Walk backward looking for a sentence boundary.
        window = remaining[:cut]
        best = -1
        for marker in (". ", "! ", "? ", ".\n", "!\n", "?\n"):
            i = window.rfind(marker)
            if i > best:
                best = i + len(marker)
        if best < max_chars // 2:
            # No sentence end nearby — fall back to a clause-level
            # break, then to a word boundary.
            for marker in (", ", "; ", ":\n"):
                i = window.rfind(marker)
                if i > best:
                    best = i + len(marker)
        if best < max_chars // 2:
            i = window.rfind(" ")
            best = i if i > 0 else cut
        chunks.append(remaining[:best].strip())
        remaining = remaining[best:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


class VerseTokenOut(BaseModel):
    """One original-language token in a verse. The reader's per-word
    study popover renders one of these per word the user taps."""
    position: int
    surface_form: str
    lemma: str
    strongs: Optional[str] = None
    morphology: Optional[str] = None


@app.get(
    "/bible/{book}/{chapter}/{verse}/tokens",
    response_model=list[VerseTokenOut],
    dependencies=[Depends(require_password)],
)
def get_verse_tokens(
    book: str,
    chapter: int,
    verse: int,
    session: Session = Depends(db),
) -> list[VerseTokenOut]:
    """Hebrew/Greek per-word data for a single verse. Powers the
    tap-a-word study popover in the Bible reader. Empty list when
    the verse exists but has no token rows (e.g. a translation-only
    book or a gap in the seed). Data sources: OSHB (OT, CC-BY-4.0)
    + MorphGNT (NT, CC-BY-SA-3.0); see
    `backend/data/seed_original_tokens.py`."""
    from ..data.models import OriginalToken as _OT
    code = book.upper()
    verse_id = f"{code}.{chapter}.{verse}"
    rows = session.scalars(
        select(_OT).where(_OT.verse_id == verse_id).order_by(_OT.position)
    ).all()
    return [
        VerseTokenOut(
            position=r.position,
            surface_form=r.surface_form,
            lemma=r.lemma,
            strongs=r.strongs,
            morphology=r.morphology,
        )
        for r in rows
    ]


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
def _orchestrator(
    session: Session,
    allow_web: bool = False,
    citation_translation: Optional[str] = None,
) -> AgentOrchestrator:
    ledger = app.state.ledger
    # Generator selection ranks:
    #   1. Ollama (env: OLLAMA_MODEL) — local-first
    #   2. DeepSeek (env: DEEPSEEK_API_KEY) — cloud fallback
    #   3. Placeholder — tests / offline dev
    import os as _os
    has_key = bool(_os.environ.get("DEEPSEEK_API_KEY"))
    if ollama_configured():
        generator = OllamaGenerator()
    elif has_key:
        generator = DeepSeekGenerator()
    else:
        generator = PlaceholderGenerator()

    # Verifier selection. Two real layers now exist:
    #   - DeepSeekVerifier — same vendor as the generator. Strong but
    #     suffers from "grades own homework" (citation-engine.MD §5).
    #   - LocalNLIVerifier — separate model running on CPU. Independent
    #     evidence pass.
    # When BOTH are available we stack them so an entailment claim
    # only passes if both verifiers agree (StackedVerifier semantics —
    # AND on entails, OR on contradiction).  When DeepSeek isn't
    # configured we still get the local pass, which is a real
    # entailment check rather than the always-False PassThrough
    # default we used to fall back to.
    nli_off = _os.environ.get("LOCAL_NLI_DISABLED") == "1"
    if nli_off:
        verifier = DeepSeekVerifier() if has_key else PassThroughVerifier()
    elif has_key:
        verifier = StackedVerifier(DeepSeekVerifier(), LocalNLIVerifier())
    else:
        verifier = LocalNLIVerifier()
    # Citation translation = the English wording the agent quotes when
    # citing a verse to the user. Grounding (Hebrew/Greek + Strong's /
    # morphology) is independent and always runs against the original-
    # language anchor; this only affects the verbatim text shown in
    # cited verses so it matches what the user sees on the Bible page.
    resolved_translation = citation_translation or "King James Version"
    engine = CitationEngine(
        retriever=SqlRetriever(
            session,
            web_searcher=make_searcher(allow_web),
            translation_name=resolved_translation,
        ),
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
    orch = _orchestrator(
        session,
        allow_web=_web_search_allowed(room),
        citation_translation=payload.citation_translation,
    )
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
    # Consecutive-day streak ending today (or yesterday if the user
    # hasn't completed today's reading yet). Resets to 0 the day
    # after a missed day.
    streak_days: int = 0


class ReadingPlanDayOut(BaseModel):
    plan_id: str
    day_index: int
    refs: list[str]
    completed: bool


def _plan_status(
    session: Session, user_id: str, plan_id: str
) -> tuple[bool, Optional[int], int, int]:
    """(enrolled, current_day_index, completed_days, streak_days)."""
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
        return False, None, completed, 0
    started = enr.started_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    delta = (datetime.now(timezone.utc) - started).days
    plan = reading_plans.PLANS.get(plan_id)
    length = len(plan["days"]) if plan else 1
    current = max(1, min(length, delta + 1))
    # Streak: count back from `current` (or `current-1` if today
    # isn't done yet) finding consecutive day_indexes with
    # progress rows. The enrollment day_index increases by 1
    # per real-world day, so a continuous streak shows as a
    # contiguous integer range.
    done_indexes = {
        d for (d,) in session.query(ReadingPlanProgress.day_index).filter(
            ReadingPlanProgress.user_id == user_id,
            ReadingPlanProgress.plan_id == plan_id,
        )
    }
    streak = 0
    # If today's reading is done, start the streak at today and walk back.
    # Otherwise start at yesterday so today's incompleteness doesn't
    # immediately zero the streak — the user has until midnight to log it.
    walk_from = current if current in done_indexes else current - 1
    while walk_from >= 1 and walk_from in done_indexes:
        streak += 1
        walk_from -= 1
    return True, current, completed, streak


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
        enrolled, current, done, streak = _plan_status(
            session, user_id, plan_id
        )
        out.append(
            ReadingPlanSummary(
                **s,
                enrolled=enrolled,
                current_day=current,
                completed_days=done,
                streak_days=streak,
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
    enrolled, current, _, _ = _plan_status(session, user_id, plan_id)
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
        # Clear today's reminder slot so the scheduler stops nagging
        # for the rest of the day — the sweep would also catch this,
        # but flipping it inline avoids a window where the user could
        # get re-pushed after finishing.
        enrollment_row = session.scalar(
            select(ReadingPlanEnrollment).where(
                ReadingPlanEnrollment.user_id == user_id,
                ReadingPlanEnrollment.plan_id == plan_id,
            )
        )
        if enrollment_row is not None:
            from datetime import datetime as _dt
            enrollment_row.last_reminded_date = _dt.utcnow().date().isoformat()
        session.commit()
        # Celebration push to the user's own devices. Quiet on
        # purpose — no body preview of the refs, just an attaboy.
        plan_meta = reading_plans.plan_summary(plan_id)
        plan_name = plan_meta.get("name") or plan_id
        send_push_to_user(
            session, user_id,
            {
                "kind": "reading_plan_done",
                "plan_id": plan_id,
                "room_name": plan_name,
                "sender": "✓ Reading done",
                "body": f"Day {day_index} complete. Keep going!",
                "url": "/?tab=bible",
            },
        )
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

            orch = _orchestrator(
                session,
                allow_web=_web_search_allowed(room),
                citation_translation=req.citation_translation,
            )

            # Same gate the HTTP /reason endpoint applies: the user-facing
            # toggle can ASK to bypass the citation engine, but whether the
            # request honors it is the admin's call.
            effective_bypass = (
                req.bypass_citation_engine
                and ag_settings.bypass_citation_engine_allowed
            )

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
                                bypass_citation_engine=effective_bypass,
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
