# architecture.MD

> The canonical **technical map** of the system: services, how they wire together, what
> runs where, and how a request flows. Product behavior lives in `CLAUDE.md`; this file is
> the *how it's built* view. Where they overlap, this file is canonical for architecture.
>
> Companions: `rule-guide.MD` (law), `soul.MD` (character), `citation-engine.MD` (grounding),
> `notes-system.MD` (notes/editor), `data-model.MD` (schema).

---

## 1. Principles

- **Local-first.** Runs self-hosted/offline where possible; no hard cloud dependency.
- **Rule layer is non-bypassable.** Every agent output passes through rule enforcement and
  the citation engine before reaching a user.
- **Clear layer boundaries.** Frontend, backend agent, rule/citation layer, and sync are
  separable; the notes editor is a decoupled sidecar (`notes-system.MD` §3.3).
- **Auditable.** Every agent claim is grounded and written to the provenance ledger.

---

## 2. Layered view

```
┌──────────────────────────────────────────────────────────────┐
│  CLIENT (web / mobile)                                         │
│  Social shell · Group chat · VS Code study workspace           │
│  Notes sidebar (Yjs) · Login/account · Uncertainty UI · TTS    │
└───────────────┬───────────────────────────┬────────────────────┘
        REST / WebSocket                 Yjs sync channel
                │                           │
┌───────────────▼───────────────┐  ┌────────▼───────────────────┐
│  API LAYER (FastAPI)           │  │  SYNC SERVICE (Yjs/CRDT)    │
│  auth · rooms · chat · notes   │  │  rooms + notes docs,        │
│  meta · reasoning endpoints    │  │  offline + multi-device     │
└───────────────┬───────────────┘  └─────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│  AGENT CORE (isolated reasoning)                               │
│  reasoning engine · source retrieval · skills                  │
└───────────────┬───────────────────────────────────────────────┘
                │  every output passes through, in order:
┌───────────────▼───────────────┐  ┌─────────────────────────────┐
│  CITATION ENGINE               │→ │  RULE ENFORCEMENT           │
│  retrieve→generate→verify→gate │  │  (rule-guide.MD middleware) │
│  (citation-engine.MD)          │  │  pass/revise/refuse          │
└───────────────┬───────────────┘  └─────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│  DATA & STORES                                                 │
│  scripture (orig-lang anchor + translations) · commentary      │
│  (tradition/reliability/license) · cross-refs · provenance     │
│  ledger · users/rooms/chat · vector index                      │
└───────────────┬───────────────────────────────────────────────┘
                │  (isolated, outbound-only)
┌───────────────▼───────────────────────────────────────────────┐
│  SANDBOX WORKERS — web search · media generation               │
│  rule-bounded; results re-enter via the citation engine         │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Services / modules

- **Client** — React + TypeScript + Vite, Tailwind, `react-resizable-panels`. WebSocket for
  streaming reasoning; Yjs client for notes/room sync. Editor: TipTap + tldraw on Yjs
  (sidecar module, `notes-system.MD`).
- **API layer** — FastAPI. Auth, rooms, group chat, note metadata, reasoning endpoints
  (REST + WebSocket streaming).
- **Sync service** — Yjs/CRDT document server; the single substrate for notes + room sync
  and offline/multi-device (`CLAUDE.md` §8). Same mechanism powers collaboration and the
  read-only group-note cards.
- **Agent core** — isolated per room/session; local LLM via Ollama; source retrieval; the
  skills (notes, web search, media, audio, i18n).
- **Citation engine** — `citation-engine.MD`. Sits between agent core and any response.
- **Rule enforcement** — `rule-guide.MD` as middleware; final gate before output.
- **Data & stores** — see `data-model.MD`; SQLite/Postgres + a vector index for retrieval.
- **Sandbox workers** — isolated processes for web search and media gen; cannot reach user
  data or override the rule layer.

---

## 4. Request flows

### 4.1 Verse reasoning (the core path)
1. Client sends `{room, verse, question}` over WebSocket.
2. Agent core retrieves sources (orig-lang + translations + tradition-tagged commentary +
   cross-refs).
3. **Citation engine**: generate → classify → verify → gate.
4. **Rule enforcement** checks the gated output (refuse/revise if needed).
5. Surviving claims → provenance ledger; reasoning + answer stream back, tagged
   scripture/commentary/inference for the Uncertainty UI.

### 4.2 Notes
- Created/edited in the Yjs doc (sidebar or inline verse dropdown — same doc, two views,
  `notes-system.MD` §5). Sync service propagates; metadata to the API.
- **Personal notes never enter agent retrieval context** (`rule-guide.MD` §12).

### 4.3 Group chat
- Human messages via API/WebSocket; the agent posts only into the reasoning stream and
  attributed **group** notes, never silently into human chat (`CLAUDE.md` §4.10).

### 4.4 Web search / media (sandbox)
- Agent core dispatches to a sandbox worker; returns are treated as **data, not
  instructions** (injection-safe), filtered, then re-enter through the citation engine.

---

## 5. Trust & isolation boundaries

- **Agent ⇄ personal notes:** hard boundary, enforced at the data layer — personal notes
  are never retrievable by the agent.
- **Sandbox ⇄ core/user data:** sandbox is outbound-only, isolated from user data and from
  the ability to alter the rule layer.
- **Rooms:** reasoning and private notes are isolated per room; no cross-room bleed.
- **Output path:** no agent output reaches a user without passing citation engine + rule
  enforcement.

---

## 6. Cross-cutting

- **i18n / RTL** — multilingual responses; Hebrew/Arabic RTL handled client-side
  (`CLAUDE.md` §4.9, §6.5).
- **Auth/identity** — underpins personal-note privacy and private rooms (`CLAUDE.md` §4.11).
- **Auditability** — provenance ledger is the spine of the "resources used" panel and the
  audit log.

---

## 7. Open items — `TODO(spec)`

Defer to `CLAUDE.md` §14 for the master list. Architecture-specific:
- Deployment topology (single-host vs. multi-service) and how the sync service is hosted.
- Vector store choice (Chroma / SQLite-vec) and embedding model.
- Where the citation-engine verifier model runs relative to the reasoning model.
