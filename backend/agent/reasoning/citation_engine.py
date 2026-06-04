"""The citation / grounding engine (citation-engine.MD).

Pipeline:
    retrieve -> generate(grounded) -> parse -> classify -> verify
             -> gate (revise / mark inference / drop) -> ledger + render

The engine sits between the reasoning model and any response; no agent
skill output bypasses it (citation-engine.MD §10).
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Optional

from ..provenance.ledger import Ledger, ProvenanceRecord
from .classifier import classify
from .interfaces import Generator, Retriever, Verifier
from .types import (
    ClassifiedStatement,
    GroundedAnswer,
    NoteSuggestion,
    RetrievedChunk,
    VerifiedClaim,
)


class StreamingEvents:
    """Lightweight callbacks the engine uses to surface progress.

    All callbacks are optional and no-op'd at the engine level if not
    provided. They never carry factual claims — only stage names,
    counts, and the generator's `reasoning_content` chunks (chain of
    thought). The final answer + verified claims are returned via the
    normal `GroundedAnswer` return value, AFTER the citation engine's
    gate (`citation-engine.MD` §10).
    """

    def __init__(
        self,
        on_stage: Optional[Callable[[str, Optional[int]], None]] = None,
        on_reasoning_chunk: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.on_stage = on_stage or (lambda _name, _n=None: None)
        self.on_reasoning_chunk = on_reasoning_chunk


@dataclass
class EngineConfig:
    max_revision_attempts: int = 1
    # Run verifier calls in parallel so a busy turn (many claims × many
    # citations) doesn't stack into a 60s+ serial wait. Set to 1 to
    # disable threading (e.g. for tests).
    verifier_concurrency: int = 8


class CitationEngine:
    """Stateless pipeline. Stateful concerns (ledger, retrieval cache)
    live in their own services."""

    def __init__(
        self,
        retriever: Retriever,
        generator: Generator,
        verifier: Verifier,
        ledger: Ledger,
        config: Optional[EngineConfig] = None,
    ) -> None:
        self.retriever = retriever
        self.generator = generator
        self.verifier = verifier
        self.ledger = ledger
        self.config = config or EngineConfig()

    def run(
        self,
        *,
        room_id: str,
        session_id: str,
        verse_ref: str,
        question: str,
        events: Optional[StreamingEvents] = None,
        history: Optional[list] = None,
        bypass: bool = False,
    ) -> GroundedAnswer:
        """`bypass=True` (user-toggled in Settings, overriding the spec
        in rule-guide.MD §14 / citation-engine.MD §10): run retrieve +
        generate only; skip parse/classify/verify/gate. Return raw LLM
        output as a GroundedAnswer with empty claims. The orchestrator
        also skips `enforce()` in this mode."""
        ev = events or StreamingEvents()
        history = history or []
        ev.on_stage("retrieving", None)
        retrieval = self.retriever.retrieve(verse_ref, question, room_id=room_id)
        ev.on_stage("generating", len(retrieval))

        # Prefer the streaming generate path if both the generator and
        # the caller want it; fall back to the plain method otherwise.
        if (
            ev.on_reasoning_chunk is not None
            and hasattr(self.generator, "generate_streaming")
        ):
            gen_out = self.generator.generate_streaming(  # type: ignore[attr-defined]
                verse_ref, question, retrieval, ev.on_reasoning_chunk,
                history=history,
                bypass=bypass,
            )
        else:
            gen_out = self.generator.generate(
                verse_ref, question, retrieval, history=history, bypass=bypass,
            )
        # Generators may return 3-tuple (back-compat) or 4-tuple with
        # an optional NoteSuggestion as the 4th element.
        if len(gen_out) == 4:
            reasoning, answer, statements, note_to_append = gen_out
        else:
            reasoning, answer, statements = gen_out
            note_to_append = None

        if bypass:
            ev.on_stage("bypassed", 0)
            return GroundedAnswer(
                reasoning=reasoning,
                answer=answer,
                claims=[],
                dropped=[],
                retrieval=retrieval,
                note_to_append=note_to_append,
            )

        classified = classify(statements, retrieval)
        ev.on_stage("verifying", len(classified))
        verified, dropped = self._verify_and_gate(classified, retrieval)

        for c in verified:
            self.ledger.write(
                ProvenanceRecord(
                    claim_id=f"{session_id}:{hash(c.text) & 0xFFFFFFFF:x}",
                    session_id=session_id,
                    room_id=room_id,
                    text=c.text,
                    citation_ids=c.citation_ids,
                    kind=c.kind,
                    verification=c.verification,
                )
            )

        return GroundedAnswer(
            reasoning=reasoning,
            answer=answer,
            claims=verified,
            dropped=dropped,
            retrieval=retrieval,
            note_to_append=note_to_append,
        )

    def _verify_and_gate(
        self,
        classified: list[ClassifiedStatement],
        retrieval: list[RetrievedChunk],
    ) -> tuple[list[VerifiedClaim], list[VerifiedClaim]]:
        by_id = {c.citation_id: c for c in retrieval}
        scripture_chunks = [
            c for c in retrieval if c.source_kind in ("scripture", "translation")
        ]

        # Collect every verifier call we need to make, dispatch them in
        # parallel, then assemble decisions. This turns N*M sequential
        # ~5s LLM calls into ~5s wall time for the whole turn.
        factual_kinds = {"scripture", "original_language", "commentary"}

        entail_jobs: list[tuple[int, str]] = []  # (claim_index, cid)
        conflict_jobs: list[tuple[int, int]] = []  # (claim_index, sc_index)
        for i, s in enumerate(classified):
            if s.kind not in factual_kinds:
                continue
            for cid in s.cited_ids:
                if cid in by_id:
                    entail_jobs.append((i, cid))
            for j, _sc in enumerate(scripture_chunks):
                conflict_jobs.append((i, j))

        def _entail(idx_cid: tuple[int, str]) -> tuple[int, str, bool]:
            i, cid = idx_cid
            ok = self.verifier.entails(classified[i].text, by_id[cid].text)
            return i, cid, ok

        def _conflict(idx_j: tuple[int, int]) -> tuple[int, int, bool]:
            i, j = idx_j
            ok = self.verifier.contradicts_scripture(
                classified[i].text, scripture_chunks[j].text
            )
            return i, j, ok

        supported_by_claim: dict[int, list[str]] = {}
        conflict_by_claim: dict[int, bool] = {}

        if entail_jobs or conflict_jobs:
            workers = max(1, self.config.verifier_concurrency)
            with ThreadPoolExecutor(max_workers=workers) as pool:
                for i, cid, ok in pool.map(_entail, entail_jobs):
                    if ok:
                        supported_by_claim.setdefault(i, []).append(cid)
                for i, _j, ok in pool.map(_conflict, conflict_jobs):
                    if ok:
                        conflict_by_claim[i] = True

        verified: list[VerifiedClaim] = []
        dropped: list[VerifiedClaim] = []

        for i, s in enumerate(classified):
            if s.kind == "non_factual":
                verified.append(
                    VerifiedClaim(
                        text=s.text,
                        kind=s.kind,
                        citation_ids=[],
                        verification="supported",
                    )
                )
                continue

            if s.kind == "inference":
                verified.append(
                    VerifiedClaim(
                        text=s.text,
                        kind="inference",
                        citation_ids=s.cited_ids,
                        verification="inference",
                    )
                )
                continue

            supported_cites = supported_by_claim.get(i, [])

            if conflict_by_claim.get(i):
                dropped.append(
                    VerifiedClaim(
                        text=s.text,
                        kind=s.kind,
                        citation_ids=supported_cites,
                        verification="dropped",
                        contradicts_scripture=True,
                        notes="Contradicts scripture; scripture stands "
                              "(rule-guide.MD §2.4).",
                    )
                )
                continue

            if not supported_cites:
                dropped.append(
                    VerifiedClaim(
                        text=s.text,
                        kind=s.kind,
                        citation_ids=[],
                        verification="dropped",
                        notes="No cited source entailed the claim.",
                    )
                )
                continue

            verified.append(
                VerifiedClaim(
                    text=s.text,
                    kind=s.kind,
                    citation_ids=supported_cites,
                    verification="supported",
                )
            )

        return verified, dropped
