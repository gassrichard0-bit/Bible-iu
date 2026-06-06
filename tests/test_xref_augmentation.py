"""Post-hoc cross-reference augmentation.

When the model name-drops a verse in prose without explicitly citing
the matching SOURCES short id, the parser walks the claim text, finds
the OSIS/human verse refs, and attaches the retrieved chunk's
citation_id. The user sees the xref in the Sources panel as a result.
"""
from __future__ import annotations

from backend.agent.reasoning.types import RetrievedChunk
from backend.agent.skills.deepseek_backends import (
    _match_verse_refs_in_text,
    _parse_generator_json,
)


def test_human_form_refs_found():
    found = _match_verse_refs_in_text(
        "See Gen 18:11, Genesis 24:1, and 1 Kings 1:1 for parallels."
    )
    assert "GEN.18.11" in found
    assert "GEN.24.1" in found
    assert "1KI.1.1" in found


def test_osis_form_refs_found():
    found = _match_verse_refs_in_text("Cross-refs: GEN.18.11 and LUK.1.7.")
    assert found == {"GEN.18.11", "LUK.1.7"}


def test_misc_book_aliases():
    found = _match_verse_refs_in_text("Cf. Jn 3:16, Ps 23:1, Mt 5:3.")
    assert "JHN.3.16" in found
    assert "PSA.23.1" in found
    assert "MAT.5.3" in found


def _chunk(verse_id: str, text: str = "...") -> RetrievedChunk:
    return RetrievedChunk(
        citation_id=f"trans:KJV:{verse_id}",
        text=text,
        source_kind="translation",
        verse_refs=[verse_id],
        license="Public Domain (KJV)",
    )


def test_parser_attaches_xref_citations_to_mentioning_claims():
    # Model emits a claim mentioning GEN.18.11 by name but only cites
    # the focused verse (S1=1KI.1.1). The retrieval has the xref too.
    raw_json = """
    {
      "reasoning": "thinking",
      "answer": "David was old, like Abraham (Gen 18:11) and Joshua (Josh 23:1).",
      "claims": [
        { "text": "David was old in his last days, echoing Gen 18:11 and Josh 23:1.", "cited_ids": ["S1"] }
      ],
      "note_to_append": null
    }
    """
    retrieval = [
        _chunk("1KI.1.1", "David was old..."),
        _chunk("GEN.18.11", "Abraham and Sarah were old..."),
        _chunk("JOS.23.1", "Joshua waxed old..."),
        _chunk("LUK.1.7", "Zechariah and Elisabeth were stricken..."),  # not mentioned
    ]
    short_to_real = {"S1": "trans:KJV:1KI.1.1"}
    _, _, statements, _ = _parse_generator_json(raw_json, short_to_real, retrieval)
    assert len(statements) == 1
    cids = statements[0].cited_ids
    # Original explicit citation still there.
    assert "trans:KJV:1KI.1.1" in cids
    # Both mentioned xrefs picked up.
    assert "trans:KJV:GEN.18.11" in cids
    assert "trans:KJV:JOS.23.1" in cids
    # Verses NOT named in the claim text stay out.
    assert "trans:KJV:LUK.1.7" not in cids


def test_parser_doesnt_duplicate_already_cited():
    # Model already cited GEN.18.11 explicitly via S2 — the augmenter
    # must NOT add it a second time.
    raw_json = """
    {
      "reasoning": "x",
      "answer": "Gen 18:11 parallels this.",
      "claims": [
        { "text": "Echoes Gen 18:11.", "cited_ids": ["S1", "S2"] }
      ],
      "note_to_append": null
    }
    """
    retrieval = [_chunk("1KI.1.1"), _chunk("GEN.18.11")]
    short_to_real = {
        "S1": "trans:KJV:1KI.1.1",
        "S2": "trans:KJV:GEN.18.11",
    }
    _, _, statements, _ = _parse_generator_json(raw_json, short_to_real, retrieval)
    assert statements[0].cited_ids.count("trans:KJV:GEN.18.11") == 1


def test_parser_skips_refs_we_didnt_retrieve():
    # Model mentions GEN.18.11 but it wasn't in the retrieval — leave
    # the claim alone (don't fabricate a citation_id).
    raw_json = """
    {
      "reasoning": "x",
      "answer": "Gen 18:11 echoes this.",
      "claims": [
        { "text": "Echoes Gen 18:11.", "cited_ids": ["S1"] }
      ],
      "note_to_append": null
    }
    """
    retrieval = [_chunk("1KI.1.1")]  # no GEN.18.11
    short_to_real = {"S1": "trans:KJV:1KI.1.1"}
    _, _, statements, _ = _parse_generator_json(raw_json, short_to_real, retrieval)
    assert statements[0].cited_ids == ["trans:KJV:1KI.1.1"]
