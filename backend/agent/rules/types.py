"""Types the rule-enforcement middleware operates over.

The agent never speaks directly: it produces a structured `AgentOutput`,
which the middleware inspects rule-by-rule (rule-guide.MD §2-§14) before
the API serializes anything to a user.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Optional

ClaimKind = Literal[
    "scripture",
    "original_language",
    "commentary",
    "inference",
    "non_factual",
]

Surface = Literal[
    "reasoning_stream",
    "group_note",
    "personal_note",
    "chat",
    "media",
    "audio",
]

MediaKind = Literal["image", "video", "audio"]


class Decision(str, Enum):
    PASS = "pass"
    REVISE = "revise"
    REFUSE = "refuse"


@dataclass
class Verdict:
    decision: Decision
    rule: str
    reason: str = ""
    revision_hint: Optional[str] = None


@dataclass
class Citation:
    """A pointer recorded by the citation engine (citation-engine.MD §8).

    `verification_result` mirrors the engine's gate output and is the
    only field the rule layer trusts when judging support.
    """

    source_id: str
    verse_refs: list[str] = field(default_factory=list)
    tradition: Optional[str] = None
    reliability: Optional[str] = None
    verification_result: Literal["supported", "inference", "dropped"] = "inference"


@dataclass
class Claim:
    text: str
    kind: ClaimKind = "non_factual"
    citations: list[Citation] = field(default_factory=list)
    contradicts_scripture: bool = False


@dataclass
class MediaItem:
    kind: MediaKind
    ai_generated: bool = True
    label: str = ""
    presented_as_real: bool = False
    prompt: str = ""


@dataclass
class AgentOutput:
    reasoning: str = ""
    answer: str = ""
    claims: list[Claim] = field(default_factory=list)
    media: list[MediaItem] = field(default_factory=list)
    source_traditions: list[str] = field(default_factory=list)
    audio_marked_machine: bool = True
    surface: Surface = "reasoning_stream"
    note_op: Optional[Literal["append", "edit_human", "delete_human"]] = None
    note_attributed_to_agent: bool = True
    target_language: Optional[str] = None
    response_language: Optional[str] = None
    web_explanation: Optional[str] = None
    used_web: bool = False
    web_sources_filtered: bool = True
    accessed_personal_notes: bool = False
    crossed_room_boundary: bool = False


@dataclass
class EnforcementResult:
    decision: Decision
    verdicts: list[Verdict]

    @property
    def passed(self) -> bool:
        return self.decision is Decision.PASS

    @property
    def refused(self) -> Optional[Verdict]:
        for v in self.verdicts:
            if v.decision is Decision.REFUSE:
                return v
        return None
