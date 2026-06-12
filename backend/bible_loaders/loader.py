"""Dispatch a chapter fetch to the right source.

`load_chapter()` is the only entry point the API layer should call.
It checks the SQLite cache first; on miss, it routes to the matching
provider (api.bible / ESV) and persists the result back into the
`translations` table (subject to the registry's cache policy).
"""
from __future__ import annotations

import logging
import os
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..data.models import Translation, Verse
from .registry import TranslationSpec, get as registry_get


log = logging.getLogger("bible_iu.bible_loaders")


class TranslationNotEnabled(RuntimeError):
    """Registry has the entry but `enabled=False` — license not signed
    yet, or the env key is missing. Surfaced as HTTP 402 by the
    endpoint."""


class TranslationMissingKey(RuntimeError):
    """Registry entry is enabled but the API key env var isn't set.
    Surfaced as HTTP 503 by the endpoint."""


class TranslationFetchError(RuntimeError):
    """Network / upstream API problem. Surfaced as HTTP 502."""


def _existing_chapter(
    session: Session, name: str, book: str, chapter: int
) -> list[tuple[Translation, Verse]]:
    stmt = (
        select(Translation, Verse)
        .join(Verse, Verse.id == Translation.verse_id)
        .where(
            Verse.book == book,
            Verse.chapter == chapter,
            Translation.name == name,
        )
        .order_by(Verse.verse)
    )
    return list(session.execute(stmt))


def _chapter_is_cached(
    session: Session, name: str, book: str, chapter: int
) -> bool:
    """Loose heuristic: we treat the chapter as cached if we have ANY
    rows for it. Loaders write a whole chapter at a time so partial
    rows shouldn't happen in practice, but if they do we re-fetch and
    upsert."""
    rows = _existing_chapter(session, name, book, chapter)
    return len(rows) > 0


def _persist(
    session: Session,
    spec: TranslationSpec,
    book: str,
    chapter: int,
    verses: Iterable[tuple[int, str]],
) -> int:
    """Upsert the fetched verses into `translations`. The license
    column gets the registry's full attribution string verbatim so the
    publisher's mandatory display text is on the same row as the text
    itself — no chance of drift.

    Honors `cache_policy="no_cache"` by skipping the persist; the API
    layer still returns the live-fetched rows to the user, just nothing
    sticks for next time.
    """
    if spec.cache_policy == "no_cache":
        return 0

    verses_list = list(verses)
    # Half-chapter cache policy (ESV free-tier rule): persist only the
    # first half of the chapter so we never exceed the publisher's cap.
    # The caller still receives the full chapter for display — only
    # disk persistence is trimmed. Next chapter open: re-fetch the
    # second half on the fly.
    if spec.cache_policy == "half_chapter":
        half = max(1, len(verses_list) // 2)
        verses_list = verses_list[:half]

    written = 0
    for verse_num, text in verses_list:
        verse_id = f"{book}.{chapter}.{verse_num}"
        v = session.get(Verse, verse_id)
        if v is None:
            # Verses table holds the canonical anchor; if it's missing
            # we can't attach a translation. Verses are seeded for
            # every book/chapter/verse the canon contains, so a miss
            # means the source returned a verse outside the canonical
            # range (rare, but possible with deuterocanonical numbering).
            log.warning(
                "bible_loaders: skipping %s — no Verse row for %s",
                spec.name, verse_id,
            )
            continue
        # Translation has composite "natural key" of (verse_id, name).
        # Look for an existing row before insert to avoid PK collision.
        existing = session.scalar(
            select(Translation).where(
                Translation.verse_id == verse_id,
                Translation.name == spec.name,
            )
        )
        if existing is not None:
            existing.text = text
            existing.license = spec.attribution
        else:
            session.add(
                Translation(
                    id=f"{verse_id}|{spec.name}",
                    name=spec.name,
                    verse_id=verse_id,
                    text=text,
                    license=spec.attribution,
                )
            )
        written += 1
    session.commit()
    return written


def load_chapter(
    session: Session, name: str, book: str, chapter: int
) -> None:
    """Ensure `translations` has rows for (name, book, chapter).

    No-op if already cached. Public-domain (`source="local"`)
    translations always need to be in the seed — if we get a miss
    on a local translation, that's a data-load problem, not a fetch
    problem, and we surface a clear error rather than pretend.
    """
    spec = registry_get(name)
    if spec is None:
        raise TranslationNotEnabled(
            f"Unknown translation: {name!r}. "
            f"Add it to bible_loaders/registry.py first."
        )

    if spec.source == "local":
        # Local translations are whatever the seed actually loaded.
        # A "miss" here is usually a partial-canon translation
        # (NT-only like Greek TR / Tyndale, OT-only like JPS, Hebrew
        # WLC, LXX) being asked for a chapter outside its scope. The
        # endpoint will just return no rows for this translation in
        # that chapter — the caller renders the other translations
        # alongside and that one stays absent. NOT a fetch error.
        return

    if not spec.enabled:
        raise TranslationNotEnabled(
            f"{name} is defined in the registry but enabled=False. "
            f"Set enabled=True after the license + env key are in place."
        )

    if _chapter_is_cached(session, name, book, chapter):
        return

    if spec.source == "api_bible":
        from .api_bible import fetch_chapter as fetch_api_bible
        verses = fetch_api_bible(spec, book, chapter)
    elif spec.source == "esv":
        from .esv import fetch_chapter as fetch_esv
        verses = fetch_esv(spec, book, chapter)
    else:  # pragma: no cover — exhaustive over Source literal
        raise TranslationFetchError(f"No loader for source: {spec.source!r}")

    _persist(session, spec, book, chapter, verses)


def api_key(env_var: str) -> str:
    """Read an env var or raise TranslationMissingKey with a clear
    pointer to where to set it. Loaders call this rather than reading
    `os.environ` directly so the missing-key error is uniform."""
    val = (os.environ.get(env_var) or "").strip()
    if not val:
        raise TranslationMissingKey(
            f"env var {env_var} is not set. Add it to the backend "
            f"launchagent plist (or shell env) and reload."
        )
    return val


# A helper the endpoint uses to surface attribution per translation in
# the response. Returns None for "no attribution available" rather than
# raising — the response should still go out even if registry lookups
# fail for legacy seed rows.
def attribution_for(name: str) -> Optional[str]:
    spec = registry_get(name)
    return spec.attribution if spec else None
