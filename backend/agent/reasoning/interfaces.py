"""Swappable backends for the citation pipeline.

The citation engine is the spine that enforces "no deception"
(citation-engine.MD §2). It must not depend on the goodwill of the
generator, so each pipeline stage is a small protocol with deterministic
behavior; the LLM call lives behind `Generator` and the entailment check
lives behind `Verifier`, kept distinct so the generator does not grade
its own homework (citation-engine.MD §5).

`TODO(spec)`: pick the local entailment model and wire it as the default
Verifier (citation-engine.MD §5).
"""
from __future__ import annotations

from typing import Any, Protocol

from .types import GeneratedStatement, RetrievedChunk


class Retriever(Protocol):
    def retrieve(
        self,
        verse_ref: str,
        question: str,
        room_id: str = "",
        scope_kind: str = "verse",
    ) -> list[RetrievedChunk]: ...


class Generator(Protocol):
    """Grounded generation: emits reasoning + answer with inline citation
    markers tied to retrieved `citation_id`s. The LLM never speaks
    outside this interface.

    `history` carries prior turns (verse_ref, question, answer) so the
    model has conversational context. It is NOT trusted as fact — the
    citation engine still re-verifies every new claim.
    """

    def generate(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        history: list[Any] = ...,  # list[HistoryTurn], avoid circular import
        scope_kind: str = "verse",
    ) -> tuple[str, str, list[GeneratedStatement]]:
        """Return (reasoning, answer, statements). `scope_kind` tells
        the implementation what label to put on the prompt — at
        chapter/book/wider zoom levels, anchoring the prompt to a
        single VERSE causes the model to ignore the broader context."""
        ...


class Verifier(Protocol):
    """Entailment check: does the cited source actually support the claim?
    Must be a separate pass from generation (citation-engine.MD §5)."""

    def entails(self, claim: str, source_text: str) -> bool: ...
    def contradicts_scripture(self, claim: str, scripture_text: str) -> bool: ...
