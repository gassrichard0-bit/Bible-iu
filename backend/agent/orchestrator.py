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


def _detect_response_language(text: str, fallback: Optional[str]) -> Optional[str]:
    """Best-effort language id for the model's answer so rule §11 can
    actually fire. Heuristic, not a full classifier:
      - Hebrew block U+0590-U+05FF   -> 'he'
      - Arabic block U+0600-U+06FF   -> 'ar'
      - CJK ideographs U+4E00-U+9FFF -> 'zh'
      - Hiragana/Katakana            -> 'ja'
      - Hangul U+AC00-U+D7AF         -> 'ko'
      - Cyrillic U+0400-U+04FF       -> 'ru'
      - Greek block U+0370-U+03FF    -> 'el'
    Otherwise default to the caller-provided target language (so a
    Latin-script question doesn't trigger spurious revises)."""
    if not text:
        return fallback
    for ch in text:
        code = ord(ch)
        if 0x0590 <= code <= 0x05FF:
            return "he"
        if 0x0600 <= code <= 0x06FF:
            return "ar"
        if 0x4E00 <= code <= 0x9FFF:
            return "zh"
        if 0x3040 <= code <= 0x30FF:
            return "ja"
        if 0xAC00 <= code <= 0xD7AF:
            return "ko"
        if 0x0400 <= code <= 0x04FF:
            return "ru"
        if 0x0370 <= code <= 0x03FF:
            return "el"
    return fallback


def _grounded_to_output(
    grounded: GroundedAnswer,
    *,
    target_language: Optional[str],
    request_room_id: str,
) -> AgentOutput:
    claims = []
    # Build `source_traditions` from RETRIEVAL, not claims. rule-guide
    # §5.2's "multiple traditions were available but only one cited"
    # check needs to know what was AVAILABLE — the chunks the retriever
    # pulled — to compare against what the model actually used.
    available_traditions: set[str] = set()
    for r in grounded.retrieval:
        if r.tradition:
            available_traditions.add(r.tradition)

    for c in grounded.claims:
        cits = []
        for cid in c.citation_ids:
            chunk = next((r for r in grounded.retrieval if r.citation_id == cid), None)
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

    # Web signals (rule-guide.MD §8). `used_web` flips on if any chunk
    # the retriever returned was a web result. `web_sources_filtered`
    # stays True because the only path to source_kind="web" is via
    # `WebSearcher` (skills/web_search.py) which enforces the §8.2
    # allowlist + profanity + injection filters before returning. If a
    # future skill emits raw web chunks bypassing the searcher, it MUST
    # flip this to False so the rule layer can refuse.
    web_chunks = [r for r in grounded.retrieval if r.source_kind == "web"]
    used_web = bool(web_chunks)
    web_explanation = None
    if used_web:
        domains = sorted({
            r.citation_id.removeprefix("web:").split("/", 3)[2]
            if r.citation_id.startswith("web:")
            else r.citation_id
            for r in web_chunks
        })
        web_explanation = (
            f"Web sources consulted: {', '.join(domains)}. Each result passed "
            "the allowlist + profanity/injection filter (rule-guide.MD §8.2). "
            "Claims were verified against scripture before inclusion."
        )

    # Room isolation (rule-guide.MD §13). The retriever is room-scoped
    # at the call site (`retrieve(..., room_id=...)`), so every chunk
    # IS from this room by construction. We carry the request's room_id
    # forward so a future retriever that returns mixed-room chunks can
    # raise this signal here — the rule layer will refuse.
    crossed = False
    for r in grounded.retrieval:
        chunk_room = getattr(r, "room_id", None)
        if chunk_room and chunk_room != request_room_id:
            crossed = True
            break

    response_language = _detect_response_language(grounded.answer, target_language)

    return AgentOutput(
        reasoning=grounded.reasoning,
        answer=grounded.answer,
        claims=claims,
        source_traditions=sorted(t for t in available_traditions if t),
        target_language=target_language,
        response_language=response_language,
        used_web=used_web,
        web_sources_filtered=True,
        web_explanation=web_explanation,
        crossed_room_boundary=crossed,
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
        # data-model.MD §5: every reasoning turn opens a ReasoningSession
        # row. Provenance rows written during this turn FK back to it, so
        # the audit trail can reconstruct what the agent saw + said in
        # one query.
        self.ledger.open_session(
            session_id=req.session_id,
            room_id=req.room_id,
            verse_ref=req.verse_ref,
            question=req.question,
        )

        # citation-engine.MD §6: revise → mark inference → drop ladder.
        # First attempt has no hints; if the rule layer asks for changes
        # we re-run the engine with the hints folded into the prompt,
        # up to `max_revision_attempts` times before shipping whatever
        # the final attempt produced. Bypass mode skips the loop —
        # there are no claims to gate, so a retry would change nothing.
        max_attempts = 1 + max(
            0, getattr(self.engine.config, "max_revision_attempts", 1)
        )
        if req.bypass_citation_engine:
            max_attempts = 1

        revision_hints: list[str] = []
        grounded: Optional[GroundedAnswer] = None
        result = None  # EnforcementResult
        output = None  # AgentOutput

        for attempt in range(max_attempts):
            grounded = self.engine.run(
                room_id=req.room_id,
                session_id=req.session_id,
                verse_ref=req.verse_ref,
                question=req.question,
                events=events if attempt == 0 else None,  # only stream first attempt
                history=req.history,
                bypass=req.bypass_citation_engine,
                scope_kind=req.scope_kind,
                revision_hints=revision_hints,
            )
            # Rule-layer enforce() ALWAYS runs (rule-guide.MD safety
            # predicates are non-bypassable). When the engine is
            # bypassed, AgentOutput.claims is empty — the rule layer
            # still gates the other predicates (web, language, notes
            # privacy, isolation, etc.) and can still refuse.
            output = _grounded_to_output(
                grounded,
                target_language=req.target_language,
                request_room_id=req.room_id,
            )
            result = enforce(output)

            if result.decision is not Decision.REVISE:
                break

            revision_hints = [
                v.revision_hint or v.reason
                for v in result.verdicts
                if v.decision is Decision.REVISE
            ]

        assert grounded is not None and result is not None  # loop runs >=1

        # Close the session row with the FINAL attempt's reasoning +
        # answer + the de-duped resources actually leaned on. The per-
        # attempt Provenance rows are already in the ledger (one set
        # per attempt) so the audit trail shows the full ladder.
        resources_used = sorted({
            cid for c in grounded.claims for cid in c.citation_ids
        })
        recommendations = (
            [grounded.note_to_append.body] if grounded.note_to_append else []
        )
        self.ledger.close_session(
            session_id=req.session_id,
            reasoning=grounded.reasoning,
            answer=grounded.answer,
            resources_used=resources_used,
            recommendations=recommendations,
        )

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

        final_hints = [
            v.revision_hint or v.reason
            for v in result.verdicts
            if v.decision is Decision.REVISE
        ]
        return ReasoningTurn(
            decision=result.decision,
            grounded=grounded,
            revision_hints=final_hints,
            note_to_append=grounded.note_to_append,
        )
