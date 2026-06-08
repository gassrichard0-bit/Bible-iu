# citation-engine.MD

> Design note for the citation / grounding engine. Companion to `CLAUDE.md` (§5, §7.5, §14)
> and `rule-guide.MD` (§3–4). This is where **"every claim cited, no uncited claims, no
> deception"** is actually enforced — design and build it **before** the agent ships.

---

## 1. The hard problem

An LLM will (a) assert things from parametric memory with no source, and (b) fabricate
citations that look real but don't support the claim. "No deception" cannot rest on the
model's goodwill. This engine makes grounding and citation **mechanical and verified**, not
trust-based: a claim only reaches the user as *fact* if a retrieved source provably
supports it.

---

## 2. Principles

1. **Answer from retrieved sources, not memory.** The model is grounded on retrieved
   passages; ungrounded assertions are not presented as fact.
2. **Every factual claim is cited or marked as inference.** No middle ground.
3. **Citations are verified** to actually support the claim — fabricated or irrelevant
   citations are caught and removed.
4. **Scripture supremacy.** No surviving claim contradicts the original-language anchor
   (`rule-guide.MD` §2).
5. **Everything that survives is written to the provenance ledger** (`CLAUDE.md` §7.5).

---

## 3. Pipeline (ordered)

```
retrieve → generate (grounded) → parse claims+citations → classify
        → verify → gate (revise / mark inference / drop) → ledger + render
```

1. **Retrieve** the relevant sources for the verse/question (§7).
2. **Generate** a grounded answer with **inline citation markers** to source IDs, and the
   reasoning kept separate from the answer (`rule-guide.MD` §7).
3. **Parse** the output into discrete claims, each with its attached citation(s).
4. **Classify** each statement (§4).
5. **Verify** each cited factual claim against its source, plus a scripture-consistency
   check (§5).
6. **Gate**: nothing uncited or unsupported ships as fact (§6).
7. **Write** surviving claims to the provenance ledger and **render** with the Uncertainty
   UI tags (`CLAUDE.md` §4.7).

---

## 4. Statement classification

The engine must not demand citations for non-factual text, and must demand them for every
factual one:

- **Scripture statement** → cite verse(s) in the original-language anchor / translation.
- **Original-language claim** (lexical, morphological) → cite the lexicon / Strong's entry.
- **Commentary interpretation** → cite source + tradition + reliability tag.
- **Agent inference** → marked **inference**, presented as the agent's reasoning, *not*
  fact (Uncertainty UI).
- **Non-factual** (pastoral framing, transitions, questions) → no citation required.

---

## 5. Verification (the core step)

For each cited factual claim:

1. **Entailment check** — does the cited source text actually support the claim?
   (NLI-style: supported / unsupported / contradicted.) This is what kills fabricated or
   real-but-irrelevant citations.
2. **Scripture-consistency check** — the claim must not contradict the anchored text
   (`rule-guide.MD` §2). If it does, scripture wins and the conflict is surfaced.

**Verifier model:** keep it **separate from the generator** (a local NLI/entailment model,
or the LLM in a constrained verify-only mode). A separate pass is what makes verification
meaningful — the generator does not get to grade its own homework. `TODO(spec)`: pick the
local entailment model.

---

## 6. The gate (no uncited fact ships)

- **Uncited factual claim** → revise to add a supporting citation, **or** downgrade to
  marked inference, **or** drop.
- **Unsupported citation** (failed entailment) → same three options.
- **Contradicts scripture** → flag the conflict (`rule-guide.MD` §2, §4); scripture stands.
- **Revision loop** with a max retry count; if it still fails, **degrade gracefully**:
  present only the verified claims and mark the rest uncertain, or decline — never paper
  over the gap.

---

## 7. Retrieval design

- **Sources:** original-language anchor + translations + tradition-tagged commentary +
  cross-references.
- Each retrieved chunk carries a **stable citation ID** (verse ref, or source + locator)
  plus **tradition, reliability, and license** metadata.
- **Diversity requirement:** retrieve across traditions, not one school, so multi-tradition
  fairness (`rule-guide.MD` §5) holds at the source level — you cannot present balance you
  never retrieved.
- **Web results** (when used) enter through this same retrieval + verification path and are
  subject to the truth filter (`rule-guide.MD` §8).
- **Personal notes never enter retrieval context** (`rule-guide.MD` §12).

---

## 8. Outputs

- Each surviving claim writes a **Provenance** record: claim → verse refs + source refs +
  tradition/reliability + reasoning-step ref + verification result (`CLAUDE.md` §10).
- This drives the left-panel "resources used" view, the `citations[]` on the reasoning
  session, and the audit log.
- Reasoning and answer are rendered separately, with each claim tagged scripture /
  commentary / inference for the Uncertainty UI.

---

## 9. Failure modes it must catch

These map directly to the adversarial eval suite (`CLAUDE.md` §12):

- **True-but-unsourced memory claim** → gated (no source ⇒ not presented as fact).
- **Fabricated or real-but-irrelevant citation** → caught by the entailment verifier.
- **Single-tradition flattening** → prevented by retrieval diversity + fairness check.
- **Translation divergence asserted as one truth** → divergence surfaced (`CLAUDE.md` §7.2).
- **Prompt injection from a fetched page** → web content is data, never instructions
  (`rule-guide.MD` §8).

---

## 10. Build notes

- The engine sits **between the reasoning model and the response**; no agent skill output
  bypasses it **by default**.
- **One opt-in escape hatch.** A user-controlled toggle (Settings → Advanced → "Bypass
  citation engine") sets `ReasoningRequest.bypass_citation_engine=true` per request. When
  true, the orchestrator returns raw LLM output without classify/verify/gate. The toggle
  is off by default; the response carries `decision="bypassed"` so the UI can render an
  explicit "uncited / unverified" badge. The provenance ledger still records the turn
  (`verification_result="bypassed"`) so the audit trail survives. Any other bypass path
  is a violation (see `CLAUDE.md` §13).
- Verification is a distinct pass from generation — do not merge them.
- Keep it local-first where possible; document the entailment-model choice.
- Build it before the agent's user-facing skills (`CLAUDE.md` §13: rule layer + this engine
  come first).
