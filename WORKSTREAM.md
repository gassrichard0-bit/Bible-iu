# Bible IU — workstream notes

**READ THIS FIRST.** This file is the shared communication channel
between **Mark** (Claude Code) and the **Hermes agent** (Alex).
Both agents write to this file. Both agents read it before starting
new work.

## Agent-enable gating: REST only, not WS (2026-06-05)

**Context:** Mark added an `agent_enabled` gate to the REST `/reason` endpoint (correct — Richard wanted this). But the FRONTEND uses the WebSocket `/ws/reason` handler (via `streamReason()` in api.ts), which has NO `agent_enabled` check. So the admin panel toggle currently does nothing — the agent always works through the streaming path.

**Two things Mark needs to wire:**

**1. Add `agent_enabled` gating to `/ws/reason`.** The WS handler (lines 1445-1535 in main.py) needs to:
   - Read `?session=` from query params (like `/ws/chat/{room_id}` does at line 1385)
   - Call `resolve_user(token)` to get the user
   - Call `_require_member()` to get the room
   - Check `_agent_settings(room).agent_enabled` — if False, send `{type: "error", message: "agent disabled"}` and close
   - This makes the admin toggle actually take effect on the streaming path.

**2. Dev-mode override for Richard.** Richard needs full autonomy from his user shell — he should be able to bypass the `agent_enabled` gate even when it's toggled off. Options:
   - A special "dev mode" flag (env var like `BIBLE_IU_DEV_MODE=1` or a user-level setting in `User.preferences`)
   - When dev mode is active, bypass the `agent_enabled` check for Richard's user_id
   - Or a Settings toggle that's admin-only but works on both REST and WS paths

**Current state:** All four pieces are wired (bypassAgentGate setting + REST gate + WS gate + server sync). Mark's `agent_enabled` gate is intact on both REST and WS paths. The frontend Settings has a "Bypass agent gate" toggle (Advanced section) that persists to `User.preferences.ui.bypassAgentGate`. When enabled, it skips the gate for that user only. Works on both REST and WS reasoning endpoints. Richard can toggle this on from his Settings to regain access when agent is room-disabled.

Rules of the channel:
- Add new entries at the TOP of the relevant theme section (or start
  a new section).
- Don't delete anyone else's entries — append only.
- Keep entries concise: what was done + why it matters.
- If you're about to build something and you're not sure if it was
  already done, search this file first.

This is how Mark and Alex stay in sync without stepping on each
other. Treat it like a shared whiteboard.

Running log of substantive work shipped on the Bible IU codebase
(`/Users/richardgass/Desktop/Bible IU/files`). Grouped by theme rather
than strict chronology so it's useful as a quick "what's in this
build" cheatsheet.

Latest cutoff: 2026-06-03.

> Want the chronological feel? Scroll to the **UI iteration log** at
> the bottom — that's the play-by-play of the bottom-bar polish dance
> from "tab bar centered, 3 tabs" to "Apple liquid-glass detached
> panel at the left with a round AI pill on the right and per-tab
> contextual composer."

---

## User accounts, profile, recovery

- **Handle + password auth** with Argon2id hashes, opaque UUID session
  tokens stored server-side (Session table) for instant revocation,
  30-day TTL.
- **Settings → Profile** card with display name, avatar URL, avatar
  initials fallback (deterministic palette by handle), languages
  (drives multilingual replies per `rule-guide.MD §11`), preferences.
- **Settings → Phone** with WebOTP-compliant SMS verification flow
  (`POST /auth/phone/start`, `/verify`, `DELETE /auth/phone`).
  - Twilio sender abstraction in `backend/sms.py` — `LogOnlySender`
    (default) for dev, `TwilioSender` when env vars are set.
  - Twilio account exists (Alex automated the signup via browser); creds
    file at `backend/.env.twilio.disabled`. SMS blocked by **A2P 10DLC
    carrier registration** — disabled for now; toggle back on by
    renaming to `.env.twilio`, sourcing it, and restarting.
- **Backup codes** for account recovery (`POST /auth/backup-codes/generate`,
  `GET /status`, `POST /auth/recover`). 10 single-use codes per batch,
  Argon2-hashed at rest, dummy-verify on bad input to avoid timing
  oracle. Login page has a "Forgot password?" link.
- **Account deletion** with cascade-clean of sessions (`DELETE
  /auth/me`).
- **Sessions table migrated** alongside `users.password_hash`,
  `users.phone_e164`, `users.phone_verified_at`. Raw `ALTER TABLE`
  applied to the live DB so existing rows weren't touched.

## Room invites + multi-user joining

- `RoomInvite` table — code, room_id, created_by, expires_at, max_uses,
  uses, revoked_at.
- Endpoints: `POST /rooms/{id}/invites`, `GET .../invites`,
  `DELETE /invites/{code}`, `GET /invites/{code}/preview`,
  `POST /invites/{code}/accept`.
- Frontend `↗ Share` button on the room rail → bottom-sheet modal
  to mint / copy / revoke 7-day invite links.
- Each link **capped at 10 joins** by default. Mint another to add
  more; revocation is instant.
- `/?invite=<code>` landing page shows preview (room name, inviter) to
  signed-out callers; "Sign in to join" flips to Login then back to
  preview with a Join button.
- Backend was tested with 10 fresh contexts joining the same link
  sequentially; 11th attempt rejected with HTTP 410.
- **Stub `current_user_id` removed**: previously every signed-in user
  shared `"u-dev"` identity. Replaced with real session-derived user;
  Richard's existing rooms were re-attached via SQL fix so he kept
  access. Test suite updated — the `client` fixture now auto-
  registers a throwaway user + attaches the session header so existing
  tests still pass (28/28 green).
- **Invite landing → auth flow** correctly toggles between three
  states: preview (signed-out), login (clicked "Sign in to join"),
  preview-with-Join (back signed-in). The `authForInvite` flag flips
  off on `onSignedIn`. Single recipe URL works for both new and
  existing accounts.

## First-time onboarding

- **Welcome room** auto-created on `/auth/register`. Name = "Welcome
  to Bible IU 👋", scripture_context = `{"focused_verse": "JHN.3.16"}`,
  user inserted as owner. Survives the full GET /rooms scope check.
- **NotesSidebar tip cards** — when the active room name starts with
  "Welcome to Bible IU" AND the Yjs notes array is empty, the sidebar
  renders 4 amber-tinted "Quick tour" cards (asking the agent,
  personal vs group, invites, original languages + cross-refs). A
  `dismiss` link persists a per-room `bible-iu:welcome-tips-
  dismissed:{roomId}` localStorage flag.
- **Workspace seeded focus**: `RoomRead` now carries
  `scripture_context`. SocialShell + MobileShell each parse
  `JHN.3.16` → `{book, chapter, verse, ref}` and set focus once per
  room. A Workspace effect syncs `book/chapter` to focus so the
  BibleView lands on John 3 instead of Genesis 1 on the welcome room's
  first open.

## Mobile-first overhaul

`SocialShell` (desktop) untouched. Below the `md` breakpoint, a
parallel `MobileShell` takes over.

- **Apple liquid-glass detached bottom panel** — translucent paper,
  `backdrop-blur-2xl backdrop-saturate-200`, soft outer shadow, inner
  highlight, white-translucent border. Fixed-positioned so scripture
  scrolls under it (the glass blur does its job).
- **Four tabs** (`Bible / Notes / Chat / Marks`) — SF-style outline ↔
  filled glyph swap on active. Notes tab has a red badge for unread
  count; Marks tab has a badge for bookmark count.
- **Standalone round AI/composer pill** at the bottom-right, same
  height as the tab bar, swaps icon per tab:
  - Bible → sparkle (toggles agent panel)
  - Notes → note glyph (toggles note composer)
  - Chat → speech bubble (toggles message composer)
  - Marks → no composer (the tab is the page)
- **Shared composer state**: tap the pill on any tab → the panel
  morphs into a chat-box across all tabs. Swipe between tabs and the
  composer stays open, glyph + placeholder swapping per context.
- **Composer drives**:
  - Bible → `Workspace.ask()` via a `forwardRef` handle
  - Notes → `notesApi.add({ scope: "personal", body, verse_anchor })`
  - Chat → placeholder (backend chat list UI still TBD)
- **AI panel on Bible tab** — when on, scripture + reasoning panel
  stacked; when off, scripture takes the whole tab. The ▲/▼ pill above
  the Bible toggles focus mode (hides breadcrumb + book/chapter
  toolbar) — separate from the agent toggle.
- **Bottom sheets** replace centered modals on mobile (Settings,
  New room, Share, Phone verify, Recover) — drag handle, slide-up
  animation, body-scroll lock. Escape closes.
- **Swipe gestures** for left/right tab navigation (60px threshold,
  ignores vertical drift).
- **Welcome room** auto-created at register, room rail shows real
  rooms from `GET /rooms` instead of fake seeds (the old `seed-1` /
  `seed-2` placeholders are gone).
- **First-visit fixes**: gate re-probe re-runs when `gate` flips back
  to "checking" (so the password screen submits cleanly); render order
  fixed so "Loading…" doesn't trap users when the gate is locked.
- **Login defaults to "Create account"** for first-time devices (until
  a `bible-iu:has-signed-in` localStorage flag flips it). Top tab pair
  makes both modes obvious (was a small underlined link before).
- **`NotesSidebar.hideComposer`** prop — desktop keeps the inline
  textarea + Add; MobileShell passes `hideComposer` so the floating
  glass composer is the only path on phones.
- **Bottom-sheet primitive** — `BottomSheet.tsx`. On mobile slides up
  from the bottom with drag handle, 92vh cap, body-scroll lock,
  global Escape handler. On desktop falls back to a centered modal.
  All five mobile modals (Settings, NewRoom, Share, PhoneVerify,
  Recover) route through it.
- **Top-of-Bible focus pill (▼/▲)** restored — toggles the breadcrumb
  + book/chapter/translation toolbar (focus mode). Separate from the
  agent toggle.
- **Workspace `forwardRef`** with `{ ask, isPending }`. MobileShell
  holds the ref so its floating chat composer can `workspaceRef
  .current?.ask(text)` directly.

## Zoom levels (Bible + agent both follow)

Three steps inward to the verse, three back out:

1. **Verse** — focused via tap on the verse number, anchors the agent
   to that ref.
2. **Chapter** — verse-focus cleared, agent asks about
   `[About BOOK chapter N] …` and uses verse-1 as the retrieval anchor.
3. **Testament** — the Bible panel becomes a grid of all books in that
   testament (39 OT or 27 NT, canonical Protestant order). Agent uses
   `GEN.1.1` (OT) or `MAT.1.1` (NT) as anchor and frames as
   `[About the Old/New Testament] …`.
4. **The Bible** — two big cards (OT, NT) for swapping testaments.
   Agent frames as `[About the Bible] …`.

The prompt-bar placeholder updates at every level. Verified live:
"What's the main theme?" produces meaningfully different answers
verse → chapter → testament → Bible.

## Citation engine kill-switch

Per Richard's explicit override (in `rule-guide.MD §14` /
`citation-engine.MD §10` terms — known spec violation):

- Settings → Advanced → **Disable citation engine** toggle. Off by
  default, prominent `confirm()` dialog when enabling.
- `ReasoningRequest` carries `bypass_citation_engine: bool`.
- When on: engine skips parse + classify + verify + gate; orchestrator
  STILL runs `enforce()` (rule layer is non-bypassable — chat scope,
  notes privacy, language, etc. predicates remain).
- Generator switches to a different system prompt
  (`_PREAMBLE_BYPASS`) + schema (`_BYPASS_SCHEMA_PROMPT`) that
  encourages **long-form, exploratory answers**. Temperature bumped
  from 0.2 → 0.4.
- Verified: same question to John 3:16 → 128 chars with engine on,
  **2,542 chars** (5 paragraphs, Greek terms, tradition perspectives,
  pastoral application) with engine off.

## Bookmarks (last-read per book)

- `Bookmark` table — `UNIQUE(user_id, book)` so each book has at most
  one bookmark; 66 books → 66 bookmarks max.
- Endpoints: `GET /auth/bookmarks` (list), `PUT /auth/bookmarks/{book}`
  (upsert chapter+verse), `DELETE /auth/bookmarks/{book}`.
- BibleView: small ribbon button next to each verse number. Tap to
  set/replace the bookmark for the current book.
- **Divider line** rendered below the bookmarked verse: ↑ arrow, "LAST
  READ" label, solid colored line, **timestamp in the middle**, line
  continues on the other side.
- **Per-book color** — 16-hue palette in `lib/testament.ts` indexed
  by canonical book order. Drives the verse ribbon, divider arrow +
  text + line, and the cards in the Marks list. Same in light/dark.
- **Bookmarks tab** (Marks) — list of all bookmarks, ribbon icon in
  per-book color, ref, timestamp. Tap a card → jump to verse;
  X → remove.
- **Timezone setting** — Settings → General → Time zone dropdown
  (Auto with detected IANA name, UTC, US Eastern/Central/Mountain/
  Pacific, Alaska, Hawaii, São Paulo, London, Paris/Berlin/Rome,
  Moscow, Dubai, India, Singapore, Tokyo, Sydney). Backend now emits
  `+00:00` UTC marker on timestamps so the browser parses correctly.

## Social on group notes (opt-in)

- **Settings → "Social on group notes"** (off by default). When on,
  every **group**-scope, **non-agent** note grows a heart + comment
  thread underneath the body. Personal notes never expose this UI
  (rule-guide.MD §12). Agent-authored group notes also stay quiet —
  the agent should not be "liked".
- Tables: `note_likes` (UNIQUE(note_id, user_id) — one heart per
  user per note), `note_comments` (flat — no thread replies, by
  spec). Both FK `users.id` and `rooms.id`; `note_id` is the Yjs
  UUID (no SQL note row required for this to work).
- Endpoints (all require_member on the room):
  - `GET /rooms/{room}/notes/{note}/social` →
    `{likes, liked_by_me, comments[]}`
  - `POST /rooms/{room}/notes/{note}/like` (toggle)
  - `POST /rooms/{room}/notes/{note}/comments` (add)
  - `DELETE /rooms/{room}/notes/{note}/comments/{id}` (own only)
- Frontend: `NoteSocialBlock` inside `NotesSidebar.tsx`. Heart count
  + comments count are always visible when the block renders;
  comment list expands on tap.
- `UserProfile.id` now flows from `/auth/me` → `App` →
  `MobileShell`/`SocialShell` → `NotesSidebar` so own-comment delete
  buttons can render.

## Verse annotations — paper-Bible highlighter, Apple-style

- **Apple "select-and-hold" UX.** Nothing visible until the user
  long-presses the verse text (~380ms). On fire, a frosted glass
  banner slides up from the bottom (`backdrop-blur-2xl`,
  `bg-white/70`, `border-white/40`); horizontally scrollable row
  with all the tools.
- **Tools (v1):** Highlight × 5 colors, Underline × 5 colors,
  Strikethrough × 5 colors, Eraser. Tapping the swatch a verse
  already has clears that kind; eraser clears every kind on the
  verse and dismisses.
- **Palette:** yellow / green / blue / pink / orange. Stored as a
  palette key on the backend; mapped to Tailwind classes in
  `frontend/src/workspace/BibleView/annotations.ts`.
- **Per-user, room-independent.** Like marks in a paper Bible the
  reader takes everywhere; not scoped to a study room.
- **Schema:** `annotations(id, user_id, verse_id, kind, color)` with
  `UNIQUE(user_id, verse_id, kind)` — one row per (user, verse,
  kind), so a verse can carry a highlight + underline + strike at
  once.
- **Endpoints (all `dependencies=[Depends(require_password)]`):**
  - `GET /auth/annotations` — list everything for the signed-in user.
  - `PUT /auth/annotations/{verse_id}/{kind}` `{color}` — upsert.
  - `DELETE /auth/annotations/{verse_id}/{kind}` — clear one kind.
  - `DELETE /auth/annotations/{verse_id}` — eraser (clear all kinds).
- **Threading:** App loads on sign-in (`MobileShell` + `SocialShell`
  both). State + apply/clear callbacks flow → `Workspace` →
  `CenterColumn` → `BibleView`. BibleView paints `bg-`/`underline`/
  `line-through` classes on the verse text span and hosts the
  `AnnotationToolbar` (`frontend/src/workspace/BibleView/
  AnnotationToolbar.tsx`).
- **Gesture details:** `onPointerDown` arms a 380ms timer;
  `onPointerMove` cancels if the user drags > 8px in either axis
  (scroll intent); `onPointerUp` either fires the toolbar or falls
  through to existing focus behavior. `onContextMenu` is suppressed
  so the native long-press menu doesn't leak in. `vibrate(10)` for
  haptic on Android Chromium (iOS Safari ignores it, by design).
- **Dismissal:** tap-outside scrim, ✕ button, or Esc.

## Communication channel

- **Save Protocol added to CLAUDE.md** — new §8 defines exactly what
  "save this project" means: update WORKSTREAM.md, commit, push. Both
  Mark and Alex are bound by it. The preamble in WORKSTREAM.md was also
  added — the "READ THIS FIRST" block explaining the shared whiteboard.
- **Autopush switched from 15m to daily** — backup-only, no tunnel.

## Mainstream readiness — Phase 1 & 2 shipped

Deploy infrastructure landed (2026-06-04):
- **Top-level `<ErrorBoundary>`** (`src/shell/ErrorBoundary.tsx`)
  swallows render crashes, shows the glass error card, dynamic-imports
  Sentry only if `VITE_SENTRY_DSN` is set.
- **`.env.example`** files for both backend and frontend.
  `backend/.env` (real values) stays gitignored.
- **`Dockerfile`** — two-stage: node:20 builds the Vite app, then a
  python:3.12-slim runtime serves both API + static assets on one
  port. Volume mount at `/data` holds SQLite + ystore.
- **`fly.toml`** — one machine, 1GB persistent volume, `/healthz`
  probe, 512MB RAM, auto-stop. `fly secrets set` for `DEEPSEEK_API_KEY`,
  `BIBLE_IU_PASSWORD`, `SENTRY_DSN`, Twilio.
- **Alembic baseline** (`alembic.ini` + `backend/alembic/`). Initial
  revision `0001_baseline` is a no-op; run `alembic stamp
  0001_baseline` against an existing DB once, then generate revisions
  for every schema change.
- **GH Actions** at `.github/workflows/ci.yml` — runs pytest, tsc,
  vite build, and Docker image build on every push/PR.
- **PWA manifest + service worker** (`frontend/public/manifest.webmanifest`,
  `sw.js`). Stale-while-revalidate on the SPA shell; API/WebSocket
  bypass the cache. `registerServiceWorker.ts` skips in dev.
- **Per-user rate limit** in `rate_limit.py` — bucket key is
  `user:<session_token>` when signed in, `ip:<addr>` otherwise.
- **`/healthz` deep readiness probe** — pings the DB, reports whether
  `DEEPSEEK_API_KEY` is set, and whether the YjS sync server is up.
- **Structured JSON logging** (`backend/api/observability.py`) — one
  line per record, queryable via Fly's log explorer.
- **Optional Sentry** — gated on `SENTRY_DSN`; both frontend (`@sentry/browser`)
  and backend (`sentry-sdk[fastapi]`) are import-on-demand so dev
  bundles stay clean.

What's still on the user to do (external action required):
1. Rotate `DEEPSEEK_API_KEY` (it's been in chat). Move to `fly secrets set`.
2. Drop in PWA icons: `frontend/public/icon-180.png`,
   `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`.
3. `pip install -r backend/requirements.txt && alembic stamp
   0001_baseline` once locally so the existing DB is tracked.
4. `fly launch` (or `fly deploy` if the app already exists) →
   `fly volumes create bible_iu_data --size 1` → set secrets.
5. (Optional) `pip install sentry-sdk[fastapi]` + `npm i @sentry/browser`
   when ready for error tracking, then set DSN env vars.

Deferred to "features" track:
- Translations beyond KJV (WEB/ASV public domain easy; ESV/NIV licensed)
- Original-language Hebrew/Greek retrieval wiring (seeded, not used)
- Reading plans + reminders + audio (Faith Comes By Hearing)
- Share-as-image cards, search across notes, onboarding tutorial
- Paid tiers + payments, analytics, group/church tools

## WhatsApp-style data isolation + per-group admin

Stage 1 — Personal notes can no longer leak to other room members:
- New per-user Y.Doc named `notes_private__{userId}__{roomId}`. The
  backend (`yjs_sync.py:_personal_notes_doc_owner`) rejects any
  websocket connection where the session-token's user_id doesn't
  match the doc name.
- Frontend (`yjsNotes.ts`) now opens TWO Y.Docs per room: the shared
  group doc + the per-user personal doc. They're merged in-memory
  for the UI but never share bytes on the wire.
- The read-path filters out any leftover `scope === "personal"`
  notes from the shared doc (legacy data from before the split), so
  the privacy fix is in effect for old DBs too without a migration.
- Snapshot logic favors the personal doc; mutations are routed by
  scope on `add()` and by id-match on `update()/remove()`.

Stage 2-4 — Admin role + per-room agent controls:
- `RoomMember.role` is now load-bearing. Schema unchanged but the
  default kept. Live DB was backfilled — every existing group
  room's earliest member is now `admin` (19 rooms promoted).
- Room creator becomes `admin` on `POST /rooms` for group rooms;
  direct (1:1) rooms have no admin concept (every operation 400s).
- `_require_admin()` helper alongside `_require_member()`.
- New endpoints (all in `backend/api/main.py`):
  - `GET /rooms/{id}/members` — every member can read; names + roles.
  - `PATCH /rooms/{id}/members/{user_id}` `{role}` — admin-only.
    Refuses to demote the last admin (rooms can't get stranded).
  - `DELETE /rooms/{id}/members/{user_id}` — admin-only with same
    last-admin guard.
  - `GET /rooms/{id}/agent_settings` — every member reads.
  - `PATCH /rooms/{id}/agent_settings` — admin-only.
- New `rooms.agent_settings` JSON column. Defaults are restrictive:
  `agent_enabled=true`, `allow_web_search=false`,
  `allow_external_links=false`, `bypass_citation_engine_allowed=false`,
  `max_questions_per_user_per_day=null`.
- `POST /reason` now enforces these. If the admin disables the
  agent the request 403s before hitting DeepSeek; user-side
  citation bypass is gated by `bypass_citation_engine_allowed`.

Stage 5 — Frontend:
- New `AdminPanel` (`frontend/src/shell/AdminPanel.tsx`) — bottom
  sheet with two sections: Members and Agent. Promote/demote/remove
  controls hidden for non-admins; settings toggles disabled.
- `⚙` button in the room header opens it (group rooms only).
- `api.ts` exposes `roomMembers`, `roomMemberPatch`,
  `roomMemberRemove`, `roomAgentSettings`, `roomAgentSettingsPatch`
  + the `RoomMemberOut` / `AgentSettingsOut` types.

Verified live: smoketest user is admin in their room; default
agent settings returned from the live DB.

Still open (Stage 6 — next pass):
- Social endpoints (`/notes/{note_id}/like|comments`) still don't
  validate that note_id is a group note. With the Yjs split this
  is much less exploitable (personal note IDs never leave the
  author's wire), but the server can't yet prove a like target is
  a group note. Needs a backend registry of "known group note IDs"
  populated by Yjs observer.
- Settings on the server (use existing `User.preferences` JSON).
- A one-shot migration script that scrubs personal notes from
  existing shared Y.Docs (the read-path filter handles them in the
  UI today, but the bytes are still on disk in `ystore.db`).

## Phase 3 — Social scope check, settings sync, legacy scrub

**Social-endpoint scope check.** New `RegisteredGroupNote` table
(`(note_id PK, room_id, author_user_id)`) and endpoint
`POST /rooms/{id}/notes/{note_id}/register_group`. The frontend
`yjsNotes.ts` auto-registers every GROUP-scope note on `add()`;
personal notes never get registered. `_require_group_note()` gates
`GET .../social`, `POST .../like`, `POST .../comments` — unknown or
cross-room IDs 404. Verified: unregistered ID returns
`{"detail":"note not found in this room"}`, registered ID likes
successfully.

**Settings → server sync.** `User.preferences.ui = {…}` carries
debugMode, bypassCitationEngine, timezone, socialNotesEnabled
across devices. Translation helpers in `lib/settings.ts`:
`settingsToPreferences()` / `settingsFromPreferences()`. App
hydrates on `authMe()` (both bootstrap + fresh sign-in), debounced
PATCH (~600ms) on every change. Pre-hydration changes don't fire
the PATCH so a fresh device's localStorage defaults can't clobber
server state. `localStorage` is still authoritative locally, so an
offline session retains preferences.

**Legacy ystore scrub.**
`python -m backend.scripts.scrub_legacy_personal_notes [--dry-run]`
walks every shared room doc in `backend/data/yjs/ystore.db`,
replays its updates onto a fresh `Doc`, deletes entries where
`scope == "personal"`, and writes a replacement update. Skips
`conv__…` and `notes_private__…` docs. Idempotent — a second run
finds nothing. On the dev DB it scrubbed 20 leaked personal notes
across 4 rooms.

## Isolation + admin test suite + PWA icons

`tests/test_isolation.py` — 18 new tests, full pass alongside the
existing suite (46/46 green):
- **Yjs personal-doc gating** (3): owner can connect; another user
  is rejected with `WebSocketDisconnect`; no-session attempt is
  rejected.
- **Social scope check** (5): unregistered like 404s; register-then-
  like succeeds; re-register same user same room is idempotent;
  cross-room register 409s; comment-on-unregistered 404s.
- **Admin role** (6): creator-becomes-admin; direct rooms 400 on
  admin endpoints; member can't promote; admin can promote+demote;
  last-admin demotion + removal both 400.
- **Per-room agent settings** (3): conservative defaults; member
  can't PATCH; `agent_enabled=false` blocks `/reason` with 403.
- **`/rooms` returns role** (1): each row carries the caller's
  role; accounts for the auto-seeded Welcome room.

Fixed an inconsistency along the way: the auto-seeded Welcome room
used `role="owner"` (pre-Phase-2 vocab). Switched to `"admin"` so
admin-only endpoints work without re-promoting; live DB backfilled
(3 rows rewritten).

**PWA icons** — `frontend/scripts/generate-pwa-icons.py` writes
`icon-{180,192,512}.png` + `icon-maskable-512.png` into
`frontend/public/`. Simple monogram on the brand-cream background so
the manifest doesn't 404 in prod. Replace with real artwork before
public launch — this is the minimum viable shape.

## Account deletion cleanup + WEB translation + notes search

**Account deletion now actually deletes.** `DELETE /auth/me` performs
a full cascade:
- **Hard-deleted**: bookmarks, annotations, backup codes, phone
  verifications, note likes, registered group notes, room
  memberships.
- **Tombstoned** (body stays, author goes null): note comments,
  chat messages. UI shows "(deleted user)".
- **Ystore purge**: every `notes_private__{userId}__*` and
  `conv__{handle}__*` doc is dropped via direct sqlite delete.
- **Last-admin handling**: if the user was the sole admin of any
  group room, the longest-tenured remaining member auto-promotes;
  if no other members exist, the room is dropped with its invites
  / notes / comments / likes / chat messages.
- `NoteComment.author_user_id` was made nullable to support
  tombstoning (live DB migrated via table-swap; `NoteCommentOut`
  + frontend `NoteCommentOut` types updated). Empty-state in the
  comments serializer shows "deleted" / "(deleted user)" when
  null.
- 3 new tests cover wipe-on-delete, comment tombstoning, and
  last-admin promotion. Full suite: 49/49 green.

**WEB (World English Bible) seeded.** Public-domain modern English.
`python -m backend.data.seed_web` pulls
`https://bolls.life/static/translations/WEB.json`, normalizes book
1-66 to OSIS codes, inserts 31,105 verses (matched against the
existing Verse grid so KJV+WEB share rows). Translation switcher
now offers KJV (1611) + WEB (modern). Verified live:
`GEN.1.1` returns the expected text from each.

**Notes search.** Plain-text search input at the top of the Notes
sidebar — filters the active scope (Personal / Group). Strips HTML
before matching so styled notes still hit. Privacy preserved:
search runs in-browser, server never sees personal note bodies.
Empty-state differentiates "no notes yet" from "no matches for
your query".

## Share-as-image cards

Long-press a verse → annotation strip now ends with a **Share**
button (dark filled pill, arrow-up-from-tray icon). Tapping it:
- Renders a 1080×1080 PNG via Canvas. Card design: paper-cream
  background, verse text centered (auto-sized between 30-64px to
  fit ≤12 lines), reference + translation top-left, "Bible IU"
  bottom-right.
- Bakes in the user's marks: highlight as a tinted ribbon, box as a
  rounded outline, underline / double-underline / wavy drawn under
  the last text line, bold tinted text. Renderer lives in
  `frontend/src/lib/shareVerse.ts`.
- Hands off to `navigator.share({ files })` where available (iOS
  Safari, Android Chrome); falls back to a browser download on
  desktop.
- Verse text + reference are fetched on-demand from KJV via
  `api.bibleChapter()`. New `OSIS_TO_BOOK_NAME` map in `api.ts`
  provides the display book name.

## Real chat (post + live websocket fan-out)

Replaced the demo conversation with a real wire.

Backend:
- `GET /rooms/{id}/chat?limit=N` — most recent N messages in
  chronological order, members only. Bulk-loads authors and
  enriches each row with `author_handle`, `author_display_name`,
  `created_at`.
- `POST /rooms/{id}/chat` — now also requires membership (was just
  "room exists"); persists then publishes via `chat_hub.publish`.
- `WS /ws/chat/{id}` — per-room subscriber registry in
  `backend/api/chat_hub.py`. Auth: app password + session token
  via query params; membership enforced on connect. Slow
  subscribers (full queue) drop messages instead of blocking the
  writer.
- `ChatMessageRead` schema gained `author_handle`,
  `author_display_name`, `created_at`.

Frontend:
- `ChatPanel` loads initial state via `api.chatList()`, opens
  `wss://.../ws/chat/{roomId}`, appends new messages to state,
  reconnects with exponential backoff on close.
- Member count in the header is loaded from `/members`; "Demo"
  badge removed.
- Composer's chat tab now POSTs via `api.chatPost()`; the WS
  subscription picks the message back up (no optimistic append, so
  no duplicates).
- Empty state: "No messages yet. Be the first to say something."
- Deleted demo data: `DemoMsg`, `DEMO_THREAD`, the per-room session
  state.

Verified end-to-end: WS subscriber receives a posted message in
under a second; full test suite still green at 49/49.

## Reading plans

Three hardcoded plans (`backend/api/reading_plans.py`) with daily
reference lists:
- **A Psalm a day** (171 days, Ps 119 split into stanzas).
- **New Testament in 90 days** (260 chapters chunked evenly).
- **Bible in a year** (OT walk-through with NT layered every 4th day).

Schema: `reading_plan_enrollments(user_id, plan_id, started_at)` +
`reading_plan_progress(user_id, plan_id, day_index)`. Both gained
`UNIQUE(user_id, plan_id[, day_index])`. Live DB migrated.

Endpoints:
- `GET /reading-plans` — full catalogue + caller's enrollment +
  derived current day + completed count.
- `POST /reading-plans/{id}/enroll` — idempotent, starts the clock.
- `DELETE /reading-plans/{id}/enroll` — leaves; progress kept by
  default so re-joining resumes where the user left off.
- `GET /reading-plans/{id}/today` — current day's reference list +
  completion flag.
- `POST /reading-plans/{id}/days/{n}/complete` — log day done.

Frontend: new **Reading plans** section in the Profile sheet
(`frontend/src/shell/Settings.tsx`). Each plan shows summary +
length; enrolled cards show "Day N of M · X done" + today's refs
(or a green ✓ when already completed) with a Done button.

End-to-end verified live: list → enroll → today → mark complete.

## Accessibility audit pass

Applied the top 8 fixes from the WCAG 2.1 AA audit (the ones most
likely to be flagged by axe-core or a real screen-reader user):

1. **Global `:focus-visible` ring + `prefers-reduced-motion` guard**
   in `index.css`. Every interactive element now shows a keyboard
   focus ring (mouse focus stays clean); reduced-motion users get
   animation durations collapsed to near-zero.
2. **`role="log" aria-live="polite"`** on the ChatPanel scroller so
   screen readers hear new messages.
3. **Roving-tabindex + arrow-key navigation** on the WAI-ARIA radio
   and tab patterns: NotesSidebar Personal/Group selector,
   BibleView InlineNotePanel scope selector, the bottom tab bar.
4. **Tab-key focus trap + focus restoration** in `BottomSheet`.
   Capture activeElement on open, focus the dialog, cycle Tab
   inside the dialog, restore focus to the trigger on close.
   Dialog gets `aria-label` from the sheet title.
5. **Missing `aria-label` on unlabeled inputs**: timezone select,
   chat/note/ask composer input, note social comment textarea.
6. **`role="tab"` / `aria-selected`** on IOSTabButton + parent
   `role="tablist"` on the bottom bar nav.
7. **`aria-orientation="horizontal"`** on the annotation toolbar.
8. **Ctrl/Cmd-B/I/U keyboard shortcuts** in `RichNoteField`.

Full test suite still green (49/49). Visual styling unchanged for
mouse users; keyboard users finally have a usable focus path.

## Other bugs squashed

- **LLM unresponsive after a restart** — backend was started without
  `.env` sourced, so `DEEPSEEK_API_KEY` and `BIBLE_IU_PASSWORD` weren't
  in the process environment. Always: `set -a && source backend/.env
  && set +a && python3 -m uvicorn …`
- **Yjs WebSocket 403 spam** — when `roomId` was empty (rail still
  loading), the URL became `/ws/yjs/?password=…` matching no route.
  Both `useYjsNotes` and `useYjsConversation` now short-circuit to a
  no-op handle when room ID or handle is missing.
- **Welcome room respected** — `scripture_context` plumbed through
  `RoomRead`. Workspace seeds focus on first open and the Bible view
  honors `focus.book / chapter` via a sync effect so the new welcome
  user lands on `JHN.3.16` instead of `GEN.1.1`.
- **Mobile audit pass with Playwright** — installed `playwright@1.60`
  + chromium and re-screenshot on iPhone 13 viewport after each change.
  Screenshots saved to `/tmp/*.png` during dev; not committed.
- **Header crowding** on the SocialShell (top app bar) — Chat/Study
  labels collapsed to icons below md, ThemeToggle gained a `compact`
  mode (icon only on phones).
- **Workspace recovery** after the `current_user_id` fix — Richard's
  pre-stub rooms (`"1"`, `"agent-notes-test"`) were re-attached via
  raw SQL `INSERT INTO room_members …`. The two old fake-seed rooms
  (`seed-1` = "Genesis study", `seed-2` = "Direct: Sam") were
  recreated as real backend rows pointing at those IDs so any
  IndexedDB content keyed by those names would re-attach.
- **First-visit white page** root cause was a render-order bug in
  App.tsx: `gate === "checking" || auth.phase === "checking"` short-
  circuited to Loading even when gate had already flipped to "locked".
  Reordered checks so gate is decided first.
- **Sign-in-to-join stuck on Loading** — `useEffect` that probes the
  gate had empty deps, so once `PasswordGate.onUnlock()` reset gate
  to "checking", nothing re-fired. Effect now depends on `gate`.

## Where things live

- **Backend** — FastAPI + SQLAlchemy. Models in
  `backend/data/models.py`; new tables migrated to the live SQLite at
  `backend/data/bible-iu.sqlite` via raw `sqlite3` ALTER statements.
- **Auth/profile/phone/backup/bookmark endpoints** —
  `backend/api/auth_users.py`. All gated by `Depends(require_password)
  + Depends(require_user)` (or the password-only gate for endpoints
  that don't need a session like preview-invite).
- **Citation engine** — `backend/agent/reasoning/citation_engine.py`.
  `bypass` flag added to `run()`.
- **DeepSeek generator** — `backend/agent/skills/deepseek_backends.py`.
  Bypass path uses `_PREAMBLE_BYPASS` + `_BYPASS_SCHEMA_PROMPT`.
- **Orchestrator** — `backend/agent/orchestrator.py`. `enforce()` ALWAYS
  runs; only the engine internals get skipped.
- **Mobile shell** — `frontend/src/shell/MobileShell.tsx`. The desktop
  shell is still `frontend/src/shell/SocialShell.tsx`. App.tsx routes
  between them by `useIsDesktop()`.
- **Workspace** — `frontend/src/workspace/Workspace.tsx` is now a
  `forwardRef` exposing `{ ask, isPending }` so MobileShell can drive
  the agent from its floating composer.
- **Per-book colors + testament metadata** —
  `frontend/src/lib/testament.ts` (`bookColor()`, `OT_BOOKS`,
  `NT_BOOKS`, `testamentOf`, etc.).

## Deferred / known limitations

- **Twilio SMS** is wired but A2P 10DLC is required for US carrier
  delivery. Workaround: buy a Twilio toll-free number (faster approval)
  or register the existing number for A2P.
- **Group note composing from mobile** — the P/G scope toggle was
  pulled from the floating composer so all three tab composers have
  matching length. Notes default to personal. A future surface
  (per-room setting or long-press) brings group back.
- **Chat tab** is the composer only; the message list / persistence
  layer is still placeholder.
- **Chapter-zoom retrieval** anchors to verse 1 of the chapter, so the
  agent sometimes complains it doesn't have enough chapter context.
  Broader chapter-wide retrieval would be a backend retriever
  enhancement.
- **Server-side Yjs persistence** appears to write all docs to a single
  shared SQLite path; content is safe in browser IndexedDB but cross-
  device sync needs deeper investigation.

---

## UI iteration log — the bottom-bar polish dance

In chronological order, because the floating glass bar took many tiny
nudges to land:

1. **Quick mobile polish** — header icons, focus-pill remap, Yjs
   empty-roomId no-op, Settings Escape handler. Done before the deep
   redesign.
2. **Mobile-first overhaul, scaffold** — MobileShell, four tabs
   (Bible / Ask / Notes / Chat), top app bar, drawer rail, swipe
   between tabs. AI panel rendered as Ask tab.
3. **Bottom sheets** for modals.
4. **Bible tab back to stacked (Bible + Reasoning)** per request — the
   user wanted the agent visible without tab-switching. Ask tab kept
   for full-screen reasoning.
5. **AI slider toggle** on Bible tab — small 💭 pill in the top bar
   to hide / show the agent panel; tab bar dropped from 4 → 3 tabs.
6. **iOS-style tab bar** — frosted translucent background, filled vs
   outline SF-style glyphs, smaller labels, safe-area inset, iMessage-
   red badge with white ring.
7. **Apple liquid-glass detached bar** — bar lifted off the bottom
   edge, became a centered floating pill with rounded-28, backdrop-
   blur-2xl, soft shadow, inner highlight. AI pill in top bar redone
   with matching glass. Bar `position: fixed` so scripture scrolls
   under it.
8. **Composer inside the glass panel** — the prompt bar was extracted
   from Workspace; on Bible+AI-on, the floating bar transforms into a
   chat composer. Tap AI pill to hide → tabs return. The bar visually
   has two modes for the same surface.
9. **AI pill moved to the bottom-right** — standalone glass capsule
   next to the centered tab bar, same vertical level. Composer form
   gets `mr-[88px]` to clear the pill.
10. **Bible runs all the way down** when AI off — drops the inner
    wrapper's `padding-bottom` so scripture ghosts through the glass
    bar (the proper Liquid Glass treatment).
11. **Notes + Chat composers swapped in too** — unified `composerOpen`
    flag drives all three tabs. Inline composers removed from
    NotesSidebar + ChatPanel.
12. **Equal-sized pills** — all three tab pills (Bible / Notes /
    Chat) and the standalone AI pill became identical 60×60 icon-only
    pills. Labels dropped — outline vs filled glyph swap is enough.
13. **Shared composer state** — `composerOpen` collapsed from a per-
    tab record to a single boolean so swiping between tabs preserves
    "the pill is on, panel is in composer mode."
14. **Round AI pill** — `h-[64px] w-[64px] rounded-full` perfect
    circle, matching the tab bar's natural height.
15. **Composer height matched** — `h-[60px]` → `h-[64px]` so the
    Bible/Notes/Chat composers visually align with the AI pill.
16. **Notes composer matches Bible/Chat** — P/G scope toggle removed
    so the input width is identical to the other tabs. Notes default
    to personal.
17. **Marks tab added** (4th tab) — bookmark glyph with badge count.
18. **Tab bar shifted** — centered → left-aligned (pl-3) → too far
    left → pl-[40px] → too far right → pl-[20px]. The AI pill always
    holds the bottom-right corner.

## Bookmarks visual polish (chronological)

1. **Flag icon next to verse number** — outline / filled ribbon.
2. **Divider line below the bookmarked verse** — initially gradient-
   to-transparent on the right.
3. **Up arrow icon** on the divider instead of a duplicate ribbon
   (the arrow points at the verse above).
4. **Continuous line** — gradient swapped for solid color edge to edge.
5. **Timestamp in the middle** — date + time chip splits the line in
   two halves.
6. **Timezone-aware** — backend timestamps gained UTC marker; Settings
   → Time zone dropdown drives `Intl.DateTimeFormat({ timeZone })` in
   both divider and Marks list.
7. **Per-book color** — 16-hue palette in canonical-order indexing.
   GEN amber, EXO rose, LEV sky, NUM emerald, … REV color 11. Same
   color drives the verse-number ribbon, divider arrow + label + line
   + timestamp, and the Marks list card icon.

## Quick reference — common commands

- **Restart backend with env loaded** (don't skip this!):
  ```bash
  cd "/Users/richardgass/Desktop/Bible IU/files"
  set -a && source backend/.env && set +a
  nohup python3 -m uvicorn backend.api.main:app \
    --host 127.0.0.1 --port 8765 --log-level warning \
    > /tmp/bible-backend.log 2>&1 & disown
  ```
- **Backend tests**: `cd backend && python3 -m pytest -q`
- **Frontend type-check**: `cd frontend && npx tsc --noEmit`
- **Live URLs**:
  - https://bible.access-term.com — public, password gate
    (`bible2026`), then sign in / create account
  - localhost:5173 — Vite dev server (HMR)
  - localhost:8765 — uvicorn backend
- **Mobile audit screenshot**:
  ```bash
  cd frontend && node _audit.mjs  # template in earlier sessions; saves to /tmp/*.png
  ```
