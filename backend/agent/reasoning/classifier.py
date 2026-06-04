"""Statement classification (citation-engine.MD §4).

We must not demand citations for non-factual text, and we must demand
them for every factual one. Classification is rules-based and runs on
the parsed statements before verification.
"""
from __future__ import annotations

import re

from .types import (
    ClassifiedStatement,
    GeneratedStatement,
    RetrievedChunk,
    StatementKind,
)


_INFERENCE_MARKERS = re.compile(
    r"\b(I think|it seems|perhaps|likely|my reading|in my view|inference)\b",
    re.IGNORECASE,
)
_NON_FACTUAL_MARKERS = re.compile(
    r"\b(let'?s|consider|what if|how does|why do you|notice that)\b",
    re.IGNORECASE,
)
_LEXICAL_MARKERS = re.compile(
    r"\b(Strong'?s|lemma|morphology|Hebrew|Greek|לֹא|אֱלֹהִים|θεός)\b",
    re.IGNORECASE,
)


def classify(
    statements: list[GeneratedStatement],
    retrieval: list[RetrievedChunk],
) -> list[ClassifiedStatement]:
    by_id = {c.citation_id: c for c in retrieval}
    out: list[ClassifiedStatement] = []
    for s in statements:
        out.append(
            ClassifiedStatement(
                text=s.text,
                cited_ids=s.cited_ids,
                kind=_kind_for(s, by_id),
            )
        )
    return out


def _kind_for(
    s: GeneratedStatement,
    by_id: dict[str, RetrievedChunk],
) -> StatementKind:
    if _NON_FACTUAL_MARKERS.search(s.text) and not s.cited_ids:
        return "non_factual"
    if _INFERENCE_MARKERS.search(s.text):
        return "inference"
    cited_kinds = {by_id[c].source_kind for c in s.cited_ids if c in by_id}
    if "scripture" in cited_kinds or "translation" in cited_kinds:
        if _LEXICAL_MARKERS.search(s.text) or "lexicon" in cited_kinds:
            return "original_language"
        return "scripture"
    if "commentary" in cited_kinds or "web" in cited_kinds:
        return "commentary"
    if _LEXICAL_MARKERS.search(s.text):
        return "original_language"
    if not s.cited_ids:
        return "inference"
    return "commentary"
