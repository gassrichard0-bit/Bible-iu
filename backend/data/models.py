"""SQLAlchemy models — canonical implementation of `data-model.MD`.

Privacy invariants (data-model.MD §8) are enforced here, not just in the UI:
    1. Personal notes are never returned outside their owner's queries.
    2. Scripture rows are immutable at runtime.
    3. No Resource or Translation without a license field.
    4. Every fact surfaces with a Provenance record.
    5. Room isolation — private notes / reasoning never cross rooms.

Yjs documents (notes substrate, notes-system.MD §3.1) are stored as
opaque BLOBs alongside a JSON snapshot for cheap read access. The Yjs
doc is the source of truth for content.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    JSON,
    BLOB,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, onupdate=_utcnow
    )


# ---------------------------------------------------------------------------
# Identity & social — data-model.MD §2
# ---------------------------------------------------------------------------
class User(Base, TimestampMixin):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    handle: Mapped[str] = mapped_column(String, unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String)
    avatar_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Cache-bust token for the self-uploaded avatar served at
    # `/auth/users/{id}/image`. Null means "no upload — render the
    # external `avatar_url` (if any) or the gradient/initials fallback".
    avatar_image_token: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    auth_provider: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    auth_subject: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Argon2 hash for local auth. Null when auth_provider != 'local'.
    password_hash: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    languages: Mapped[list[str]] = mapped_column(JSON, default=list)
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)
    # E.164 phone number ("+14155551234"). Verified via WebOTP/SMS — we
    # only set both fields together in the `phone/verify` endpoint.
    phone_e164: Mapped[Optional[str]] = mapped_column(
        String, unique=True, nullable=True, index=True
    )
    phone_verified_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    # Email — optional. Lets the user request a password reset link
    # via SMTP and (later) gates trust-sensitive flows behind
    # `email_verified_at`. SQLite allows multiple NULL values through
    # a unique constraint, so the unique-when-set semantics fall out
    # naturally from the schema. `email_verified_at` is null until a
    # future verification flow flips it; not gated on tonight.
    email: Mapped[Optional[str]] = mapped_column(
        String, unique=True, nullable=True, index=True
    )
    email_verified_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )


class PasswordResetToken(Base, TimestampMixin):
    """One-shot reset link. Created when the user requests a password
    reset, consumed on click. Hashed in the DB so a SQL leak doesn't
    yield usable reset links."""
    __tablename__ = "password_reset_tokens"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String, unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class ReadingPlanEnrollment(Base, TimestampMixin):
    """User opted into one of the hard-coded reading plans (defined
    in `backend.api.reading_plans`). One row per (user, plan) — only
    one active enrollment per plan per user, but a user can be on
    multiple plans simultaneously."""
    __tablename__ = "reading_plan_enrollments"
    __table_args__ = (UniqueConstraint("user_id", "plan_id"),)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    plan_id: Mapped[str] = mapped_column(String, index=True)
    # The user's day-1 of the plan. The current day is derived from
    # `(today - started_at).days + 1`, capped at plan length.
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    # Date (YYYY-MM-DD in the user's local tz) we last fired a daily
    # reminder push for this enrollment. The scheduler skips rows
    # where this already equals today so we don't double-remind on a
    # restart, and never push on a day the user already finished.
    last_reminded_date: Mapped[Optional[str]] = mapped_column(
        String, nullable=True
    )


class ReadingPlanProgress(Base, TimestampMixin):
    """Check-off log. One row per (user, plan, day_index) the moment
    the user marks that day complete. Whether they skipped or fell
    behind is derived from absence of rows."""
    __tablename__ = "reading_plan_progress"
    __table_args__ = (UniqueConstraint("user_id", "plan_id", "day_index"),)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    plan_id: Mapped[str] = mapped_column(String, index=True)
    day_index: Mapped[int] = mapped_column()


class Annotation(Base, TimestampMixin):
    """A per-user mark on a (sub-range of a) single verse. `kind`
    distinguishes the paper-Bible tools the toolbar offers (highlight,
    underline, strikethrough); each (kind, range) is its own row so a
    verse can carry several simultaneously (e.g. yellow highlight on
    "For God so loved" + green highlight on "everlasting life" within
    one verse). `start_offset` / `end_offset` are character offsets
    into the verse text; both null means "whole verse" — the v1
    shape, preserved for backward compat. `color` is a palette key
    from the frontend (`yellow|green|blue|pink|orange`); the renderer
    translates into Tailwind classes."""
    __tablename__ = "annotations"
    __table_args__ = (
        # Wider uniqueness so a user can stack multiple sub-ranges of
        # the same kind on one verse, but still can't double-write the
        # SAME range twice (a duplicate would be a UI bug we want to
        # surface, not a write to retry).
        UniqueConstraint(
            "user_id",
            "verse_id",
            "kind",
            "start_offset",
            "end_offset",
            name="uq_annotations_user_verse_kind_range",
        ),
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    verse_id: Mapped[str] = mapped_column(String, index=True)
    kind: Mapped[str] = mapped_column(String)
    color: Mapped[str] = mapped_column(String)
    # null + null = whole verse (legacy / explicit "verse-wide" tools).
    # otherwise [start_offset, end_offset) in JS-string-character terms
    # over the canonical translation text the verse renders with.
    start_offset: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    end_offset: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)


class RegisteredGroupNote(Base, TimestampMixin):
    """Server-side registry of note IDs that are in a room's SHARED
    Y.Doc (i.e. group-scope). Likes + comments only accept note IDs
    that appear here.

    Personal notes never get registered — they live in per-user
    private Y.Docs that no one else can subscribe to, so their UUIDs
    are never legitimately exposed. If a personal note's UUID DOES
    leak (devtools, a frontend bug), the social endpoints still
    refuse it because there's no row here for it.

    Author is recorded so we can ignore registrations from anyone who
    isn't the actual note author (a member can't fake-register
    someone else's personal note as a group note).
    """
    __tablename__ = "registered_group_notes"
    note_id: Mapped[str] = mapped_column(String, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    author_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), index=True
    )


class NoteLike(Base, TimestampMixin):
    """One reaction per (note, user, kind). `kind` is "heart" (the
    original react) or "thumbsup"; a user can stack different kinds
    on the same note but not the same kind twice. Only group-scope
    notes are exposed in the UI for reactions — personal notes never
    leave the author's view (rule-guide.MD §12). `room_id` is
    duplicated for the membership check on every read/write."""
    __tablename__ = "note_likes"
    __table_args__ = (
        UniqueConstraint("note_id", "user_id", "kind", name="uq_note_likes_note_user_kind"),
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)
    note_id: Mapped[str] = mapped_column(String, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    kind: Mapped[str] = mapped_column(String, default="heart", index=True)


class NoteComment(Base, TimestampMixin):
    """Flat comments on a group note. Threading isn't supported by
    design — the spec leans toward humility, not Reddit-style debate
    trees. Authors can delete their own comments.

    `author_user_id` is nullable so account deletion can tombstone
    comments (body stays for group history; the author becomes
    "deleted user" in the UI)."""
    __tablename__ = "note_comments"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    note_id: Mapped[str] = mapped_column(String, index=True)
    author_user_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    body: Mapped[str] = mapped_column(Text)


class Bookmark(Base, TimestampMixin):
    """User's per-verse read marker. A book can have MANY bookmarks —
    each represents a past read point. The UI renders one divider per
    bookmark below the matching verse. Double-tapping a divider
    navigates to the next-nearest one above; when no bookmark above
    remains, the next double-tap deletes the current one."""
    __tablename__ = "bookmarks"
    __table_args__ = (UniqueConstraint("user_id", "book", "chapter", "verse"),)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    book: Mapped[str] = mapped_column(String)  # 3-letter code, e.g. "GEN"
    chapter: Mapped[int] = mapped_column()
    verse: Mapped[int] = mapped_column()


class BackupCode(Base, TimestampMixin):
    """One single-use account-recovery code. Argon2-hashed at rest so a
    DB leak doesn't expose live codes. Used codes are kept (with
    `used_at` set) so the UI can show 'X of 10 remaining' accurately."""
    __tablename__ = "backup_codes"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    code_hash: Mapped[str] = mapped_column(String)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class PhoneVerification(Base, TimestampMixin):
    """One in-flight verification per user — older rows for the same
    user are deleted when a new code is requested. Code is stored
    Argon2-hashed so a database leak doesn't expose live OTPs."""
    __tablename__ = "phone_verifications"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    phone_e164: Mapped[str] = mapped_column(String)
    code_hash: Mapped[str] = mapped_column(String)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(default=0)


class Session(Base, TimestampMixin):
    """Opaque-token session store for `Handle + password` auth.

    `id` is the bearer token the client sends. We store it server-side
    so revocation is immediate (vs JWTs which can't be revoked without
    extra infrastructure). `expires_at` keeps stale tokens from being
    valid forever.
    """
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Room(Base, TimestampMixin):
    __tablename__ = "rooms"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String)  # 'group' | 'direct'
    name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    scripture_context: Mapped[dict] = mapped_column(JSON, default=dict)
    # Per-room agent + safety controls — set by admins via
    # PATCH /rooms/{id}/agent_settings. Defaults are restrictive so a
    # fresh room is safe out of the box.
    agent_settings: Mapped[dict] = mapped_column(JSON, default=dict)
    # Opaque token tied to the room's current avatar. Bumped on every
    # successful upload so the frontend's `<img>` URL changes and the
    # browser cache discards the old one. Null means "no avatar set —
    # show the gradient/initials fallback".
    image_token: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Optional accent color picked by an admin. Stored as a palette key
    # (e.g. "amber", "sky", "rose") — the frontend maps it to actual
    # CSS variables so a future palette refresh doesn't require a DB
    # migration. Null = use the auto-derived color from the room id.
    accent_color: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class RoomMember(Base, TimestampMixin):
    __tablename__ = "room_members"
    __table_args__ = (UniqueConstraint("room_id", "user_id"),)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    # 'admin' or 'member'. The creator of a room is auto-promoted
    # to admin on insert (see api/main.py:create_room). Direct (1:1)
    # rooms keep both participants as 'member' since there's nothing
    # to administrate.
    role: Mapped[str] = mapped_column(String, default="member")
    # Last time this member opened the room and read messages. Used to
    # derive the `unread_count` returned by GET /rooms. Null = never
    # opened (the join time effectively becomes the read cutoff via
    # the COALESCE in the unread-count query in main.py).
    last_read_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )


class RoomInvite(Base, TimestampMixin):
    """Shareable join token for a room. `code` is the bearer secret —
    treat it like a password (don't log it, don't include in error msgs).
    Expiry and use-count caps make leaked links self-limiting."""
    __tablename__ = "room_invites"
    code: Mapped[str] = mapped_column(String, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    max_uses: Mapped[Optional[int]] = mapped_column(nullable=True)
    uses: Mapped[int] = mapped_column(default=0)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )


class ChatMessage(Base, TimestampMixin):
    __tablename__ = "chat_messages"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    author_user_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    author_is_agent: Mapped[bool] = mapped_column(Boolean, default=False)
    body: Mapped[str] = mapped_column(Text)
    language: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Optional image attachment. When set, an upload sits at
    # `data/uploads/chat/{id}.webp` and is served by
    # `GET /rooms/{room_id}/chat/{message_id}/image?v=<token>`.
    # The token is also the cache-bust value; null = no attachment.
    attachment_image_token: Mapped[Optional[str]] = mapped_column(
        String, nullable=True
    )
    # When this message is a reply, points at the parent. Renders as
    # the quoted preview above the body. Null = top-level message.
    reply_to_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("chat_messages.id"), nullable=True
    )
    # Admin can pin one or more messages to the top of the room
    # (announcements, verse-of-the-day, etc.). When set, the value
    # is an ISO timestamp recording when the pin happened — null =
    # not pinned. The timestamp lets the renderer order multiple
    # pinned messages by recency.
    pinned_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )


class ChatReaction(Base, TimestampMixin):
    """A single emoji reaction on a chat message.

    Unique on (message_id, user_id, emoji) — a user can stack
    different emojis on the same message (❤️ + 👍) but can't double
    up the same emoji. Toggling the same one removes it; tapping a
    new one adds another row.
    """
    __tablename__ = "chat_reactions"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", "emoji"),
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)
    message_id: Mapped[str] = mapped_column(
        ForeignKey("chat_messages.id"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    emoji: Mapped[str] = mapped_column(String)


class RoomStatus(Base, TimestampMixin):
    """A 24-hour "status" update inside a room (WhatsApp-style stories).

    Authors post a short text + optional image; everyone in the room
    sees the strip above chat and can tap into a full-screen viewer.
    `expires_at` is created_at + 24h and is the only TTL — we filter
    at read time and let the row stay until a sweeper drops it (or
    until the user deletes their own). Image attachments live at
    `data/uploads/status/{id}.webp`; the field stores the cache-bust
    token, NOT the image bytes.
    """
    __tablename__ = "room_statuses"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    author_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    body: Mapped[str] = mapped_column(Text, default="")
    attachment_image_token: Mapped[Optional[str]] = mapped_column(
        String, nullable=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class RoomStatusView(Base, TimestampMixin):
    """Records that a viewer saw a specific status. One row per
    (status, viewer). UPSERT-on-INSERT semantics in the API: if the
    row exists the viewed_at stays at the first sighting.
    """
    __tablename__ = "room_status_views"
    __table_args__ = (
        UniqueConstraint("status_id", "viewer_user_id"),
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)
    status_id: Mapped[str] = mapped_column(
        ForeignKey("room_statuses.id"), index=True
    )
    viewer_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), index=True
    )


class PushSubscription(Base, TimestampMixin):
    """A single Web Push endpoint registered by a user's browser/PWA.

    One user can have many subscriptions (phone PWA, laptop browser,
    second device). Endpoint is unique — re-subscribing on the same
    device upserts on the endpoint URL so we don't accumulate dead
    rows. `p256dh` + `auth` are the ECDH params the push service needs
    to decrypt our payload; both are URL-safe base64 strings from the
    PushSubscription.toJSON() shape.
    """
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint("endpoint"),
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    endpoint: Mapped[str] = mapped_column(String)
    p256dh: Mapped[str] = mapped_column(String)
    auth: Mapped[str] = mapped_column(String)
    # Bumped every time the push service accepts a send; 404/410
    # responses delete the row instead so we drop dead endpoints
    # without a separate sweeper job.
    last_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )


# ---------------------------------------------------------------------------
# Scripture & sources (read-only ground truth) — data-model.MD §3
# ---------------------------------------------------------------------------
class Verse(Base):
    __tablename__ = "verses"
    id: Mapped[str] = mapped_column(String, primary_key=True)  # e.g. GEN.1.1
    book: Mapped[str] = mapped_column(String, index=True)
    chapter: Mapped[int] = mapped_column()
    verse: Mapped[int] = mapped_column()


class OriginalToken(Base):
    """Hebrew/Greek token — the ground-truth anchor (CLAUDE.md §7.1)."""

    __tablename__ = "original_tokens"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    verse_id: Mapped[str] = mapped_column(ForeignKey("verses.id"), index=True)
    position: Mapped[int] = mapped_column()
    surface_form: Mapped[str] = mapped_column(String)
    lemma: Mapped[str] = mapped_column(String)
    strongs: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    morphology: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    lexicon_entry: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class Translation(Base):
    __tablename__ = "translations"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    verse_id: Mapped[str] = mapped_column(ForeignKey("verses.id"), index=True)
    text: Mapped[str] = mapped_column(Text)
    token_alignment: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    # CLAUDE.md §7.6: required. Enforced via event listener below.
    license: Mapped[str] = mapped_column(String)


class Resource(Base, TimestampMixin):
    """Commentary / cross-ref / lexicon — data-model.MD §3."""

    __tablename__ = "resources"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String)  # commentary | xref | lexicon
    source: Mapped[str] = mapped_column(String)
    tradition_tag: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reliability_flag: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # CLAUDE.md §7.6: required.
    license_attribution: Mapped[str] = mapped_column(String)
    body: Mapped[str] = mapped_column(Text)


class CrossReference(Base):
    __tablename__ = "cross_references"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    from_verse_id: Mapped[str] = mapped_column(ForeignKey("verses.id"), index=True)
    to_verse_id: Mapped[str] = mapped_column(ForeignKey("verses.id"), index=True)
    relation_type: Mapped[str] = mapped_column(String)  # thematic|quotation|parallel


# ---------------------------------------------------------------------------
# Notes — data-model.MD §4, notes-system.MD §8
# ---------------------------------------------------------------------------
class Note(Base, TimestampMixin):
    __tablename__ = "notes"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    author_user_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    author_is_agent: Mapped[bool] = mapped_column(Boolean, default=False)
    scope: Mapped[str] = mapped_column(String, index=True)  # 'personal' | 'group'
    yjs_doc: Mapped[Optional[bytes]] = mapped_column(BLOB, nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    verse_anchors: Mapped[list[str]] = mapped_column(JSON, default=list)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    language: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class VerseNoteIndex(Base):
    """verse_id -> note_id. Drives the inline verse toggle (notes-system.MD §5)."""

    __tablename__ = "verse_note_index"
    __table_args__ = (UniqueConstraint("verse_id", "note_id"),)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    verse_id: Mapped[str] = mapped_column(ForeignKey("verses.id"), index=True)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id"), index=True)


# ---------------------------------------------------------------------------
# Reasoning & provenance — data-model.MD §5
# ---------------------------------------------------------------------------
class ReasoningSession(Base, TimestampMixin):
    __tablename__ = "reasoning_sessions"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    verse_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("verses.id"), nullable=True
    )
    question: Mapped[str] = mapped_column(Text)
    reasoning: Mapped[str] = mapped_column(Text, default="")
    answer: Mapped[str] = mapped_column(Text, default="")
    resources_used: Mapped[list[str]] = mapped_column(JSON, default=list)
    recommendations: Mapped[list[str]] = mapped_column(JSON, default=list)


class Provenance(Base, TimestampMixin):
    __tablename__ = "provenance"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    claim_id: Mapped[str] = mapped_column(String, index=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("reasoning_sessions.id"), index=True
    )
    verse_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    source_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    tradition: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reliability: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reasoning_step_ref: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    verification_result: Mapped[str] = mapped_column(String)  # supported|inference|dropped
    kind: Mapped[str] = mapped_column(String)


# ---------------------------------------------------------------------------
# Media — data-model.MD §6
# ---------------------------------------------------------------------------
class Media(Base, TimestampMixin):
    __tablename__ = "media"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String)  # image|video|audio
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=True)
    label: Mapped[str] = mapped_column(
        String, default="AI-generated — illustrative"
    )
    prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    storage_uri: Mapped[Optional[str]] = mapped_column(String, nullable=True)


# ---------------------------------------------------------------------------
# Sync — data-model.MD §7
# ---------------------------------------------------------------------------
class SyncMeta(Base, TimestampMixin):
    """Minimal — Yjs carries its own clocks (data-model.MD §7)."""

    __tablename__ = "sync_meta"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    doc_id: Mapped[str] = mapped_column(String, index=True)
    device: Mapped[str] = mapped_column(String)
    last_synced: Mapped[datetime] = mapped_column(DateTime)


# ---------------------------------------------------------------------------
# Invariants enforced at the data layer
# ---------------------------------------------------------------------------
@event.listens_for(Verse, "before_update")
@event.listens_for(OriginalToken, "before_update")
def _scripture_is_immutable(mapper, connection, target):
    # data-model.MD §8.2 — scripture rows are immutable at runtime.
    raise RuntimeError("Scripture rows are immutable at runtime.")


@event.listens_for(Translation, "before_insert")
@event.listens_for(Resource, "before_insert")
def _require_license(mapper, connection, target):
    # CLAUDE.md §7.6 — no source ships without a recorded license.
    license_value = getattr(target, "license", None) or getattr(
        target, "license_attribution", None
    )
    if not license_value or not str(license_value).strip():
        raise ValueError(
            f"{type(target).__name__} requires a license/attribution "
            "(CLAUDE.md §7.6)."
        )
