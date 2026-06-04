"""Default backends for development.

These are placeholder implementations so the app boots and the wiring is
end-to-end testable. They are **not** the production agent — that is the
local-LLM Ollama path (CLAUDE.md §8) and a real entailment verifier
(`TODO(spec)`, citation-engine.MD §5).
"""
from __future__ import annotations

import re

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from ..reasoning.types import GeneratedStatement, RetrievedChunk
from ...data.models import CrossReference, Resource, Translation
from ...data.repos import AgentNoteRepository
from .web_search import WebSearcher, _NoopWebSearcher


# Very small English stopword list — enough to keep keyword search
# focused without pulling in a dependency.
_STOPWORDS = frozenset(
    """a an and are as at be been being but by can did do does for from
    have has had he her him his i in is it its me my of on or our she
    so such that the their them then they this to us was we were what
    when where which who why will with you your yours mine related
    verses verse bible find more about does did mean meaning meanings
    please""".split()
)


def _note_body_text(note) -> str:
    """Pull the plain-text body out of a Note row.

    Notes store rich content as a Yjs doc (`notes-system.MD` §3.1) but
    the row also keeps a JSON snapshot. We use the snapshot's `body`
    field if present; otherwise fall back to the empty string.
    """
    snap = getattr(note, "snapshot", None) or {}
    if isinstance(snap, dict):
        body = snap.get("body") or snap.get("text") or ""
        if isinstance(body, str):
            return body.strip()
    return ""


# Traditional authorship attributions. These are widely held and let the
# retriever find verses BY an author when the question asks for them,
# not just verses that mention their name. Disputed cases (Hebrews,
# Psalms beyond David, etc.) are marked accordingly in the agent's
# prompt — the engine still verifies each surviving claim.
_AUTHOR_BOOKS: dict[str, list[str]] = {
    "paul": ["ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL",
             "1TH", "2TH", "1TI", "2TI", "TIT", "PHM"],
    "peter": ["1PE", "2PE"],
    "john": ["JHN", "1JN", "2JN", "3JN", "REV"],
    "james": ["JAS"],
    "jude": ["JUD"],
    "luke": ["LUK", "ACT"],
    "matthew": ["MAT"],
    "mark": ["MRK"],
    "moses": ["GEN", "EXO", "LEV", "NUM", "DEU"],
    "david": ["PSA"],
    "solomon": ["PRO", "ECC", "SNG"],
    "isaiah": ["ISA"],
    "jeremiah": ["JER", "LAM"],
    "daniel": ["DAN"],
    "ezekiel": ["EZK"],
}

_AUTHORSHIP_RE = re.compile(
    r"\b(?:wrote|written by|authored?(?: by)?|"
    r"letter(?:s)? (?:of|by|from)|epistle(?:s)? (?:of|by)|"
    r"writing(?:s)? (?:of|by)|verses? (?:of|by|from)|"
    r"book(?:s)? (?:of|by))\b\s+"
    r"(?:the\s+)?(?:apostle\s+|prophet\s+|king\s+|saint\s+|st\.?\s+)?"
    r"(paul|peter|john|james|jude|luke|matthew|mark|moses|david|solomon|"
    r"isaiah|jeremiah|daniel|ezekiel)\b",
    re.IGNORECASE,
)


def _detect_authorship(question: str) -> list[str]:
    """If the question is asking for the writings of a named author,
    return that author's book codes. Empty list otherwise."""
    books: list[str] = []
    for m in _AUTHORSHIP_RE.finditer(question):
        name = m.group(1).lower()
        for b in _AUTHOR_BOOKS.get(name, []):
            if b not in books:
                books.append(b)
    return books


_TOPIC_MODE_PATTERNS = re.compile(
    r"\b("
    r"all (?:of (?:the )?)?(?:verses?|passages?|references?)"
    r"|every (?:verse|passage|reference)"
    r"|list (?:all|every|the)"
    r"|bring up (?:all|every|the)"
    r"|show me (?:all|every|the)"
    r"|give me (?:all|every|the)"
    r"|find (?:me )?(?:all|every|the)"
    r"|what (?:verses?|passages?)"
    r"|where (?:does|do).+(?:say|mention|teach)"
    r"|wrote|written by|author(?:ed)? by"
    r")\b",
    re.IGNORECASE,
)


def _is_topic_mode(question: str) -> bool:
    """Heuristic: question is asking for a broad topical list rather than
    an explanation of the focused verse. When true, the retriever ignores
    the focused verse's keywords + cross-references and searches purely
    on question terms."""
    return bool(_TOPIC_MODE_PATTERNS.search(question))


def _extract_keywords(text: str, *, min_len: int = 4, limit: int = 6) -> list[str]:
    """Pull content words from a string, dropping stopwords + duplicates."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in re.findall(r"[A-Za-z][A-Za-z'-]+", text.lower()):
        if len(raw) < min_len or raw in _STOPWORDS or raw in seen:
            continue
        seen.add(raw)
        out.append(raw)
        if len(out) >= limit:
            break
    return out


class SqlRetriever:
    """Retrieves source chunks for a verse + a question.

    Two passes:
      1. The focused verse's translation(s) — always included.
      2. A keyword search across the entire KJV (Translation.text) using
         content words from the question and the focused verse, ranked
         by number of matching keywords. Capped at `related_limit`.

    Vector search will replace step 2 (CLAUDE.md §8). Personal notes are
    never queried here (rule-guide.MD §12.1).
    """

    def __init__(
        self,
        session: Session,
        *,
        related_limit: int = 12,
        xref_limit: int = 8,
        notes_limit: int = 8,
        web_limit: int = 3,
        translation_name: str = "King James Version",
        web_searcher: WebSearcher | None = None,
    ) -> None:
        self.session = session
        self.related_limit = related_limit
        self.xref_limit = xref_limit
        self.notes_limit = notes_limit
        self.web_limit = web_limit
        self.translation_name = translation_name
        self.web_searcher = web_searcher or _NoopWebSearcher()

    def retrieve(
        self,
        verse_ref: str,
        question: str,
        room_id: str = "",
    ) -> list[RetrievedChunk]:
        chunks: list[RetrievedChunk] = []
        seen_ids: set[str] = set()
        topic_mode = _is_topic_mode(question)

        # 1. The focused verse(s) themselves — restrict to the named
        #    translation so we don't accidentally hand the model Hebrew or
        #    Arabic chunks for a verse it isn't asked about.
        focus_text_parts: list[str] = []
        for t in self.session.scalars(
            select(Translation).where(
                Translation.verse_id == verse_ref,
                Translation.name == self.translation_name,
            )
        ):
            cid = f"trans:{t.id}"
            chunks.append(
                RetrievedChunk(
                    citation_id=cid,
                    text=t.text,
                    source_kind="translation",
                    verse_refs=[verse_ref],
                    license=t.license,
                )
            )
            seen_ids.add(cid)
            focus_text_parts.append(t.text)

        # 2. Cross-references for the focused verse (CLAUDE.md §7.4).
        # Skip in topic-mode — xrefs are focus-specific and would crowd
        # out topical results.
        if self.xref_limit > 0 and not topic_mode:
            xref_stmt = (
                select(CrossReference.to_verse_id)
                .where(CrossReference.from_verse_id == verse_ref)
                .limit(self.xref_limit)
            )
            xref_targets = [r for (r,) in self.session.execute(xref_stmt)]
            if xref_targets:
                t_stmt = (
                    select(Translation).where(
                        Translation.verse_id.in_(xref_targets),
                        Translation.name == self.translation_name,
                    )
                )
                for t in self.session.scalars(t_stmt):
                    cid = f"trans:{t.id}"
                    if cid in seen_ids:
                        continue
                    chunks.append(
                        RetrievedChunk(
                            citation_id=cid,
                            text=t.text,
                            source_kind="translation",
                            verse_refs=[t.verse_id],
                            license=t.license,
                        )
                    )
                    seen_ids.add(cid)

        # 2b. Group notes — the agent's oversight surface (rule-guide.MD
        #     §12.2). PERSONAL notes are filtered at the data layer by
        #     `AgentNoteRepository` and never reach here (§12.1).
        if room_id and self.notes_limit > 0:
            try:
                notes_repo = AgentNoteRepository(self.session, room_id)
                group_notes = notes_repo.list_visible()
            except Exception:
                group_notes = []
            # Prefer verse-anchored notes if we have a focus.
            def _note_relevance(n) -> int:
                anchors = list(n.verse_anchors or [])
                if verse_ref in anchors:
                    return 2
                if anchors:
                    return 1
                return 0

            group_notes.sort(key=_note_relevance, reverse=True)
            for n in group_notes[: self.notes_limit]:
                body = _note_body_text(n)
                if not body:
                    continue
                anchors = list(n.verse_anchors or [])
                attribution = "agent" if n.author_is_agent else "human"
                chunks.append(
                    RetrievedChunk(
                        citation_id=f"note:{n.id}",
                        text=f"[group note, {attribution}] {body}",
                        source_kind="group_note",
                        verse_refs=anchors,
                    )
                )

        # 3. Keyword expansion across the whole Bible.
        # 2c. Authorship retrieval — when the user asks for verses BY
        #     an author, pull representative verses straight from each
        #     of that author's books. Keyword search misses these
        #     because Paul (etc.) rarely writes his own name.
        author_books = _detect_authorship(question)
        author_verses_per_book = 2
        if author_books:
            # First 2 verses of each book — enough to represent each
            # without blowing the context budget.
            author_stmt = (
                select(Translation, Verse)
                .join(Verse, Verse.id == Translation.verse_id)
                .where(
                    Verse.book.in_(author_books),
                    Verse.chapter == 1,
                    Verse.verse <= author_verses_per_book,
                    Translation.name == self.translation_name,
                )
                .order_by(Verse.book, Verse.chapter, Verse.verse)
            )
            for t, v in self.session.execute(author_stmt):
                cid = f"trans:{t.id}"
                if cid in seen_ids:
                    continue
                chunks.append(
                    RetrievedChunk(
                        citation_id=cid,
                        text=t.text,
                        source_kind="translation",
                        verse_refs=[v.id],
                        license=t.license,
                    )
                )
                seen_ids.add(cid)

        # Question keywords get a higher weight than focus-verse keywords so
        # topic queries ("verses about Paul") aren't drowned by content
        # matching the focused verse's text. In topic-mode, focus keywords
        # are dropped entirely.
        question_keywords = _extract_keywords(question, limit=6 if topic_mode else 5)
        focus_keywords: list[str] = []
        if not topic_mode:
            focus_keywords = [
                kw for kw in _extract_keywords(" ".join(focus_text_parts), limit=4)
                if kw not in question_keywords
            ]
        all_keywords = [*question_keywords, *focus_keywords]
        # Bump the result cap in topic-mode — broad questions warrant more
        # candidates so a verse mentioning the topic alone can still score.
        result_limit = (
            int(self.related_limit * 1.5) if topic_mode else self.related_limit
        )
        if all_keywords:
            lowered = func.lower(Translation.text)
            conditions = [lowered.like(f"%{kw}%") for kw in all_keywords]
            score_terms = [
                case((lowered.like(f"%{kw}%"), 3), else_=0)
                for kw in question_keywords
            ] + [
                case((lowered.like(f"%{kw}%"), 1), else_=0)
                for kw in focus_keywords
            ]
            score = score_terms[0]
            for term in score_terms[1:]:
                score = score + term
            stmt = (
                select(Translation, score.label("score"))
                .where(
                    Translation.name == self.translation_name,
                    or_(*conditions),
                )
                .order_by(score.desc())
                .limit(result_limit * 2)  # over-fetch, dedupe below
            )
            for t, _score in self.session.execute(stmt):
                cid = f"trans:{t.id}"
                if cid in seen_ids:
                    continue
                chunks.append(
                    RetrievedChunk(
                        citation_id=cid,
                        text=t.text,
                        source_kind="translation",
                        verse_refs=[t.verse_id],
                        license=t.license,
                    )
                )
                seen_ids.add(cid)
                if (len(chunks) - 1) >= result_limit:
                    break

        # 3. A few commentary stubs (none seeded yet — `TODO(spec)` for
        #    real commentary + licenses, CLAUDE.md §7.6).
        for r in self.session.scalars(select(Resource).limit(3)):
            chunks.append(
                RetrievedChunk(
                    citation_id=f"res:{r.id}",
                    text=r.body,
                    source_kind="commentary" if r.type == "commentary" else "lexicon",
                    tradition=r.tradition_tag,
                    reliability=r.reliability_flag,
                    license=r.license_attribution,
                )
            )

        # 4. Rule-bounded web search for commentary (CLAUDE.md §6.2,
        #    rule-guide.MD §8). Each result is allowlist-checked,
        #    profanity/injection-filtered, and stored under
        #    source_kind="web" so the agent's prompt forces it to
        #    explain why each web source is trustworthy
        #    (rule-guide.MD §8.3).
        if self.web_limit > 0 and not isinstance(self.web_searcher, _NoopWebSearcher):
            web_query = f"commentary {verse_ref.replace('.', ' ')} {question[:120]}"
            try:
                web_results = self.web_searcher.search(
                    web_query, verse_ref=verse_ref, limit=self.web_limit
                )
            except Exception:
                web_results = []
            for w in web_results:
                chunks.append(
                    RetrievedChunk(
                        citation_id=f"web:{w.url}",
                        text=f"[{w.source_domain}] {w.title}\n{w.body}",
                        source_kind="web",
                        license=f"Web; source: {w.source_domain}",
                    )
                )

        return chunks


class PlaceholderGenerator:
    """No-op generator: returns a structured stub so the pipeline runs
    even before a local LLM is wired (CLAUDE.md §8)."""

    def generate(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        history=None,
        bypass: bool = False,
    ):
        reasoning = (
            f"Considering {verse_ref} in light of {len(retrieval)} retrieved "
            "source(s). No reasoning model is wired yet (CLAUDE.md §8 TODO)."
        )
        answer = "The reasoning model is not yet wired."
        return reasoning, answer, [], None


class PassThroughVerifier:
    """Default verifier. Refuses to validate by default — the only safe
    fallback if the real entailment model is missing. This is what
    prevents the engine from silently passing junk in dev.
    `TODO(spec)`: replace with a local NLI/entailment model
    (citation-engine.MD §5)."""

    def entails(self, claim: str, source_text: str) -> bool:
        return False

    def contradicts_scripture(self, claim: str, scripture_text: str) -> bool:
        return False
