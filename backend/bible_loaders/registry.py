"""Registry of supported Bible translations.

One row per translation = where to find it + what the license requires
us to show. `source="local"` translations live in the SQLite seed and
need no loader. `source="api_bible"` routes through the corresponding
loader module.

To enable a new licensed translation:

  1. Add an entry below with the publisher's required attribution string
     and the source's lookup id (API.Bible's `bibleId`).
  2. Set the env var the loader reads — `API_BIBLE_KEY`.
  3. (Optional) flag it `enabled=False` while you wait on the license
     signing — the chapter endpoint will refuse it with a clear error
     instead of pretending.

We do NOT ship any licensed text in the seed db. Cached rows are
treated as a soft cache subject to the publisher's terms.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional


Source = Literal["local", "api_bible"]


@dataclass(frozen=True)
class TranslationSpec:
    name: str  # canonical name used in the `translations` table + UI
    source: Source
    # API.Bible: the Bible Id (UUID-ish). Local: ignored.
    source_id: Optional[str]
    # Long-form copyright string the publisher requires on display.
    # Stored verbatim in `Translation.license` and surfaced as
    # `attribution` in the chapter response.
    attribution: str
    # How aggressively we may cache the loaded text. The chapter loader
    # honors this.
    cache_policy: Literal["full", "half_chapter", "no_cache"] = "full"
    # Set False to mark a translation that's defined for documentation
    # but not yet licensed. Requests get a 402 (Payment Required) with
    # a clear message instead of attempting the fetch.
    enabled: bool = True
    # Display label shown in the picker. Defaults to `name`.
    display_label: Optional[str] = None


# ----- the registry --------------------------------------------------
# Order is the suggested picker order. Local public-domain options
# come first, then aggregator-fed, then per-publisher.
_REGISTRY: dict[str, TranslationSpec] = {
    spec.name: spec
    for spec in [
        # Names MUST match what's stored in the `translations` table.
        # Run `sqlite3 backend/data/bible-iu.sqlite "SELECT DISTINCT
        # name FROM translations"` to see the current set.
        TranslationSpec(
            name="King James Version",
            source="local",
            source_id=None,
            attribution="Public Domain (King James Version, 1611)",
            display_label="KJV",
        ),
        TranslationSpec(
            name="World English Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (World English Bible)",
            display_label="WEB",
        ),
        TranslationSpec(
            name="Berean Standard Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (Berean Standard Bible)",
            display_label="BSB",
        ),
        TranslationSpec(
            name="Young's Literal Translation",
            source="local",
            source_id=None,
            attribution="Public Domain (Young's Literal Translation, 1862)",
            display_label="YLT",
        ),
        TranslationSpec(
            name="Geneva Bible (1599)",
            source="local",
            source_id=None,
            attribution="Public Domain (Geneva Bible, 1599)",
            display_label="GEN",
        ),
        TranslationSpec(
            name="Douay-Rheims Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (Douay-Rheims Bible)",
            display_label="DRB",
        ),
        TranslationSpec(
            name="New English Translation",
            source="local",
            source_id=None,
            attribution=(
                "Scripture quoted by permission. Quotations designated "
                "(NET) are from the NET Bible® copyright ©1996-2017 by "
                "Biblical Studies Press, L.L.C. All rights reserved."
            ),
            display_label="NET",
        ),
        TranslationSpec(
            name="Hebrew (WLC)",
            source="local",
            source_id=None,
            attribution="Public Domain (Westminster Leningrad Codex)",
        ),
        TranslationSpec(
            name="Greek (TR)",
            source="local",
            source_id=None,
            attribution="Public Domain (Textus Receptus)",
        ),
        TranslationSpec(
            name="Arabic (SVD)",
            source="local",
            source_id=None,
            attribution="Public Domain (Smith & Van Dyke Arabic Bible)",
        ),
        TranslationSpec(
            name="Russian Synodal Translation",
            source="local",
            source_id=None,
            attribution="Public Domain (Russian Synodal Translation, 1876)",
            display_label="RST",
        ),
        # --------- Other-language public-domain translations ----------
        # Major-language PD translations sourced from scrollmapper.
        # Display labels follow the in-language convention where it
        # reads naturally (和合本 / 文語訳) — the picker shows whatever
        # `name` is here.
        TranslationSpec(
            name="Elberfelder 1871 (German)",
            source="local",
            source_id=None,
            attribution="Public Domain (Elberfelder Bible 1871)",
            display_label="Elb. 1871",
        ),
        TranslationSpec(
            name="Reina-Valera 1865 (Spanish)",
            source="local",
            source_id=None,
            attribution="Public Domain (Reina-Valera 1865)",
            display_label="RV 1865",
        ),
        TranslationSpec(
            name="Crampon (French)",
            source="local",
            source_id=None,
            attribution="Public Domain (Bible de Crampon 1923)",
            display_label="Crampon",
        ),
        TranslationSpec(
            name="Synodale 1921 (French)",
            source="local",
            source_id=None,
            attribution="Public Domain (Bible du Synode 1921) — NT primary",
            display_label="Synodale",
        ),
        TranslationSpec(
            name="Bíblia Livre (Portuguese)",
            source="local",
            source_id=None,
            attribution="Free license (Bíblia Livre, biblialivre.com.br)",
            display_label="BLivre",
        ),
        TranslationSpec(
            name="和合本 (Chinese Union, Traditional)",
            source="local",
            source_id=None,
            attribution="Public Domain (Chinese Union Version, 1919)",
            display_label="和合本",
        ),
        TranslationSpec(
            name="개역한글 (Korean Revised)",
            source="local",
            source_id=None,
            attribution="Public Domain (Korean Revised Version)",
            display_label="개역한글",
        ),
        TranslationSpec(
            name="文語訳 (Japanese Bungo)",
            source="local",
            source_id=None,
            attribution="Public Domain (Japanese Bungo Translation, 1887)",
            display_label="文語訳",
        ),
        TranslationSpec(
            name="Огієнко (Ukrainian)",
            source="local",
            source_id=None,
            attribution="Public Domain (Ohienko Translation, 1962)",
            display_label="Огієнко",
        ),
        TranslationSpec(
            name="Biblia Gdańska (Polish)",
            source="local",
            source_id=None,
            attribution="Public Domain (Biblia Gdańska, 1632)",
            display_label="Gdańska",
        ),
        TranslationSpec(
            name="Statenvertaling (Dutch)",
            source="local",
            source_id=None,
            attribution="Public Domain (Statenvertaling, 1637)",
            display_label="SVV",
        ),
        TranslationSpec(
            name="Svenska 1917 (Swedish)",
            source="local",
            source_id=None,
            attribution="Public Domain (Swedish Bible 1917)",
            display_label="Sv 1917",
        ),
        TranslationSpec(
            name="Truyền thống (Vietnamese)",
            source="local",
            source_id=None,
            attribution="Public Domain (Vietnamese Bible, 1934)",
            display_label="Việt",
        ),
        TranslationSpec(
            name="ไทย KJV (Thai)",
            source="local",
            source_id=None,
            attribution="Public Domain (Thai KJV Translation)",
            display_label="ไทย",
        ),
        TranslationSpec(
            name="Vulgata Clementina (Latin)",
            source="local",
            source_id=None,
            attribution="Public Domain (Clementine Vulgate)",
            display_label="Vulg.",
        ),
        TranslationSpec(
            name="Norsk (Norwegian)",
            source="local",
            source_id=None,
            attribution="Public Domain (Norwegian Bible, pre-1928)",
            display_label="Norsk",
        ),
        # --------- Public-domain English (scrollmapper batch) ----------
        # Imported via `seed_scrollmapper_translation.py`. License
        # strings here MUST match the strings stamped onto Translation
        # rows so the picker attribution = stored attribution.
        TranslationSpec(
            name="Darby Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (Darby Translation, 1890)",
            display_label="Darby",
        ),
        TranslationSpec(
            name="Webster's Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (Webster's Revision of the KJV, 1833)",
            display_label="Webster",
        ),
        TranslationSpec(
            name="Rotherham's Emphasized Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (Rotherham's Emphasized Bible, 1902)",
            display_label="Rotherham",
        ),
        TranslationSpec(
            name="Tyndale Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (Tyndale Bible, 1534) — partial (NT + portions of OT)",
            display_label="Tyndale",
        ),
        TranslationSpec(
            name="JPS 1917",
            source="local",
            source_id=None,
            attribution="Public Domain (Jewish Publication Society Tanakh, 1917) — OT only",
            display_label="JPS",
        ),
        TranslationSpec(
            name="New Heart English Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (New Heart English Bible)",
            display_label="NHEB",
        ),
        TranslationSpec(
            name="Open English Bible",
            source="local",
            source_id=None,
            attribution=(
                "CC0 / Public Domain (Open English Bible, openenglishbible.org) "
                "— NT only + Psalms; OT translation in progress upstream."
            ),
            display_label="OEB",
        ),
        TranslationSpec(
            name="Catholic Public Domain Version",
            source="local",
            source_id=None,
            attribution="Public Domain (Catholic Public Domain Version, 2009)",
            display_label="CPDV",
        ),
        TranslationSpec(
            name="American King James Version",
            source="local",
            source_id=None,
            attribution="Free license (American King James Version, 1999)",
            display_label="AKJV",
        ),
        TranslationSpec(
            name="Modern King James Version",
            source="local",
            source_id=None,
            attribution="Free license (Modern King James Version, 1999)",
            display_label="MKJV",
        ),
        TranslationSpec(
            name="Literal Translation of the Holy Bible",
            source="local",
            source_id=None,
            attribution="Free license (Literal Translation of the Holy Bible, 2001)",
            display_label="LITV",
        ),
        TranslationSpec(
            name="Jubilee Bible 2000",
            source="local",
            source_id=None,
            attribution="Free license (Jubilee Bible 2000)",
            display_label="JUB",
        ),
        TranslationSpec(
            name="Updated King James Version",
            source="local",
            source_id=None,
            attribution="Free license (Updated King James Version, 2000)",
            display_label="UKJV",
        ),
        TranslationSpec(
            name="A Conservative Version",
            source="local",
            source_id=None,
            attribution="Free license (A Conservative Version, 2003)",
            display_label="ACV",
        ),
        TranslationSpec(
            name="Restored Name King James Version",
            source="local",
            source_id=None,
            attribution="Free license (Restored Name KJV, 2003)",
            display_label="RNKJV",
        ),
        TranslationSpec(
            name="Revised Literal Translation",
            source="local",
            source_id=None,
            attribution="Free license (Revised Literal Translation, 2008)",
            display_label="RLT",
        ),
        TranslationSpec(
            name="Revised Webster's Bible",
            source="local",
            source_id=None,
            attribution="Public Domain (Revised Webster's Bible, 1833 base)",
            display_label="RWebster",
        ),
        TranslationSpec(
            name="Bible in Basic English",
            source="local",
            source_id=None,
            attribution="Public Domain in the US (Bible in Basic English, 1949)",
            display_label="BBE",
        ),
        TranslationSpec(
            name="Anderson's New Testament",
            source="local",
            source_id=None,
            attribution="Public Domain (Anderson's New Testament, 1866) — NT only",
            display_label="Anderson",
        ),
        TranslationSpec(
            name="Noyes' New Testament",
            source="local",
            source_id=None,
            attribution="Public Domain (Noyes' New Testament, 1869) — NT only",
            display_label="Noyes",
        ),
        TranslationSpec(
            name="Haweis' New Testament",
            source="local",
            source_id=None,
            attribution="Public Domain (Haweis' New Testament, 1795) — NT only",
            display_label="Haweis",
        ),
        TranslationSpec(
            name="Twentieth Century New Testament",
            source="local",
            source_id=None,
            attribution="Public Domain (Twentieth Century NT, 1904) — NT only",
            display_label="20thC NT",
        ),
        TranslationSpec(
            name="Septuagint (LXX)",
            source="local",
            source_id=None,
            attribution="Public Domain (Septuagint — Rahlfs edition, pre-1928)",
            display_label="LXX",
        ),
        # --------- API.Bible-aggregated translations ----------
        # Bible IDs fetched from the API.Bible dashboard.
        # NKJV and NIV confirmed on Starter Plan ($0/mo, 5K calls).
        TranslationSpec(
            name="New King James Version",
            source="api_bible",
            source_id="63097d2a0a2f7db3-01",
            attribution=(
                "New King James Version®, Copyright© 1982, Thomas Nelson. "
                "All rights reserved."
            ),
            display_label="NKJV",
            enabled=True,
        ),
        TranslationSpec(
            name="New International Version",
            source="api_bible",
            source_id="78a9f6124f344018-01",
            attribution=(
                "THE HOLY BIBLE, NEW INTERNATIONAL VERSION®, NIV® "
                "Copyright © 1973, 1978, 1984, 2011 by Biblica, Inc.® "
                "Used by permission. All rights reserved worldwide."
            ),
            display_label="NIV",
            enabled=True,
        ),
    ]
}


def get(name: str) -> Optional[TranslationSpec]:
    return _REGISTRY.get(name)


def all_specs() -> list[TranslationSpec]:
    return list(_REGISTRY.values())


def enabled_specs() -> list[TranslationSpec]:
    return [s for s in _REGISTRY.values() if s.enabled]


def is_remote(name: str) -> bool:
    """Does fetching this translation require a network round-trip?"""
    spec = get(name)
    return spec is not None and spec.source != "local"
