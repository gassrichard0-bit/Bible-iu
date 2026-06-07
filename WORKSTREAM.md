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
- **Reading plans** — `backend/api/reading_plans.py`.
- **Citation engine** — `backend/agent/reasoning/citation_engine.py`. `bypass` flag on `run()`.
- **DeepSeek generator** — `backend/agent/skills/deepseek_backends.py`. Bypass path uses separate preamble + schema.
- **Orchestrator** — `backend/agent/orchestrator.py`. `enforce()` ALWAYS runs; only the engine internals get skipped.
- **Mobile shell** — `frontend/src/shell/MobileShell.tsx`.
- **Desktop shell** — `frontend/src/shell/SocialShell.tsx`. App.tsx routes by `useIsDesktop()`.
- **Workspace** — `frontend/src/workspace/Workspace.tsx` (`forwardRef` exposing `{ ask, isPending }`).
- **Bible reader + annotations** — `frontend/src/workspace/BibleView/BibleView.tsx`, `AnnotationToolbar.tsx`, `annotations.ts`.
- **Notes (Yjs CRDT)** — `frontend/src/workspace/NotesSidebar/`.
- **Per-book colors + testament metadata** — `frontend/src/lib/testament.ts`.
- **Share cards** — `frontend/src/lib/shareVerse.ts`.

## Quick reference

- **Restart backend with env loaded:**
  ```bash
  cd "/Users/richardgass/Desktop/Bible IU/files"
  set -a && source backend/.env && set +a
  nohup python3 -m uvicorn backend.api.main:app \
    --host 127.0.0.1 --port 8765 --log-level warning \
    > /tmp/bible-backend.log 2>&1 & disown
  ```
- **Backend tests:** `cd backend && python3 -m pytest -q`
- **Frontend type-check:** `cd frontend && npx tsc --noEmit`
- **Live URLs:**
  - `https://bible.access-term.com` — public, password `bible2026`, then sign in
  - `localhost:5173` — Vite dev server (HMR)
  - `localhost:8765` — uvicorn backend
- **Restart frontend:** `pkill -f vite && cd frontend && npx vite --host`
- **Save to local git:** `git add -A && git commit -m "..." && git push local main`
- **Push to GitHub:** `git push origin main`

## Known limitations

- **No per-word / sub-verse selection.** Annotations are whole-verse only. The custom drag-to-select work is on an orphan branch (d64ae06...) and was never merged to main.
- **No commentary data.** `resources` table has 0 rows. Retriever returns nothing.
- **No original-language tokens.** `original_tokens` table has 0 rows.
- **SMS blocked.** A2P 10DLC carrier registration required for US delivery. Workaround: toll-free Twilio number.
- **Dirty working tree.** 22 modified + 7 untracked files, ~1,750 uncommitted lines.
- **75 test errors.** New test files (room images, unread badges) need their dependencies in the test env.
- **Annotation cross-device sync.** Loaded once at mount — no WebSocket or polling.
- **Annotation error feedback.** Empty catch blocks on API failures.
- **Reading plan reminders.** `reading_plan_scheduler.py` exists but needs cron wiring.
- **DEEPSEEK_API_KEY exposed in chat.** Should be rotated.

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
