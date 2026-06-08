"""Pydantic schemas for the HTTP / WS surface."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    ok: bool = True


class RoomCreate(BaseModel):
    type: Literal["group", "direct"]
    name: Optional[str] = None
    member_ids: list[str] = Field(default_factory=list)


class RoomRead(BaseModel):
    id: str
    type: str
    name: Optional[str]
    scripture_context: dict = Field(default_factory=dict)
    # Caller's role IN THIS ROOM — populated by GET /rooms and
    # POST /rooms. Lets the Profile UI flag rooms the user
    # administrates without a second round-trip.
    role: Optional[str] = None
    # When an admin has uploaded a room avatar, this is the URL that
    # serves it (with a cache-busting query param so the browser
    # refetches on every re-upload). Null = no avatar set — frontend
    # falls back to the gradient + initials.
    image_url: Optional[str] = None
    # Optional accent color picked by an admin from a fixed palette
    # (see `ROOM_ACCENT_PALETTE` in main.py). Null = the frontend
    # auto-derives one from the room id so brand-new rooms still look
    # distinct out of the box.
    accent_color: Optional[str] = None
    # Count of chat messages in this room newer than the caller's
    # `last_read_at`, authored by someone other than the caller. Drives
    # the in-app unread badges. Always present; zero when caught up.
    unread_count: int = 0
    # Most-recent chat message in this room — used by the rooms rail
    # to render WhatsApp-style row previews + sort by activity. All
    # three are null when the room has no messages yet.
    last_message_body: Optional[str] = None
    last_message_at: Optional[str] = None  # ISO-8601 UTC
    last_message_author_handle: Optional[str] = None


class ChatMessageCreate(BaseModel):
    body: str
    language: Optional[str] = None
    # When the user is replying to a specific message, that message's
    # id. Server validates it belongs to the same room. Null = top-level.
    reply_to_id: Optional[str] = None


class ChatMessageRead(BaseModel):
    id: str
    room_id: str
    author_user_id: Optional[str]
    author_is_agent: bool
    body: str
    language: Optional[str]
    # Populated for outbound replies so the UI can render the
    # author's name without a second lookup. Null when the author
    # deleted their account; "(deleted user)" rendered in the UI.
    author_handle: Optional[str] = None
    author_display_name: Optional[str] = None
    # Resolved avatar URL — uploaded webp (`/auth/users/{id}/image?v=...`)
    # if the user uploaded one, else the externally-provided `avatar_url`,
    # else null. Lets the chat UI render the sender's photo without a
    # second round-trip per message.
    author_avatar_url: Optional[str] = None
    # Cache-busted URL of an image attachment, if any. Same auth-via-
    # query-string pattern as room/user avatars. Null on plain text
    # messages. The token portion of the URL changes on every upload
    # so the browser cache discards old images on re-send.
    attachment_image_url: Optional[str] = None
    # When this message is a reply, the parent's id + a short text
    # preview to show inline above the bubble. Authors of the parent
    # are looked up by the same join used for the message itself.
    reply_to_id: Optional[str] = None
    reply_to_body: Optional[str] = None
    reply_to_author_handle: Optional[str] = None
    reply_to_has_image: bool = False
    # Aggregated reactions on this message. `mine` is True when the
    # current viewer has applied this emoji — drives the highlighted
    # state on the reaction pill in chat.
    reactions: list["ReactionTally"] = Field(default_factory=list)
    created_at: Optional[str] = None
    # ISO timestamp when an admin pinned this message. Null = not
    # pinned. The chat UI sorts pinned messages above unpinned ones
    # within their normal time order.
    pinned_at: Optional[str] = None


class ReactionTally(BaseModel):
    emoji: str
    count: int
    mine: bool


class NoteCreate(BaseModel):
    scope: Literal["personal", "group"]
    snapshot: dict = Field(default_factory=dict)
    verse_anchors: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    language: Optional[str] = None


class NoteRead(BaseModel):
    id: str
    room_id: str
    scope: str
    author_user_id: Optional[str]
    author_is_agent: bool
    snapshot: dict
    verse_anchors: list[str]
    tags: list[str]


class BibleBook(BaseModel):
    code: str
    name: str
    chapters: int


class BibleVerse(BaseModel):
    verse_id: str
    book: str
    chapter: int
    verse: int
    text: str
    translation: str
    license: str


class BibleChapter(BaseModel):
    book: str
    chapter: int
    translation: str
    verses: list[BibleVerse]


class BibleVerseTranslation(BaseModel):
    name: str
    text: str
    direction: Literal["ltr", "rtl"]
    license: str


class BibleVerseMulti(BaseModel):
    verse_id: str
    book: str
    chapter: int
    verse: int
    translations: list[BibleVerseTranslation]


class BibleChapterMulti(BaseModel):
    book: str
    chapter: int
    translations: list[str]
    verses: list[BibleVerseMulti]


class CrossRefOut(BaseModel):
    to_verse_id: str
    relation_type: str
    text: Optional[str] = None  # preview text in the requested translation


class AgentNoteOut(BaseModel):
    id: str
    body: str
    verse_anchors: list[str]
    created_at: str


class ReasoningHistoryTurn(BaseModel):
    verse_ref: str
    question: str
    answer: str


class ReasoningRequest(BaseModel):
    room_id: str
    verse_ref: str
    question: str
    target_language: Optional[str] = None
    history: list[ReasoningHistoryTurn] = Field(default_factory=list)
    # Override the spec rule (rule-guide.MD §14, citation-engine.MD §10).
    # When true, the orchestrator skips claim parsing / verification /
    # gating and returns raw LLM output. The user opted into this in
    # Settings; the safety invariant no longer holds for that response.
    bypass_citation_engine: bool = False
    # Caller's current zoom level — drives how much scripture context
    # the retriever pulls in. `verse` is the historical behavior;
    # wider scopes expand the lookup:
    #   verse     → just the anchor verse + its cross-refs
    #   chapter   → every verse in `BOOK.CHAPTER`
    #   book      → representative passages from the book
    #   testament → no retrieval; LLM general knowledge + framing
    #   bible     → no retrieval; LLM general knowledge + framing
    scope_kind: Literal["verse", "chapter", "book", "testament", "bible"] = "verse"


class CitationOut(BaseModel):
    source_id: str
    verse_refs: list[str]
    tradition: Optional[str] = None
    reliability: Optional[str] = None
    verification_result: str


class ClaimOut(BaseModel):
    text: str
    kind: str
    citations: list[CitationOut]
    contradicts_scripture: bool = False


class AgentNoteAppended(BaseModel):
    id: str
    body: str
    verse_anchor: Optional[str] = None


class ReasoningResponse(BaseModel):
    decision: str
    reasoning: str
    answer: str
    claims: list[ClaimOut]
    dropped: list[ClaimOut] = Field(default_factory=list)
    revision_hints: list[str] = Field(default_factory=list)
    refusal_reason: Optional[str] = None
    note_appended: Optional[AgentNoteAppended] = None
