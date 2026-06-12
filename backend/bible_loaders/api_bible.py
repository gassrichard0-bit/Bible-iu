"""API.Bible loader — https://docs.api.bible

One API key gives access to dozens of translations. Each translation
has a `bibleId` (UUID-ish) used in the URL. We fetch one whole
chapter per request using the chapter-text endpoint:

  GET /v1/bibles/{bibleId}/chapters/{chapterId}?content-type=text
      &include-notes=false&include-titles=false
      &include-chapter-numbers=false&include-verse-numbers=true

The response carries the chapter as plain text with `[N]` markers
between verses. We split on the marker to recover (verse_num, text)
pairs — one API call per chapter, instead of the ~25 calls we'd
make hitting `/verses/{verseId}` per verse.

Rate limits — Starter plan is 5,000 calls/month. At ~1 call per
chapter view, that covers ~5,000 chapter reads a month with no
caching. With the SQLite cache, a chapter only hits the network
once ever — so most of the quota is free for new readers / new
translations.
"""
from __future__ import annotations

import logging
import re
from typing import Iterable

import httpx

from .loader import (
    TranslationFetchError,
    TranslationSpec,
    api_key,
)


log = logging.getLogger("bible_iu.bible_loaders.api_bible")

_BASE_URL = "https://api.scripture.api.bible/v1"
_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
# API.Bible's chapter id format is `BOOK.CHAPTER` where BOOK is the
# OSIS-ish three-letter code we already use everywhere.
_VERSE_ID_RE = re.compile(r"^([A-Z0-9]+)\.(\d+)\.(\d+)$")


def _chapter_id(book_osis: str, chapter: int) -> str:
    # OSIS codes from our seed already match API.Bible's book ids.
    return f"{book_osis}.{chapter}"


def _verse_num_from_id(verse_id: str) -> int | None:
    m = _VERSE_ID_RE.match(verse_id)
    if not m:
        return None
    try:
        return int(m.group(3))
    except ValueError:
        return None


# Verses inside the chapter response are delimited by `[N]` markers
# in front of each verse's text:
#   "[1] In the beginning God…  [2] Now the earth was…"
_VERSE_MARKER_RE = re.compile(r"\[(\d+)\]\s*")


def fetch_chapter(
    spec: TranslationSpec, book_osis: str, chapter: int
) -> Iterable[tuple[int, str]]:
    """Yield (verse_num, text) for every verse in the chapter via ONE
    API call to the chapter-text endpoint."""
    if not spec.source_id:
        raise TranslationFetchError(
            f"API.Bible translation {spec.name!r} is missing source_id "
            f"(the bibleId). Fill it in in registry.py."
        )
    key = api_key("API_BIBLE_KEY")
    url = (
        f"{_BASE_URL}/bibles/{spec.source_id}"
        f"/chapters/{_chapter_id(book_osis, chapter)}"
    )
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.get(
                url,
                headers={"api-key": key},
                params={
                    "content-type": "text",
                    "include-notes": "false",
                    "include-titles": "false",
                    "include-chapter-numbers": "false",
                    "include-verse-numbers": "true",
                },
            )
        if resp.status_code == 401:
            raise TranslationFetchError(
                f"API.Bible rejected key (401). Check API_BIBLE_KEY."
            )
        if resp.status_code == 403:
            raise TranslationFetchError(
                f"API.Bible forbade access to {spec.name} (403). "
                f"This translation may not be on your plan."
            )
        if resp.status_code == 404:
            raise TranslationFetchError(
                f"API.Bible has no chapter {book_osis} {chapter} for "
                f"{spec.name}. Possibly out-of-canon for this translation."
            )
        resp.raise_for_status()
        content = (resp.json().get("data") or {}).get("content", "")
    except httpx.HTTPError as e:
        raise TranslationFetchError(
            f"API.Bible chapter fetch failed: {e}"
        ) from e

    # Split on the [N] verse markers. The first split piece is whatever
    # preface text (often empty or a chapter heading we asked to exclude)
    # sits before [1]; drop it.
    parts = _VERSE_MARKER_RE.split(content)
    out: list[tuple[int, str]] = []
    if len(parts) >= 3:
        it = iter(parts[1:])
        for n, text in zip(it, it):
            try:
                verse_num = int(n)
            except ValueError:
                continue
            cleaned = re.sub(r"\s+", " ", text).strip()
            if cleaned:
                out.append((verse_num, cleaned))

    if not out:
        raise TranslationFetchError(
            f"API.Bible returned no parseable verses for {spec.name} "
            f"{book_osis} {chapter}"
        )
    return out
