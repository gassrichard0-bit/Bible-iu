# notes-system.MD

> Spec for the Notes system. Companion to `CLAUDE.md` (§4.6) and `rule-guide.MD` (§12).
> The Notes sidebar is the **single canonical home for every note** — notes are never
> stored loose inside the scripture text; the text only ever points to them.

---

## 1. Principles

1. **One canonical home.** The Notes sidebar is the canonical store for every note. A
   note may also be *viewed and edited inline* at its anchored verse (§5), but that inline
   view is the same note — the scripture text never absorbs it.
2. **Two scopes.** Every note is either **Personal** (private to you) or **Group**
   (shared with the room).
3. **Notes bridge to scripture.** A note can be anchored to one or more verses; an
   anchored verse shows a **toggle** that drops the note(s) down inline for editing (§5).
4. **Persistent.** The sidebar follows the user across every page and both workspace
   scopes (room scope and verse focus).
5. **Reviewable.** A central Notes page indexes everything for later review.

---

## 2. The Notes sidebar

- Slidable, collapsible, persistent across the whole app (matches `CLAUDE.md` §4.6).
- **Tabbed pages:**
  - **Personal Notes** — visible only to you.
  - **Group Notes** — shared with the room's members.
- Each tab is a scrollable thread/list of note cards in time order.
- The sidebar is the canonical home, but a note can **expand to a full-screen editor**
  for heavy work (drawing, long writing) and collapse back into its sidebar card. This
  keeps "all notes live in the sidebar" true while giving room to actually draw.

---

## 3. Rich editing (a first-class, deliberately advanced surface)

The editor is treated as a **core surface of the product**, not a side feature. It is
built to be highly capable — comparable to a serious notes/annotation app — and the
time investment is accepted intentionally.

Capabilities:
- **Rich text** — headings, lists, quotes, callouts, inline scripture references.
- **Color & highlight** — text color, highlight, colored tags.
- **Drawing / canvas** — freehand ink, shapes, diagrams, annotation.
- **Attachments** — images and AI-generated media (labeled per `rule-guide.MD` §9).

### 3.1 Locked decisions (how "advanced" stays achievable)
"Advanced" and "framework-based" are not in tension — frameworks are *how* you reach
advanced without rebuilding editor primitives. Extend mature libraries; never fork or
reimplement their core.

- **Text:** TipTap / ProseMirror. Build custom **extensions/nodes** on top — e.g. a
  `verse-anchor` mark and a scripture-reference node — rather than touching primitives.
- **Canvas:** tldraw / Excalidraw for drawing, embedded as a block within a note.
- **Substrate:** **Yjs (CRDT)** as the underlying document model. This single decision
  delivers three requirements at once:
  1. real-time **group collaboration** (and the read-only cards in §4),
  2. **offline / local-first sync** (`CLAUDE.md` §8),
  3. conflict-free merging so the advanced editor doesn't corrupt on concurrent edits.
  TipTap binds to Yjs natively; tldraw supports multiplayer. Retrofitting collaboration
  onto a non-CRDT editor later is a rewrite — so this is decided **up front.**

### 3.2 Document model first
The hard part of an advanced editor is **not** the feature list — it is one coherent,
serializable, syncable document that holds rich text + an embedded canvas + verse anchors
together. Design this model before building UI. Getting it wrong is what makes advanced
editors collapse under their own weight.

### 3.3 Decoupled (sidecar) module
Build the editor as its **own module** — a sidecar with a clean interface to the note data
model — so its size never entangles or delays the reasoning core. The agent + rule-guide
spine stays **independently buildable and testable** (`CLAUDE.md` §12) while the editor
advances on its own track and can grow as advanced as you want without destabilizing the
core. Text + verse-anchors can land first; full canvas can follow — but the ambition is
the full advanced surface, not a minimal one.

The module communicates through that interface and through the shared **Yjs** documents
(§3.1); it never reaches around the boundary, and **personal notes never cross into the
agent's context** (§7, `rule-guide.MD` §12).

---

## 4. Group study — notes as cards

- **Your own notes:** fully editable by you.
- **Other members' group notes:** appear to you as **read-only cards** on the Group Notes
  page — you can view, react, and reply/thread on them, but **not edit** them.
- Symmetrically, your group notes appear as cards to them.
- A card is a compact representation; tap to expand for the full note.
- This avoids edit collisions while still letting the group see and discuss each other's
  notes in one shared sidebar.

---

## 5. Verse bridge (note ↔ verse)

1. A note can be anchored ("bridged") to one or more verses.
2. A verse that has at least one note shows a **toggle** in the scripture view (not a
   passive icon).
3. Clicking the toggle **drops the note(s) down inline**, directly beneath/beside the
   verse, as an expandable panel. Clicking again collapses it.
4. Notes are **fully editable right there inline** — the same rich editor as the sidebar.
5. **The scripture text is never modified.** The dropdown is an overlay anchored to the
   verse; notes do **not** become part of the Bible. The verse holds a pointer, not the
   note's content.
6. **One note, two live views.** The inline dropdown and the Notes sidebar render the
   **same underlying note** (the shared Yjs document, §3.1). An edit made inline appears
   instantly in the sidebar and vice versa — they are never separate copies.
7. **Scope is respected.** Personal notes drop down only for their owner; group notes drop
   down for room members (others' group notes appear as read-only cards, §4).
8. A new note can also be **created inline** from the toggle; it is stored in the sidebar
   like any other.
9. Removing a note's anchor removes the toggle from that verse; deleting a note removes it
   everywhere (inline, sidebar, and central page).

---

## 6. Central Notes page (review)

- A dedicated page that **indexes every note across all rooms** for review.
- **Search and filter** by: room, anchored verse, scope (personal/group), tag, author,
  date.
- Click-through opens the note in context: room → verse focus → sidebar, with the note
  in view.
- Personal and group notes are clearly separated; personal notes appear only for their
  owner.

---

## 7. Privacy & agent oversight

> Applied as an amendment to `rule-guide.MD` §12.

- **Personal notes are private.** Not visible to other users **and not visible to the
  agent.** They never enter the agent's reasoning context.
- **Group notes are shared** with room members; the agent has **read oversight** and may
  **append** notes (clearly attributed), but **never silently edits or deletes** a human's
  note.
- Boundary rule: *agent note oversight applies to group/shared notes only; personal notes
  are out of scope for the agent,* enforced at the data layer (§9).

---

## 8. Data model additions

- **Note** — id, room, **scope** (`personal` | `group`), author, **a Yjs document**
  (rich text + embedded canvas), color/highlight metadata, **verse_anchors[]**, tags[],
  created_at, updated_at. The Yjs doc is the source of truth for content; the row stores
  metadata + the latest snapshot.
- **VerseNoteIndex** — verse ref → note refs. Drives the verse **toggle** and its inline
  dropdown; respects scope (personal anchors only show for the owner).
- **NoteCard** — derived, read-only view of another member's group note (for the Group
  Notes page).

---

## 9. Build notes for the coding agent

- Extend frameworks (TipTap/ProseMirror, tldraw/Excalidraw); never reimplement editor
  primitives (see §3).
- **Yjs is the document substrate** — it powers collaboration, the read-only cards, and
  offline/local-first sync from one mechanism. Decide and wire this before building UI.
- **Design the document model first** (§3.2): one doc holding text + canvas + verse anchors.
- Build the editor as a **decoupled module** so its scope never delays the reasoning core
  (`CLAUDE.md` §12).
- The sidebar is the canonical store/index; full-screen editing is a view of the same
  note, not a separate entity.
- **Personal notes must never cross into agent context** — enforce at the data boundary,
  not just the UI (`rule-guide.MD` §12).
