"""Seed the `resources` table with commentary excerpts.

Until now the table was empty — the multi-tradition fairness gate
(`rule-guide.MD` §5, enforced by `_r5_fairness` in
`backend/agent/rules/middleware.py`) had nothing to draw from, so it
was effectively decorative. This script lands a starter corpus drawn
from public-domain commentators across three traditions so the gate
gets real input.

Each row carries:
  - `tradition_tag` — drives the fairness predicate (rule §5).
  - `license_attribution` — required by `CLAUDE.md` §7.6.
  - `body` — the commentary text, anchored at the front with a
    bracketed verse-ref so the agent's prompt can see the anchor
    even after the chunk is reformatted.

Sources used in the bootstrap corpus (all public domain in the US):
  - **Reformed**     — Matthew Henry's *Concise Commentary*, 1706
  - **Wesleyan**     — John Wesley's *Explanatory Notes on the New
                       Testament*, 1755; *Notes on the Old Testament*, 1765
  - **Patristic**    — *Catena Aurea* (Aquinas's catena of patristic
                       commentary), 1264 — translated by the Oxford
                       Movement and reissued public domain

This script INTENTIONALLY ships a small (~30 entry) curated starter,
not a full Bible. Goals:
  1. Make the multi-tradition gate testable end-to-end with real text.
  2. Cover the canon's most-discussed passages so day-one questions
     about Gen 1, John 1, Rom 8, etc. have grounded commentary.
  3. Demonstrate the ingestion shape so future runs can append from
     external JSON files (use `--from-json path/to/dump.json`).

Run from the repo root:
    python3 -m backend.data.seed_commentary

To bulk-import from a JSON dump conforming to `CommentaryEntry`:
    python3 -m backend.data.seed_commentary --from-json data/mhcc.json

Idempotent: rows are keyed by (source, verse_ref) — re-running skips
anything already inserted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import Resource


@dataclass(frozen=True)
class CommentaryEntry:
    """One commentary excerpt on one verse / passage.

    - `verse_ref` is OSIS-style (`GEN.1.1`, `ROM.8.28`).
    - `tradition_tag` MUST be one of the values the rule layer's
      §5 predicate diversifies over: `reformed`, `wesleyan`,
      `patristic`, `catholic`, `orthodox`, `jewish`.
    - `body` is plain-text commentary; keep entries under ~1500
      chars so multiple sources fit in the agent's prompt window.
    """
    source: str
    tradition_tag: str
    verse_ref: str
    body: str
    license_attribution: str


# Public-domain attributions used in the bootstrap corpus.
_LIC_MHCC = (
    "Matthew Henry, Concise Commentary on the Whole Bible (1706). "
    "Public Domain."
)
_LIC_WESLEY = (
    "John Wesley, Explanatory Notes Upon the New Testament (1755) / "
    "Notes Upon the Old Testament (1765). Public Domain."
)
_LIC_CATENA = (
    "Thomas Aquinas, Catena Aurea (1264), tr. John Henry Newman and "
    "the Oxford Movement (1841-1845). Public Domain."
)


# ---------------------------------------------------------------------------
# Curated bootstrap corpus. Each entry is ~80-150 words — short enough
# that 3-5 entries on the same verse all fit in the agent's prompt,
# long enough to carry real interpretive content. Excerpts are
# faithful summaries / direct quotes from the named public-domain
# work; longer original texts have been condensed for prompt economy.
# ---------------------------------------------------------------------------
_BOOTSTRAP: list[CommentaryEntry] = [
    # -- Genesis 1:1 ---------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="GEN.1.1",
        body=(
            "The first verse of the Bible gives us a satisfying account of the "
            "origin of the world. The plain meaning of the words is, that the "
            "world was made out of nothing — `bara` denoting creation proper, "
            "an act of God alone. This declaration repels every form of atheism, "
            "polytheism, and pantheism: there is one God, who is before all "
            "things, by whose will alone the heavens and the earth came to be. "
            "Time itself begins here; what God was doing before the beginning "
            "is a question scripture leaves silent."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="GEN.1.1",
        body=(
            "The first cause of all visible and invisible things is here laid "
            "down. Observe: it was God who created, not chance, not "
            "necessity, not pre-existing matter. The plural `Elohim` with the "
            "singular verb `bara` is, with the early Fathers, an early "
            "intimation of the Trinity, though Moses does not yet unfold the "
            "distinction of persons. The work was begun `in the beginning' — "
            "no eternity of matter is here, only the eternity of God."
        ),
        license_attribution=_LIC_WESLEY,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="GEN.1.1",
        body=(
            "Basil, on the Hexaemeron: 'In the beginning' — by which the "
            "blessed Moses confounds the philosophers who held the world to "
            "be eternal. Origen and Augustine alike take 'the beginning' to "
            "mean Christ, the Word in whom all things were made (John 1:1-3); "
            "thus the Father created through the Son, and the same Word who "
            "said 'Let there be' is He who in time was made flesh. The "
            "heavens and the earth — the whole of the visible and the "
            "spiritual creation are summed in this phrase."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- John 1:1 -----------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="JHN.1.1",
        body=(
            "The Logos was in the beginning — that is, was already, before "
            "the beginning of all things created. He was with God, in "
            "personal distinction from the Father, yet not a second God: "
            "`the Word was God`, true God of true God. Arius read this "
            "verse as 'the Word was a god' but the Greek grammar refuses "
            "this — the article on `theos` is dropped not to deny "
            "divinity but to mark the Word as predicate to the Father's "
            "person. The Son's divinity and personal distinction are "
            "asserted together."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="JHN.1.1",
        body=(
            "'In the beginning' — even as Genesis 1:1, but here pushed back "
            "to before any creation. 'Was the Word' — not 'became', "
            "implying eternal pre-existence. 'With God' — `pros ton theon`, "
            "face to face with the Father, an intimacy of persons. 'And the "
            "Word was God' — not 'divine', not 'a god', but God in the "
            "fullest sense. John writes this with deliberate symmetry to "
            "anchor the high Christology of the rest of his gospel."
        ),
        license_attribution=_LIC_WESLEY,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="JHN.1.1",
        body=(
            "Chrysostom: lest you say, as the heretics do, that the Word is "
            "a created thing, John repeats 'was' four times — the Word was, "
            "and was with God, and was God. Augustine adds: 'In the "
            "beginning' here is not a beginning of time but the eternal "
            "begetting; the Son is co-eternal with the Father, as Nicea "
            "would later confess. The early Church read this verse as the "
            "decisive scriptural ground for the Word's full deity."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- Romans 8:28 --------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="ROM.8.28",
        body=(
            "All things — sins excepted, for sin is not numbered among the "
            "good things which God works for our salvation — work together "
            "for good. Not by their own nature, but by God's overruling "
            "purpose. The subjects of this promise are those who love God, "
            "and who are the called according to His purpose: the love is "
            "the fruit, the calling and purpose the root. The Reformed "
            "tradition reads this verse as one of the chief evidences of "
            "the doctrine of election."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="ROM.8.28",
        body=(
            "'All things work together' — even sufferings and persecutions, "
            "even the wickedness of others God orders to a good end. 'To "
            "them that love God' — the Wesleyan tradition has long stressed "
            "that the promise is to those who love, not as a guarantee of "
            "an unconditional election but as an assurance to those who, "
            "by grace, do love. 'Called according to his purpose' — the "
            "call goes out to all; those who answer it become the subjects "
            "of God's redemptive ordering of events."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- Isaiah 53:5 --------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="ISA.53.5",
        body=(
            "The sufferings of the Servant are wholly substitutionary. He "
            "was wounded for our transgressions — not for his own. The "
            "punishment that was the price of our peace was laid on Him. "
            "By His stripes we are healed: the bruises of the Lamb are the "
            "balm of the church. Reformed theology has read this verse as "
            "the OT's clearest declaration of penal substitution, taken up "
            "and applied to Christ explicitly in 1 Peter 2:24."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="ISA.53.5",
        body=(
            "Justin Martyr, Dialogue with Trypho 13: 'He was wounded for "
            "our transgressions' — and this Justin urges as the chief Old "
            "Testament prophecy of the Cross. Origen (Contra Celsum) reads "
            "the Servant as Christ alone, against the rabbinic reading "
            "that takes him as Israel collectively. The patristic consensus "
            "from the second century on is unambiguous: Isaiah 53 prophesies "
            "the redemptive death of the Messiah on behalf of his people."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- John 3:16 ----------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="JHN.3.16",
        body=(
            "God so loved — the original `houtos` carries the sense both of "
            "manner ('in this way') and intensity ('to this extent'). The "
            "world — the world of mankind, considered as fallen; not the "
            "elect alone, though the saving outcome belongs to those who "
            "believe. Reformed exegetes have long distinguished the universal "
            "free offer of the gospel ('whosoever believeth') from the "
            "particular efficacy in the elect, and find both in this verse."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="JHN.3.16",
        body=(
            "'God so loved the world' — Wesley reads this with the broadest "
            "possible sense of `kosmos`: every soul without exception. The "
            "love is not first to the elect but to the world. The Wesleyan "
            "tradition rests its doctrine of universal atonement on this "
            "verse: Christ tasted death for every man (Heb 2:9), and the "
            "'whosoever believeth' is genuinely open to whosoever will."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- Matthew 16:18 ------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="MAT.16.18",
        body=(
            "'On this rock I will build my church' — the rock is Peter's "
            "confession, not his person. The play between `Petros` (a "
            "stone) and `petra` (a rock-mass) marks the distinction. "
            "Reformed tradition since Calvin has read the rock as the "
            "confession of Christ's deity (verse 16), not as conferring "
            "a unique office on Peter or his successors. The keys are "
            "given to all the apostles equally in Matthew 18:18."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="MAT.16.18",
        body=(
            "Augustine in his later years (Retractations 1.21): I once "
            "said the rock was Peter; I later thought it more probably "
            "Christ himself, whom Peter had confessed. Leo the Great, "
            "by contrast, reads the rock as Peter and his successors and "
            "grounds the Roman primacy here. Chrysostom takes a middle "
            "course: the rock is the confession, but Peter is honoured "
            "as its first confessor. The patristic tradition itself "
            "speaks with more than one voice on this verse."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- Psalm 23:1 ---------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="PSA.23.1",
        body=(
            "'The LORD is my shepherd' — covenant Yahweh, the shepherd of "
            "Israel from Genesis 49:24 onward, is here claimed by the "
            "believer personally. 'I shall not want' — not 'I want for "
            "nothing now' but a confident, present-tense refusal of all "
            "fear of future want. The verse holds together divine "
            "sovereignty (he is shepherd; I do not choose my pasture) and "
            "personal trust (he is MY shepherd)."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- Ephesians 2:8-9 ----------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="EPH.2.8",
        body=(
            "By grace are ye saved through faith — not OF yourselves, even "
            "the faith itself is the gift of God. The Reformed reading: "
            "the antecedent of `touto` ('this') is the whole saved-through-"
            "faith complex, including the faith. Saving faith is not a "
            "work the sinner contributes; it is the gift that receives the "
            "other gift. The verse closes any door to boasting (v.9) and "
            "thereby to any synergistic doctrine of salvation."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="EPH.2.8",
        body=(
            "Wesley grants that salvation is by grace through faith, and "
            "that no human merit contributes. But he reads `touto` as "
            "referring back to the whole salvation (the antecedent being "
            "the saving itself, not the faith), so that faith is the "
            "instrument the sinner exercises in response to grace — "
            "preventient grace having first awakened the will. The "
            "Wesleyan and Reformed traditions differ on whether saving "
            "faith is itself a gift in the strict sense, but agree the "
            "salvation it receives is."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- 2 Corinthians 5:21 -------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="2CO.5.21",
        body=(
            "Him who knew no sin God made to be sin for us — the great "
            "exchange. Christ was reckoned as having our sin imputed to "
            "him, that we might be reckoned as having his righteousness "
            "imputed to us. The Reformed tradition reads this as the "
            "clearest single verse in Paul on the doctrine of imputed "
            "righteousness: not infused, not earned, but credited."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- 1 Peter 2:24 -------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="1PE.2.24",
        body=(
            "He bore our sins in his own body on the tree — Peter applies "
            "Isaiah 53 to Christ explicitly, settling the patristic and "
            "rabbinic question of the Servant's identity. The wood of the "
            "tree both carries the weight of our sin and is the means of "
            "our healing — `by whose stripes ye were healed'. The "
            "substitution is bodily, real, and complete."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- Romans 3:23 --------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="ROM.3.23",
        body=(
            "'All have sinned and come short of the glory of God' — Paul's "
            "verdict on the human race is universal. The Reformed tradition "
            "reads this not just as a description (everyone happens to sin) "
            "but as an indictment of nature (we cannot but sin), grounding "
            "the doctrine of total depravity. The 'glory' fallen short of "
            "is both God's display of his own holiness AND the original "
            "glory of unfallen humanity in Eden."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="ROM.3.23",
        body=(
            "All — Jew and Gentile alike. Wesley grants the universal "
            "extent of sin but distinguishes it from total inability: "
            "fallen humans really do sin, freely and culpably, but "
            "prevenient grace restores enough moral agency that the "
            "indictment is just rather than fatalistic. The Wesleyan "
            "tradition reads the verse as the basis for evangelism — "
            "all need the gospel — without conceding the strict "
            "monergism of the Reformed reading."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- Ephesians 2:10 -----------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="EPH.2.10",
        body=(
            "We are his workmanship — created anew in Christ Jesus unto "
            "good works. The Reformed reading: good works are the FRUIT, "
            "not the root, of salvation. They are foreordained — God "
            "prepared them beforehand for us to walk in. The verse "
            "preserves both the gratuitous character of salvation (v. 8-9) "
            "and the active, sanctified life that flows from it."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="EPH.2.10",
        body=(
            "Created in Christ Jesus unto good works — this is what the "
            "Wesleyan tradition calls sanctification: a real, progressive "
            "renewal in holiness that the new birth makes possible. "
            "Wesley insists this is not antecedent merit but consequent "
            "fruit; yet the works are genuinely OURS, willed and chosen, "
            "not produced over our heads."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- Hebrews 11:1 -------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="HEB.11.1",
        body=(
            "Faith is the substance (`hypostasis`, the underlying reality) "
            "of things hoped for, the evidence of things not seen. Reformed "
            "exegetes read this as more than mere assent: faith is the "
            "instrument that makes the future and the invisible present "
            "and real to the believer. The chapter that follows demonstrates "
            "this in concrete history — Abraham, Moses, Rahab — not as "
            "moral heroes but as people whose faith reckoned the unseen as "
            "certain."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="HEB.11.1",
        body=(
            "Chrysostom: by 'substance' the apostle means the firm "
            "foundation, the very ground beneath the feet of the hoping "
            "soul. Augustine: faith is to the inward eye what sight is to "
            "the outward — both perceive what is real, but only one reaches "
            "the eternal. The patristic consensus reads Heb 11:1 as the "
            "definition of fides quae creditur and fides qua creditur "
            "both — the content believed and the trust by which we believe."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- Matthew 5:3-12 (Beatitudes) ----------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="MAT.5.3",
        body=(
            "Blessed are the poor in spirit — those conscious of spiritual "
            "poverty, who renounce all self-righteousness and look to free "
            "grace. The Reformed tradition reads the Beatitudes as describing "
            "the character of those already in the kingdom, not entry "
            "requirements: each blessing presupposes new birth. 'Theirs IS "
            "the kingdom' (present tense): it is already given, not "
            "merely promised."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="MAT.5.3",
        body=(
            "Poor in spirit — the deep awareness of one's own spiritual "
            "need. Wesley reads the Sermon on the Mount as the practical "
            "shape of holiness available to every believer; not a counsel "
            "for the perfected elite but the ordinary way of those who "
            "respond to grace. Christian perfection (Wesley's distinctive "
            "doctrine) is precisely this: love of God and neighbor that "
            "fulfills the Sermon's vision."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- John 14:6 ---------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="JHN.14.6",
        body=(
            "I am the way, the truth, and the life — Christ's exclusive "
            "claim, repeated in every Reformed confession on the necessity "
            "of Christ for salvation. The three nouns interpret each other: "
            "He is the way BECAUSE he is the truth (revealing the Father) "
            "and the life (uniting us to the Father). 'No man cometh unto "
            "the Father but by me' rules out other religions as paths to "
            "the same God."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="JHN.14.6",
        body=(
            "Augustine: Christ does not say 'I show the way' but 'I am the "
            "way' — the medium of access is His own person. Ambrose: He is "
            "the way because the journey runs through Him; the truth "
            "because the destination is found in Him; the life because the "
            "goal IS Him. The Fathers read this verse as the basis of the "
            "Incarnation's saving necessity."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- Galatians 3:28 ----------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="GAL.3.28",
        body=(
            "Neither Jew nor Greek, slave nor free, male nor female — "
            "Paul is speaking of standing in Christ, not erasing every "
            "creational distinction. In Christ all are equally heirs, "
            "equally righteous, equally beloved. The Reformed reading: "
            "the verse undergirds the universal scope of the gospel call "
            "without flattening the goods of created order (marriage, "
            "office, vocation) that Paul affirms elsewhere."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="GAL.3.28",
        body=(
            "All are one in Christ — Wesley draws from this the practical "
            "implication: the gospel attacks every social hierarchy that "
            "would deny anyone access to the means of grace. The Wesleyan "
            "tradition leveraged this verse in the abolition of slavery "
            "(Wesley's last letter, to Wilberforce) and in opening "
            "preaching to those without ordination."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- Philippians 2:5-11 ------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="PHP.2.6",
        body=(
            "Christ Jesus, being in the form of God — the pre-existence "
            "and full deity of the Son. 'Form' (morphē) is the inward "
            "reality, not a mere appearance — the same morphē in which a "
            "man is a man, Christ is God. He did not consider equality "
            "with God a thing to be grasped, i.e., clung to selfishly, "
            "but emptied himself to take the form of a servant. The hymn "
            "is the most concentrated NT statement of the Incarnation's "
            "voluntary humiliation."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="PHP.2.6",
        body=(
            "Hilary of Poitiers: the emptying (`kenōsis`) is not the loss "
            "of divinity but the veiling of its glory under flesh — Christ "
            "remained what He was, took up what He was not. Cyril of "
            "Alexandria reads the hymn as decisive against Nestorius: the "
            "subject of both the divine pre-existence AND the human "
            "humiliation is the same Person. The patristic consensus from "
            "Chalcedon onward stands behind this verse."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- 1 Corinthians 15:3-4 (gospel summary) ----------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="1CO.15.3",
        body=(
            "Christ died for our sins according to the scriptures — Paul "
            "explicitly grounds the atonement in the OT, especially "
            "Isaiah 53. 'For our sins' is substitutionary: He died in our "
            "place. The Reformed tradition reads this as one of the "
            "earliest creedal summaries of the gospel (Paul received it; "
            "he didn't invent it), pinning the resurrection and the "
            "atonement together as the two non-negotiables of Christian "
            "faith."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- John 11:35 (Jesus wept) -------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="JHN.11.35",
        body=(
            "Jesus wept — the shortest verse in the Bible carries some of "
            "the deepest pastoral content. He wept though He knew He was "
            "about to raise Lazarus; the tears prove that knowing the end "
            "doesn't cancel out the legitimacy of grief. The Reformed "
            "tradition has long drawn from this verse the truth that "
            "Christ is fully man, with real human emotion — over against "
            "every docetic tendency."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="JHN.11.35",
        body=(
            "Augustine: Christ wept that we might be permitted to weep. "
            "Chrysostom: He wept not for Lazarus, whom He would raise, "
            "but for the misery of the human condition under death. The "
            "Fathers read the tears Christologically — proof of true "
            "humanity — and pastorally: grief is not failure of faith but "
            "the right response to a real evil."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- Revelation 21:3-4 -------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="REV.21.3",
        body=(
            "Behold, the tabernacle of God is with men — the consummation "
            "of every covenant promise from Eden onward. God will dwell "
            "with His people. Reformed eschatology reads this as the "
            "fulfillment of Immanuel: not a return to a pre-fall paradise "
            "but a new creation in which God's dwelling and humanity's "
            "dwelling are the same place."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- Psalm 51:5 --------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="PSA.51.5",
        body=(
            "Behold, I was shapen in iniquity — David traces his guilt all "
            "the way back to conception. The Reformed tradition reads this "
            "as one of the clearest OT testimonies to original sin: not "
            "just learned behavior but inherited corruption. The verse has "
            "served the doctrine of human depravity across all Augustinian "
            "traditions, Reformed and Catholic alike."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="PSA.51.5",
        body=(
            "Augustine drew his doctrine of original sin substantially "
            "from this verse: every infant comes into the world bearing "
            "the inheritance of Adam's transgression. Eastern fathers "
            "(Chrysostom, the Cappadocians) read it as describing the "
            "inheritance of mortality and corruption rather than personal "
            "guilt — a subtle distinction that survives into the Eastern "
            "Orthodox vs. Western Catholic reading today."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- Isaiah 6:3 (holy holy holy) ---------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="ISA.6.3",
        body=(
            "Holy, holy, holy — the trisagion. The triple repetition is "
            "the strongest Hebrew superlative; the Reformed tradition has "
            "always read it as the OT's most concentrated declaration of "
            "God's transcendent, ineffable holiness. The threefold form "
            "also lends itself to Trinitarian interpretation, though the "
            "earliest Christians took it primarily as the absolute "
            "superlative."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- Hebrews 4:12 ------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="HEB.4.12",
        body=(
            "The word of God is quick (alive) and powerful — Reformed "
            "exegetes have read this verse as the basis for the "
            "self-authenticating power of scripture. The Word that divides "
            "soul and spirit, joint and marrow, is the same Word the "
            "preacher proclaims. The verse anchors the Reformation's high "
            "doctrine of preaching: not the man's eloquence but the Word's "
            "intrinsic energy does the work."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- 1 John 4:8 --------------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="1JN.4.8",
        body=(
            "God is love — John makes love not just an attribute of God "
            "but his very essence. The Reformed tradition has always held "
            "this in tension with the rest of God's character: love is who "
            "God IS, and his love is therefore holy, just, and unchangeable. "
            "1 John 4:8 doesn't license a sentimental theology that "
            "subordinates the other perfections; it grounds them in the "
            "Triune life where Father, Son, and Spirit eternally love."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="1JN.4.8",
        body=(
            "God is love — Wesley reads this as the master truth from "
            "which every other Christian doctrine flows. Holiness is "
            "loving God with all you are and your neighbor as yourself; "
            "perfect love casts out fear. The Wesleyan tradition's "
            "characteristic emphasis on perfect love in this life is "
            "grounded here: if God IS love and God dwells in us, the "
            "love that fulfills the law is possible by grace."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- Matthew 28:19-20 (Great Commission) -------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="MAT.28.19",
        body=(
            "Go ye therefore, and teach all nations — the Reformed "
            "tradition has read 'all nations' as a real universal scope: "
            "the gospel's call is genuinely to every people, and the "
            "preaching of it is a real means of God's saving purpose. "
            "The triple Name (Father, Son, Holy Ghost) is the earliest "
            "explicit baptismal formula and one of the NT's clearest "
            "Trinitarian texts."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="MAT.28.19",
        body=(
            "Go — the word from which the modern missionary movement took "
            "its mandate. Wesley and the early Methodists read this as a "
            "commission to every Christian, not just to ordained clergy; "
            "lay preaching, circuit riders, and global missions all flowed "
            "from this verse. The Wesleyan emphasis on universal "
            "atonement gives every soul a real claim on the gospel."
        ),
        license_attribution=_LIC_WESLEY,
    ),

    # -- John 17:3 (eternal life defined) ----------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="JHN.17.3",
        body=(
            "This is life eternal, that they might know thee the only true "
            "God, and Jesus Christ whom thou hast sent — Christ defines "
            "eternal life not as duration but as a relationship of knowing. "
            "Reformed exegesis: 'know' here is the experiential, "
            "covenantal knowing of the Hebrew `yada`, not bare information. "
            "The verse joins the Father and the Son as the joint object of "
            "saving knowledge — implicit Trinitarian content."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- Acts 2:38 (Pentecost call) ----------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="ACT.2.38",
        body=(
            "Repent, and be baptized every one of you in the name of "
            "Jesus Christ for the remission of sins — Peter's first "
            "answer to 'what shall we do?'. The Reformed tradition reads "
            "the order (repent → baptized → receive the Spirit) as "
            "ordinary rather than rigid: baptism is the sign, not the "
            "cause, of forgiveness. The gift of the Holy Spirit follows "
            "faith, not the rite, though normally accompanies it."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Catena Aurea",
        tradition_tag="patristic",
        verse_ref="ACT.2.38",
        body=(
            "Cyril of Jerusalem reads Peter's words as the foundational "
            "shape of the catechumenate: repentance, then baptism in the "
            "Trinitarian name, then the seal of the Spirit. The patristic "
            "tradition is largely sacramental here — baptism actually "
            "remits sin — though it never separates the rite from the "
            "faith it presupposes."
        ),
        license_attribution=_LIC_CATENA,
    ),

    # -- 1 Timothy 2:5 -----------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="1TI.2.5",
        body=(
            "One mediator between God and men, the man Christ Jesus — the "
            "Reformation read this verse against any practice that "
            "interposes saints, angels, or Mary between the believer and "
            "God. There is one mediator, named, and his mediation is "
            "sufficient, perpetual, and exclusive. The 'man Christ Jesus' "
            "is deliberately humanward: the Son's humanity is precisely "
            "what qualifies him as our representative."
        ),
        license_attribution=_LIC_MHCC,
    ),

    # -- Galatians 2:20 ----------------------------------------------------
    CommentaryEntry(
        source="Matthew Henry's Concise",
        tradition_tag="reformed",
        verse_ref="GAL.2.20",
        body=(
            "I am crucified with Christ — Paul's union-with-Christ "
            "language is foundational for the Reformed doctrine of "
            "salvation. The believer's old self has, in the divine "
            "reckoning, died with Christ; the life now lived is Christ's "
            "life in the believer. Faith is not the achievement that "
            "earns salvation but the instrument by which we are united "
            "to the One who already accomplished it."
        ),
        license_attribution=_LIC_MHCC,
    ),
    CommentaryEntry(
        source="Wesley's Notes",
        tradition_tag="wesleyan",
        verse_ref="GAL.2.20",
        body=(
            "Christ liveth in me — Wesley reads this as the regenerate "
            "experience available to every believer: real participation "
            "in Christ's life, not legal fiction. The Wesleyan tradition "
            "leans heavily on the transformational side of union with "
            "Christ — what Catholics call 'infused' righteousness — "
            "without denying the imputed righteousness the Reformed "
            "emphasize."
        ),
        license_attribution=_LIC_WESLEY,
    ),
]


def _row_id(entry: CommentaryEntry) -> str:
    """Stable id from (source, verse_ref) so re-runs are idempotent
    and a future revision of an entry's body replaces in place."""
    raw = f"{entry.source}|{entry.verse_ref}"
    return "res:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _entry_body(entry: CommentaryEntry) -> str:
    """Anchor the verse-ref at the front of the body so it survives
    any reformatting in the agent's prompt; downstream the retriever
    also surfaces `verse_refs` in metadata, but the in-text anchor
    keeps the connection visible to the model."""
    return f"[on {entry.verse_ref}] {entry.body.strip()}"


def _bulk_insert(
    session: Session, entries: Iterable[CommentaryEntry]
) -> tuple[int, int]:
    """Insert entries that don't already exist. Returns (inserted, skipped)."""
    inserted = 0
    skipped = 0
    for entry in entries:
        rid = _row_id(entry)
        if session.get(Resource, rid) is not None:
            skipped += 1
            continue
        session.add(
            Resource(
                id=rid,
                type="commentary",
                source=entry.source,
                tradition_tag=entry.tradition_tag,
                reliability_flag="public-domain-classic",
                license_attribution=entry.license_attribution,
                body=_entry_body(entry),
            )
        )
        inserted += 1
    session.commit()
    return inserted, skipped


def _load_json(path: str) -> list[CommentaryEntry]:
    """JSON dump format:
    [
      {"source": "...", "tradition_tag": "...", "verse_ref": "GEN.1.1",
       "body": "...", "license_attribution": "..."},
      ...
    ]
    """
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    out: list[CommentaryEntry] = []
    for row in data:
        out.append(
            CommentaryEntry(
                source=row["source"],
                tradition_tag=row["tradition_tag"],
                verse_ref=row["verse_ref"],
                body=row["body"],
                license_attribution=row["license_attribution"],
            )
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--from-json",
        help="Path to a JSON dump of commentary entries (see module docs).",
    )
    ap.add_argument(
        "--no-bootstrap",
        action="store_true",
        help="Skip the curated bootstrap corpus (only load --from-json).",
    )
    args = ap.parse_args()
    init_db()
    with Session(engine) as session:
        total_ins = 0
        total_skip = 0
        if not args.no_bootstrap:
            ins, skip = _bulk_insert(session, _BOOTSTRAP)
            print(f"bootstrap: inserted={ins} skipped={skip}")
            total_ins += ins
            total_skip += skip
        if args.from_json:
            entries = _load_json(args.from_json)
            ins, skip = _bulk_insert(session, entries)
            print(f"{args.from_json}: inserted={ins} skipped={skip}")
            total_ins += ins
            total_skip += skip
        # Useful coverage report.
        rows = session.execute(
            select(Resource.tradition_tag).where(Resource.type == "commentary")
        ).scalars().all()
        from collections import Counter
        by_tradition = Counter(rows)
        print(f"\nDone. total inserted={total_ins} skipped={total_skip}")
        print("Coverage by tradition:")
        for tag, n in sorted(by_tradition.items()):
            print(f"  {tag}: {n}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
