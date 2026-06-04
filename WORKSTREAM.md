# Bible IU — workstream notes

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
