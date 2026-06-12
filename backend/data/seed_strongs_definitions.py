"""Backfill OriginalToken.lexicon_entry with short Strong's definitions.

Source: openscriptures/strongs (CC-BY-SA). Two JS files exporting a
single object whose keys are Strong's numbers (`H1`, `G2316`, …) and
values are records with `lemma`, `xlit`, `pronounce`, `derivation`,
`strongs_def`, and `kjv_def` (the AV gloss). We pick the most useful
short form per entry and write it to `lexicon_entry` so the frontend
can show inline definitions next to the Strong's pill.

Idempotent: skips tokens that already have lexicon_entry populated.
Tokens whose Strong's number isn't in the dictionary (a small tail
of rare/conjectural numbers) are left null and the UI handles the
absent definition gracefully.

Run from the repo root:
    python3 -m backend.data.seed_strongs_definitions
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from typing import Iterable

from sqlalchemy import update
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import OriginalToken


_GREEK_URL = (
    "https://raw.githubusercontent.com/openscriptures/strongs/master/"
    "greek/strongs-greek-dictionary.js"
)
_HEBREW_URL = (
    "https://raw.githubusercontent.com/openscriptures/strongs/master/"
    "hebrew/strongs-hebrew-dictionary.js"
)


# The openscriptures files are JS: a license header, then
#   var strongsGreekDictionary = { ... }; module.exports = …;
# Find the first `{`, walk to its matching `}`, and parse as JSON.
def _extract_object(raw: str) -> str:
    start = raw.index("{")
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(raw)):
        c = raw[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return raw[start : i + 1]
    raise ValueError("unbalanced braces in strongs dictionary file")


def _fetch_dict(url: str) -> dict[str, dict]:
    print(f"  fetching {url}…", flush=True)
    with urllib.request.urlopen(url, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
    body = _extract_object(raw)
    return json.loads(body)


def _short_definition(entry: dict) -> str | None:
    """Pick the most compact useful gloss. Prefer `kjv_def` (one-line
    AV gloss), then `strongs_def`, then `derivation`. Strip any inline
    `H####` / `G####` cross-references for readability — those are
    useful in a full lexicon viewer, distracting in an inline tooltip."""
    for field in ("kjv_def", "strongs_def", "derivation"):
        v = entry.get(field)
        if not v:
            continue
        s = str(v).strip()
        # Strip cross-references in {H123} / {G123} braces.
        s = re.sub(r"\{[HG]\d+\}", "", s)
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            return s
    return None


def _build_strongs_map() -> dict[str, str]:
    greek = _fetch_dict(_GREEK_URL)
    hebrew = _fetch_dict(_HEBREW_URL)
    out: dict[str, str] = {}
    for raw_key, entry in greek.items():
        defn = _short_definition(entry)
        if defn:
            # Greek keys are `G123`. Our tokens store the same form.
            out[raw_key] = defn
    for raw_key, entry in hebrew.items():
        defn = _short_definition(entry)
        if defn:
            # Hebrew keys are `H123`. Some OT tokens carry the form
            # without a leading H (legacy seed) — register both spellings
            # so we hit either way.
            out[raw_key] = defn
            if raw_key.startswith("H"):
                out[raw_key[1:]] = defn
    return out


def _batches(it: Iterable, n: int = 500):
    buf = []
    for x in it:
        buf.append(x)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf


def seed() -> None:
    init_db()
    strongs_map = _build_strongs_map()
    print(f"  loaded {len(strongs_map)} Strong's definitions")

    with Session(engine) as s:
        # Pull every token that has a Strong's number but no
        # lexicon_entry. We update in batches by primary key so the
        # write is fast and re-runnable.
        rows = list(
            s.query(OriginalToken.id, OriginalToken.strongs)
            .filter(OriginalToken.strongs.isnot(None))
            .filter(
                (OriginalToken.lexicon_entry.is_(None))
                | (OriginalToken.lexicon_entry == "")
            )
            .all()
        )
        print(f"  {len(rows)} tokens need a lexicon entry")
        updated = 0
        missing = 0
        for batch in _batches(rows, 500):
            mappings = []
            for tok_id, strongs in batch:
                defn = strongs_map.get(strongs)
                if not defn:
                    missing += 1
                    continue
                mappings.append({"id": tok_id, "lexicon_entry": defn})
            if mappings:
                s.bulk_update_mappings(OriginalToken, mappings)
                s.commit()
                updated += len(mappings)
                print(
                    f"    updated {updated}/{len(rows)} "
                    f"(missing-key: {missing})",
                    flush=True,
                )
        print(f"Done. {updated} tokens stamped, {missing} had no lex entry.")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
