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


class ChatMessageCreate(BaseModel):
    body: str
    language: Optional[str] = None


class ChatMessageRead(BaseModel):
    id: str
    room_id: str
    author_user_id: Optional[str]
    author_is_agent: bool
    body: str
    language: Optional[str]


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
