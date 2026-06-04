"""Deterministic test doubles for the citation engine.

The real Retriever/Generator/Verifier are heavy (vector store + LLM +
NLI model). For the adversarial eval suite (CLAUDE.md §12) we plug in
scripted versions so each adversarial scenario is reproducible.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from backend.agent.reasoning.types import GeneratedStatement, RetrievedChunk


@dataclass
class FakeRetriever:
    chunks: list[RetrievedChunk] = field(default_factory=list)

    def retrieve(
        self,
        verse_ref: str,
        question: str,
        room_id: str = "",
    ) -> list[RetrievedChunk]:
        return list(self.chunks)


@dataclass
class FakeGenerator:
    reasoning: str = "Reasoning."
    answer: str = "Answer."
    statements: list[GeneratedStatement] = field(default_factory=list)

    def generate(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        history=None,
        bypass: bool = False,
    ):
        return self.reasoning, self.answer, list(self.statements), None


@dataclass
class ScriptedVerifier:
    """Verifier driven by a small substring rule. Each retrieved chunk
    `entails` a claim iff every token from a hand-picked overlap word
    appears in both. Lets each test express its own ground truth
    without an entailment model."""

    entail_pairs: set[tuple[str, str]] = field(default_factory=set)
    scripture_conflicts: set[str] = field(default_factory=set)

    def entails(self, claim: str, source_text: str) -> bool:
        return (claim, source_text) in self.entail_pairs

    def contradicts_scripture(self, claim: str, scripture_text: str) -> bool:
        return claim in self.scripture_conflicts
