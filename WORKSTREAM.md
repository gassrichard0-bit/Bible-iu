# Bible IU — Workstream Notes

**READ THIS FIRST.** This file is the shared communication channel
between **Mark** (Claude Code) and the **Hermes agent** (Alex).
Both agents write to this file. Both agents read it before starting
new work.

## Rules of the channel

- Add new entries at the TOP of the relevant section (or start a new section).
- Don't delete anyone else's entries — append only. (Cleanup is done by agreement, not unilaterally.)
- Keep entries concise: what was done + why it matters.
- If you're about to build something and you're not sure if it was already done, search this file first.
- When the user says "ask mark" or "let mark know" — write an entry here. That is the handoff mechanism.

## Where things live

- **Backend** — FastAPI + SQLAlchemy. Models in `backend/data/models.py`; new tables migrated via raw `sqlite3` ALTER on the live DB at `backend/data/bible-iu.sqlite`.
- **Auth/profile/phone/backup/bookmark/annotation endpoints** — `backend/api/auth_users.py`. All gated by `Depends(require_password) + Depends(require_user)`.
- **Chat** — `backend/api/main.py` (REST + WS handlers), `backend/api/chat_hub.py` (per-room subscriber registry).
- **Reading plans** — `backend/api/reading_plans.py`. Scheduler at `backend/api/reading_plan_scheduler.py`, wired into FastAPI lifespan.
- **Push notifications** — `backend/api/push.py` (VAPID Web Push). Migration 0009 added `push_subscriptions`.
- **Citation engine** — `backend/agent/reasoning/citation_engine.py`. `bypass` flag on `run()`.
- **DeepSeek generator + verifier** — `backend/agent/skills/deepseek_backends.py`. Bypass path uses separate preamble + schema.
- **Ollama generator + verifier** — `backend/agent/skills/ollama_backends.py`. Activated by `OLLAMA_MODEL` env.
- **Local NLI verifier + StackedVerifier** — `backend/agent/skills/local_nli.py`. Uses `cross-encoder/nli-deberta-v3-base`.
- **Original-language retrieval** — `OriginalToken` rows folded into `SqlRetriever` in `default_backends.py`.
- **Commentary retrieval** — `Resource` rows filtered by `[on <verse>]` body prefix, diversified across `tradition_tag`.
- **Orchestrator** — `backend/agent/orchestrator.py`. `enforce()` ALWAYS runs; only the engine internals get skipped.
- **Mobile shell** — `frontend/src/shell/MobileShell.tsx`.
- **Desktop shell** — `frontend/src/shell/SocialShell.tsx`. App.tsx routes by `useIsDesktop()`.
- **Workspace** — `frontend/src/workspace/Workspace.tsx` (`forwardRef` exposing `{ ask, isPending }`).
- **Bible reader + annotations + token study + search** — `frontend/src/workspace/BibleView/BibleView.tsx`, `AnnotationToolbar.tsx`, `annotations.ts`.
- **Notes (Yjs CRDT + TipTap)** — `frontend/src/workspace/NotesSidebar/`. Rich editor is `RichNoteField.tsx` (Tiptap on top of the existing string Y.Text).
- **TTS / voice input** — `frontend/src/lib/tts.ts` (Web Speech synthesis with smart voice picker) + `frontend/src/lib/speechRecognition.ts`.
- **Push subscribe + SW update banner** — `frontend/src/lib/pushNotifications.ts`, `frontend/src/lib/registerServiceWorker.ts`.
- **Per-book colors + testament metadata** — `frontend/src/lib/testament.ts`.
- **Share cards** — `frontend/src/lib/shareVerse.ts`.

## Quick reference

- **Backend autostart (survives reboot):** managed by
  `~/Library/LaunchAgents/com.user.bible-iu-backend.plist`. Regenerate /
  reload after rotating `backend/.env`: `bash scripts/install-launchagent.sh`.
  Logs at `/tmp/bible-iu-backend.log`. Runtime uses a venv at
  `~/Library/Application Support/bible-iu/venv/` (homebrew python3.12 —
  the only interpreter with the `kTCCServiceSystemPolicyDesktopFolder`
  TCC grant launchd needs to read this repo from `~/Desktop/`).
- **Manual restart (dev shell, no launchd):**
  ```bash
  cd "/Users/richardgass/Desktop/Bible IU/files"
  set -a && source backend/.env && set +a
  nohup python3 -m uvicorn backend.api.main:app \
    --host 127.0.0.1 --port 8765 --log-level warning \
    > /tmp/bible-backend.log 2>&1 & disown
  ```
- **Backend tests:** `cd backend && python3 -m pytest -q` (120/120 pass; 2 DeepSeek-output-flaky tests fail when env is loaded — pre-existing, unrelated to feature work).
- **Frontend type-check:** `cd frontend && npx tsc --noEmit`
- **Live URLs:**
  - `https://bible.access-term.com` — public, password `bible2026`, then sign in
  - `localhost:5173` — Vite dev server (HMR)
  - `localhost:8765` — uvicorn backend
- **Restart frontend:** `pkill -f vite && cd frontend && npx vite --host`
- **Save to local git:** `git add -A && git commit -m "..." && git push local main`
- **Push to GitHub:** `git push origin main`

## Known limitations (updated 2026-06-08)

- **No per-word / sub-verse selection.** Annotations are whole-verse only. The custom drag-to-select work is on an orphan branch (d64ae06...) and was never merged to main.
- **Notes — no tldraw/canvas.** Editor is TipTap text only. Image attachments work; freehand drawing doesn't.
- **SMS blocked.** A2P 10DLC carrier registration required for US delivery. Workaround: toll-free Twilio number.
- **Dirty working tree.** Heavy uncommitted work from the audit sweep — many new modules need a commit pass. Roughly: seed scripts (originals + commentary + NT Strong's), local_nli, ollama_backends, push, security headers, all the search endpoints + sheet, TTS + voice input, cross-room notes review, quiet hours, room delete, annotation toast, app-update banner, attachment endpoints.
- **DEEPSEEK_API_KEY exposed in chat.** Should be rotated. Explicitly deferred by user.
- **Chat fan-out is single-instance.** `chat_hub.py` is per-process pub/sub; multi-instance deploys need Redis (also true for the rate-limit token bucket and the reading-plan scheduler).
- **No OAuth / no email-verification / no email-based password reset.** Backup codes are the only recovery flow.
- **Commentary corpus is starter-only.** 19 entries (Matthew Henry / Wesley / Catena). The retriever + fairness gate work; real coverage needs bulk ingestion via `--from-json` on `seed_commentary.py`.
- **NT Strong's is 98.5% covered.** Misses are mostly proper nouns and rare hapax legomena whose MorphGNT lemma form differs from the dictionary's.
- **Note-image cleanup is best-effort.** Orphaned image rows persist when their referencing note is deleted. Acceptable on single-instance; needs a sweep job at scale.

## Done since the last WORKSTREAM update (Jun 7 → Jun 8)

Big push. Adding here so neither agent re-does any of it.

### Agent grounding (formerly "Known limitations" 2 + 3 + commentary)
- `backend/data/seed_original_tokens.py` — 444,339 tokens (OSHB OT + MorphGNT NT). Strong's for OT comes from the lemma attribute; populates `original_tokens.strongs / lemma / morphology / surface_form`.
- `backend/data/seed_strongs_nt.py` — 135,433 NT tokens (98.5%) backfilled with Strong's by joining against OpenScriptures Greek dictionary.
- `backend/data/seed_commentary.py` — 19 starter entries (Reformed/Wesleyan/Patristic) on key verses. Supports `--from-json` for bulk ingestion.
- `SqlRetriever` in `default_backends.py` now folds: (a) per-word morphology for the anchor verse, (b) verse-anchored commentary diversified across `tradition_tag`, (c) note-comment threads complete with anchor refs.
- `backend/agent/skills/local_nli.py` — `LocalNLIVerifier` (cross-encoder DeBERTa) + `StackedVerifier` (AND on entails, OR on contradicts) so DeepSeek doesn't grade its own homework. Orchestrator picks Ollama > DeepSeek > placeholder; verifier stacks NLI with DeepSeek when both are present.
- `backend/agent/skills/ollama_backends.py` — `OllamaGenerator` + `OllamaVerifier`. Activates on `OLLAMA_MODEL` env.

### Reader features
- Token-level study block per verse (`אα` badge → tap-to-study every Hebrew/Greek word with lemma + Strong's + morph code + Blue Letter Bible deep link). Endpoint: `GET /bible/{book}/{ch}/{v}/tokens`.
- Inline word-level translation-divergence highlighting between primary and alternate translations.
- Bible full-text search: `GET /bible/search?q=...` + magnifier modal in the reader toolbar.
- TTS read-aloud per verse (🔊 button). Smart voice picker prefers Neural / Premium / Enhanced / Siri / Google / Natural in that order.
- Read-aloud agent answers (🔊 button on each answer in `ReasoningStream`).
- Offline reader: SW caches `/bible/{book}/{ch}/multi` responses under `bible-iu-scripture-v1`. Network-first, falls back to cache.
- Default-translation picker in Settings → General. Bible reader honors `settings.defaultTranslation`.

### Notes
- TipTap editor swapped in (`RichNoteField.tsx`). External API unchanged; existing string Y.Text bodies still work.
- Author-only delete enforced server-side: `DELETE /rooms/{room_id}/notes/{note_id}` validates author from the shared Y.Doc.
- Cross-room notes search: `GET /notes/search?q=...&scope=...`.
- Cross-room notes review page: Settings → "All my notes" (calls `/notes/all`).
- Note image attachments: `POST /rooms/{room}/notes/image` (multipart, 1600px WebP). Sanitizer carves out `<img>` for src patterns matching the serve endpoint only.
- Notes page redesign (Unread/All view + book/chapter filter; unread tracker per-room in localStorage).
- Personal/Group scope toggle on the verse + chapter inline note panels (mirrors Notes-page toggle).

### Chat
- Within-room search (was already wired; confirmed working).
- Replied-to thread preview (already shipped).
- Image attachments (already shipped).
- Reactions (already shipped).
- Sender avatars + tap-to-DM (already shipped).
- Contacts sheet now scoped to active room when opened from chat tab; cross-room version reached from rooms-rail header.

### Rooms / settings / notifications
- Rooms-rail redesigned: search, last-message preview + timestamp + author, sections for Pinned/DMs/Groups/Hidden, swipe-to-reveal Pin/Hide actions, 3D card recipe.
- `last_message_body` / `last_message_at` / `last_message_author_handle` added to `RoomRead` via a grouped MAX query.
- Per-room pin / hide / mute lists in `settings.ui` (`pinnedRoomIds`, `hiddenRoomIds`, `mutedRoomIds`).
- Quiet hours: `quietHoursEnabled` + `quietStartHour` + `quietEndHour`. Backend `_is_quiet_hours_for(user)` skips push fan-out within the window.
- Push fan-out for chat + group notes + reading-plan reminders.
- Web Push end-to-end: VAPID, subscribe/unsubscribe endpoints, SW push event + notificationclick. Auto-enable on first sign-in (one-shot inside the gesture window).
- `POST /rooms/{id}/leave` for non-admin members.
- `DELETE /rooms/{id}` (admin-only) with manual cascade.
- Default-translation picker; reading-plan reminder hour picker.
- Reading-plan streak indicator (`streak_days` on `ReadingPlanSummary`, 🔥 chip in Settings).
- App-update banner: SW emits `bible-iu:sw-update-ready` → toast → "Reload" calls `skipWaiting` + reloads on `controllerchange`.

### Live sync, safety, audit
- **Annotation cross-device refresh** (resolves the WORKSTREAM "no WebSocket or polling" item). `authAnnotationsList()` re-pulls on window focus + visibility change.
- **Annotation error feedback** (resolves the WORKSTREAM "empty catch blocks" item). Failed `applyAnnotation` / `clearAnnotationKind` / `clearAnnotations` now surface via a small toast at the bottom of the shell. Auto-dismisses after 3.5s.
- **Reading-plan scheduler** is wired — the old WORKSTREAM entry "needs cron wiring" is stale. `reading_plan_scheduler.startup()` runs in FastAPI lifespan, sweeps every 5 minutes, respects per-user `readingReminderHour` + quiet hours.
- **Security headers middleware**: CSP (with `connect-src` for `https://api.deepseek.com`), HSTS (https only), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`.
- **Provenance audit log viewer** in Settings → Advanced (debug-mode-gated). `GET /admin/provenance`.
- **Personal-note leak regression test** + **multi-tradition fairness regression test** added to `tests/`.
- **Test count corrected.** 120/120 pass in env-isolated runs; the old "75 errors" entry was stale. With env loaded, two link-stripping tests fail on DeepSeek output assertions — pre-existing flake unrelated to feature work.

### Misc
- Voice input via browser `SpeechRecognition` (🎙 button in the floating composer; falls back silently on browsers without support).
- Multilingual response detection: dominant non-Latin script in the question → `target_language` BCP-47 hint sent to the agent.
- RTL/bidi quick pass: `dir="auto"` on chat bodies + Tiptap editor attributes.
- Marks page: bookmark labels now use full book names (Genesis, not GEN); search button replaces avatar slot.
- Top-banner full-bleed fix: dynamic `<meta name="theme-color">` + body bg matches the accent so the strip above the page blends with the banner.
- 3D card recipe applied to room-rail rows.

## Recent additions to main (Jun 6-7)

| Commit | What |
|--------|------|
| `7846cbd` | Contacts button on chat tab + GET /contacts |
| `8c68d54` | iMessage-style chat reactions |
| `1debfa0` | iMessage-style replies with long-press action sheet |
| `f44ec71` | Chat image attachments |
| `156298b` | Profile preview sheet from chat avatar |
| `7fea201` | Chat sender avatars + tap-to-DM |
| `06191d0` | Fix runaway POST /rooms/{id}/read loop in ChatPanel |
| `37dc960` | 3D + glass overhaul (pass 2): join, theme toggle, desktop shell, swatches |
| `c9ed34d` | 3D + glass overhaul (pass 1) |
| `5f9f13c` | 3D theme polish: chat bubbles, marks page, today's reading toggle |
