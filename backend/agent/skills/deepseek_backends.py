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

GROUNDING vs. CITATION — read carefully, this is THE accuracy rule:
  - The Hebrew (WLC) text and Greek (TR) text, plus the per-word \
morphology / lemma / Strong's chunks, are tagged in SOURCES as \
`[original_language ...]`. These are the GROUND TRUTH. Every claim \
about what the verse SAYS or MEANS must be anchored to the original \
language. If the original-language reading and an English wording \
diverge, follow the original.
  - The English translation chunks (KJV / BSB / WEB / NET / YLT / etc.) \
are for CITATION — they are the WORDING the user sees on their Bible \
page. When you quote a verse in your answer, quote it from the English \
translation source the user provided so the words match what's on \
screen. Cite both: the original-language anchor (for grounding) and the \
English-translation chunk (for the quoted wording).
  - Lemma / Strong's / morph chunks (tagged `[original_language morph \
…]`) are first-class evidence. If you say "the Greek here is ἀγάπη \
(agapē, G26), self-giving love", you MUST cite the morph chunk for that \
verse. Don't paraphrase the lexical entry without the citation.

WHAT YOU CAN SEE — be honest and concrete when asked, instead of hedging:
  - GROUP NOTES that the user and other room members have written. These \
arrive in SOURCES with a `[group note, human]` or `[group note, agent]` \
prefix. You may reference them and cite their source id.
  - COMMENTS on those group notes — back-and-forth between members. They \
arrive prefixed with `[comment K/N on note <id> by @handle]`, where K \
is the comment's position in the thread and N is the total. When K=N \
you've seen every comment on that note — the thread is COMPLETE, not a \
sample. Read the exchange in order before responding. When two or more \
people are debating, name each person's position with their handle, \
summarize the points of disagreement, and offer scripture-grounded \
perspective. Mediate; do not pick a personal side.
  - SCRIPTURE in the requested translation, cross-references, and any \
public commentary the room has wired in.
WHAT YOU CANNOT SEE — never claim or pretend you can:
  - PERSONAL notes (private to their author by design).
  - CHAT messages on the Chat tab (the agent has no read path to chat).
When the user asks "can you see my notes?" — if `[group note ...]` \
chunks appear in SOURCES, say "Yes, I can see the group notes in this \
room" and reference what you see. If there are none, say "No group \
notes have been shared in this room yet." Either way, add that personal \
notes and chat stay private to them.

SCOPE — the user's message begins with one of these scope markers, \
which tells you the BREADTH of what they're asking about. Treat the \
marker as the topic, NOT a single verse to drill into:
  - VERSE: BOOK.CH.V — answer about that specific verse.
  - CHAPTER: Book N — answer about the whole chapter; sources cover \
all of it.
  - BOOK: Book — answer about the whole book; sources are a sample.
  - TESTAMENT: Old/New Testament — answer about the testament as a \
whole; pick representative passages from the sources.
  - SCOPE: the whole Bible — answer across the entire Bible; cite \
verses from anywhere in the sources, not just the first one shown.

WIDE-SCOPE BEHAVIOR (BOOK / TESTAMENT / the whole Bible) — read this \
carefully, the most common failure mode at wide scope is the model \
treating SOURCES as the answer universe:
  - The SOURCES list at wide scope is a TINY KEYWORD-SAMPLED SLICE of \
scripture, not a representative survey of what's relevant. Treat it as \
seed material, not as the limits of what you may discuss.
  - You MUST draw on your full knowledge of the Bible. If the question \
is about a topic that's addressed in passages NOT shown (e.g. the user \
asks about Christ bearing judgment and SOURCES happens to contain \
Genesis 1 + 2 Kings 1, you must still discuss Isaiah 53, 2 Corinthians \
5:21, Romans 8:32, John 3:16, etc.). Reference them by human-readable \
ref ("Isaiah 53:10", not "S7") freely in the ANSWER prose. Those \
references do not need to appear in SOURCES.
  - NEVER write phrases like "the sources don't contain", "the \
provided sources don't include", or "those verses are not in the given \
sources" at wide scope. That framing is wrong — the user asked about \
the WHOLE BIBLE; the absence of a verse from the keyword slice is not \
meaningful. Answer the actual question, citing the relevant scripture \
by human-readable reference.
  - The `claims` array (verified by the citation engine) is for \
statements you want to pin to a specific source ID. Plain scripture \
discussion in the ANSWER text doesn't need to be a "claim" — it can \
flow as prose with human-readable refs. Save `claims` for paraphrases / \
assertions you want backed by the SOURCES that were provided.
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

GROUNDING vs. CITATION — even with the citation engine OFF, the \
accuracy rule still holds:
  - The Hebrew (WLC) + Greek (TR) text + per-word morphology / lemma / \
Strong's chunks in REFERENCE PASSAGES are tagged `[original_language \
…]`. Treat them as GROUND TRUTH. When you describe what a verse SAYS \
or MEANS, base it on the original language, not on a paraphrase from \
memory. If the Hebrew or Greek disagrees with your recollection of an \
English wording, trust the Hebrew or Greek.
  - When you QUOTE a verse to the reader, quote it from the English \
translation chunk supplied (KJV / BSB / WEB / NET / etc.) — that's what \
the reader is looking at on their Bible page, so your quote should \
match their on-screen text.
  - Original-language insights ("the Greek ἀγάπη here means…") are \
welcome — they're a big part of why bypass mode exists — but they must \
be drawn from the morphology/lemma chunks for the actual verse, not \
generated from training-set memory of what the word "usually means".

WHAT YOU CAN SEE — when the user asks, be concrete:
  - GROUP NOTES from the room (REFERENCE PASSAGES will contain \
`[group note, human]` / `[group note, agent]` lines).
  - COMMENTS on those notes, prefixed `[comment K/N on note <id> by \
@handle]` where K/N marks turn order and N is the full thread length. \
You always receive the COMPLETE thread, not a sample. Read the \
exchange in order. When two or more members are debating, name each \
side with their handle, summarize the disagreement, and offer \
scripture-grounded perspective. Mediate; do not pick a personal side.
WHAT YOU CANNOT SEE: personal notes (private to their author) and \
chat-tab messages (no read path). When asked "can you see my notes?", \
answer specifically based on whether group-note chunks are present in \
the supplied REFERENCE PASSAGES — and note that personal/chat stay \
private to the user.

SCOPE — the FIRST line of the user message tells you the breadth of \
the question:
  - VERSE: answer about that one verse.
  - CHAPTER: answer about the whole chapter.
  - BOOK: answer about the whole book.
  - TESTAMENT: answer about the OT or NT as a whole.
  - SCOPE: the whole Bible — answer at the broadest level.
At wider scopes the REFERENCE PASSAGES are a sample; range freely \
across all of scripture, using your knowledge of the rest. Don't \
narrow to a single verse just because one appears in the passages.
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
- When you mention a CROSS-REFERENCE verse (a passage that echoes the \
focused verse), check the SOURCES list for that verse — translation \
chunks carry their verse_id in the head (e.g. `[S7] (translation, GEN.18.11)`). \
If the verse you're referencing is in the list, you MUST emit a claim \
that cites its short id, even if the mention is brief. That's how the \
UI surfaces it in the Sources panel.

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
- When the user asks to LIST or FIND verses on a topic or word \
(e.g. "list all verses about hate", "find verses on love"), the \
output shape is STRICT:
    • `answer` MUST be ONE SHORT SENTENCE — a framing line and an \
      optional count. Example: "Here are 32 verses about hate from \
      across the canon." Do NOT include the verse list itself in \
      `answer`. Do NOT print refs like "Gen 24:60: ..." inside \
      `answer`. The UI renders each claim as a card; a list in the \
      answer prose defeats that and the user sees a wall of text \
      instead of cards.
    • `claims` MUST contain ONE claim per matching retrieved verse. \
      Claim text quotes (or paraphrases) the verse + its reference, \
      and `cited_ids` is the SOURCES short id for that verse. \
      Example claim: \
      `{"text": "Genesis 24:60 — let thy seed possess the gate of those which hate them", "cited_ids": ["S7"]}`.
    • Skip retrieved verses that don't actually match the topic — \
      false matches hurt more than missing ones.
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


_OSIS_BOOK_NAMES: dict[str, str] = {
    "GEN": "Genesis", "EXO": "Exodus", "LEV": "Leviticus", "NUM": "Numbers",
    "DEU": "Deuteronomy", "JOS": "Joshua", "JDG": "Judges", "RUT": "Ruth",
    "1SA": "1 Samuel", "2SA": "2 Samuel", "1KI": "1 Kings", "2KI": "2 Kings",
    "1CH": "1 Chronicles", "2CH": "2 Chronicles",
    "EZR": "Ezra", "NEH": "Nehemiah", "EST": "Esther",
    "JOB": "Job", "PSA": "Psalms", "PRO": "Proverbs",
    "ECC": "Ecclesiastes", "SNG": "Song of Solomon",
    "ISA": "Isaiah", "JER": "Jeremiah", "LAM": "Lamentations",
    "EZK": "Ezekiel", "DAN": "Daniel",
    "HOS": "Hosea", "JOL": "Joel", "AMO": "Amos",
    "OBA": "Obadiah", "JON": "Jonah", "MIC": "Micah",
    "NAM": "Nahum", "HAB": "Habakkuk", "ZEP": "Zephaniah",
    "HAG": "Haggai", "ZEC": "Zechariah", "MAL": "Malachi",
    "MAT": "Matthew", "MRK": "Mark", "LUK": "Luke", "JHN": "John",
    "ACT": "Acts", "ROM": "Romans",
    "1CO": "1 Corinthians", "2CO": "2 Corinthians",
    "GAL": "Galatians", "EPH": "Ephesians", "PHP": "Philippians",
    "COL": "Colossians", "1TH": "1 Thessalonians", "2TH": "2 Thessalonians",
    "1TI": "1 Timothy", "2TI": "2 Timothy",
    "TIT": "Titus", "PHM": "Philemon", "HEB": "Hebrews",
    "JAS": "James", "1PE": "1 Peter", "2PE": "2 Peter",
    "1JN": "1 John", "2JN": "2 John", "3JN": "3 John",
    "JUD": "Jude", "REV": "Revelation",
}

_NT_BOOKS = {
    "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
    "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
    "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
}


# Build the inverse map once: any case-folded book name (short or full,
# with common abbreviations) → its OSIS code. Used by
# `_match_verse_refs_in_text` to find references like "Gen 18:11" or
# "Genesis 18:11" or "1 Kgs 1:1" inside the model's answer.
_NAME_TO_OSIS: dict[str, str] = {}


def _seed_name_map() -> None:
    if _NAME_TO_OSIS:
        return
    # Common short forms the model is likely to write — we keep this
    # small + literal rather than trying to be clever. Add to it when a
    # real-world miss is observed.
    extras: dict[str, str] = {
        "Gen": "GEN", "Exo": "EXO", "Ex": "EXO", "Lev": "LEV", "Num": "NUM",
        "Deut": "DEU", "Dt": "DEU", "Josh": "JOS", "Judg": "JDG", "Ru": "RUT",
        "1 Sam": "1SA", "2 Sam": "2SA", "1 Kgs": "1KI", "2 Kgs": "2KI",
        "1 Ki": "1KI", "2 Ki": "2KI", "1 Chr": "1CH", "2 Chr": "2CH",
        "1 Chron": "1CH", "2 Chron": "2CH",
        "Neh": "NEH", "Est": "EST", "Ps": "PSA", "Pss": "PSA", "Psa": "PSA",
        "Prov": "PRO", "Eccl": "ECC", "Qoh": "ECC", "Song": "SNG", "SoS": "SNG",
        "Isa": "ISA", "Jer": "JER", "Lam": "LAM", "Ezek": "EZK", "Ez": "EZK",
        "Dan": "DAN", "Hos": "HOS", "Jl": "JOL", "Am": "AMO", "Ob": "OBA",
        "Jon": "JON", "Mic": "MIC", "Nah": "NAM", "Hab": "HAB", "Zeph": "ZEP",
        "Hag": "HAG", "Zech": "ZEC", "Zec": "ZEC", "Mal": "MAL",
        "Mt": "MAT", "Matt": "MAT", "Mk": "MRK", "Mar": "MRK",
        "Lk": "LUK", "Lu": "LUK", "Jn": "JHN", "Joh": "JHN",
        "Acts": "ACT", "Rom": "ROM",
        "1 Cor": "1CO", "2 Cor": "2CO",
        "Gal": "GAL", "Eph": "EPH", "Phil": "PHP", "Php": "PHP",
        "Col": "COL", "1 Thess": "1TH", "2 Thess": "2TH",
        "1 Tim": "1TI", "2 Tim": "2TI", "Tit": "TIT", "Phlm": "PHM",
        "Heb": "HEB", "Jas": "JAS", "1 Pet": "1PE", "2 Pet": "2PE",
        "1 Jn": "1JN", "2 Jn": "2JN", "3 Jn": "3JN", "Jud": "JUD", "Rev": "REV",
    }
    for code, full in _OSIS_BOOK_NAMES.items():
        _NAME_TO_OSIS[full.lower()] = code
        _NAME_TO_OSIS[code.lower()] = code
    for short, code in extras.items():
        _NAME_TO_OSIS[short.lower()] = code


_OSIS_REF_RE = re.compile(r"\b([1-3]?[A-Z]{2,4})\.(\d+)\.(\d+)\b")
# Human "Gen 18:11" / "1 Kings 1:1" — captures multi-word book names too.
# We're permissive on whitespace and accept either a colon or a period.
_HUMAN_REF_RE = re.compile(
    r"\b([1-3]\s?)?([A-Z][a-zA-Z]{1,12}(?:\s[A-Z][a-zA-Z]{1,12})?)\s+(\d+)[:.](\d+)"
)


def _match_verse_refs_in_text(text: str) -> set[str]:
    """Pull every verse_id the model name-drops in `text`. Returns OSIS
    `BOOK.CH.V` strings — same shape as `RetrievedChunk.verse_refs[0]`
    so callers can intersect with the retrieval list directly."""
    _seed_name_map()
    found: set[str] = set()
    for m in _OSIS_REF_RE.finditer(text):
        found.add(f"{m.group(1)}.{m.group(2)}.{m.group(3)}")
    for m in _HUMAN_REF_RE.finditer(text):
        prefix = (m.group(1) or "").strip()
        body = m.group(2).strip()
        ch, v = m.group(3), m.group(4)
        candidate = f"{prefix} {body}".strip().lower()
        # Greedy two-word match can capture a leading sentence word
        # ("See Gen 18:11" → body="See Gen"). When the full body
        # doesn't map, fall back to the last whitespace-separated
        # token, which is the actual book name in practice.
        words = body.split()
        last = words[-1].lower() if words else ""
        code = (
            _NAME_TO_OSIS.get(candidate)
            or _NAME_TO_OSIS.get(body.lower())
            or (_NAME_TO_OSIS.get(last) if len(words) > 1 else None)
        )
        if code:
            found.add(f"{code}.{ch}.{v}")
    return found


def _scope_label(scope_kind: str, verse_ref: str) -> str:
    """Build the prompt label that announces the scope to the model.
    The label is the FIRST line of the user message — at non-verse
    scope, it replaces the misleading `VERSE: BOOK.CH.V` line that
    would otherwise pin the model to a single verse."""
    parts = verse_ref.split(".") if verse_ref else []
    book_code = parts[0] if parts else ""
    book_name = _OSIS_BOOK_NAMES.get(book_code, book_code)
    if scope_kind == "chapter" and len(parts) >= 2:
        return f"CHAPTER: {book_name} {parts[1]}"
    if scope_kind == "book" and book_code:
        return f"BOOK: {book_name}"
    if scope_kind == "testament":
        # The frontend sends GEN.1.1 for OT and MAT.1.1 for NT; derive
        # the testament from the anchor book.
        testament = "New Testament" if book_code in _NT_BOOKS else "Old Testament"
        return f"TESTAMENT: {testament}"
    if scope_kind == "bible":
        return "SCOPE: the whole Bible"
    # Default = verse scope (or fallback if the kind is missing).
    return f"VERSE: {verse_ref}"


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
        # Surface the verse anchor when the chunk is one — without it
        # the model sees a bare snippet of text and can't tell that
        # `S7` is `GEN.18.11`. The fallout was cross-references
        # mentioned by name in prose but never tied back to a citation,
        # so the Sources panel showed nothing for them.
        if c.verse_refs:
            head += f", {c.verse_refs[0]}"
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
        scope_kind: str = "verse",
        revision_hints: Optional[list[str]] = None,
    ) -> tuple[str, str, list[GeneratedStatement], Optional[NoteSuggestion]]:
        """Non-streaming entry point — used by tests and the POST /reason
        path. Internally routes through `generate_streaming` with a no-op
        callback so the two paths can't drift."""
        return self.generate_streaming(
            verse_ref, question, retrieval, None,
            history=history, bypass=bypass, scope_kind=scope_kind,
            revision_hints=revision_hints,
        )

    def generate_streaming(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        on_reasoning_chunk: Optional[Callable[[str], None]],
        history: Optional[list] = None,
        bypass: bool = False,
        scope_kind: str = "verse",
        revision_hints: Optional[list[str]] = None,
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
        # Pick the prompt label so the model doesn't misread a single
        # verse anchor as the topic when the user is actually asking
        # at chapter / book / wider zoom.
        scope_label = _scope_label(scope_kind, verse_ref)
        if bypass:
            # Engine off: looser prompt, no citation discipline, longer
            # answers welcome. Still JSON so the rest of the pipeline
            # round-trips cleanly — but claims/cited_ids stay empty.
            system = _PREAMBLE_BYPASS
            user = (
                f"{scope_label}\n\n"
                + (f"PRIOR DISCUSSION:\n{history_block}\n\n" if history_block else "")
                + f"QUESTION: {question}\n\n"
                + f"REFERENCE PASSAGES (use freely, no citation IDs required):\n{sources_text}\n\n"
                + _BYPASS_SCHEMA_PROMPT
            )
        else:
            system = _PREAMBLE
            # citation-engine.MD §6: on a retry, the rule layer hands us
            # specific revision hints. Surface them prominently so the
            # model addresses each one rather than emitting the same
            # output and tripping the same gate.
            revision_block = ""
            if revision_hints:
                lines = "\n".join(f"  - {h}" for h in revision_hints if h)
                revision_block = (
                    "\nREVIEWER FEEDBACK FROM PRIOR ATTEMPT — your previous "
                    "response was held back. Address each item before "
                    "re-emitting:\n" + lines + "\n\n"
                )
            user = (
                f"{scope_label}\n\n"
                + (f"PRIOR DISCUSSION:\n{history_block}\n\n" if history_block else "")
                + revision_block
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
            return _parse_generator_json(content, short_to_real, retrieval)

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

        return _parse_generator_json("".join(content_parts), short_to_real, retrieval)


def _parse_generator_json(
    content: str,
    short_to_real: dict[str, str],
    retrieval: Optional[list[RetrievedChunk]] = None,
) -> tuple[str, str, list[GeneratedStatement], Optional[NoteSuggestion]]:
    """Pull reasoning/answer/claims/note_to_append out of the model's
    JSON response.

    Each `cited_ids` entry is mapped back from `S1`-style labels to the
    real citation_id the engine expects. IDs not in the map are dropped.
    `note_to_append` may be null/missing/malformed — return None then.

    When `retrieval` is provided, every claim's text is scanned for verse
    references; any reference that matches a retrieved translation chunk
    has its citation_id appended to the claim. This is the safety net
    for cross-references the model name-drops without explicitly tying
    back to a SOURCES short id — those used to vanish from the Sources
    panel even though the user could see them in the prose.
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

    # Post-hoc safety net: scan each claim's text for verse refs the
    # model didn't bother to tie back to a SOURCES id. For each one we
    # actually retrieved, attach the chunk's citation_id. This is what
    # makes "Gen 18:11" appear in the Sources panel even when the model
    # only mentioned it in prose.
    if retrieval:
        verse_to_cid: dict[str, str] = {}
        for ch in retrieval:
            if ch.source_kind in ("translation", "scripture", "original_language") and ch.verse_refs:
                # First chunk wins — prefer the primary translation over
                # a Hebrew/Greek row when both exist for the same verse.
                verse_to_cid.setdefault(ch.verse_refs[0], ch.citation_id)
        if verse_to_cid:
            for st in statements:
                already = set(st.cited_ids)
                for ref in _match_verse_refs_in_text(st.text):
                    cid = verse_to_cid.get(ref)
                    if cid and cid not in already:
                        st.cited_ids.append(cid)
                        already.add(cid)

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
