/**
 * Mobile-first shell. Replaces SocialShell below the md breakpoint.
 *
 * Layout:
 *   • Top app bar (hamburger, room name, share, settings)
 *   • Tab content (Bible / Ask / Notes / Chat)  — full screen
 *   • Bottom tab bar (4 tabs, 56px tall, large tap targets)
 *
 * Rooms rail is a left drawer; modals are bottom sheets (BottomSheet).
 * The desktop SocialShell remains untouched.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceHandle } from "../workspace/Workspace";
import type { Theme } from "../lib/theme";
import type { Settings } from "../lib/settings";
import {
  api,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationOut,
  type BookmarkOut,
  type RoomOut,
} from "../lib/api";
import { GLASS_CARD_INLINE } from "../lib/glass";
import {
  AnnotationToolbar,
  type AnnotationTarget,
} from "../workspace/BibleView/AnnotationToolbar";
import { bookColor } from "../lib/testament";
import { useYjsNotes } from "../workspace/NotesSidebar/yjsNotes";
import { NotesSidebar } from "../workspace/NotesSidebar/NotesSidebar";
import { Workspace, type VerseFocus } from "../workspace/Workspace";
import { Avatar } from "./Profile";
import { SettingsModal } from "./Settings";
import { NewRoomModal, type NewRoomValues } from "./NewRoomModal";
import { ShareRoomModal } from "./ShareRoomModal";

interface DemoMsg {
  from: string;
  mine?: boolean;
  body: string;
  /** Display timestamp like "9:14 AM". */
  time: string;
}

interface RoomItem {
  id: string;
  type: "group" | "direct";
  name: string;
  focusedVerse?: string;
}

type Tab = "bible" | "notes" | "chat" | "bookmarks";
const TAB_ORDER: Tab[] = ["bible", "notes", "chat", "bookmarks"];

/** Minimum horizontal distance (px) to count as a swipe vs scroll. */
const SWIPE_THRESHOLD = 60;
/** Maximum vertical drift (px) before we abort and treat as scroll. */
const SWIPE_MAX_VERT = 50;

interface Props {
  handle: string;
  /** Stable user id from /auth/me. Used to check "did I write this
   *  comment?" so we can show a delete affordance on it. May be empty
   *  while still loading. */
  selfUserId?: string;
  onSignOut: () => void;
  onDeleted: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  pendingRoomId?: string | null;
  onPendingRoomConsumed?: () => void;
}

export function MobileShell({
  handle,
  selfUserId,
  onSignOut,
  onDeleted,
  theme,
  onToggleTheme,
  settings,
  onChangeSettings,
  pendingRoomId,
  onPendingRoomConsumed,
}: Props) {
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("bible");
  // AI/reasoning slider: when true, the Bible tab shows scripture
  // stacked above the reasoning panel. When false, scripture takes the
  // whole tab — the agent is hidden. Toggled by the brain pill in the
  // top app bar; replaces the dedicated "Ask" tab.
  // Whether the contextual composer is open. ONE shared state across
  // all tabs so the bottom-right pill feels like a single button that
  // changes role per tab — toggle it on Bible and it stays on when
  // you swipe to Notes/Chat. What the composer DOES depends on the
  // active tab:
  //   bible → asks the agent (Workspace.ask)
  //   notes → adds a note via notesApi.add
  //   chat  → sends a chat message (placeholder until backend lands)
  const [composerOpen, setComposerOpen] = useState(false);
  // Backwards-compat alias: a lot of layout decisions hinge on
  // "is the agent visible" on the Bible tab. Keep the name local.
  const aiVisible = composerOpen;
  // Focus mode hides the breadcrumb + Bible toolbar so scripture takes
  // more vertical space. Toggled by the ▲/▼ pill above the Bible.
  const [focusMode, setFocusMode] = useState(false);
  // User's "last read" bookmark per book. Capped at 66 (one per Bible
  // book) by the backend's UNIQUE(user_id, book) constraint. Loaded
  // once at mount; updated locally for instant feedback.
  const [bookmarks, setBookmarks] = useState<BookmarkOut[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .authBookmarksList()
      .then((bs) => alive && setBookmarks(bs))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  // Verse annotations (highlighter / underline / strikethrough). Per
  // user, room-independent — like marks in a paper Bible they follow
  // the reader everywhere. Loaded once at mount; mutated locally for
  // instant feedback when the toolbar applies.
  const [annotations, setAnnotations] = useState<AnnotationOut[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .authAnnotationsList()
      .then((rs) => alive && setAnnotations(rs))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const applyAnnotation = async (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
  ) => {
    try {
      const r = await api.authAnnotationSet(verseId, kind, color);
      setAnnotations((as) => [
        r,
        ...as.filter(
          (a) => !(a.verse_id === verseId && a.kind === kind),
        ),
      ]);
    } catch {}
  };
  const clearAnnotationKind = async (verseId: string, kind: AnnotationKind) => {
    try {
      await api.authAnnotationRemoveKind(verseId, kind);
      setAnnotations((as) =>
        as.filter((a) => !(a.verse_id === verseId && a.kind === kind)),
      );
    } catch {}
  };
  const clearAnnotations = async (verseId: string) => {
    try {
      await api.authAnnotationClear(verseId);
      setAnnotations((as) => as.filter((a) => a.verse_id !== verseId));
    } catch {}
  };
  // The active annotation target lives at the shell level so the
  // bottom panel can swap from tab bar → annotation tool strip when
  // the user long-presses a verse. Setting this back to null restores
  // the normal tab bar.
  const [annotationTarget, setAnnotationTarget] =
    useState<AnnotationTarget | null>(null);
  /**
   * Single-tap ribbon at verse V:
   *   - V already has an entry → remove it (toggle off).
   *   - No entries in this book yet → add V (becomes the bookmark).
   *   - V is ABOVE the current bookmark → add a flag at V.
   *   - V is BELOW the current bookmark → MOVE the bookmark forward
   *     to V. The old bookmark position stays as a flag (it's now
   *     above the new bookmark).
   *   - V is AT the bookmark → handled above (existing toggle path
   *     deletes the bookmark).
   * Flags never live below the bookmark; this rule emerges naturally
   * because tapping below always becomes the new bookmark.
   */
  async function setBookmark(book: string, chapter: number, verse: number) {
    const inBook = bookmarks.filter((b) => b.book === book);
    const existing = inBook.find(
      (b) => b.chapter === chapter && b.verse === verse,
    );
    if (existing) {
      try {
        await api.authBookmarkRemoveAt(book, chapter, verse);
        setBookmarks((bs) =>
          bs.filter(
            (b) =>
              !(b.book === book && b.chapter === chapter && b.verse === verse),
          ),
        );
      } catch {}
      return;
    }
    // Add an entry. The "deepest in the book" auto-derives whether
    // this becomes the new bookmark (deepest) or a flag (above).
    try {
      const r = await api.authBookmarkSet(book, chapter, verse);
      setBookmarks((bs) => [r, ...bs]);
    } catch {}
  }
  async function removeBookmark(book: string) {
    try {
      await api.authBookmarkRemove(book);
      setBookmarks((bs) => bs.filter((b) => b.book !== book));
    } catch {}
  }
  async function removeBookmarkAt(
    book: string,
    chapter: number,
    verse: number,
  ) {
    try {
      await api.authBookmarkRemoveAt(book, chapter, verse);
      setBookmarks((bs) =>
        bs.filter(
          (b) =>
            !(b.book === book && b.chapter === chapter && b.verse === verse),
        ),
      );
    } catch {}
  }
  // Double-tap-on-divider: consume the active mark and fall back to
  // the next-deepest past flag (always above the deleted position).
  // Repeat → walks UP through the trail of past reads until the book
  // has no flags left.
  function handleBookmarkDoubleTap(
    book: string,
    chapter: number,
    verse: number,
  ) {
    void removeBookmarkAt(book, chapter, verse);
    // Of the remaining flags in this book, pick the highest (deepest).
    const remaining = bookmarks
      .filter(
        (b) =>
          b.book === book &&
          !(b.chapter === chapter && b.verse === verse),
      )
      .sort((a, b) => {
        if (a.chapter !== b.chapter) return b.chapter - a.chapter;
        return b.verse - a.verse;
      });
    const prior = remaining[0];
    if (prior) {
      setFocus({
        book: prior.book,
        chapter: prior.chapter,
        verse: prior.verse,
        ref: `${prior.book}.${prior.chapter}.${prior.verse}`,
      });
    }
  }
  const [composerDraft, setComposerDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Held so we can refocus after submitting — otherwise iOS dismisses
  // the keyboard between messages and the user has to re-tap the
  // input every time. Especially noticeable on the chat tab.
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  // Session-local chat. Per-room so switching rooms doesn't bleed
  // messages. Goes away on refresh — real chat (POST /rooms/{id}/chat
  // + ws) replaces this once wired up. The seed thread in
  // ChatPanel still appears below as the "demo conversation".
  const [chatByRoom, setChatByRoom] = useState<Record<string, DemoMsg[]>>({});
  const workspaceRef = useRef<WorkspaceHandle | null>(null);
  function toggleComposer() {
    setComposerOpen((v) => !v);
  }
  function submitComposer() {
    const text = composerDraft.trim();
    if (!text || sending) return;
    if (tab === "bible") {
      workspaceRef.current?.ask(text);
    } else if (tab === "notes") {
      notesApi.add({
        body: text,
        scope: "personal",
        verse_anchor: focus?.ref,
      });
    } else if (tab === "chat" && active) {
      const msg: DemoMsg = {
        from: "You",
        mine: true,
        body: text,
        time: new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        }),
      };
      setChatByRoom((prev) => ({
        ...prev,
        [active.id]: [...(prev[active.id] || []), msg],
      }));
    }
    setComposerDraft("");
    setSending(true);
    setTimeout(() => setSending(false), 250);
    // Keep the keyboard up so the user can fire off the next thought
    // without re-tapping the input. iOS blurs the field on form
    // submit by default; this re-grabs focus on the same gesture
    // chain so the keyboard never animates away.
    composerInputRef.current?.focus();
  }
  const [railOpen, setRailOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [focus, setFocus] = useState<VerseFocus | null>(null);
  const [seededRoomId, setSeededRoomId] = useState<string | null>(null);

  const active = useMemo(
    () => rooms.find((r) => r.id === activeId),
    [rooms, activeId],
  );
  const notesApi = useYjsNotes(activeId);

  // Seed focus from a room's scripture_context exactly once per room.
  useEffect(() => {
    if (!active || !active.focusedVerse) return;
    if (seededRoomId === active.id) return;
    const m = /^([A-Z0-9]{2,4})\.(\d+)\.(\d+)$/.exec(active.focusedVerse);
    if (!m) return;
    setFocus({
      book: m[1],
      chapter: Number(m[2]),
      verse: Number(m[3]),
      ref: active.focusedVerse,
    });
    setSeededRoomId(active.id);
  }, [active, seededRoomId]);

  useEffect(() => {
    let alive = true;
    api
      .listRooms()
      .then((list) => {
        if (!alive) return;
        const mapped: RoomItem[] = list.map((r: RoomOut) => ({
          id: r.id,
          type: (r.type === "direct" ? "direct" : "group") as
            | "group"
            | "direct",
          name: r.name ?? "(unnamed)",
          focusedVerse: r.scripture_context?.focused_verse,
        }));
        setRooms(mapped);
        if (pendingRoomId && mapped.some((r) => r.id === pendingRoomId)) {
          setActiveId(pendingRoomId);
          onPendingRoomConsumed?.();
        } else if (!activeId && mapped.length > 0) {
          setActiveId(mapped[0].id);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pendingRoomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Touch state for swipe-between-tabs. We track the start point and
  // decide on touchend whether the gesture was decisive horizontal
  // (≥60px) without too much vertical drift (≤50px). If so, we step
  // the active tab one slot left or right.
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    // On the Bible tab, horizontal swipe means "next chapter / prev
    // chapter" — owned by BibleView itself. The tab-switching
    // gesture only applies on Notes/Chat/Marks.
    if (tab === "bible") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dy) > SWIPE_MAX_VERT) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    const idx = TAB_ORDER.indexOf(tab);
    if (dx < 0 && idx < TAB_ORDER.length - 1) setTab(TAB_ORDER[idx + 1]);
    if (dx > 0 && idx > 0) setTab(TAB_ORDER[idx - 1]);
  }

  async function createRoom(values: NewRoomValues) {
    try {
      const r = await api.createRoom(values.type, values.name);
      const item: RoomItem = { id: r.id, type: values.type, name: values.name };
      setRooms((rs) => [item, ...rs]);
      setActiveId(item.id);
    } catch {
      const id = `local-${Date.now()}`;
      setRooms((rs) => [{ id, type: values.type, name: values.name }, ...rs]);
      setActiveId(id);
    }
    setRailOpen(false);
  }

  return (
    <div className="flex h-full flex-col bg-paper-soft dark:bg-neutral-950">
      {/* Top app bar */}
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-paper px-2 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <button
          onClick={() => setRailOpen(true)}
          className="grid h-10 w-10 place-items-center rounded text-neutral-700 hover:bg-paper-soft dark:text-neutral-200 dark:hover:bg-neutral-800"
          aria-label="Open rooms"
        >
          ☰
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
          {active?.name ?? "Bible IU"}
        </div>
        <div className="flex items-center gap-1">
          {active && active.type === "group" && !active.id.startsWith("local-") && (
            <button
              onClick={() => setShareOpen(true)}
              className="grid h-10 w-10 place-items-center rounded text-neutral-700 hover:bg-paper-soft dark:text-neutral-200 dark:hover:bg-neutral-800"
              aria-label="Share"
              title="Share room"
            >
              ↗
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="grid h-10 w-10 place-items-center rounded hover:bg-paper-soft dark:hover:bg-neutral-800"
            aria-label="Settings"
          >
            <Avatar handle={handle} size={28} />
          </button>
        </div>
      </header>

      {/* Tab content area */}
      <main
        className="relative min-h-0 flex-1 overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {!active ? (
          <EmptyState
            title="No room selected"
            body="Tap ☰ to open the menu and pick or create a room."
          />
        ) : (
          <div className="absolute inset-0">
            {/* No bottom padding: every tab's content now scrolls all
                the way to the bottom edge, with the floating glass
                bar overlaying it. All composers live in the bar, so
                nothing fixed-positioned at the bottom of the content
                needs reserved space. */}
            {tab === "bible" && (
              // Bible tab: when the AI slider is on (default) the
              // reasoning panel stacks below scripture; when off,
              // scripture takes the whole tab and the agent is hidden.
              <Workspace
                ref={workspaceRef}
                roomId={active.id}
                roomName={active.name}
                focus={focus}
                onFocusChange={setFocus}
                notes={notesApi}
                focusMode={focusMode}
                onToggleFocus={() => setFocusMode((v) => !v)}
                debugMode={settings.debugMode}
                bypassCitationEngine={settings.bypassCitationEngine}
                handle={handle}
                mobilePanel={aiVisible ? undefined : "bible"}
                hidePrompt
                // BibleView gets ALL bookmarks so each past-marked
                // verse shows a filled ribbon. The divider rendering
                // is filtered to the latest per book inside BibleView.
                bookmarks={bookmarks}
                onSetBookmark={setBookmark}
                onRemoveBookmarkAt={removeBookmarkAt}
                onDoubleTapBookmark={handleBookmarkDoubleTap}
                timezone={settings.timezone}
                selfUserId={selfUserId}
                socialNotesEnabled={settings.socialNotesEnabled}
                annotations={annotations}
                onApplyAnnotation={applyAnnotation}
                onClearAnnotationKind={clearAnnotationKind}
                onClearAnnotations={clearAnnotations}
                annotationTarget={annotationTarget}
                onAnnotationTargetChange={setAnnotationTarget}
              />
            )}
            {tab === "notes" && (
              <NotesSidebar
                focus={focus}
                notes={notesApi}
                roomId={active.id}
                roomName={active.name}
                hideComposer
                socialNotesEnabled={settings.socialNotesEnabled}
                selfUserId={selfUserId}
              />
            )}
            {tab === "chat" && (
              <ChatPanel
                roomName={active.name}
                userMessages={chatByRoom[active.id] || []}
              />
            )}
            {tab === "bookmarks" && (
              <BookmarksPanel
                bookmarks={pickLatestPerBook(bookmarks)}
                timezone={settings.timezone}
                onPick={(b) => {
                  setFocus({
                    book: b.book,
                    chapter: b.chapter,
                    verse: b.verse,
                    ref: `${b.book}.${b.chapter}.${b.verse}`,
                  });
                  setTab("bible");
                }}
                // X = remove just the active bookmark entry. Past
                // flags in the book survive and the next-deepest one
                // becomes the new bookmark.
                onRemoveOne={(book, chapter, verse) =>
                  removeBookmarkAt(book, chapter, verse)
                }
                // Edit → Reset = wipe everything for this book
                // (active bookmark AND all past flags).
                onReset={(book) => removeBookmark(book)}
              />
            )}
          </div>
        )}
      </main>

      {/* Standalone glass AI pill — same vertical level as the tab
       *  bar below, but anchored to the bottom-right. Visible only on
       *  each tab. Bible → AI sparkle; Notes → pencil; Chat → speech
       *  bubble. Tapping it flips the floating bar between the tabs
       *  view (closed) and a contextual composer (open). */}
      {(() => {
        const open = composerOpen;
        const meta =
          tab === "bible"
            ? {
                outline: <SparkleOutline />,
                filled: <SparkleFilled />,
                onLabel: "Hide AI panel",
                offLabel: "Show AI panel",
              }
            : tab === "notes"
              ? {
                  outline: <NotesOutline />,
                  filled: <NotesFilled />,
                  onLabel: "Hide note composer",
                  offLabel: "Show note composer",
                }
              : tab === "chat"
                ? {
                    outline: <ChatOutline />,
                    filled: <ChatFilled />,
                    onLabel: "Hide message composer",
                    offLabel: "Show message composer",
                  }
                : {
                    outline: <BookmarkOutline />,
                    filled: <BookmarkFilled />,
                    onLabel: "Bookmarks",
                    offLabel: "Bookmarks",
                  };
        return (
          <div
            className="pointer-events-none fixed bottom-0 right-3 z-40 pt-2"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
          >
            <button
              onClick={toggleComposer}
              // Square 64x64 pill, squircle corners matching the tab
              // bar (`rounded-[28px]`) so the two glass elements feel
              // like the same material rather than a circle next to a
              // rounded rectangle.
              className={`pointer-events-auto grid h-[64px] w-[64px] place-items-center rounded-[28px] border border-white/40 backdrop-blur-2xl backdrop-saturate-200 transition-all dark:border-white/10 ${
                open
                  ? "bg-white/60 text-neutral-900 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.6)] dark:bg-white/15 dark:text-neutral-50 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
                  : "bg-paper/55 text-neutral-700 shadow-[0_8px_28px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45)] dark:bg-neutral-900/45 dark:text-neutral-200 dark:shadow-[0_8px_28px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]"
              }`}
              aria-label={open ? meta.onLabel : meta.offLabel}
              aria-pressed={open}
              title={open ? meta.onLabel : meta.offLabel}
            >
              {open ? meta.filled : meta.outline}
            </button>
          </div>
        );
      })()}

      {/* Apple "liquid glass" detached tab bar — floats over the
       *  scripture/content rather than bolting to the bottom edge.
       *  Fixed positioning lets the glass blur show through whatever
       *  is behind it. Main content pads its bottom (see <main>) so
       *  scrolled text doesn't tuck permanently behind the bar. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-start pl-[20px] pr-[88px] pt-2"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
      >
        {annotationTarget ? (
          // Long-press on a verse hands the bottom panel to the
          // annotation tool strip. Same h-[64px] / rounded-[28px]
          // outer geometry as the tab bar so the swap is seamless.
          <AnnotationToolbar
            target={annotationTarget}
            annotations={annotations}
            onApply={applyAnnotation}
            onClearKind={clearAnnotationKind}
            onClearAll={clearAnnotations}
            onClose={() => setAnnotationTarget(null)}
          />
        ) : composerOpen ? (
          // Composer open on the current tab → the floating bar
          // becomes a contextual input. The bottom-right pill
          // (rendered above) toggles it back to the tabs view.
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitComposer();
            }}
            // No extra `mr-` — the parent's `pr-[88px]` already
            // reserves space for the AI pill, and we want the composer
            // to reach the same right edge as the tab bar does in its
            // non-composer state.
            // Exactly the tab bar's outer geometry so the swap from
            // tabs ↔ composer reads as the same panel re-rendering its
            // contents, not two different shapes.
            className="pointer-events-auto flex h-[64px] flex-1 items-stretch gap-1 rounded-[28px] border border-white/40 bg-paper/55 px-1 py-1 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
            aria-label={
              tab === "bible"
                ? "Ask the agent"
                : tab === "notes"
                  ? "Add a note"
                  : "Send a message"
            }
          >
            <input
              ref={composerInputRef}
              value={composerDraft}
              onChange={(e) => setComposerDraft(e.target.value)}
              placeholder={
                tab === "bible"
                  ? "Ask the agent…"
                  : tab === "notes"
                    ? "New personal note…"
                    : "Message…"
              }
              // px-3 inside the px-1 outer keeps the visual gutter
              // between the glass edge and the typed text similar to
              // the tab buttons' breathing room.
              className="min-w-0 flex-1 self-stretch bg-transparent px-3 text-sm text-neutral-900 placeholder:text-neutral-500 focus:outline-none dark:text-neutral-50 dark:placeholder:text-neutral-400"
              autoComplete="off"
              autoCapitalize="sentences"
            />
            <button
              type="submit"
              disabled={!composerDraft.trim() || sending}
              // Block the button from stealing focus before the form
              // submits — without this, iOS blurs the input on
              // pointerdown and the keyboard already starts collapsing
              // by the time we try to refocus.
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              className="grid h-[48px] w-[48px] shrink-0 self-center place-items-center rounded-full bg-neutral-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] transition disabled:opacity-30 dark:bg-neutral-50 dark:text-neutral-900"
              aria-label="Send"
              title="Send"
            >
              <SendArrow />
            </button>
          </form>
        ) : (
          <nav
            className="pointer-events-auto flex h-[64px] flex-1 items-stretch rounded-[28px] border border-white/40 bg-paper/55 px-1 py-1 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
          >
            <IOSTabButton
              outline={<BibleOutline />}
              filled={<BibleFilled />}
              label="Bible"
              active={tab === "bible"}
              onClick={() => setTab("bible")}
            />
            <IOSTabButton
              outline={<NotesOutline />}
              filled={<NotesFilled />}
              label="Notes"
              active={tab === "notes"}
              onClick={() => setTab("notes")}
              badge={notesApi.notes.length || undefined}
            />
            <IOSTabButton
              outline={<ChatOutline />}
              filled={<ChatFilled />}
              label="Chat"
              active={tab === "chat"}
              onClick={() => setTab("chat")}
            />
            <IOSTabButton
              outline={<BookmarkOutline />}
              filled={<BookmarkFilled />}
              label="Marks"
              active={tab === "bookmarks"}
              onClick={() => setTab("bookmarks")}
              badge={
                // Count one per book — flags / past reads in the
                // same book don't bump the badge.
                new Set(bookmarks.map((b) => b.book)).size || undefined
              }
            />
          </nav>
        )}
      </div>

      {/* Rooms rail drawer */}
      {railOpen && (
        <>
          <button
            onClick={() => setRailOpen(false)}
            aria-label="Close menu"
            className="fixed inset-0 z-30 bg-black/40"
          />
          <aside className="fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-neutral-200 bg-paper shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
            <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <div className="text-sm font-semibold">Bible IU</div>
              <button
                onClick={() => setRailOpen(false)}
                className="grid h-9 w-9 place-items-center rounded text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
                aria-label="Close menu"
              >
                ✕
              </button>
            </header>
            <button
              onClick={() => {
                setNewRoomOpen(true);
              }}
              className="mx-3 mt-3 rounded border border-dashed border-neutral-300 px-3 py-3 text-sm text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
            >
              + New room
            </button>
            <nav className="mt-2 flex-1 overflow-y-auto">
              {rooms.length === 0 && (
                <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400">
                  No rooms yet. Tap "+ New room" to start one.
                </p>
              )}
              {rooms.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setActiveId(r.id);
                    setRailOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-3 text-left text-sm hover:bg-paper-soft dark:hover:bg-neutral-800 ${
                    r.id === activeId
                      ? "bg-paper-soft dark:bg-neutral-800"
                      : ""
                  }`}
                >
                  <span className="text-base">
                    {r.type === "direct" ? "💬" : "📚"}
                  </span>
                  <span className="truncate">{r.name}</span>
                </button>
              ))}
            </nav>
          </aside>
        </>
      )}

      {/* Modals — TODO: convert to bottom sheets in task #49 */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={onChangeSettings}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onSignOut={onSignOut}
        onDeleted={onDeleted}
      />
      <NewRoomModal
        open={newRoomOpen}
        onClose={() => setNewRoomOpen(false)}
        onCreate={createRoom}
      />
      {active && (
        <ShareRoomModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          roomId={active.id}
          roomName={active.name}
        />
      )}
    </div>
  );
}

/**
 * iOS-style tab item — bigger glyph, smaller label, active/inactive
 * switches between a filled and outline icon variant the way SF
 * Symbols do in native iOS apps. Includes an iMessage-style red badge.
 */
function IOSTabButton({
  outline,
  filled,
  label,
  active,
  onClick,
  badge,
}: {
  outline: React.ReactNode;
  filled: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex min-w-[68px] flex-1 flex-col items-center justify-center gap-[3px] rounded-[22px] px-3 pb-1.5 pt-2 text-[10.5px] font-medium tracking-[0.01em] transition-all ${
        active
          ? "bg-white/55 text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:bg-white/15 dark:text-neutral-50"
          : "text-neutral-600 dark:text-neutral-300"
      }`}
      aria-pressed={active}
      aria-label={label}
    >
      <span className="relative grid h-7 place-items-center">
        {active ? filled : outline}
        {badge != null && badge > 0 && (
          <span className="absolute -right-2.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_0_0_2px_rgba(247,243,234,0.95)] dark:shadow-[0_0_0_2px_rgba(23,23,23,0.95)]">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span className="leading-none">{label}</span>
    </button>
  );
}

// ---- SF-style glyphs (outline = inactive, filled = active) ----------

function BibleOutline() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 4.5a1.5 1.5 0 0 1 1.5-1.5H18v16H6.5A1.5 1.5 0 0 0 5 20.5V4.5Z" />
      <path d="M5 20.5A1.5 1.5 0 0 1 6.5 22H18" />
      <path d="M12 6.5v8" />
      <path d="M9 10.5h6" />
    </svg>
  );
}
function BibleFilled() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.5 2.25A2.25 2.25 0 0 0 4.25 4.5v16a2.25 2.25 0 0 0 2.25 2.25H18a.75.75 0 0 0 .75-.75V3a.75.75 0 0 0-.75-.75H6.5ZM12 5.5a.75.75 0 0 1 .75.75v3.25H16a.75.75 0 0 1 0 1.5h-3.25v3.25a.75.75 0 0 1-1.5 0V11H8a.75.75 0 0 1 0-1.5h3.25V6.25A.75.75 0 0 1 12 5.5Z" />
    </svg>
  );
}
function NotesOutline() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.75h9.25L19.25 7.75V20a1.5 1.5 0 0 1-1.5 1.5h-11.75A1.5 1.5 0 0 1 4.5 20V5.25A1.5 1.5 0 0 1 6 3.75Z" />
      <path d="M14.75 3.75v4h4.5" />
      <path d="M8 12.25h8" />
      <path d="M8 16.25h5.5" />
    </svg>
  );
}
function NotesFilled() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 2.5A2.25 2.25 0 0 0 3.75 4.75v14.5A2.25 2.25 0 0 0 6 21.5h12a2.25 2.25 0 0 0 2.25-2.25V9.06c0-.46-.18-.9-.5-1.22l-4.34-4.34a1.72 1.72 0 0 0-1.22-.5H6Zm9.25 2.06v3.94c0 .55.45 1 1 1h3.94l-4.94-4.94ZM7.5 12.75c0-.41.34-.75.75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1-.75-.75Zm.75 3.25a.75.75 0 0 0 0 1.5h5a.75.75 0 0 0 0-1.5h-5Z" />
    </svg>
  );
}
function ChatOutline() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.25 7.5A3.25 3.25 0 0 1 7.5 4.25h9a3.25 3.25 0 0 1 3.25 3.25v6a3.25 3.25 0 0 1-3.25 3.25h-4.78L8 19.75v-3H7.5A3.25 3.25 0 0 1 4.25 13.5v-6Z" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4.5 19.5 10 7.5 22H2v-5.5L14 4.5Z" />
      <path d="M12 6.5l5.5 5.5" />
    </svg>
  );
}

function BookmarkOutline() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 3.75h11a.75.75 0 0 1 .75.75v15.93a.5.5 0 0 1-.78.41L12 17.25l-5.47 3.59a.5.5 0 0 1-.78-.41V4.5a.75.75 0 0 1 .75-.75Z" />
    </svg>
  );
}
function BookmarkFilled() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.5 2.75A1.75 1.75 0 0 0 4.75 4.5v16.43a1.5 1.5 0 0 0 2.33 1.25L12 19l4.92 3.18a1.5 1.5 0 0 0 2.33-1.25V4.5a1.75 1.75 0 0 0-1.75-1.75H6.5Z" />
    </svg>
  );
}

function SendArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 4.25a.75.75 0 0 1 .75.75v12.94l4.22-4.22a.75.75 0 1 1 1.06 1.06l-5.5 5.5a.75.75 0 0 1-1.06 0l-5.5-5.5a.75.75 0 1 1 1.06-1.06l4.22 4.22V5a.75.75 0 0 1 .75-.75Z" transform="rotate(-90 12 12)" />
    </svg>
  );
}

function SparkleOutline() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z" />
      <path d="M18 14.5l.8 2.2L21 17.5l-2.2.8L18 20.5l-.8-2.2L15 17.5l2.2-.8L18 14.5Z" />
    </svg>
  );
}
function SparkleFilled() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z" />
      <path d="M18 14.5l.8 2.2L21 17.5l-2.2.8L18 20.5l-.8-2.2L15 17.5l2.2-.8L18 14.5Z" />
    </svg>
  );
}

function ChatFilled() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.5 3.5h9a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-4.43L8.6 20.34a.75.75 0 0 1-1.27-.54v-2.3a4 4 0 0 1-3.83-4v-6a4 4 0 0 1 4-4Z" />
    </svg>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div>
        <div className="mb-1 text-sm font-semibold">{title}</div>
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {body}
        </div>
      </div>
    </div>
  );
}

/** Keep one bookmark per book — the "active" mark, which is the
 *  bookmark at the HIGHEST (chapter, verse) position. Past flags
 *  always sit ABOVE the active mark in scroll order (smaller
 *  chapter:verse). Sorted with the deepest book first. */
function pickLatestPerBook(all: BookmarkOut[]): BookmarkOut[] {
  const byBook = new Map<string, BookmarkOut>();
  for (const b of all) {
    const cur = byBook.get(b.book);
    if (!cur) {
      byBook.set(b.book, b);
      continue;
    }
    // "Deeper" = higher chapter, or same chapter & higher verse.
    if (
      b.chapter > cur.chapter ||
      (b.chapter === cur.chapter && b.verse > cur.verse)
    ) {
      byBook.set(b.book, b);
    }
  }
  return Array.from(byBook.values()).sort(
    (a, b) =>
      (Date.parse(b.updated_at || "") || 0) -
      (Date.parse(a.updated_at || "") || 0),
  );
}


function BookmarksPanel({
  bookmarks,
  onPick,
  onRemoveOne,
  onReset,
  timezone,
}: {
  bookmarks: BookmarkOut[];
  onPick: (b: BookmarkOut) => void;
  onRemoveOne: (book: string, chapter: number, verse: number) => void;
  onReset: (book: string) => void;
  timezone?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 bg-paper-soft px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <h2 className="text-sm font-semibold">Last read</h2>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          One bookmark per book — the latest verse you marked. Past
          marks in the same book stay as flags on the Bible page;
          double-tap a flag there to walk up the stack or remove it.
        </p>
      </div>
      <ul className="flex-1 space-y-2 overflow-y-auto p-3">
        {bookmarks.length === 0 && (
          <li className="px-2 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
            No bookmarks yet. Tap the ribbon next to any verse to mark
            where you left off in that book.
          </li>
        )}
        {bookmarks.map((b) => (
          <li key={b.book} className={GLASS_CARD_INLINE}>
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                onClick={() => onPick(b)}
                className="flex-1 text-left"
                aria-label={`Jump to ${b.book} ${b.chapter}:${b.verse}`}
              >
                <div className="flex items-center gap-2">
                  <span className={bookColor(b.book).text}>
                    <BookmarkFilled />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {b.book} {b.chapter}:{b.verse}
                    </div>
                    <div className="truncate text-[10px] text-neutral-500 dark:text-neutral-400">
                      {b.updated_at
                        ? new Date(b.updated_at).toLocaleString(undefined, {
                            timeZone: timezone || undefined,
                          })
                        : ""}
                    </div>
                  </div>
                </div>
              </button>
              <button
                onClick={() =>
                  setEditing((cur) => (cur === b.book ? null : b.book))
                }
                className={`grid h-9 w-9 place-items-center rounded transition ${
                  editing === b.book
                    ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
                    : "text-neutral-400 hover:bg-paper-soft hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                }`}
                aria-label={`Edit ${b.book} bookmark`}
                title={`Edit ${b.book} bookmark`}
                aria-expanded={editing === b.book}
              >
                <PencilIcon />
              </button>
              <button
                onClick={() => onRemoveOne(b.book, b.chapter, b.verse)}
                className="grid h-9 w-9 place-items-center rounded text-neutral-400 hover:bg-paper-soft hover:text-red-600 dark:hover:bg-neutral-800"
                aria-label={`Remove ${b.book} bookmark`}
                title="Remove just the active bookmark"
              >
                ✕
              </button>
            </div>
            {editing === b.book && (
              <div className="space-y-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Reset clears the active bookmark AND every past flag
                  for this book. Use ✕ above if you only want to drop
                  the active mark.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setEditing(null)}
                    className="rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          `Reset ${b.book}? This removes the active bookmark and every past flag in ${b.book}.`,
                        )
                      ) {
                        onReset(b.book);
                        setEditing(null);
                      }
                    }}
                    className="rounded bg-red-600 px-2 py-1 text-[11px] text-white hover:bg-red-700"
                  >
                    Reset {b.book}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Static demo conversation so the chat tab has something to look at
 *  before the live `POST /rooms/{id}/chat` ↔ websocket wiring lands.
 *  Strip this `DEMO_THREAD` when the real message list is rendered. */
const DEMO_THREAD: DemoMsg[] = [
  {
    from: "Maya",
    body: "Anyone else stuck on Romans 9 today? I keep rereading verse 16 and feeling the weight of it.",
    time: "8:42 AM",
  },
  {
    from: "Daniel",
    body: "Same. The mercy/works contrast is wild — Paul drives it home so hard.",
    time: "8:45 AM",
  },
  {
    from: "You",
    mine: true,
    body: "I marked v.16 yellow + a wavy underline on “but of God that sheweth mercy.” Felt like the whole chapter pivots there.",
    time: "8:47 AM",
  },
  {
    from: "Maya",
    body: "Oh I like that. Going to copy that mark over.",
    time: "8:48 AM",
  },
  {
    from: "Daniel",
    body: "Quick Q — how do y’all read v.18? It feels almost dissonant after the mercy line.",
    time: "9:02 AM",
  },
  {
    from: "You",
    mine: true,
    body: "I read it as Paul anticipating the objection. He doesn’t soften it; he leans in.",
    time: "9:04 AM",
  },
  {
    from: "Maya",
    body: "Going to drop a group note on this thread later tonight. Want to look at it alongside Exodus 33.",
    time: "9:07 AM",
  },
  {
    from: "Daniel",
    body: "+1 — that pairing makes v.18 land differently for me.",
    time: "9:08 AM",
  },
];

function ChatPanel({
  roomName,
  userMessages,
}: {
  roomName: string;
  userMessages: DemoMsg[];
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Stick to the bottom whenever a new message lands. The user can
  // still scroll up to read the seed thread — we just snap back after
  // they hit send.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [userMessages.length]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 bg-paper-soft px-4 py-2 text-[11px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
        <div className="flex items-center justify-between">
          <span>
            <span className="font-medium text-neutral-700 dark:text-neutral-200">
              {roomName}
            </span>{" "}
            · 3 members
          </span>
          <span className="rounded-full bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-900 dark:bg-amber-500/30 dark:text-amber-100">
            Demo
          </span>
        </div>
      </div>
      <div
        ref={scrollerRef}
        // Bottom padding clears the floating glass composer + AI pill
        // so the last bubble isn't hidden behind them. The pill is
        // 64px tall and sits on top of the safe-area inset, so we add
        // 64 + ~24px breathing room + the inset.
        className="flex-1 space-y-3 overflow-y-auto px-3 pt-3"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)",
        }}
      >
        {DEMO_THREAD.map((m, i) => (
          <ChatBubble key={`seed-${i}`} msg={m} />
        ))}
        {userMessages.length > 0 && (
          <div className="my-1 flex items-center gap-2 text-[10px] text-neutral-400 dark:text-neutral-500">
            <span className="flex-1 border-t border-neutral-200 dark:border-neutral-700" />
            <span>Today</span>
            <span className="flex-1 border-t border-neutral-200 dark:border-neutral-700" />
          </div>
        )}
        {userMessages.map((m, i) => (
          <ChatBubble key={`mine-${i}`} msg={m} />
        ))}
        <p className="pt-2 text-center text-[10px] text-neutral-400 dark:text-neutral-500">
          Demo conversation — real chat lands when{" "}
          <code>POST /rooms/{`{id}`}/chat</code> + websocket are wired up.
        </p>
      </div>
    </div>
  );
}

function ChatBubble({ msg }: { msg: DemoMsg }) {
  const side = msg.mine ? "items-end" : "items-start";
  // Mine = darker pill on the right; others = light glass bubble on
  // the left. Both echo the rest of the app's glass material so the
  // chat tab feels like part of the same surface.
  const bubble = msg.mine
    ? "rounded-[18px] rounded-br-md bg-neutral-900 text-white shadow-[0_4px_14px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.10)] dark:bg-neutral-100 dark:text-neutral-900"
    : `rounded-[18px] rounded-bl-md ${GLASS_CARD_INLINE}`;
  return (
    <div className={`flex flex-col gap-0.5 ${side}`}>
      {!msg.mine && (
        <span className="px-2 text-[10px] font-semibold text-neutral-500 dark:text-neutral-400">
          {msg.from}
        </span>
      )}
      <div className={`max-w-[80%] px-3 py-1.5 text-sm ${bubble}`}>
        {msg.body}
      </div>
      <span className="px-2 text-[9px] text-neutral-400 dark:text-neutral-500">
        {msg.time}
      </span>
    </div>
  );
}
