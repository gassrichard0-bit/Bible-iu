"""Rule-enforcement middleware.

Implements `rule-guide.MD` as a sequence of discrete predicates over
`AgentOutput`. Every agent skill MUST route its output through `enforce()`
before it reaches a user (CLAUDE.md §13, architecture.MD §2).

The middleware is intentionally mechanical — no "interpret away" a rule
for convenience (CLAUDE.md §13). REFUSE is final; REVISE returns a hint
so the agent can try once more; PASS lets the output through.
"""
from __future__ import annotations

import re
from typing import Callable

from .types import (
    AgentOutput,
    Decision,
    EnforcementResult,
    Verdict,
)


# Seed list. The full filter lives in a configurable resource; this keeps
# the eval suite (CLAUDE.md §12) deterministic without external data.
_PROFANITY = {
    "shit", "fuck", "fucking", "bitch", "asshole", "bastard", "damn", "crap",
    "piss", "dick", "cunt", "cock", "whore", "slut",
}
_PROFANITY_RE = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in _PROFANITY) + r")\b",
    re.IGNORECASE,
)

_HARMFUL_PATTERNS = [
    re.compile(r"\bhow to (kill|harm|hurt|poison|attack)\b", re.IGNORECASE),
    re.compile(r"\b(suicide|self[- ]harm) (method|instructions?)\b", re.IGNORECASE),
    re.compile(r"\bbuild (a )?(bomb|weapon)\b", re.IGNORECASE),
]


# rule-guide.MD §6.1 — Never use profanity.
def _r6_profanity(out: AgentOutput) -> Verdict:
    blob = " ".join([out.reasoning, out.answer, *(c.text for c in out.claims)])
    if _PROFANITY_RE.search(blob):
        return Verdict(Decision.REFUSE, "rule-guide.MD §6.1",
                       "Output contains profanity.")
    return Verdict(Decision.PASS, "rule-guide.MD §6.1")


# rule-guide.MD §6.2 — Never give harmful advice.
def _r6_harmful(out: AgentOutput) -> Verdict:
    blob = " ".join([out.reasoning, out.answer])
    for pat in _HARMFUL_PATTERNS:
        if pat.search(blob):
            return Verdict(Decision.REFUSE, "rule-guide.MD §6.2",
                           "Output appears to contain harmful instructions.")
    return Verdict(Decision.PASS, "rule-guide.MD §6.2")


# rule-guide.MD §2.4 — Scripture stands; conflicts must be stated, not silently asserted.
def _r2_scripture_supremacy(out: AgentOutput) -> Verdict:
    for c in out.claims:
        if c.contradicts_scripture and c.kind != "non_factual":
            return Verdict(
                Decision.REVISE,
                "rule-guide.MD §2.4",
                f"Claim contradicts scripture: {c.text[:80]!r}.",
                "State the conflict explicitly; scripture stands.",
            )
    return Verdict(Decision.PASS, "rule-guide.MD §2.4")


# rule-guide.MD §3.3 / §4.2 — No uncited claim presented as fact.
def _r4_citation_required(out: AgentOutput) -> Verdict:
    factual_kinds = {"scripture", "original_language", "commentary"}
    for c in out.claims:
        if c.kind not in factual_kinds:
            continue
        supported = [ct for ct in c.citations
                     if ct.verification_result == "supported"]
        if not supported:
            return Verdict(
                Decision.REVISE,
                "rule-guide.MD §4.2",
                f"Factual claim without a verified citation: {c.text[:80]!r}.",
                "Add a verified citation, downgrade to inference, or drop.",
            )
    return Verdict(Decision.PASS, "rule-guide.MD §4.2")


# rule-guide.MD §5 — Multi-tradition fairness: don't flatten disagreement.
def _r5_multi_tradition(out: AgentOutput) -> Verdict:
    commentary_traditions = {
        ct.tradition
        for c in out.claims if c.kind == "commentary"
        for ct in c.citations
        if ct.tradition
    }
    # Heuristic: if commentary is invoked but only a single tradition is
    # cited despite multiple being available, flag for revision. The
    # retrieval layer (citation-engine.MD §7) is what actually enforces
    # diversity; this is the safety net.
    if commentary_traditions and len(commentary_traditions) == 1:
        available = {t for t in out.source_traditions if t}
        if len(available) > 1:
            return Verdict(
                Decision.REVISE,
                "rule-guide.MD §5.2",
                "Commentary draws from a single tradition while others were available.",
                "Surface the disagreement; cite at least two traditions.",
            )
    return Verdict(Decision.PASS, "rule-guide.MD §5.2")


# rule-guide.MD §7 — Always show reasoning; no bare verdicts.
def _r7_show_reasoning(out: AgentOutput) -> Verdict:
    if out.answer.strip() and not out.reasoning.strip():
        return Verdict(
            Decision.REVISE,
            "rule-guide.MD §7.1",
            "Answer provided without reasoning.",
            "Attach the reasoning steps and resources used.",
        )
    return Verdict(Decision.PASS, "rule-guide.MD §7.1")


# rule-guide.MD §8 — Web search must be filtered and explained.
def _r8_web_search(out: AgentOutput) -> Verdict:
    if not out.used_web:
        return Verdict(Decision.PASS, "rule-guide.MD §8")
    if not out.web_sources_filtered:
        return Verdict(Decision.REFUSE, "rule-guide.MD §8.2",
                       "Web sources did not pass the truth filter.")
    if not (out.web_explanation or "").strip():
        return Verdict(
            Decision.REVISE,
            "rule-guide.MD §8.3",
            "Web-derived content missing detailed reasoning explanation.",
            "Explain what was searched, what was found, and how it measures "
            "against scripture.",
        )
    return Verdict(Decision.PASS, "rule-guide.MD §8")


# rule-guide.MD §9 — Media must never deceive; labeled illustrative.
def _r9_media(out: AgentOutput) -> Verdict:
    for m in out.media:
        if m.presented_as_real:
            return Verdict(Decision.REFUSE, "rule-guide.MD §9.2",
                           "Generated media presented as a real photograph or footage.")
        if not m.ai_generated:
            continue
        label = (m.label or "").lower()
        if "ai-generated" not in label and "illustrative" not in label:
            return Verdict(
                Decision.REVISE,
                "rule-guide.MD §9.3",
                "AI-generated media missing required label.",
                "Label as 'AI-generated — illustrative' in data and UI.",
            )
    return Verdict(Decision.PASS, "rule-guide.MD §9")


# rule-guide.MD §10 — Audio obeys all rules; identify as machine-generated.
def _r10_audio(out: AgentOutput) -> Verdict:
    if out.surface == "audio" and not out.audio_marked_machine:
        return Verdict(
            Decision.REVISE,
            "rule-guide.MD §10.2",
            "Audio output not marked as machine-generated.",
            "Mark the audio as machine-generated.",
        )
    return Verdict(Decision.PASS, "rule-guide.MD §10")


# rule-guide.MD §11 — Respond in the user's language.
def _r11_language(out: AgentOutput) -> Verdict:
    if (out.target_language
            and out.response_language
            and out.target_language != out.response_language):
        return Verdict(
            Decision.REVISE,
            "rule-guide.MD §11.1",
            f"User language {out.target_language!r} but responded in "
            f"{out.response_language!r}.",
            "Re-emit in the user's language.",
        )
    return Verdict(Decision.PASS, "rule-guide.MD §11")


# rule-guide.MD §12 — Notes oversight: personal notes invisible to the agent;
# group notes appendable with attribution; never silent edit/delete.
def _r12_notes(out: AgentOutput) -> Verdict:
    if out.accessed_personal_notes:
        return Verdict(Decision.REFUSE, "rule-guide.MD §12.1",
                       "Agent attempted to access personal notes.")
    if out.note_op == "append" and out.surface == "group_note":
        if not out.note_attributed_to_agent:
            return Verdict(
                Decision.REVISE,
                "rule-guide.MD §12.2",
                "Group note append not attributed to the agent.",
                "Mark the note as authored by the agent.",
            )
    if out.note_op in ("edit_human", "delete_human"):
        return Verdict(Decision.REFUSE, "rule-guide.MD §12.3",
                       "Agent attempted to edit or delete a human's note.")
    return Verdict(Decision.PASS, "rule-guide.MD §12")


# rule-guide.MD §13 — Isolation: no cross-room bleed.
def _r13_isolation(out: AgentOutput) -> Verdict:
    if out.crossed_room_boundary:
        return Verdict(Decision.REFUSE, "rule-guide.MD §13.1",
                       "Output draws on data from another room.")
    return Verdict(Decision.PASS, "rule-guide.MD §13")


_RULES: list[Callable[[AgentOutput], Verdict]] = [
    _r6_profanity,
    _r6_harmful,
    _r2_scripture_supremacy,
    _r4_citation_required,
    _r5_multi_tradition,
    _r7_show_reasoning,
    _r8_web_search,
    _r9_media,
    _r10_audio,
    _r11_language,
    _r12_notes,
    _r13_isolation,
]


def enforce(output: AgentOutput) -> EnforcementResult:
    """Run every rule. REFUSE short-circuits; REVISE accumulates."""
    verdicts: list[Verdict] = []
    final = Decision.PASS
    for rule in _RULES:
        v = rule(output)
        verdicts.append(v)
        if v.decision is Decision.REFUSE:
            return EnforcementResult(Decision.REFUSE, verdicts)
        if v.decision is Decision.REVISE:
            final = Decision.REVISE
    return EnforcementResult(final, verdicts)
