"""Handle + password user auth (CLAUDE.md §4.11).

Layered on top of the existing shared-password gate (`auth.py`):
  - Shared password = "this deployment isn't public" gate
  - User auth     = "who you are" — scopes personal notes, conversations,
                    eventually private rooms

Tokens are opaque UUIDs stored server-side (Session table) so revocation
is immediate. Passwords are Argon2id-hashed.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid4

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pathlib import Path
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session

import secrets
import string

from ..data import get_session
from ..data.models import (
    Annotation,
    BackupCode,
    Bookmark,
    ChatMessage,
    NoteComment,
    NoteLike,
    PhoneVerification,
    RegisteredGroupNote,
    Room,
    RoomMember,
    Session as SessionRow,
    User,
)
from ..sms import format_otp_message, get_sender
from .auth import require_password


_HASHER = PasswordHasher()
_SESSION_TTL = timedelta(days=30)
_HANDLE_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")
# 32-char Crockford-style alphabet (no O/I/0/1 to avoid transcription bugs).
_BACKUP_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
# Each code: 3 groups of 4 → ~60 bits of entropy per code.
_BACKUP_GROUPS = 3
_BACKUP_GROUP_LEN = 4
_BACKUP_BATCH = 10
# E.164 — leading '+' then 8–15 digits, first digit non-zero.
_PHONE_RE = re.compile(r"^\+[1-9]\d{7,14}$")
_OTP_TTL = timedelta(minutes=10)
_OTP_MAX_ATTEMPTS = 5
_OTP_RESEND_COOLDOWN = timedelta(seconds=30)


router = APIRouter(prefix="/auth", tags=["auth"])


def _db_session() -> Session:
    s = get_session()
    try:
        yield s
    finally:
        s.close()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utc_iso(dt: Optional[datetime]) -> str:
    """ISO-8601 with an explicit `+00:00` so JS `new Date()` parses it
    as UTC. SQLite-stored naive datetimes lose the original tzinfo —
    assume UTC (we always write `datetime.now(timezone.utc)`) and
    re-attach the marker."""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


class RegisterRequest(BaseModel):
    handle: str = Field(min_length=2, max_length=32)
    password: str = Field(min_length=8, max_length=200)
    display_name: Optional[str] = None


class LoginRequest(BaseModel):
    handle: str
    password: str


class SessionResponse(BaseModel):
    token: str
    handle: str
    display_name: str
    avatar_url: Optional[str] = None
    languages: list[str] = Field(default_factory=list)
    preferences: dict = Field(default_factory=dict)
    phone_e164: Optional[str] = None
    phone_verified_at: Optional[str] = None
    expires_at: str


class MeResponse(BaseModel):
    id: str
    handle: str
    display_name: str
    avatar_url: Optional[str] = None
    languages: list[str] = Field(default_factory=list)
    preferences: dict = Field(default_factory=dict)
    phone_e164: Optional[str] = None
    phone_verified_at: Optional[str] = None


class ProfilePatch(BaseModel):
    """Partial update of profile/preferences. Any field left as None
    is unchanged; pass an explicit empty value to clear."""
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    languages: Optional[list[str]] = None
    preferences: Optional[dict] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


@router.post(
    "/register",
    response_model=SessionResponse,
    dependencies=[Depends(require_password)],
)
def register(
    payload: RegisterRequest,
    s: Session = Depends(_db_session),
) -> SessionResponse:
    if not _HANDLE_RE.match(payload.handle):
        raise HTTPException(400, "handle must be 2-32 chars: letters, digits, _ or -")
    existing = s.scalar(select(User).where(User.handle == payload.handle))
    if existing is not None:
        raise HTTPException(409, "handle already taken")

    user = User(
        id=str(uuid4()),
        handle=payload.handle,
        display_name=payload.display_name or payload.handle,
        auth_provider="local",
        password_hash=_HASHER.hash(payload.password),
    )
    s.add(user)
    s.flush()  # user.id needs to exist before the welcome room references it

    # Onboarding: seed a Welcome room so the first sign-in lands somewhere
    # populated instead of a blank rail. Tips render in the notes sidebar
    # by name-detection on the frontend (no fake notes in the data layer).
    welcome = Room(
        id=str(uuid4()),
        type="group",
        name="Welcome to Bible IU 👋",
        scripture_context={"focused_verse": "JHN.3.16"},
    )
    s.add(welcome)
    s.add(
        RoomMember(
            id=str(uuid4()),
            room_id=welcome.id,
            user_id=user.id,
            # 'admin' is the canonical role since Phase 2 — see
            # `_require_admin()` in api/main.py. The Welcome room's
            # creator is the user themselves, so they get admin.
            role="admin",
        )
    )
    s.commit()
    return _issue_session(s, user)


@router.post(
    "/login",
    response_model=SessionResponse,
    dependencies=[Depends(require_password)],
)
def login(
    payload: LoginRequest,
    s: Session = Depends(_db_session),
) -> SessionResponse:
    user = s.scalar(select(User).where(User.handle == payload.handle))
    # Always run the hash verify path even on missing user, to avoid a
    # timing oracle on handle existence. We use a dummy hash for that.
    dummy = (
        "$argon2id$v=19$m=65536,t=3,p=4$cwGfvfwUYTbBflwxbgwAfg$"
        "DqxL1XOQTcLmOOQYg08eOyhFhJiNRMnk/JjLkj7N6Ic"
    )
    h = user.password_hash if user and user.password_hash else dummy
    try:
        _HASHER.verify(h, payload.password)
    except VerifyMismatchError:
        raise HTTPException(401, "invalid handle or password")
    if user is None:
        raise HTTPException(401, "invalid handle or password")
    return _issue_session(s, user)


@router.post(
    "/logout",
    dependencies=[Depends(require_password)],
)
def logout(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    if x_session_token:
        row = s.get(SessionRow, x_session_token)
        if row is not None:
            s.delete(row)
            s.commit()
    return {"ok": True}


@router.get(
    "/me",
    response_model=MeResponse,
    dependencies=[Depends(require_password)],
)
def me(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> MeResponse:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    return _user_to_response(user)


@router.patch(
    "/me",
    response_model=MeResponse,
    dependencies=[Depends(require_password)],
)
def patch_me(
    patch: ProfilePatch,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> MeResponse:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    if patch.display_name is not None:
        name = patch.display_name.strip()
        if not name:
            raise HTTPException(400, "display_name cannot be empty")
        user.display_name = name
    if patch.avatar_url is not None:
        # Accept any URL-ish string up to a reasonable cap; empty = clear.
        url = patch.avatar_url.strip()
        user.avatar_url = url[:500] or None
    if patch.languages is not None:
        cleaned = [l.strip()[:32] for l in patch.languages if l and l.strip()]
        user.languages = cleaned[:10]
    if patch.preferences is not None:
        merged = dict(user.preferences or {})
        merged.update(patch.preferences)
        user.preferences = merged
    s.commit()
    return _user_to_response(user)


class AvatarImageOut(BaseModel):
    avatar_url: Optional[str]


@router.post(
    "/me/image",
    response_model=AvatarImageOut,
    dependencies=[Depends(require_password)],
)
async def upload_my_avatar(
    file: UploadFile = File(...),
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> AvatarImageOut:
    """Authenticated user uploads their own photo. Re-encoded to WebP
    at ≤384px. The token bump invalidates the browser cache for
    everyone viewing the user's avatar (e.g. chat author rows)."""
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    raw = await file.read()
    if len(raw) > _USER_IMAGE_MAX_BYTES:
        raise HTTPException(413, "Image too large (max 20MB).")
    from io import BytesIO
    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(BytesIO(raw)) as im:
            im.load()
            from PIL.ImageOps import exif_transpose
            im = exif_transpose(im)
            im.thumbnail((_USER_IMAGE_MAX_SIDE, _USER_IMAGE_MAX_SIDE))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            _USER_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
            out_path = _user_image_path(user.id)
            im.save(out_path, format="WEBP", quality=82, method=4)
    except UnidentifiedImageError:
        raise HTTPException(415, "Unsupported image format.")
    user.avatar_image_token = uuid4().hex[:12]
    s.commit()
    return AvatarImageOut(avatar_url=_resolved_avatar_url(user))


@router.delete(
    "/me/image",
    response_model=AvatarImageOut,
    dependencies=[Depends(require_password)],
)
def delete_my_avatar(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> AvatarImageOut:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    path = _user_image_path(user.id)
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass
    user.avatar_image_token = None
    # Also clear the external URL so a "Remove" actually removes the
    # avatar instead of falling back to a previously-pasted URL the
    # user may have forgotten was there.
    user.avatar_url = None
    s.commit()
    return AvatarImageOut(avatar_url=_resolved_avatar_url(user))


class PublicUserView(BaseModel):
    """Trimmed user view — only what's safe to show to anyone who
    shares a room with this user. No password hash, no auth provider,
    no phone (people don't always want their phone broadcast)."""
    id: str
    handle: str
    display_name: str
    avatar_url: Optional[str] = None
    languages: list[str] = Field(default_factory=list)


@router.get(
    "/users/{user_id}",
    response_model=PublicUserView,
    dependencies=[Depends(require_password)],
)
def get_user_public(
    user_id: str,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> PublicUserView:
    """Used by the chat-avatar profile preview. Visible to any
    authenticated user — same trust boundary as listing room members.
    """
    if _resolve_session(s, x_session_token) is None:
        raise HTTPException(401, "not signed in")
    user = s.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    return PublicUserView(
        id=user.id,
        handle=user.handle,
        display_name=user.display_name,
        avatar_url=_resolved_avatar_url(user),
        languages=list(user.languages or []),
    )


@router.get("/users/{user_id}/image")
def get_user_avatar(
    user_id: str,
    request: Request,
    s: Session = Depends(_db_session),
) -> FileResponse:
    """Avatars are visible to any authenticated user. Browser `<img>`
    loaders can't send custom headers, so this handler accepts the
    deployment password + session token via header OR query string
    (`?password=…&session=…`). Cache-bust via `?v=<token>`."""
    pw = request.headers.get("X-App-Password") or request.query_params.get("password")
    expected = os.getenv("BIBLE_IU_PASSWORD") or ""
    if expected and pw != expected:
        raise HTTPException(401, "App password required.")
    token = request.headers.get("X-Session-Token") or request.query_params.get("session")
    if _resolve_session(s, token) is None:
        raise HTTPException(401, "not signed in")
    path = _user_image_path(user_id)
    if not path.exists():
        raise HTTPException(404, "No avatar set for this user.")
    return FileResponse(
        str(path),
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post(
    "/change-password",
    dependencies=[Depends(require_password)],
)
def change_password(
    payload: ChangePasswordRequest,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    if not user.password_hash:
        raise HTTPException(400, "local password not set for this account")
    try:
        _HASHER.verify(user.password_hash, payload.current_password)
    except VerifyMismatchError:
        raise HTTPException(401, "current password is incorrect")
    user.password_hash = _HASHER.hash(payload.new_password)
    # Invalidate all OTHER sessions for this user — keep the current one
    # so the caller stays signed in.
    rows = s.scalars(
        select(SessionRow).where(SessionRow.user_id == user.id)
    ).all()
    for row in rows:
        if row.id != x_session_token:
            s.delete(row)
    s.commit()
    return {"ok": True}


@router.delete(
    "/me",
    dependencies=[Depends(require_password)],
)
def delete_me(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    """Delete the calling user's account and every byte of their data
    we can. Group artifacts (chat, comments) are TOMBSTONED — the
    body stays for room history but the author goes null so the UI
    shows "deleted user". Rooms where the user is the only admin
    auto-promote another member; rooms where they're the only
    member are dropped entirely."""
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")

    user_id = user.id
    user_handle = user.handle

    # --- ROOM MEMBERSHIP: don't strand any group room ---
    memberships = s.scalars(
        select(RoomMember).where(RoomMember.user_id == user_id)
    ).all()
    rooms_to_drop: list[str] = []
    for mem in memberships:
        room = s.get(Room, mem.room_id)
        if room is None or room.type != "group" or mem.role != "admin":
            continue
        # Is this user the only admin?
        other_admins = s.scalars(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.role == "admin",
                RoomMember.user_id != user_id,
            )
        ).all()
        if other_admins:
            continue
        # Promote the longest-tenured non-admin member, if any.
        candidate = s.scalar(
            select(RoomMember)
            .where(
                RoomMember.room_id == room.id,
                RoomMember.user_id != user_id,
            )
            .order_by(RoomMember.created_at.asc())
        )
        if candidate is None:
            # User is the only member of this room — drop it.
            rooms_to_drop.append(room.id)
        else:
            candidate.role = "admin"

    # --- HARD DELETE: rows that are only meaningful to the user ---
    s.query(Bookmark).filter(Bookmark.user_id == user_id).delete(
        synchronize_session=False
    )
    s.query(Annotation).filter(Annotation.user_id == user_id).delete(
        synchronize_session=False
    )
    s.query(BackupCode).filter(BackupCode.user_id == user_id).delete(
        synchronize_session=False
    )
    s.query(PhoneVerification).filter(
        PhoneVerification.user_id == user_id
    ).delete(synchronize_session=False)
    s.query(NoteLike).filter(NoteLike.user_id == user_id).delete(
        synchronize_session=False
    )
    s.query(RegisteredGroupNote).filter(
        RegisteredGroupNote.author_user_id == user_id
    ).delete(synchronize_session=False)

    # --- TOMBSTONE: group artifacts stay for history, author goes null ---
    s.query(NoteComment).filter(NoteComment.author_user_id == user_id).update(
        {"author_user_id": None}, synchronize_session=False
    )
    s.query(ChatMessage).filter(ChatMessage.author_user_id == user_id).update(
        {"author_user_id": None}, synchronize_session=False
    )

    # --- MEMBERSHIP + ROOM DROPS ---
    s.query(RoomMember).filter(RoomMember.user_id == user_id).delete(
        synchronize_session=False
    )
    for room_id in rooms_to_drop:
        # Cascade by hand: invites, registered notes, comments, likes,
        # chat — all keyed on room_id. (SQLite FKs alone won't fire
        # without `PRAGMA foreign_keys=ON`.)
        s.execute(text("DELETE FROM room_invites WHERE room_id = :r"), {"r": room_id})
        s.query(RegisteredGroupNote).filter(
            RegisteredGroupNote.room_id == room_id
        ).delete(synchronize_session=False)
        s.query(NoteComment).filter(NoteComment.room_id == room_id).delete(
            synchronize_session=False
        )
        s.query(NoteLike).filter(NoteLike.room_id == room_id).delete(
            synchronize_session=False
        )
        s.query(ChatMessage).filter(ChatMessage.room_id == room_id).delete(
            synchronize_session=False
        )
        s.execute(text("DELETE FROM notes WHERE room_id = :r"), {"r": room_id})
        s.execute(text("DELETE FROM rooms WHERE id = :r"), {"r": room_id})

    # --- SESSIONS + USER ---
    s.query(SessionRow).filter(SessionRow.user_id == user_id).delete(
        synchronize_session=False
    )
    s.delete(user)
    s.commit()

    # --- YSTORE PURGE: per-user Y.Docs from the websocket store ---
    _purge_user_ystore(user_id=user_id, user_handle=user_handle)

    return {"ok": True}


def _purge_user_ystore(user_id: str, user_handle: str) -> None:
    """Delete every row in the Yjs ystore that belongs to docs only
    this user could connect to: `notes_private__{user_id}__...` and
    `conv__{user_handle}__...`. The schema is private to pycrdt so
    we sniff the candidate table names (matches scripts/scrub_legacy
    _personal_notes.py). Best-effort — failures here don't undo the
    SQL deletion above; orphaned bytes aren't a privacy issue (only
    the deleted user could have read them)."""
    from pathlib import Path
    import sqlite3

    store = (
        Path(__file__).resolve().parent.parent / "data" / "yjs" / "ystore.db"
    )
    if not store.is_file():
        return
    try:
        conn = sqlite3.connect(str(store))
    except sqlite3.Error:
        return
    try:
        target_tables: list[str] = []
        for candidate in ("yupdates", "ystore_yupdates", "updates"):
            try:
                conn.execute(
                    f"SELECT 1 FROM {candidate} LIMIT 1"
                )
                target_tables.append(candidate)
            except sqlite3.OperationalError:
                continue
        personal_prefix = f"notes_private__{user_id}__"
        conv_prefix = f"conv__{user_handle}__"
        for table in target_tables:
            conn.execute(
                f"DELETE FROM {table} WHERE path LIKE ? OR path LIKE ?",
                (f"{personal_prefix}%", f"{conv_prefix}%"),
            )
        conn.commit()
    except sqlite3.Error:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


class BackupCodesResponse(BaseModel):
    """Returned only the moment codes are generated — the plaintext is
    NOT stored anywhere, so this is the one chance to save them."""
    codes: list[str]
    generated_at: str


class BackupCodesStatus(BaseModel):
    total: int
    remaining: int
    last_generated_at: Optional[str]


class RecoverRequest(BaseModel):
    handle: str
    backup_code: str = Field(min_length=8, max_length=64)
    new_password: str = Field(min_length=8, max_length=200)


def _generate_backup_code() -> str:
    parts = [
        "".join(secrets.choice(_BACKUP_ALPHABET) for _ in range(_BACKUP_GROUP_LEN))
        for _ in range(_BACKUP_GROUPS)
    ]
    return "-".join(parts)


def _normalize_backup_code(raw: str) -> str:
    """Strip whitespace and uppercase; tolerate users typing with/without
    dashes. The alphabet excludes O/I/0/1 so common look-alikes don't
    need substitution."""
    s = "".join(c for c in raw if c not in string.whitespace).upper()
    # Remove dashes for canonical comparison — we'll match against
    # whatever the stored hash was generated against (with dashes).
    return s.replace("-", "")


def _format_canonical(stripped: str) -> str:
    """Insert dashes every _BACKUP_GROUP_LEN chars."""
    return "-".join(
        stripped[i : i + _BACKUP_GROUP_LEN]
        for i in range(0, len(stripped), _BACKUP_GROUP_LEN)
    )


@router.post(
    "/backup-codes/generate",
    response_model=BackupCodesResponse,
    dependencies=[Depends(require_password)],
)
def generate_backup_codes(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> BackupCodesResponse:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    # Drop any existing codes (used or not) — generating a fresh batch
    # invalidates the previous batch so the count display stays honest.
    s.query(BackupCode).filter(BackupCode.user_id == user.id).delete()
    codes = [_generate_backup_code() for _ in range(_BACKUP_BATCH)]
    now = _utcnow()
    for c in codes:
        s.add(
            BackupCode(
                id=str(uuid4()),
                user_id=user.id,
                code_hash=_HASHER.hash(c),
            )
        )
    s.commit()
    return BackupCodesResponse(codes=codes, generated_at=now.isoformat())


@router.get(
    "/backup-codes/status",
    response_model=BackupCodesStatus,
    dependencies=[Depends(require_password)],
)
def backup_codes_status(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> BackupCodesStatus:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    rows = s.scalars(
        select(BackupCode).where(BackupCode.user_id == user.id)
    ).all()
    if not rows:
        return BackupCodesStatus(total=0, remaining=0, last_generated_at=None)
    remaining = sum(1 for r in rows if r.used_at is None)
    # All rows in a batch share a created_at within a few ms — pick the
    # earliest to represent the generation moment.
    last = min(r.created_at for r in rows)
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return BackupCodesStatus(
        total=len(rows),
        remaining=remaining,
        last_generated_at=last.isoformat(),
    )


@router.post(
    "/recover",
    response_model=SessionResponse,
    dependencies=[Depends(require_password)],
)
def recover_account(
    payload: RecoverRequest,
    s: Session = Depends(_db_session),
) -> SessionResponse:
    """Recover a forgotten password using one single-use backup code.

    On success: sets a new password hash, marks the code used, deletes
    ALL existing sessions for the user (forcing other devices to sign in
    again), and issues a fresh session token for the caller.
    """
    user = s.scalar(select(User).where(User.handle == payload.handle))
    # Constant-ish-time behaviour: always run an Argon2 verify even when
    # the user is missing, so an attacker can't tell from latency whether
    # the handle exists.
    dummy_hash = (
        "$argon2id$v=19$m=65536,t=3,p=4$cwGfvfwUYTbBflwxbgwAfg$"
        "DqxL1XOQTcLmOOQYg08eOyhFhJiNRMnk/JjLkj7N6Ic"
    )
    submitted = _normalize_backup_code(payload.backup_code)
    canonical = _format_canonical(submitted)
    matched: Optional[BackupCode] = None
    if user is not None:
        rows = s.scalars(
            select(BackupCode).where(
                BackupCode.user_id == user.id,
                BackupCode.used_at.is_(None),
            )
        ).all()
        for row in rows:
            try:
                _HASHER.verify(row.code_hash, canonical)
                matched = row
                break
            except VerifyMismatchError:
                continue
    if matched is None:
        # Run one dummy verify so an attacker hitting an unknown handle
        # or a wrong code spends roughly the same time as a real check.
        try:
            _HASHER.verify(dummy_hash, canonical)
        except VerifyMismatchError:
            pass
        raise HTTPException(401, "invalid handle or backup code")
    assert user is not None
    # Burn the code.
    matched.used_at = _utcnow()
    user.password_hash = _HASHER.hash(payload.new_password)
    # Nuke all existing sessions — anyone on a stolen device gets booted.
    s.query(SessionRow).filter(SessionRow.user_id == user.id).delete()
    s.commit()
    return _issue_session(s, user)


class PhoneStartRequest(BaseModel):
    """E.164 phone number. We validate strictly so we don't blow money on
    typo'd SMS — the user must add the country code themselves."""
    phone: str = Field(min_length=8, max_length=20)


class PhoneStartResponse(BaseModel):
    phone_e164: str
    cooldown_until: str
    # In dev mode (LogOnlySender) we return the code so the client can
    # auto-fill for testing. Always None in production with Twilio creds.
    dev_code: Optional[str] = None


class PhoneVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


def _normalize_phone(raw: str) -> str:
    """Strip whitespace/dashes/parens, keep leading + and digits."""
    s = "".join(c for c in raw if c.isdigit() or c == "+")
    if not s.startswith("+") and s:
        # Allow numbers without explicit +; user has to supply country code.
        s = "+" + s
    return s


@router.post(
    "/phone/start",
    response_model=PhoneStartResponse,
    dependencies=[Depends(require_password)],
)
def phone_start(
    payload: PhoneStartRequest,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> PhoneStartResponse:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    phone = _normalize_phone(payload.phone)
    if not _PHONE_RE.match(phone):
        raise HTTPException(
            400, "phone must be E.164 — e.g. +14155551234 (country code + digits)"
        )
    # Rate-limit: at most one new code every 30s for this user.
    recent = s.scalars(
        select(PhoneVerification).where(PhoneVerification.user_id == user.id)
    ).all()
    now = _utcnow()
    for row in recent:
        sent_at = row.created_at
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        if now - sent_at < _OTP_RESEND_COOLDOWN:
            wait_s = int(
                (_OTP_RESEND_COOLDOWN - (now - sent_at)).total_seconds()
            ) + 1
            raise HTTPException(429, f"please wait {wait_s}s before requesting another code")
    # Drop any in-flight verifications for this user — only one at a time.
    for row in recent:
        s.delete(row)

    code = f"{_secure_otp():06d}"
    s.add(
        PhoneVerification(
            id=str(uuid4()),
            user_id=user.id,
            phone_e164=phone,
            code_hash=_HASHER.hash(code),
            expires_at=now + _OTP_TTL,
        )
    )
    s.commit()

    sender = get_sender()
    body = format_otp_message(code)
    try:
        sender.send(phone, body)
    except Exception as exc:
        # Roll the verification back so the user can retry without
        # tripping the cooldown.
        s.query(PhoneVerification).filter(
            PhoneVerification.user_id == user.id
        ).delete()
        s.commit()
        raise HTTPException(502, f"could not send SMS: {exc}")

    # Dev-mode convenience: when we're using the log-only sender (no
    # Twilio creds), surface the code in the response so the user can
    # finish the flow without tailing the log.
    from ..sms import LogOnlySender
    dev_code = code if isinstance(sender, LogOnlySender) else None

    return PhoneStartResponse(
        phone_e164=phone,
        cooldown_until=(now + _OTP_RESEND_COOLDOWN).isoformat(),
        dev_code=dev_code,
    )


@router.post(
    "/phone/verify",
    response_model=MeResponse,
    dependencies=[Depends(require_password)],
)
def phone_verify(
    payload: PhoneVerifyRequest,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> MeResponse:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    row = s.scalar(
        select(PhoneVerification).where(PhoneVerification.user_id == user.id)
    )
    if row is None:
        raise HTTPException(400, "no verification in progress — request a code first")
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < _utcnow():
        s.delete(row)
        s.commit()
        raise HTTPException(400, "code expired — request a new one")
    if row.attempts >= _OTP_MAX_ATTEMPTS:
        s.delete(row)
        s.commit()
        raise HTTPException(429, "too many attempts — request a new code")
    row.attempts += 1
    try:
        _HASHER.verify(row.code_hash, payload.code)
    except VerifyMismatchError:
        s.commit()
        raise HTTPException(401, "incorrect code")

    # Phone numbers are unique — if someone else already bound this one,
    # block the swap. (Argon2 verify happened first to avoid leaking
    # which numbers are taken via a timing oracle.)
    conflict = s.scalar(
        select(User).where(
            User.phone_e164 == row.phone_e164, User.id != user.id
        )
    )
    if conflict is not None:
        s.delete(row)
        s.commit()
        raise HTTPException(409, "this phone is already linked to another account")

    user.phone_e164 = row.phone_e164
    user.phone_verified_at = _utcnow()
    s.delete(row)
    s.commit()
    return _user_to_response(user)


@router.delete(
    "/phone",
    dependencies=[Depends(require_password)],
)
def phone_remove(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    user.phone_e164 = None
    user.phone_verified_at = None
    s.query(PhoneVerification).filter(
        PhoneVerification.user_id == user.id
    ).delete()
    s.commit()
    return {"ok": True}


def _secure_otp() -> int:
    """6-digit OTP from os.urandom — uniformly distributed across 0..999999."""
    import secrets
    return secrets.randbelow(1_000_000)


class BookmarkOut(BaseModel):
    book: str
    chapter: int
    verse: int
    updated_at: str


class BookmarkUpsert(BaseModel):
    chapter: int = Field(ge=1, le=200)
    verse: int = Field(ge=1, le=200)


_BOOK_RE = re.compile(r"^[A-Z0-9]{2,4}$")


@router.get(
    "/bookmarks",
    response_model=list[BookmarkOut],
    dependencies=[Depends(require_password)],
)
def list_bookmarks(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> list[BookmarkOut]:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    rows = s.scalars(
        select(Bookmark).where(Bookmark.user_id == user.id).order_by(
            Bookmark.updated_at.desc()
        )
    ).all()
    return [
        BookmarkOut(
            book=b.book,
            chapter=b.chapter,
            verse=b.verse,
            updated_at=_utc_iso(b.updated_at),
        )
        for b in rows
    ]


@router.put(
    "/bookmarks/{book}",
    response_model=BookmarkOut,
    dependencies=[Depends(require_password)],
)
def add_bookmark(
    book: str,
    payload: BookmarkUpsert,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> BookmarkOut:
    """Add a bookmark at `book` chapter:verse, or no-op (touch the
    updated_at) if one already exists at that exact verse. Multiple
    bookmarks per book are allowed — the UNIQUE constraint is on
    (user_id, book, chapter, verse)."""
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    if not _BOOK_RE.match(book):
        raise HTTPException(400, "book must be a 2-4 char code (e.g. GEN, JHN)")
    existing = s.scalar(
        select(Bookmark).where(
            Bookmark.user_id == user.id,
            Bookmark.book == book,
            Bookmark.chapter == payload.chapter,
            Bookmark.verse == payload.verse,
        )
    )
    if existing is None:
        row = Bookmark(
            id=str(uuid4()),
            user_id=user.id,
            book=book,
            chapter=payload.chapter,
            verse=payload.verse,
        )
        s.add(row)
    else:
        # Touch updated_at by re-assigning the verse (no-op if same).
        existing.verse = payload.verse
        row = existing
    s.commit()
    s.refresh(row)
    return BookmarkOut(
        book=row.book,
        chapter=row.chapter,
        verse=row.verse,
        updated_at=_utc_iso(row.updated_at),
    )


@router.delete(
    "/bookmarks/{book}/{chapter}/{verse}",
    dependencies=[Depends(require_password)],
)
def delete_bookmark_at(
    book: str,
    chapter: int,
    verse: int,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    """Remove the bookmark at exactly book/chapter/verse. Used when the
    user double-taps a divider that has no bookmark above it."""
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    s.query(Bookmark).filter(
        Bookmark.user_id == user.id,
        Bookmark.book == book,
        Bookmark.chapter == chapter,
        Bookmark.verse == verse,
    ).delete()
    s.commit()
    return {"ok": True}


@router.delete(
    "/bookmarks/{book}",
    dependencies=[Depends(require_password)],
)
def delete_book_bookmarks(
    book: str,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    """Remove all bookmarks for a given book. Used by the Marks tab's
    X button to clear an entire book's history."""
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    s.query(Bookmark).filter(
        Bookmark.user_id == user.id, Bookmark.book == book
    ).delete()
    s.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Annotations — verse highlight / underline / strikethrough.
#
# Per-user, room-independent (paper-Bible style: the user's marks
# follow them everywhere). `kind` is one of `highlight | underline |
# strikethrough`; `color` is a palette key the renderer maps to
# Tailwind classes.
# ---------------------------------------------------------------------------
_ANNOTATION_KINDS = {
    "highlight",
    "underline",
    "double_underline",
    "wavy",
    "box",
    "bold",
}
_ANNOTATION_COLORS = {"yellow", "green", "blue", "pink", "orange"}
_VERSE_ID_RE = re.compile(r"^[A-Z0-9]{2,4}\.\d{1,3}\.\d{1,3}$")


class AnnotationOut(BaseModel):
    verse_id: str
    kind: str
    color: str
    updated_at: str


class AnnotationUpsert(BaseModel):
    color: str


@router.get(
    "/annotations",
    response_model=list[AnnotationOut],
    dependencies=[Depends(require_password)],
)
def list_annotations(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> list[AnnotationOut]:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    rows = s.scalars(
        select(Annotation)
        .where(Annotation.user_id == user.id)
        .order_by(Annotation.updated_at.desc())
    ).all()
    return [
        AnnotationOut(
            verse_id=r.verse_id,
            kind=r.kind,
            color=r.color,
            updated_at=_utc_iso(r.updated_at),
        )
        for r in rows
    ]


@router.put(
    "/annotations/{verse_id}/{kind}",
    response_model=AnnotationOut,
    dependencies=[Depends(require_password)],
)
def set_annotation(
    verse_id: str,
    kind: str,
    payload: AnnotationUpsert,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> AnnotationOut:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    if not _VERSE_ID_RE.match(verse_id):
        raise HTTPException(400, "verse_id must look like GEN.1.1")
    if kind not in _ANNOTATION_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(_ANNOTATION_KINDS)}")
    if payload.color not in _ANNOTATION_COLORS:
        raise HTTPException(
            400, f"color must be one of {sorted(_ANNOTATION_COLORS)}"
        )
    existing = s.scalar(
        select(Annotation).where(
            Annotation.user_id == user.id,
            Annotation.verse_id == verse_id,
            Annotation.kind == kind,
        )
    )
    if existing is None:
        row = Annotation(
            id=str(uuid4()),
            user_id=user.id,
            verse_id=verse_id,
            kind=kind,
            color=payload.color,
        )
        s.add(row)
    else:
        existing.color = payload.color
        row = existing
    s.commit()
    s.refresh(row)
    return AnnotationOut(
        verse_id=row.verse_id,
        kind=row.kind,
        color=row.color,
        updated_at=_utc_iso(row.updated_at),
    )


@router.delete(
    "/annotations/{verse_id}/{kind}",
    dependencies=[Depends(require_password)],
)
def delete_annotation_kind(
    verse_id: str,
    kind: str,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    s.query(Annotation).filter(
        Annotation.user_id == user.id,
        Annotation.verse_id == verse_id,
        Annotation.kind == kind,
    ).delete()
    s.commit()
    return {"ok": True}


@router.delete(
    "/annotations/{verse_id}",
    dependencies=[Depends(require_password)],
)
def delete_annotations(
    verse_id: str,
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> dict:
    """Eraser — drop every annotation on this verse for this user."""
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "not signed in")
    s.query(Annotation).filter(
        Annotation.user_id == user.id, Annotation.verse_id == verse_id
    ).delete()
    s.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Self-uploaded avatar — admin-style flow but scoped to /me.
# ---------------------------------------------------------------------------
_USER_UPLOADS_DIR = (
    Path(os.environ.get("BIBLE_IU_UPLOADS_DIR", ""))
    if os.environ.get("BIBLE_IU_UPLOADS_DIR")
    else Path(__file__).resolve().parent.parent / "data" / "uploads"
) / "users"
_USER_IMAGE_MAX_BYTES = 20 * 1024 * 1024
_USER_IMAGE_MAX_SIDE = 384  # px — slightly tighter than rooms; profile photos render small


def _user_image_path(user_id: str) -> Path:
    return _USER_UPLOADS_DIR / f"{user_id}.webp"


def _resolved_avatar_url(user: User) -> Optional[str]:
    """When the user has uploaded their own photo, return the served
    URL (with cache-bust token). Otherwise return whatever's in
    `avatar_url` (an externally-hosted URL or null)."""
    token = getattr(user, "avatar_image_token", None)
    if token:
        return f"/auth/users/{user.id}/image?v={token}"
    return user.avatar_url


def _user_to_response(user: User) -> MeResponse:
    return MeResponse(
        id=user.id,
        handle=user.handle,
        display_name=user.display_name,
        avatar_url=_resolved_avatar_url(user),
        languages=list(user.languages or []),
        preferences=dict(user.preferences or {}),
        phone_e164=user.phone_e164,
        phone_verified_at=(
            user.phone_verified_at.isoformat()
            if user.phone_verified_at
            else None
        ),
    )


def _issue_session(s: Session, user: User) -> SessionResponse:
    token = str(uuid4())
    expires_at = _utcnow() + _SESSION_TTL
    s.add(SessionRow(id=token, user_id=user.id, expires_at=expires_at))
    s.commit()
    return SessionResponse(
        token=token,
        handle=user.handle,
        display_name=user.display_name,
        avatar_url=_resolved_avatar_url(user),
        languages=list(user.languages or []),
        preferences=dict(user.preferences or {}),
        phone_e164=user.phone_e164,
        phone_verified_at=(
            user.phone_verified_at.isoformat()
            if user.phone_verified_at
            else None
        ),
        expires_at=expires_at.isoformat(),
    )


def _resolve_session(s: Session, token: Optional[str]) -> Optional[User]:
    if not token:
        return None
    row = s.get(SessionRow, token)
    if row is None:
        return None
    # SQLite returns naive datetimes — coerce to UTC for the compare.
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < _utcnow():
        s.delete(row)
        s.commit()
        return None
    return s.get(User, row.user_id)


def require_user(
    s: Session = Depends(_db_session),
    x_session_token: Optional[str] = Header(default=None),
) -> User:
    """FastAPI dependency — guarantees the caller is authenticated.

    Use on any endpoint that touches user-scoped data. Distinct from
    `require_password` (the deployment gate) — both can be applied:
    the password gate fails first if the wrong deployment, then the
    user check fails if the session token is bad.
    """
    user = _resolve_session(s, x_session_token)
    if user is None:
        raise HTTPException(401, "session required")
    return user


def resolve_user(token: str) -> Optional[User]:
    """Standalone helper for WS handshakes (which can't use Depends).
    Opens its own short-lived session."""
    s = get_session()
    try:
        return _resolve_session(s, token)
    finally:
        s.close()
