# data-model.MD

> The canonical **data model** for the system. All entities live here; other docs
> reference this file rather than redefining schema. Where another doc lists fields, this
> file is authoritative.
>
> Companions: `CLAUDE.md`, `architecture.MD`, `notes-system.MD`, `citation-engine.MD`,
> `rule-guide.MD`.

---

## 1. Conventions

- All entities have `id`, `created_at`, `updated_at` unless noted.
- "Ref" = foreign-key reference by id.
- Scripture data is **read-only ground truth**; user data is mutable.
- Note **content** lives in a Yjs document (collaborative substrate); rows hold metadata +
  the latest snapshot.

---

## 2. Identity & social

### User
- `id`, **auth identity** (email/handle + credentials or provider ref)
- `display_name`, `avatar`
- `languages[]` — drives multilingual responses (`rule-guide.MD` §11)
- `preferences` — default translation, TTS voice, default note scope, theme

### Room
- `id`, `type` (`group` | `direct`)
- `members[]` (User refs + roles — roles `TODO(spec)`)
- `scripture_context` — current book/chapter/translation focus

### ChatMessage
- `id`, `room` ref, `author` (User | `agent`), `body`, `language`, `timestamp`
- Human group chat; **distinct from Note** (`CLAUDE.md` §4.10).

---

## 3. Scripture & sources (read-only ground truth)

### Verse
- `book`, `chapter`, `verse`
- refs to `Translation` rows and `OriginalToken` rows

### OriginalToken
- `verse` ref, `surface_form`, `lemma`, `strongs`, `morphology`, `lexicon_entry`
- The ground-truth anchor (`CLAUDE.md` §7.1).

### Translation
- `id`, `name`, `verse` ref, `text`, `token_alignment` (where available)
- `license` — required (`CLAUDE.md` §7.6)

### Resource  (commentary / cross-ref / lexicon)
- `id`, `type`, `source`
- `tradition_tag`, `reliability_flag`
- `license_attribution` — required; no source ships without it (`CLAUDE.md` §7.6)
- `body`

### CrossReference
- `from_verse` ref, `to_verse` ref, `relation_type` (thematic | quotation | parallel)

---

## 4. Notes  (see `notes-system.MD`)

### Note
- `id`, `room` ref, `author` (User | `agent`)
- `scope` (`personal` | `group`)
- `yjs_doc` — rich text + embedded canvas (source of truth for content)
- `verse_anchors[]` — Verse refs (the "bridge")
- `tags[]`, `language`
- **Privacy:** `personal` notes are never readable by other users or the agent
  (`rule-guide.MD` §12).

### VerseNoteIndex
- `verse` ref → `note` refs
- Drives the verse **toggle** + inline dropdown; respects scope (personal anchors show only
  to the owner).

### NoteCard  (derived, read-only)
- A read-only view of another member's **group** note for the Group Notes page. Not stored
  independently; projected from `Note`.

---

## 5. Reasoning & provenance

### ReasoningSession
- `id`, `room` ref, `verse` ref, `question`
- `resources_used[]` (Resource/Verse refs)
- `reasoning`, `answer`
- `citations[]` (Provenance refs)
- `recommendations[]`
- `timestamp`

### Provenance
- `id`, `claim_id`
- `verse_refs[]`, `source_refs[]`
- `tradition`, `reliability`
- `reasoning_step_ref`
- `verification_result` (supported | inference | dropped) — from the citation engine
  (`citation-engine.MD` §8)

---

## 6. Media

### Media
- `id`, `kind` (image | video | audio)
- `ai_generated: true`, `label` ("AI-generated — illustrative")
- `prompt`
- Always labeled in data + UI (`rule-guide.MD` §9).

---

## 7. Sync

### SyncMeta
- Minimal. **Yjs carries its own version vectors/clocks**, so do not duplicate them; store
  only what Yjs does not (e.g. `device`, `last_synced` for display).
- See `architecture.MD` §3 (sync service).

---

## 8. Privacy & integrity invariants

1. **Personal notes** are never exposed to other users or to the agent — enforced at the
   data layer (`rule-guide.MD` §12).
2. **Scripture** rows are immutable at runtime.
3. **No Resource or Translation** without a license field populated (`CLAUDE.md` §7.6).
4. **No fact** surfaces without a Provenance record (`citation-engine.MD`).
5. **Room isolation** — private notes and reasoning never cross rooms.
