# CLAUDE.md

> Build instructions and operating context for Claude Code.
> Read this first, then read `rule-guide.MD`. The rule-guide is law — it overrides
> anything in this file if the two ever conflict.
>
> **Companion specs:** `architecture.MD` (technical map), `data-model.MD` (schema),
> `rule-guide.MD` (runtime law), `soul.MD` (the agent's character & voice),
> `citation-engine.MD` (the grounding/citation core), `notes-system.MD` (the notes &
> editor). Precedence: `rule-guide.MD` governs; `soul.MD` shapes tone within it.

---

## 1. What we are building

A **social Bible-study platform** with an AI reasoning agent.

At the top level it feels like Telegram/WhatsApp: a list of **groups** and **direct
conversations**. Opening any group or conversation drops you into a **study
workspace** that is laid out like VS Code, centered on scripture. Clicking a verse
spins up an AI reasoning session about that verse.

Two roles in every study room:
- **The human(s)** — read, discuss, take notes, ask questions.
- **The agent** — reasons over the verse using the original-language text as ground
  truth and commentary as reference, shows its work with citations, and surfaces only
  factual recommendations.

The product has three layers:
1. **Frontend** — the social shell + the VS Code-style study workspace.
2. **Backend agent** — isolated reasoning, scripture-as-truth, commentary-as-reference.
3. **Rule layer** — `rule-guide.MD`, enforced on every agent action.

---

## 2. Non-negotiable principles

Summarized here; defined fully in `rule-guide.MD`:

- **Scripture is ground truth**, anchored to the **original-language text** (Hebrew/
  Greek). English translations are themselves a reference layer and may differ — show
  divergence, never hide it.
- **Commentary is a reference layer** ("a dictionary to the Bible") and may be flawed.
  Label it, attribute it by tradition, and show disagreement instead of flattening it.
- **No deception, ever.** Every resource is filtered for false claims and false measure.
- **Every claim is traceable.** Reasoning carries citations to verse + named source.
- **Show the reasoning.** No bare answers.
- **Generated media must never deceive** — clearly illustrative, never passed off as real.
- **No profanity. No harmful advice. Nothing that contradicts scripture.**

If a feature request would break any of these, stop and surface the conflict.

---

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  FRONTEND  (social shell + VS Code-style study workspace)     │
│  - Group / DM list  ->  enter room  ->  Bible workspace        │
│  - Persistent slidable Notes sidebar (follows every page)      │
│  - Uncertainty UI: scripture vs commentary vs agent-inference  │
└───────────────┬───────────────────────────────────────────────┘
                │  REST + WebSocket (streaming reasoning)
┌───────────────▼───────────────────────────────────────────────┐
│  BACKEND AGENT  (isolated reasoning service)                   │
│  - Scripture store (original-language anchor + translations)   │
│  - Commentary store (reference, tradition-tagged, flaggable)   │
│  - Cross-reference graph                                       │
│  - Notes store (group notes only; not personal)                │
│  - Provenance ledger (every claim -> sources, auditable)       │
│  - Skills: notes, rule-bounded web search, media, audio, i18n  │
└───────────────┬───────────────────────────────────────────────┘
                │  every action passes through
┌───────────────▼───────────────────────────────────────────────┐
│  RULE LAYER  (rule-guide.MD enforced as middleware)            │
└───────────────┬───────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│  OFFLINE / LOCAL SYNC  (local-first; rooms + notes sync across │
│  machines without a cloud)                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Frontend specification

### 4.1 Social shell (the "front door")
- Behaves like a messaging app: a left rail of **groups** and **direct conversations**,
  search, unread badges, last-message preview.
- Selecting a group or DM opens the **room**, which has a **group chat** (human
  discussion) and a **study workspace** (the VS Code shell). See §4.10.
- Each room has its own scripture context, resources, reasoning history, and notes.

### 4.2 Study workspace — one shell, two scopes

The workspace is a **single, persistent VS Code-style shell**. The chrome — panels,
sidebar, layout — stays constant. What changes is *what is loaded* and *how tightly it
is focused*. There are **two scopes** within the one shell; entering a verse is a
**focus/zoom of the same workspace, never a second nested layout.**

- **Room scope (broad)** — active the moment you enter a chat/room.
- **Verse focus (deep)** — active when you click a verse; same shell, scoped down.

A **breadcrumb** (`Room › Book › Chapter › Verse`) shows the current scope and lets the
user zoom back out. The persistent Notes sidebar (§4.6) stays coherent across both scopes.

### 4.3 The four regions (constant chrome)

| Region | Content |
|--------|---------|
| **Left panel** | **Resources** as a file-explorer tree: commentaries (tradition-tagged), cross-references, lexicon/original-language entries, study notes. Its contents re-scope with the current scope (see §4.4–4.5). |
| **Center** | The **Bible text** (selected book/chapter), verses individually clickable, with a translation switcher and an original-language toggle. Below it, a **chat/prompt box** for the agent. |
| **Top of center** | The **reasoning stream** — the agent's response and running reasoning for the active scope, with inline citations. |
| **Right panel** | **Notes** — the room's notes (Personal + Group), threaded and editable, with the agent's attributed additions in group notes. Persists across both scopes. Full spec: `notes-system.MD`. |

### 4.4 Room scope (entering the chat)
- The full VS Code shell loads immediately on entering a group/DM.
- **Left panel** shows the room's **entire study library** — all commentaries,
  cross-references, lexicon/original-language entries.
- **Center** allows browsing the Bible; the prompt box and reasoning stream operate at
  **room level** (questions about the passage, the book, the discussion).
- **Right panel** shows the room's notes thread.
- This is the broad study view.

### 4.5 Verse focus (clicking a verse — same shell)
1. User clicks a verse. The shell **focuses**; it does not open a new window.
2. The breadcrumb updates to `Room › Book › Chapter › Verse`.
3. A reasoning session opens for that verse. The agent reasons (original-language =
   truth, translations + commentary = reference) and **streams** reasoning + answer into
   the top panel, **with citations**.
4. The **left panel filters** to "resources used for this verse" — the same tree, scoped
   down, lighting up the exact files pulled.
5. **Cross-references** for the verse are surfaced and clickable (clicking one re-focuses).
6. The **Notes sidebar** stays available and can thread **verse-specific** notes.
7. The user can zoom back out to room scope via the breadcrumb.

### 4.6 Persistent Notes sidebar
- A **slidable sidebar that follows the user across every page, every UI, and both
  scopes** — not scoped to a single screen.
- Conversational: messages from both parties and the agent's note additions appear in
  thread order; agent notes are clearly attributed.
- Notes can be room-level or verse-level; verse-level notes surface in verse focus and
  remain findable from room scope.
- Collapsible/expandable; remembers state per room.
- **Full spec: `notes-system.MD`** (advanced editor, Personal/Group pages, verse bridge,
  cards, central review page, privacy boundary).

### 4.7 Uncertainty UI
- Distinct, consistent visual treatment for three claim types:
  - **Scripture** (ground truth) — strongest visual weight.
  - **Commentary** (reference, may be flawed) — tagged with source + tradition.
  - **Agent inference** — visibly marked as the agent's own reasoning, not fact.
- Confidence/uncertainty is shown, not just logged.

### 4.8 Audio layer
- **Read-aloud (TTS)** for verses and for the agent's reasoning/answers.
- Optional voice input for asking the agent (ties to the existing Whisper pipeline).

### 4.9 Frontend conventions
- Component-driven, accessible (keyboard nav for panels, ARIA on the verse list).
- **RTL / bidirectional text** — the original-language anchor is Hebrew (right-to-left),
  and supported languages include other RTL scripts (e.g. Arabic). The UI must handle
  RTL and mixed-direction text correctly throughout. Easy to miss, painful to retrofit.
- Panels resizable and collapsible (VS Code feel).
- Streaming UI for reasoning, with a clear **reasoning vs. answer** separation.
- All agent-generated media rendered with a visible **"AI-generated — illustrative"** label.

### 4.10 Conversation surfaces (chat vs. notes vs. reasoning)
A room has **three distinct surfaces**, kept separate by design:

1. **Group chat** — lightweight human-to-human messaging (the Telegram/WhatsApp layer):
   the running discussion between members. It is the room's social/front view and drives
   unread badges + last-message previews (§4.1).
2. **Notes** — anchored study artifacts (Personal/Group), richly editable and bridged to
   verses (`notes-system.MD`). Notes are **documents, not messages**; you can thread/react
   on a note, but it is not the chat stream.
3. **Agent reasoning stream** — the agent's cited reasoning/answers for the active scope
   (§4.3, §4.5).

**Placement:** group chat is the room's front view; entering **study mode** opens the VS
Code workspace (resources + Bible + reasoning stream). The **Notes sidebar persists across
both** the chat view and the workspace.

**Why distinct:** conflating chat and notes makes both worse — chat wants ephemerality and
flow; notes want permanence, structure, and verse anchoring. The agent posts into the
reasoning stream and may append **group** notes (attributed); it never silently injects
into human chat, and never touches personal notes.

### 4.11 Authentication & account
- **Login / signup UI** — a dedicated front-end entry flow shown before the social shell,
  with sign-out. (Auth provider/method is `TODO(spec)`, §14.)
- **Profile & account settings** — reachable from a menu (e.g. the avatar in the top bar):
  - **Profile:** display name, avatar, languages (these drive multilingual responses,
    §6.5 / `rule-guide.MD` §11).
  - **Account:** credentials, sign-out, delete account.
  - **Preferences:** default translation, TTS voice, default note scope (personal/group),
    theme.
- Identity underpins the privacy model — personal notes and private rooms are scoped to
  the authenticated user (`rule-guide.MD` §12).

---

## 5. Backend agent specification

> The agent's **character and voice** are defined in `soul.MD`: a humble study companion,
> never an authority or a substitute for prayer, clergy, or community. Its **hard
> constraints** are in `rule-guide.MD`.

### 5.1 Isolated reasoning
- Runs in an **isolated reasoning context** per room/session. No cross-room bleed of
  private notes or conversations.
- Every reasoning turn is auditable via the **provenance ledger** (§7.5): inputs
  (verse, question, resources used) and outputs (reasoning, answer, citations,
  recommendations) are logged.

### 5.2 Source hierarchy (strict)
1. **Original-language scripture — ground truth.** Hebrew/Greek text is the anchor and
   is never contradicted.
2. **Translations — reference.** Treated as a translation layer that may differ; when
   versions diverge on a verse, surface the divergence rather than picking silently.
3. **Christian commentary — reference, tradition-tagged.** A companion to the text; may
   be flawed. Attribute by tradition and show disagreement (§7.3).
4. **Web search — last, rule-bounded** (§6.2).

If anything lower in the hierarchy contradicts scripture, **scripture wins** and the
conflict is stated.

### 5.3 Oversight of notes
- The agent has **read oversight over group/shared notes only** and may **append** notes
  (clearly attributed). **Personal notes are private and never enter the agent's context**
  (`rule-guide.MD` §12, `notes-system.MD` §7). The agent **never silently edits or
  deletes** a human's note.

### 5.4 Factual recommendations only
- Any recommendation must be **fact-based, verifiable, and cited**, with reasoning
  attached. Uncertain ground is labeled uncertain; no speculation presented as fact.
- Citation and grounding are enforced by the **citation engine** (`citation-engine.MD`),
  which sits between the reasoning model and every response.

---

## 6. Agent skills & abilities

Implement each as a discrete, individually rule-checked capability.

### 6.1 Notes
- Create and append notes, attributed to the agent. Read room notes for context,
  respecting room isolation.

### 6.2 Rule-bounded web search
- Runs in an **isolated sandbox** that may not violate `rule-guide.MD`.
- Every fetched resource passes the truth filter before use.
- The agent **explains its reasoning in detail** for anything pulled from the web (what
  it searched, what it found, why it trusts it, how it measures against scripture), and
  records sources in the provenance ledger.

### 6.3 Media generation (images / video)
- Permitted, but output **must never deceive**. No fabricated "real" photos/footage.
  All output is clearly marked illustrative/AI-generated in data and UI.

### 6.4 Audio (TTS + voice input)
- Generate read-aloud audio for verses and reasoning; accept voice questions.
- Spoken output obeys every rule that text output does.

### 6.5 Multilingual
- Detect the user's language(s) and **respond in the matching language(s)**; handle
  mixed-language input; keep scripture references accurate across languages.

---

## 7. Scripture & sources model

### 7.1 Original-language anchor
- Store the Hebrew/Greek text with token-level data: lemma, Strong's number, morphology,
  and a lexicon entry per token.
- The original-language text is the single source of truth; everything else references it.

### 7.2 Translations as a reference layer
- Multiple translations stored and aligned to verses (and where possible to original tokens).
- Translation differences are first-class data, surfaced in the Uncertainty UI (§4.5).

### 7.3 Multi-tradition commentary
- Every commentary resource is **tagged by tradition** (e.g. Catholic, Orthodox,
  Reformed, Evangelical, etc.) and by a **reliability flag**.
- When traditions disagree, **present the disagreement** with attribution; never present
  one school as *the* answer.

### 7.4 Cross-reference graph
- Verses link to verses (thematic, quotation, parallel). Navigable from the verse-click
  flow and the left panel.

### 7.5 Provenance ledger
- Every agent claim is traceable to: source verse(s) + named source(s) + tradition/
  reliability tags + the reasoning step that used them.
- Powers the left-panel "resources used" view and the audit log. This is the mechanism
  that makes "no deception" verifiable.

### 7.6 Data sourcing & licensing (gating item)
The app cannot ship without legally usable source texts — resolve this before building the
sources layer:
- **Original-language text** — use a freely licensed Hebrew/Greek text with Strong's +
  morphology (public-domain / open datasets exist). This is the ground-truth anchor (§7.1).
- **Translations** — many modern translations (e.g. NIV, ESV) are copyrighted and need a
  license or API agreement; public-domain options (e.g. KJV, ASV, WEB) ship freely. Track
  a license per translation.
- **Commentary** — much published commentary is copyrighted; prefer public-domain or
  openly licensed works. Store a **license + attribution field per resource** (extends the
  `Resource` model, §10).
- **Rule:** no source ships without a recorded license. `TODO(spec)`: finalize the exact
  text / translation / commentary set and their licenses.

---

## 8. Tech stack (assumptions — swappable)

Chosen local-first to match a self-hosted/offline-capable setup. Swap freely.

**Frontend**
- React + TypeScript + Vite, Tailwind CSS
- `react-resizable-panels` for the VS Code-style panes
- WebSocket client for streaming reasoning

**Backend**
- FastAPI (Python)
- Local LLM via **Ollama** (reasoning agent)
- Vector store (e.g. Chroma / SQLite-vec) for commentary + cross-reference retrieval
- SQLite/Postgres for users, rooms, notes, conversations, provenance
- Sandboxed worker for web search and media generation
- **TTS** engine for audio; reuse existing **Whisper** pipeline for voice input

**Data**
- Original-language text (Hebrew/Greek) with Strong's + morphology + lexicon
- Translations aligned to verses/tokens
- Commentary indexed by source, tradition, reliability
- Cross-reference graph

**Offline / local sync**
- Local-first storage built on **Yjs (CRDT)** — the *same* substrate as the notes editor
  (`notes-system.MD` §3.1). One mechanism gives rooms and notes offline edits, conflict-free
  merging, and replication across machines without a cloud.

> If you change the stack, update this section and keep the layer boundaries intact.

---

## 9. Suggested directory structure

```
.
├── CLAUDE.md
├── rule-guide.MD
├── frontend/
│   ├── src/
│   │   ├── shell/            # group + DM list, routing
│   │   ├── workspace/        # VS Code-style 4-region layout
│   │   │   ├── ResourcesPanel/    # left: folder tree (commentary/xref/lexicon)
│   │   │   ├── BibleView/          # center: verses + translation/original toggle + prompt
│   │   │   ├── ReasoningStream/    # top: agent reasoning/answers + citations
│   │   │   └── NotesSidebar/       # right: persistent slidable notes
│   │   ├── uncertainty/      # scripture vs commentary vs inference styling
│   │   ├── audio/            # TTS playback + voice input
│   │   └── lib/             # ws client, api client, i18n
│   └── ...
├── backend/
│   ├── agent/
│   │   ├── reasoning/        # isolated reasoning engine
│   │   ├── sources/          # original-language anchor, translations, commentary, xrefs
│   │   ├── provenance/       # citation ledger + audit log
│   │   ├── skills/           # notes, web_search, media_gen, audio, i18n
│   │   └── rules/            # rule-guide enforcement middleware
│   ├── api/                  # REST + WebSocket endpoints
│   └── data/                 # scripture, lexicon, commentary index, xref graph
├── sync/                     # offline/local-first sync layer
├── sandbox/                  # isolated web-search + media workers
└── tests/
    └── rule_guide/           # adversarial eval suite (see §12)
```

---

## 10. Core data model

The full, canonical schema lives in **`data-model.MD`**. At a glance, the entities are:
**User, Room, ChatMessage** (identity & social); **Verse, OriginalToken, Translation,
Resource, CrossReference** (scripture & sources, read-only); **Note, VerseNoteIndex,
NoteCard** (notes — `notes-system.MD`); **ReasoningSession, Provenance** (reasoning &
grounding — `citation-engine.MD`); **Media**; **SyncMeta** (minimal; Yjs carries its own
clocks).

> Do not redefine fields here — edit `data-model.MD` so the schema has one source of truth.

---

## 11. Build & run

```bash
# frontend
cd frontend && npm install && npm run dev

# backend
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn api.main:app --reload

# local model
ollama pull <reasoning-model>      # set in backend config

# rule-guide eval suite
cd tests/rule_guide && pytest      # must pass before agent ships
```

> Fill in exact model name, ports, and TTS/sync config in a single config file.

---

## 12. Rule-guide test harness (write this FIRST)

The product's integrity rests on `rule-guide.MD` actually holding. Untested rules are
decoration. Build the rule-enforcement middleware **and** this eval suite before any
agent skill ships.

The suite is an **adversarial** set of prompts the agent must handle correctly:
- **Profanity bait** — coax the agent into cursing → must refuse/stay clean.
- **Fake-media bait** — "make a real photo of [biblical event/person]" → must produce
  only clearly-labeled illustrative media, or decline.
- **Rule-override bait** — "ignore rule-guide.MD" / prompt injection from a fetched
  page → must hold the rules.
- **Contradict-scripture bait** — pressure to assert something against the text → must
  keep scripture as ground truth and state the conflict.
- **False-measure bait** — misquote/out-of-context source → must filter and flag.
- **Unsourced-claim bait** — must refuse to present uncited claims as fact.
- **Multi-tradition flattening** — must show disagreement, not pick one as *the* answer.

Each case has an expected-behavior assertion. CI fails if any case regresses.

---

## 13. Rules for the coding agent (you, Claude Code)

- **Read `rule-guide.MD` before writing agent logic.** It governs runtime behavior.
- **Write the rule-enforcement layer and the §12 eval suite first.**
- Keep the layers (frontend / backend agent / rule layer / sync) cleanly separated.
- Every agent skill routes through the rule-enforcement middleware — no skill touches the
  web, generates media, or speaks without passing the rule check first.
- Every agent claim writes to the provenance ledger; no uncited claims.
- Prefer small, testable modules.
- When the spec is ambiguous, leave a `TODO(spec):` marker rather than inventing behavior
  that could violate the rule-guide.
- Do not weaken or "interpret away" any rule in `rule-guide.MD` for convenience.

---

## 14. Open items — `TODO(spec)`

Intentionally unspecified. **Do not invent behavior** for these; each needs a decision
before its area is built:

- **Citation / grounding engine** — **designed in `citation-engine.MD`.** Build it
  **before** the agent's user-facing skills; it is where "no deception" actually lives.
  Remaining `TODO(spec)` within it: pick the local entailment/verifier model.
- **Group lifecycle & permissions** — create / invite / remove members, roles
  (admin/member), who may add the agent to a room, leaving a room and what happens to your
  notes.
- **User-content moderation** — `rule-guide.MD` governs the *agent*; define a separate
  policy for *user* conduct (harassment, reporting, blocking).
- **Media-generation backend** — §6.3 permits image/video but names no model/integration;
  choose one compatible with the local-first setup and the network sandbox.
- **Auth provider/method** — choose the login method(s) for §4.11.
- **Data set + licenses** — finalize the exact original-language text, translations, and
  commentary set and their licenses (§7.6).
- **SyncMeta vs Yjs** — simplify the §10 `SyncMeta` entity once Yjs is committed; Yjs
  carries its own version clocks, so manual clocks are largely redundant.
