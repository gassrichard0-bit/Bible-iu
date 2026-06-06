"""End-to-end agent path.

Per architecture.MD §4.1 every reasoning turn flows:
    retrieve -> generate -> citation engine -> rule enforcement -> render

The rule layer is non-bypassable: if it refuses, no output reaches the
user. If it asks for a revision, we attempt one retry; if it still fails
we degrade gracefully (citation-engine.MD §6).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .provenance.ledger import Ledger
from .reasoning import CitationEngine, GroundedAnswer, StreamingEvents
from .reasoning.types import NoteSuggestion
from .rules import (
    AgentOutput,
    Citation,
    Claim,
    Decision,
    enforce,
)


@dataclass
class HistoryTurn:
    """A prior reasoning turn, passed as conversational context.

    The `answer` is included so the model knows what was previously
    discussed, but it is NOT trusted as fact — each new turn still flows
    through retrieve → verify → gate (citation-engine.MD §10). If the
    model wants to cite a prior assertion, it must re-cite the source.
    """
    verse_ref: str
    question: str
    answer: str


@dataclass
class ReasoningRequest:
    room_id: str
    session_id: str
    verse_ref: str
    question: str
    target_language: Optional[str] = None
    history: list[HistoryTurn] = field(default_factory=list)
    # User-toggled in Settings, overriding the spec in rule-guide.MD §14
    # / citation-engine.MD §10. When true, the orchestrator skips both
    # verification (inside the engine) and the rule-layer enforce step.
    bypass_citation_engine: bool = False
    # Zoom level — the retriever uses this to expand or narrow the
    # context it pulls from scripture. See ReasoningRequest in
    # api/schemas.py for the four scopes.
    scope_kind: str = "verse"


@dataclass
class ReasoningTurn:
    decision: Decision
    grounded: GroundedAnswer
    refusal_reason: Optional[str] = None
    revision_hints: list[str] = None  # type: ignore[assignment]
    # Promoted to the top level so the API layer can persist it without
    # reaching into `grounded`. None when the agent didn't suggest a note
    # (the common case) or when the rule layer refused the overall turn.
    note_to_append: Optional[NoteSuggestion] = None

    def __post_init__(self) -> None:
        if self.revision_hints is None:
            self.revision_hints = []


def _grounded_to_output(
    grounded: GroundedAnswer,
    *,
    target_language: Optional[str],
) -> AgentOutput:
    claims = []
    traditions: set[str] = set()
    for c in grounded.claims:
        cits = []
        for cid in c.citation_ids:
            chunk = next((r for r in grounded.retrieval if r.citation_id == cid), None)
            if chunk and chunk.tradition:
                traditions.add(chunk.tradition)
            cits.append(
                Citation(
                    source_id=cid,
                    verse_refs=chunk.verse_refs if chunk else [],
                    tradition=chunk.tradition if chunk else None,
                    reliability=chunk.reliability if chunk else None,
                    verification_result=c.verification,
                )
            )
        claims.append(
            Claim(
                text=c.text,
                kind=c.kind,
                citations=cits,
                contradicts_scripture=c.contradicts_scripture,
            )
        )
    return AgentOutput(
        reasoning=grounded.reasoning,
        answer=grounded.answer,
        claims=claims,
        source_traditions=sorted(t for t in traditions if t),
        target_language=target_language,
        response_language=target_language,  # placeholder generator stub
    )


class AgentOrchestrator:
    def __init__(self, engine: CitationEngine, ledger: Ledger) -> None:
        self.engine = engine
        self.ledger = ledger

    def reason(
        self,
        req: ReasoningRequest,
        events: Optional[StreamingEvents] = None,
    ) -> ReasoningTurn:
        grounded = self.engine.run(
            room_id=req.room_id,
            session_id=req.session_id,
            verse_ref=req.verse_ref,
            question=req.question,
            events=events,
            history=req.history,
            bypass=req.bypass_citation_engine,
            scope_kind=req.scope_kind,
        )
        # Rule-layer enforce() ALWAYS runs (rule-guide.MD safety
        # predicates are non-bypassable). When the citation engine is
        # off, AgentOutput.claims is empty — the rule layer still gates
        # the other twelve predicates (chat scope, language, notes
        # privacy, etc.) and can still refuse the turn.
        output = _grounded_to_output(grounded, target_language=req.target_language)
        result = enforce(output)

        if result.decision is Decision.REFUSE:
            refused = result.refused
            return ReasoningTurn(
                decision=Decision.REFUSE,
                grounded=GroundedAnswer(
                    reasoning="",
                    answer="",
                    claims=[],
                    dropped=grounded.claims + grounded.dropped,
                    retrieval=grounded.retrieval,
                ),
                refusal_reason=refused.reason if refused else None,
            )

        revision_hints = [
            v.revision_hint or v.reason
            for v in result.verdicts
            if v.decision is Decision.REVISE
        ]
        return ReasoningTurn(
            decision=result.decision,
            grounded=grounded,
            revision_hints=revision_hints,
            note_to_append=grounded.note_to_append,
        )
