# AI Bible Study Platform

A social Bible-study platform with an AI reasoning agent. At the top level it feels like a
messaging app — groups and direct conversations. Open a room and you enter a VS Code-style
study workspace built around scripture: click a verse and an AI agent reasons over it,
showing its work with citations, treating the Bible as ground truth and commentary as a
flaggable reference.

> **Status:** specification stage. This repo currently contains the design docs; the build
> follows from them.

---

## What makes it different

- **Scripture as ground truth**, anchored to the original-language (Hebrew/Greek) text;
  translations and commentary are a reference layer, and divergence is shown, not hidden.
- **No deception by construction** — every factual claim is grounded and citation-verified
  before it reaches you (see `citation-engine.MD`).
- **Transparent reasoning** — the agent always shows how it reached an answer.
- **Rich, collaborative notes** bridged to verses, with private personal notes the agent
  can never see.
- **Local-first** — designed to run self-hosted and offline-capable.

---

## The documents

Read them in roughly this order:

| Doc | What it owns |
|-----|--------------|
| **`CLAUDE.md`** | Product spec + build entry point. Start here. |
| **`architecture.MD`** | Technical map — services, flows, how it all wires together. |
| **`data-model.MD`** | Canonical schema for every entity. |
| **`rule-guide.MD`** | Runtime **law** — what the agent must and must not do. Governs all. |
| **`soul.MD`** | The agent's **character & voice** (a humble study companion). |
| **`citation-engine.MD`** | The grounding/citation core that enforces "no deception." |
| **`notes-system.MD`** | The notes system and rich editor. |

**Precedence:** `rule-guide.MD` is law and overrides everything; `soul.MD` shapes tone
within that law; each doc above is canonical for its own domain — edit there, not in copies.

---

## Architecture at a glance

```
Client (social shell · chat · VS Code workspace · notes)
        │
API + Yjs sync
        │
Agent core (isolated reasoning)
        │
Citation engine → Rule enforcement     ← every output passes through
        │
Data stores (scripture · commentary · provenance · users)
        │
Sandbox workers (web search · media, rule-bounded)
```

Full version in `architecture.MD`.

---

## Tech stack (assumptions — swappable)

React + TypeScript + Vite (frontend) · FastAPI (backend) · local LLM via Ollama · Yjs/CRDT
for notes + sync · TipTap + tldraw for the editor · a vector store for retrieval. See
`CLAUDE.md` §8.

---

## Build order (when development starts)

1. **Rule enforcement + citation engine first** — the spine every agent output routes
   through (`rule-guide.MD`, `citation-engine.MD`).
2. The adversarial rule-guide eval suite (`CLAUDE.md` §12).
3. Scripture/sources layer, then the workspace, then notes, then social features.

---

## Open decisions before building

These gate the build and are tracked in `CLAUDE.md` §14:
- **Data + licenses** — finalize the original-language text, translations, and commentary
  set and their licenses.
- **Verifier model** — pick the local entailment model for the citation engine.
- **Auth** — choose the login method.

---

## Getting started

```bash
# frontend
cd frontend && npm install && npm run dev

# backend
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn api.main:app --reload

# local model
ollama pull <reasoning-model>
```

Detailed setup in `CLAUDE.md` §11.
