"""DeepSeek-backed Generator and Verifier.

Replaces `PlaceholderGenerator` and `PassThroughVerifier` (the safe-fail
dev stubs) with real calls to `deepseek-v4-flash` via the
OpenAI-compatible Chat Completions API.

Design notes
------------
- The Generator returns a structured JSON object: reasoning, answer,
  and a list of statements with citation_ids tied back to retrieved
  chunks. This lets the citation engine parse without regexes.
- The Verifier is a separate pass (`citation-engine.MD` §5) — the
  generator does not get to grade its own homework. We use a much
  smaller, constrained NLI-style prompt for it.
- All prompts encode the character (soul.MD) and hard constraints
  (rule-guide.MD §2–§13) so the model defaults to good behavior; the
  middleware then verifies.

`TODO(spec)`: when a true local entailment model lands (citation-engine
.MD §5), swap Verifier to that — DeepSeek-based verification is fine
for a hosted-only deployment but isn't local-first.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Callable, Optional

import httpx

from ..reasoning.types import GeneratedStatement, NoteSuggestion, RetrievedChunk


DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE", "https://api.deepseek.com/v1")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")
DEEPSEEK_TIMEOUT = float(os.environ.get("DEEPSEEK_TIMEOUT", "60"))


def _api_key() -> Optional[str]:
    return os.environ.get("DEEPSEEK_API_KEY") or None


# Shared character + constraint preamble (soul.MD + rule-guide.MD).
_PREAMBLE = """You are a humble Bible-study companion, not an authority. \
You walk alongside the reader; you do not preach. Be patient, gracious, \
intellectually honest. Never claim divine authority. Distinguish what \
scripture says from what commentary interprets from what you infer. \
Never use profanity. Never give harmful advice. Never assert claims as \
fact without a citation to one of the provided sources. When sources \
disagree, present the disagreement rather than picking one as the \
answer. If you don't know, say so.
"""

# JSON schema instructions when the citation engine is OFF. We still
# round-trip through JSON so the wider pipeline (orchestrator,
# rule-layer, WS protocol) doesn't have to switch shapes — but `claims`
# is always empty and `answer` is allowed to be long-form.
_BYPASS_SCHEMA_PROMPT = """Respond with a SINGLE valid JSON object \
matching this exact shape (no Markdown fences, no commentary outside \
the JSON):

{
  "reasoning": "...",
  "answer": "...",
  "claims": [],
  "note_to_append": null
}

Rules:
- The `answer` field should be your FULL, complete reply. Do not \
truncate, summarize, or hold back. Treat this like a long-form study \
note rather than a tweet.
  • Aim for several paragraphs of real substance — multiple angles, \
    examples, related scripture by plain reference, traditions where \
    they differ, original-language insights where they help, pastoral \
    application where relevant.
  • Newlines inside the JSON string are fine (use \\n for paragraph \
    breaks). Markdown-style bold/italics is fine in the answer text.
- The `reasoning` field is your private chain-of-thought. Brief is \
fine here; the user reads `answer`.
- `claims` MUST be the empty array `[]`. The citation engine is off; \
do not emit structured claims.
- `note_to_append` should usually be null. Only set it if the turn \
surfaces a single concise insight that's worth saving as a permanent \
group note (≤ 240 chars).
"""


# Used when the user has explicitly disabled the citation engine
# (Settings → Advanced). Loosens the citation discipline so the LLM can
# write longer, more exploratory answers. The rule layer still gates
# the result via `enforce()` in the orchestrator, but per-claim
# verification is off — so the answer can range widely and use general
# theological / historical context without source-id gymnastics.
_PREAMBLE_BYPASS = """You are a knowledgeable, warm Bible-study \
companion. The reader has turned off the citation engine — they want \
your full thinking, not a tight citation-bounded reply. Give a rich, \
substantive answer:
  - Multiple paragraphs are welcome; explore multiple angles.
  - Bring in theological, historical, literary, and pastoral context.
  - Reference related verses by their human-readable refs (e.g. \
"Romans 5:8", "Isaiah 53") freely in prose. You don't need to gate \
them behind a SOURCES list.
  - Where traditions disagree (Catholic/Protestant/Orthodox/Jewish), \
name the disagreement honestly instead of picking sides.
  - You still must not claim divine authority, give harmful advice, or \
use profanity. You may admit uncertainty, but lean into substance over \
hedging.
"""


_GENERATOR_SCHEMA_PROMPT = """Respond with a SINGLE valid JSON object \
matching this exact shape (no Markdown fences, no commentary outside the \
JSON):

{
  "reasoning": "...",
  "answer": "...",
  "claims": [
    { "text": "the exact factual statement", "cited_ids": ["S1"] }
  ],
  "note_to_append": null
}

Rules:
- Use the short ids from SOURCES verbatim (e.g. "S1", "S2") in the \
`cited_ids` array only. Do NOT invent ids. Do NOT include square \
brackets in cited_ids — just "S1".
- IMPORTANT: NEVER write "S1", "S2", "S3", etc. (or "(S1)", "[S1]") in \
the `reasoning` or `answer` fields. Those labels are private — only \
the engine sees them. Write verse references plainly: "Jeremiah 25:12", \
not "Jeremiah 25:12 (S6)".
- Only include factual claims (scripture, original-language, commentary). \
Pastoral framing/transitions do NOT belong in claims.
- Every claim MUST cite at least one source id. If you cannot cite, drop \
the claim.
- For a paraphrase of the verse itself, cite the translation source id.

About `note_to_append`:
- This is an OPTIONAL short group note (≤ 240 chars) that will be saved \
to the room for future study. Use it ONLY when a turn surfaces something \
genuinely worth preserving — a notable cross-reference, a clear \
summary insight, a distinction worth remembering. Most turns: leave it \
as null.
- Shape: `null`  OR  `{ "body": "...", "verse_anchor": "BOOK.CH.V" }`.
- Notes are always group-scoped and attributed to the agent. Never \
suggest editing or deleting an existing human note.

About web sources (citation_ids beginning with "web:"):
- When you cite a web source, your `reasoning` field MUST include \
specifically: what you searched for, what you found, why you trust it, \
and how it measures against scripture (rule-guide.MD §8.3).
- A web source NEVER overrides scripture. If a web result contradicts \
the verse text, surface the conflict; scripture stands.

About topical queries (e.g. "all verses about X", "everything Paul wrote"):
- Answer the topical question directly. Do NOT re-frame it through the \
focused VERSE unless the user explicitly tied them together. The \
focused verse is where the cursor happened to be; the question may be \
unrelated.
- When the question asks about an author's writings (Paul, John, \
Moses, etc.), state the books traditionally ascribed to that author \
clearly in the `answer` — the user wants the scope. You may name the \
books even if SOURCES doesn't carry one verse from every chapter, \
because the books themselves are bibliographic fact, not a textual \
claim about meaning. Cite the specific verses you actually have \
sources for in `claims`. Disputed authorship (Hebrews → Paul, Psalms \
beyond David, etc.) should be flagged honestly.
"""


_SOURCE_LABEL_RE = re.compile(
    r"""
    [\s]*           # optional leading whitespace (we'll re-collapse)
    [\[\(]?         # optional opening [ or (
    \b              # word boundary
    S\d+            # S1, S12, etc.
    (?:\s*,\s*S\d+)*  # optional ", S2, S3" continuation
    \b
    [\]\)]?         # optional closing
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _strip_source_labels(text: str) -> str:
    """Remove S1/S2/(S3)/[S4] leakage from user-visible fields.

    The agent is told not to put these in the answer or reasoning, but
    prompt instructions aren't 100% reliable. We strip them after the
    fact so the user never sees the engine's private labels.
    """
    if not text:
        return text
    cleaned = _SOURCE_LABEL_RE.sub("", text)
    # Collapse the runs of spaces or " , " that the removal can leave behind.
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\(\s*\)", "", cleaned)
    cleaned = re.sub(r"\[\s*\]", "", cleaned)
    return cleaned.strip()


def _format_history(history: list) -> str:
    """Render prior turns as PRIOR DISCUSSION context.

    Kept short on purpose — only the question + a one-paragraph answer
    summary per turn, last 4 turns. The model uses this to follow
    "what about Paul's view" / "explain more" / "and the next verse",
    but the citation engine still re-verifies every new claim
    (citation-engine.MD §10).
    """
    if not history:
        return ""
    keep = history[-4:]
    lines: list[str] = []
    for i, h in enumerate(keep, start=1):
        verse = getattr(h, "verse_ref", "") or ""
        q = (getattr(h, "question", "") or "").strip()
        a = (getattr(h, "answer", "") or "").strip()
        # Cap each answer so we don't blow prompt size.
        if len(a) > 400:
            a = a[:400].rstrip() + "…"
        lines.append(f"Turn {i} (verse {verse}):\n  Q: {q}\n  A: {a}")
    return "\n".join(lines)


def _format_sources(
    retrieval: list[RetrievedChunk],
) -> tuple[str, dict[str, str]]:
    """Render sources with short S1/S2 IDs and return the inverse map.

    Long IDs like `trans:KJV:GEN.1.1` confuse models — they get
    truncated, quoted oddly, or invented. Short labels (`S1`, `S2`)
    round-trip reliably. The returned mapping converts model output
    back to the real `citation_id` the engine expects.
    """
    if not retrieval:
        return "(no sources retrieved)", {}
    lines: list[str] = []
    short_to_real: dict[str, str] = {}
    for i, c in enumerate(retrieval, start=1):
        label = f"S{i}"
        short_to_real[label] = c.citation_id
        head = f"[{label}] ({c.source_kind}"
        if c.tradition:
            head += f", {c.tradition}"
        head += ")"
        lines.append(f"{head}\n{c.text.strip()}")
    return "\n\n".join(lines), short_to_real


@dataclass
class DeepSeekGenerator:
    """Calls DeepSeek's Chat Completions API and parses a JSON response.

    If the response fails to parse cleanly, we degrade gracefully: emit
    the raw text as `answer` with no statements. The citation engine
    then drops nothing (no factual claims to verify) and the user sees
    the answer text marked with no supporting citations.
    """

    api_key: Optional[str] = None
    base: str = DEEPSEEK_BASE
    model: str = DEEPSEEK_MODEL

    def generate(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        history: Optional[list] = None,
        bypass: bool = False,
    ) -> tuple[str, str, list[GeneratedStatement], Optional[NoteSuggestion]]:
        """Non-streaming entry point — used by tests and the POST /reason
        path. Internally routes through `generate_streaming` with a no-op
        callback so the two paths can't drift."""
        return self.generate_streaming(
            verse_ref, question, retrieval, None, history=history, bypass=bypass,
        )

    def generate_streaming(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        on_reasoning_chunk: Optional[Callable[[str], None]],
        history: Optional[list] = None,
        bypass: bool = False,
    ) -> tuple[str, str, list[GeneratedStatement], Optional[NoteSuggestion]]:
        """Streaming generate: invokes the callback with reasoning chunks
        as they arrive from DeepSeek's `reasoning_content` field. The
        callback should NEVER receive factual claims — those come back
        in the structured JSON content (parsed at the end) and still flow
        through the citation engine before display.

        Pass `on_reasoning_chunk=None` for the non-streaming path.
        """
        key = self.api_key or _api_key()
        if not key:
            return (
                f"DeepSeek key not configured (DEEPSEEK_API_KEY). Cannot "
                f"reason about {verse_ref}.",
                "The reasoning model is not yet wired.",
                [],
                None,
            )

        sources_text, short_to_real = _format_sources(retrieval)
        history_block = _format_history(history or [])
        if bypass:
            # Engine off: looser prompt, no citation discipline, longer
            # answers welcome. Still JSON so the rest of the pipeline
            # round-trips cleanly — but claims/cited_ids stay empty.
            system = _PREAMBLE_BYPASS
            user = (
                f"VERSE FOCUS: {verse_ref}\n\n"
                + (f"PRIOR DISCUSSION:\n{history_block}\n\n" if history_block else "")
                + f"QUESTION: {question}\n\n"
                + f"REFERENCE PASSAGES (use freely, no citation IDs required):\n{sources_text}\n\n"
                + _BYPASS_SCHEMA_PROMPT
            )
        else:
            system = _PREAMBLE
            user = (
                f"VERSE: {verse_ref}\n\n"
                + (f"PRIOR DISCUSSION:\n{history_block}\n\n" if history_block else "")
                + f"QUESTION: {question}\n\n"
                + f"SOURCES:\n{sources_text}\n\n"
                + f"{_GENERATOR_SCHEMA_PROMPT}"
            )

        body: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.4 if bypass else 0.2,
            "response_format": {"type": "json_object"},
        }
        if on_reasoning_chunk is not None:
            body["stream"] = True

        if on_reasoning_chunk is None:
            try:
                r = httpx.post(
                    f"{self.base}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                    timeout=DEEPSEEK_TIMEOUT,
                )
                r.raise_for_status()
                payload = r.json()
                content = payload["choices"][0]["message"]["content"]
            except (httpx.HTTPError, KeyError, ValueError, IndexError) as e:
                return (
                    f"DeepSeek request failed: {e}",
                    "I couldn't reach the reasoning service.",
                    [],
                    None,
                )
            return _parse_generator_json(content, short_to_real)

        # Streaming path. Accumulate content + reasoning_content; emit
        # reasoning chunks to the callback as they arrive. The final
        # structured JSON lives in `content` and is parsed once the
        # stream completes — it still flows through the citation engine
        # in the caller.
        content_parts: list[str] = []
        try:
            with httpx.stream(
                "POST",
                f"{self.base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                },
                json=body,
                timeout=DEEPSEEK_TIMEOUT,
            ) as r:
                r.raise_for_status()
                for raw in r.iter_lines():
                    if not raw or not raw.startswith("data:"):
                        continue
                    payload_str = raw[len("data:"):].strip()
                    if payload_str == "[DONE]":
                        break
                    try:
                        evt = json.loads(payload_str)
                    except json.JSONDecodeError:
                        continue
                    delta = (
                        evt.get("choices", [{}])[0].get("delta", {}) or {}
                    )
                    rc = delta.get("reasoning_content")
                    if rc:
                        on_reasoning_chunk(rc)
                    c = delta.get("content")
                    if c:
                        content_parts.append(c)
        except httpx.HTTPError as e:
            return (
                f"DeepSeek stream failed: {e}",
                "I couldn't reach the reasoning service.",
                [],
                None,
            )

        return _parse_generator_json("".join(content_parts), short_to_real)


def _parse_generator_json(
    content: str,
    short_to_real: dict[str, str],
) -> tuple[str, str, list[GeneratedStatement], Optional[NoteSuggestion]]:
    """Pull reasoning/answer/claims/note_to_append out of the model's
    JSON response.

    Each `cited_ids` entry is mapped back from `S1`-style labels to the
    real citation_id the engine expects. IDs not in the map are dropped.
    `note_to_append` may be null/missing/malformed — return None then.
    """
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return ("(could not parse JSON reasoning)", text, [], None)

    reasoning = _strip_source_labels(str(data.get("reasoning", "")).strip())
    answer = _strip_source_labels(str(data.get("answer", "")).strip())
    raw_claims = data.get("claims", []) or []
    statements: list[GeneratedStatement] = []
    for c in raw_claims:
        if not isinstance(c, dict):
            continue
        ct = str(c.get("text", "")).strip()
        if not ct:
            continue
        mapped_ids: list[str] = []
        for x in c.get("cited_ids") or []:
            label = str(x).strip().strip("[]")
            real = short_to_real.get(label)
            if real:
                mapped_ids.append(real)
        statements.append(GeneratedStatement(text=ct, cited_ids=mapped_ids))

    note: Optional[NoteSuggestion] = None
    raw_note = data.get("note_to_append")
    if isinstance(raw_note, dict):
        body = str(raw_note.get("body", "")).strip()
        # Hard cap so the agent can't spam huge notes.
        if body:
            if len(body) > 500:
                body = body[:500].rstrip() + "…"
            anchor = raw_note.get("verse_anchor")
            note = NoteSuggestion(
                body=body,
                verse_anchor=str(anchor).strip() if anchor else None,
            )

    return reasoning, answer, statements, note


# ---------------------------------------------------------------------------
# Verifier (citation-engine.MD §5) — separate pass from the generator.
# ---------------------------------------------------------------------------
@dataclass
class DeepSeekVerifier:
    """Entailment + scripture-conflict checks via the same model.

    The verifier prompt is tightly constrained — yes/no — to keep
    cost down and prevent the verifier from "explaining away" a bad
    citation.

    `TODO(spec)`: replace with a local NLI model for local-first
    operation (citation-engine.MD §5, CLAUDE.md §14).
    """

    api_key: Optional[str] = None
    base: str = DEEPSEEK_BASE
    model: str = DEEPSEEK_MODEL

    def _yesno(self, system: str, user: str) -> bool:
        key = self.api_key or _api_key()
        if not key:
            return False
        try:
            r = httpx.post(
                f"{self.base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0,
                    # V4 Flash is a reasoning model: it spends tokens on
                    # internal reasoning_content before emitting the final
                    # answer. Need enough budget for that PLUS the YES/NO.
                    "max_tokens": 256,
                },
                timeout=DEEPSEEK_TIMEOUT,
            )
            r.raise_for_status()
            msg = r.json()["choices"][0]["message"]
            # Prefer the final content; fall back to reasoning_content
            # if the model truncated before producing one.
            content = (msg.get("content") or "").strip()
            if not content:
                content = (msg.get("reasoning_content") or "").strip()
        except (httpx.HTTPError, KeyError, ValueError, IndexError):
            return False
        return content.lower().lstrip().startswith("y")

    def entails(self, claim: str, source_text: str) -> bool:
        system = (
            "You are an entailment judge. Reply with only one word: "
            "YES if the SOURCE clearly supports the CLAIM, NO otherwise. "
            "If the source is irrelevant or only loosely related, reply NO."
        )
        user = f"SOURCE:\n{source_text}\n\nCLAIM:\n{claim}\n\nAnswer YES or NO."
        return self._yesno(system, user)

    def contradicts_scripture(self, claim: str, scripture_text: str) -> bool:
        system = (
            "You are a scripture-consistency judge. Reply with only one "
            "word: YES if the CLAIM directly contradicts what the "
            "SCRIPTURE plainly says, NO otherwise. Be conservative — only "
            "answer YES for clear contradictions, not interpretive "
            "differences."
        )
        user = (
            f"SCRIPTURE:\n{scripture_text}\n\nCLAIM:\n{claim}\n\n"
            "Answer YES or NO."
        )
        return self._yesno(system, user)
