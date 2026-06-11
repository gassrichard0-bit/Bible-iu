"""Shared types for the reasoning + citation engine."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

StatementKind = Literal[
    "scripture",
    "original_language",
    "commentary",
    "inference",
    "non_factual",
]

VerificationResult = Literal["supported", "inference", "dropped"]


@dataclass
class RetrievedChunk:
    """A retrieval result carrying everything the citation engine needs.

    `citation_id` is the stable id used in inline markers and ledger rows.
    `group_note` is the agent's oversight surface (rule-guide.MD §12.2);
    personal notes are NEVER a valid source_kind here (§12.1).
    """

    citation_id: str
    text: str
    source_kind: Literal[
        "scripture",
        "translation",
        "lexicon",
        "commentary",
        "web",
        "group_note",
    ]
    verse_refs: list[str] = field(default_factory=list)
    tradition: Optional[str] = None
    reliability: Optional[str] = None
    license: Optional[str] = None
    # Populated for room-scoped sources (group notes, agent notes appended
    # in a room) so `_r13_isolation` (rule-guide.MD §13.1) can detect a
    # cross-room leak. Universal sources (scripture, lexicon, commentary,
    # web) leave this as None.
    room_id: Optional[str] = None


@dataclass
class GeneratedStatement:
    """A single statement parsed out of the grounded LLM output."""

    text: str
    cited_ids: list[str] = field(default_factory=list)


@dataclass
class ClassifiedStatement(GeneratedStatement):
    kind: StatementKind = "non_factual"


@dataclass
class VerifiedClaim:
    text: str
    kind: StatementKind
    citation_ids: list[str]
    verification: VerificationResult
    contradicts_scripture: bool = False
    notes: str = ""


@dataclass
class NoteSuggestion:
    """An agent-suggested group note. The agent only ever appends to
    group notes, never personal, and the note is always attributed
    (`rule-guide.MD` §12.2). Verse anchor is optional.
    """
    body: str
    verse_anchor: Optional[str] = None


@dataclass
class GroundedAnswer:
    """The post-gate output. Reasoning vs answer is kept separate per
    rule-guide.MD §7.3 and rendered with Uncertainty UI tags (CLAUDE.md §4.7).
    """

    reasoning: str
    answer: str
    claims: list[VerifiedClaim]
    dropped: list[VerifiedClaim] = field(default_factory=list)
    retrieval: list[RetrievedChunk] = field(default_factory=list)
    note_to_append: Optional[NoteSuggestion] = None
