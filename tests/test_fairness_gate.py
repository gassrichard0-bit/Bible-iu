"""Regression tests for the multi-tradition fairness predicate
(`rule-guide.MD` §5.2; implemented in
`backend/agent/rules/middleware.py:_r5_multi_tradition`).

The gate's purpose: when commentary is invoked, force the model to
surface disagreement instead of flattening it to one tradition's
voice. This batch of tests pins down two scenarios:

  1. **Single-tradition commentary + other traditions available** —
     must REVISE. This is the exact failure mode the seeded
     commentary corpus is meant to make detectable: if Reformed is
     cited alone while Wesleyan / Patristic were retrieved, that's
     a fairness violation.

  2. **Multi-tradition commentary cited** — must PASS. No revision
     forced when the model already represents disagreement.

Before this session the gate was effectively decorative because
`resources` had zero rows. Now we have 19 entries across three
traditions (see `backend/data/seed_commentary.py`), so end-to-end
fairness behavior is testable.
"""
from __future__ import annotations

from backend.agent.rules import (
    AgentOutput,
    Citation,
    Claim,
    Decision,
    enforce,
)


def _commentary_claim(tradition: str, source_id: str = "res:fake") -> Claim:
    return Claim(
        text="John 1:1 declares the eternal pre-existence of the Word.",
        kind="commentary",
        citations=[
            Citation(
                source_id=source_id,
                verse_refs=["JHN.1.1"],
                tradition=tradition,
                verification_result="supported",
            )
        ],
    )


def _baseline_output(claims: list[Claim], available_traditions: list[str]) -> AgentOutput:
    return AgentOutput(
        reasoning="The Reformed reading of John 1:1 anchors the Logos's deity.",
        answer="John 1:1 anchors the Word's deity from before creation.",
        claims=claims,
        source_traditions=available_traditions,
    )


class TestFairnessGate:
    def test_single_tradition_when_others_available_revises(self) -> None:
        out = _baseline_output(
            claims=[_commentary_claim(tradition="reformed")],
            available_traditions=["reformed", "wesleyan", "patristic"],
        )
        result = enforce(out)
        # The middleware aggregates per-predicate verdicts; the
        # §5.2 violation should drive the final decision to REVISE
        # (or worse — REFUSE only happens on safety rules).
        assert result.decision == Decision.REVISE, (
            f"Expected REVISE for single-tradition commentary while "
            f"other traditions were available; got {result.decision.name}. "
            f"Reasons: {[v.reason for v in result.verdicts]}"
        )
        # And the specific reason on the §5.2 verdict should be the
        # fairness one — not some other unrelated revision driver.
        fairness_verdicts = [
            v for v in result.verdicts if v.rule == "rule-guide.MD §5.2"
        ]
        assert any(
            v.decision == Decision.REVISE for v in fairness_verdicts
        ), "Expected at least one §5.2 verdict to flag REVISE"

    def test_two_traditions_cited_passes(self) -> None:
        out = _baseline_output(
            claims=[
                _commentary_claim(tradition="reformed"),
                _commentary_claim(tradition="wesleyan", source_id="res:fake2"),
            ],
            available_traditions=["reformed", "wesleyan", "patristic"],
        )
        result = enforce(out)
        # When the agent already cites two traditions, the §5.2
        # predicate has nothing to flag — its verdict must be PASS.
        fairness_verdicts = [
            v for v in result.verdicts if v.rule == "rule-guide.MD §5.2"
        ]
        assert fairness_verdicts, "Expected a §5.2 verdict to be recorded"
        assert all(
            v.decision == Decision.PASS for v in fairness_verdicts
        ), (
            "Expected §5.2 to PASS when multiple traditions are cited; "
            f"got {[v.decision.name for v in fairness_verdicts]}"
        )

    def test_single_tradition_when_no_others_available_passes(self) -> None:
        # If only one tradition was *available* to the retriever then
        # citing only that one is not a fairness violation; it's the
        # only thing the model had. The §5.2 predicate should not
        # punish the model for the retriever's empty shelf.
        out = _baseline_output(
            claims=[_commentary_claim(tradition="reformed")],
            available_traditions=["reformed"],
        )
        result = enforce(out)
        fairness_verdicts = [
            v for v in result.verdicts if v.rule == "rule-guide.MD §5.2"
        ]
        assert fairness_verdicts, "Expected a §5.2 verdict to be recorded"
        assert all(
            v.decision == Decision.PASS for v in fairness_verdicts
        ), (
            "Expected §5.2 to PASS when only one tradition was available; "
            f"got {[v.decision.name for v in fairness_verdicts]}"
        )

    def test_no_commentary_claims_passes(self) -> None:
        # Scripture-only answers don't invoke the fairness gate.
        out = _baseline_output(
            claims=[
                Claim(
                    text="The Word was God.",
                    kind="scripture",
                    citations=[
                        Citation(
                            source_id="trans:KJV:JHN.1.1",
                            verse_refs=["JHN.1.1"],
                            verification_result="supported",
                        )
                    ],
                )
            ],
            available_traditions=["reformed", "wesleyan"],
        )
        result = enforce(out)
        fairness_verdicts = [
            v for v in result.verdicts if v.rule == "rule-guide.MD §5.2"
        ]
        assert all(
            v.decision == Decision.PASS for v in fairness_verdicts
        ), "Expected §5.2 to PASS when no commentary claims are present"
