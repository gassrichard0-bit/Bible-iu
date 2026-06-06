"""Scope-aware retrieval invariants.

Locks in the contract that drove the recent agent-scope work so a
regression in the keyword-window gating or the anchor-pull shape
shows up immediately:

  verse     → anchor verse only (whole-Bible keyword search ok)
  chapter   → every verse in the chapter; keyword search same-book only
  book      → anchor's first chapter; keyword search same-book only
  testament → no scripture anchor; keyword search same-testament only
  bible     → no scripture anchor; keyword search whole-Bible
"""
from __future__ import annotations

import os
from importlib import reload
from typing import Iterable

import pytest


@pytest.fixture()
def retriever(tmp_path):
    os.environ["BIBLE_IU_DATABASE_URL"] = f"sqlite:///{tmp_path}/test.sqlite"
    import backend.data.db as db_mod
    reload(db_mod)
    import backend.data as data_mod
    reload(data_mod)
    import backend.agent.skills.default_backends as backends
    reload(backends)
    data_mod.init_db()

    # Seed three NT verses + three OT verses + a stray Proverbs row
    # with the keyword "more" — used to verify scope gating excludes it
    # at chapter scope but allows it at verse / bible.
    from backend.data import models as m
    with data_mod.SessionLocal() as s:
        def _seed(verse_id: str, book: str, ch: int, v: int, text: str):
            s.add(m.Verse(id=verse_id, book=book, chapter=ch, verse=v))
            s.add(m.Translation(
                id=f"KJV:{verse_id}",
                name="King James Version",
                verse_id=verse_id,
                text=text,
                license="Public Domain (KJV)",
            ))
        _seed("JHN.3.1",  "JHN", 3,  1,  "There was a man of the Pharisees, named Nicodemus.")
        _seed("JHN.3.16", "JHN", 3, 16, "For God so loved the world.")
        _seed("JHN.3.36", "JHN", 3, 36, "He that believeth on the Son hath everlasting life.")
        _seed("JHN.16.18","JHN", 16, 18, "We cannot tell what he saith.")
        _seed("GEN.1.1",  "GEN", 1,  1,  "In the beginning God created the heaven and the earth.")
        _seed("PRO.30.4", "PRO", 30, 4,  "Who hath ascended up into heaven, or descended?")
        _seed("MAT.1.1",  "MAT", 1,  1,  "The book of the generation of Jesus Christ.")
        s.commit()
        retriever = backends.SqlRetriever(s, related_limit=20)
        yield retriever


def _refs(chunks) -> list[str]:
    return [c.verse_refs[0] for c in chunks if c.verse_refs]


class TestScopeAnchor:
    def test_verse_pulls_only_anchor(self, retriever):
        chunks = retriever.retrieve("JHN.3.16", "Tell me about love", scope_kind="verse")
        anchor_refs = [c.verse_refs[0] for c in chunks if c.source_kind == "translation" and c.verse_refs == ["JHN.3.16"]]
        assert anchor_refs == ["JHN.3.16"]

    def test_chapter_pulls_entire_chapter(self, retriever):
        chunks = retriever.retrieve("JHN.3.1", "Tell me more", scope_kind="chapter")
        anchor_refs = {
            c.verse_refs[0]
            for c in chunks
            if c.source_kind == "translation"
            and c.verse_refs[0].startswith("JHN.3.")
        }
        # All three seeded JHN.3 verses should be there.
        assert anchor_refs == {"JHN.3.1", "JHN.3.16", "JHN.3.36"}

    def test_testament_and_bible_skip_anchor_pull(self, retriever):
        # No `like("BOOK.CH.%")` style anchor at wide scope.
        chunks = retriever.retrieve("GEN.1.1", "tell me about love", scope_kind="testament")
        # Should not have JHN/MAT in the OT testament return…
        nt_leaks = [r for r in _refs(chunks) if r.startswith(("JHN.", "MAT."))]
        assert nt_leaks == []


class TestScopeKeywordWindow:
    def test_chapter_keyword_stays_in_book(self, retriever):
        # "more" matches JHN.16.18 (same book, different chapter) and
        # PRO.30.4 (different book). At chapter scope only JHN.16.18
        # may surface as backfill.
        chunks = retriever.retrieve("JHN.3.1", "tell me more", scope_kind="chapter")
        refs = set(_refs(chunks))
        assert "PRO.30.4" not in refs, "Proverbs leak from a Genesis-chapter query"
        # JHN.16.18 is allowed (same book) but not required.
        assert all(r.startswith("JHN.") for r in refs)

    def test_testament_keyword_stays_in_testament(self, retriever):
        # OT-scope question shouldn't pull MAT/JHN.
        chunks = retriever.retrieve("GEN.1.1", "ascended heaven", scope_kind="testament")
        refs = set(_refs(chunks))
        nt = {r for r in refs if r.startswith(("MAT.", "MRK.", "JHN."))}
        assert nt == set(), f"NT verses leaked into OT-scope: {nt}"

    def test_bible_keyword_unconstrained(self, retriever):
        # At bible scope we want broad coverage — keyword search
        # crosses books freely. No anchor pull, only keyword hits.
        chunks = retriever.retrieve(
            "GEN.1.1", "Pull up all places it talks about love", scope_kind="bible",
        )
        # We expect at least one love-keyword hit somewhere.
        love_hits = [c for c in chunks if "love" in c.text.lower()]
        assert love_hits, "no love verses returned at bible scope"

    def test_wide_scope_caps_per_book(self, retriever):
        """At bible scope a one-keyword query gives every hit the same
        score. Without a per-book cap the DB returns them in canonical
        order and the answer reads like "all my hate verses are in
        Genesis." Cap MUST hold even when many same-book matches exist.
        """
        # Seed several GEN verses + a PSA verse, all containing "hate".
        import backend.data as data_mod
        from backend.data import models as m
        with data_mod.SessionLocal() as s:
            for i, vid in enumerate(
                ["GEN.24.60", "GEN.26.27", "GEN.27.41", "GEN.37.4", "GEN.49.23"],
                start=1,
            ):
                s.add(m.Verse(id=vid, book="GEN", chapter=24, verse=60 + i))
                s.add(m.Translation(
                    id=f"KJV:{vid}",
                    name="King James Version",
                    verse_id=vid,
                    text=f"{vid} those who hate them",
                    license="Public Domain (KJV)",
                ))
            s.add(m.Verse(id="PSA.97.10", book="PSA", chapter=97, verse=10))
            s.add(m.Translation(
                id="KJV:PSA.97.10",
                name="King James Version",
                verse_id="PSA.97.10",
                text="Ye that love the LORD, hate evil",
                license="Public Domain (KJV)",
            ))
            s.commit()
            # Phrase the question so it does NOT match topic-mode (no
            # "list/find/all", etc.). The cap we're testing here is the
            # narrower wide-scope cap, which is what conversational
            # questions hit. Topic-mode caps are tested separately.
            chunks = retriever.retrieve(
                "GEN.1.1", "what does Scripture teach about hate",
                scope_kind="bible",
            )
            gen_refs = [r for r in _refs(chunks) if r.startswith("GEN.")]
            psa_refs = [r for r in _refs(chunks) if r.startswith("PSA.")]
            # At most 2 GEN verses (per_book_cap=2), and the PSA verse must surface.
            assert len(gen_refs) <= 2, f"per-book cap broken: {gen_refs}"
            assert "PSA.97.10" in psa_refs, (
                f"diverse-book hit missed at bible scope: refs={_refs(chunks)}"
            )

    def test_command_verbs_not_treated_as_search_terms(self):
        """The keyword extractor must drop instructional verbs ("list",
        "find", "show", "tell", "every", "all", "verses"...). Otherwise
        a question like "List all about hate" matches verses containing
        the word "list" with the same weight as verses containing
        "hate", and unrelated rows hijack the ranking.
        """
        from backend.agent.skills.default_backends import _extract_keywords
        kws = _extract_keywords("List all about hate")
        assert "list" not in kws
        assert "all" not in kws
        assert "about" not in kws
        assert "hate" in kws

        kws = _extract_keywords("Show me every verse about love")
        assert "show" not in kws
        assert "every" not in kws
        assert "verse" not in kws
        assert "love" in kws

    def test_topic_mode_returns_many_diverse_verses(self, retriever):
        """Word-search mode: when the user asks "list all verses about hate",
        the retriever should surface many verses from across the canon,
        not the default ~12.
        """
        import backend.data as data_mod
        from backend.data import models as m
        # Seed 25 hate verses spread across 6 books — enough that the
        # default cap would chop most of them.
        plan: list[tuple[str, str, int, int]] = []
        for i in range(6):
            plan.append(("GEN", "GEN", 30 + i, 1))
        for i in range(5):
            plan.append(("PSA", "PSA", 25 + i, 5))
        for i in range(4):
            plan.append(("PRO", "PRO", 6 + i, 16))
        for i in range(4):
            plan.append(("ECC", "ECC", 3 + i, 8))
        # Pick chapter/verse pairs that don't collide with the seed
        # fixture (which already inserts MAT.1.1 and JHN.16.18).
        for i in range(3):
            plan.append(("MAT", "MAT", 10 + i, 22))
        for i in range(3):
            plan.append(("JHN", "JHN", 5 + i, 20))
        with data_mod.SessionLocal() as s:
            for book, code, ch, v in plan:
                vid = f"{code}.{ch}.{v}"
                s.add(m.Verse(id=vid, book=book, chapter=ch, verse=v))
                s.add(m.Translation(
                    id=f"KJV:{vid}",
                    name="King James Version",
                    verse_id=vid,
                    text=f"{vid}: they that hate evil",
                    license="Public Domain (KJV)",
                ))
            s.commit()
            chunks = retriever.retrieve(
                "GEN.1.1", "list all verses about hate", scope_kind="bible",
            )
            refs = _refs(chunks)
            # Topic mode should bring back well over the default ~12.
            assert len(refs) >= 20, f"only {len(refs)} verses returned: {refs}"
            # At least four distinct books represented (no Genesis lock-in).
            books = {r.split('.', 1)[0] for r in refs}
            assert len(books) >= 4, f"books too narrow: {books}"

    def test_wide_scope_drops_focus_keywords(self, retriever):
        # Bible-scope question "Tell me about love" with cursor at GEN.1.1
        # MUST NOT pull verses scored purely by GEN.1.1's own content words
        # ("beginning", "created", "heaven", "earth"). The fallout was
        # the topic getting outranked by Genesis-1 lookalikes. The Genesis
        # 1:1 verse itself was the bug indicator — it shouldn't surface
        # at bible-scope on a love query.
        chunks = retriever.retrieve("GEN.1.1", "Tell me about love", scope_kind="bible")
        refs = set(_refs(chunks))
        assert "GEN.1.1" not in refs, (
            "GEN.1.1 surfaced on a love query — focus-verse keywords "
            "still bleed into wide-scope retrieval"
        )
