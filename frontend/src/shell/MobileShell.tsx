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
  getPassword,
  getSessionToken,
  OSIS_TO_BOOK_NAME,
  parseVerseRef,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationOut,
  type BookmarkOut,
  type ChatMessageOut,
  type RoomOut,
} from "../lib/api";
import { shareVerseCard } from "../lib/shareVerse";
import { AdminPanel } from "./AdminPanel";
import {
  AnnotationToolbar,
  type AnnotationTarget,
} from "../workspace/BibleView/AnnotationToolbar";
import type { WorkspaceScope } from "../workspace/Workspace";
import { bookColor } from "../lib/testament";
import { useRoomQuota } from "../lib/useRoomQuota";
import { useStickToBottom } from "../lib/useStickToBottom";
import { useKeyboardInset } from "../lib/useKeyboardInset";
import { ACCENT_PALETTE, resolveAccent } from "../lib/accentColors";
import { useYjsNotes } from "../workspace/NotesSidebar/yjsNotes";
import { NotesSidebar } from "../workspace/NotesSidebar/NotesSidebar";
import { Workspace, type VerseFocus } from "../workspace/Workspace";
import { Avatar } from "./Profile";
import { SettingsModal } from "./Settings";
import { NewRoomModal, type NewRoomValues } from "./NewRoomModal";
import { ShareRoomModal } from "./ShareRoomModal";
import { RoomAvatar } from "./RoomAvatar";
import { Pill } from "./SettingsButtons";

interface RoomItem {
  id: string;
  type: "group" | "direct";
  name: string;
  focusedVerse?: string;
  /** Caller's role IN THIS ROOM — populated from GET /rooms so the
   *  Profile UI can flag rooms the user administrates. */
  role?: "admin" | "member";
  /** Server-relative URL for the room avatar; null when the admin
   *  hasn't uploaded one. Fallback is the gradient/initials. */
  imageUrl?: string | null;
  /** Admin-picked accent palette key. Null = auto-derive from id. */
  accent?: string | null;
  /** In-app unread chat-message count. Drives the badge on the rail
   *  row and the bottom Chat tab. */
  unreadCount?: number;
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
  // Persist last-selected room per-user. Per-user key (not global)
  // so signing out + back in as a different person doesn't surface
  // someone else's last room.
  const lastRoomKey = handle ? `bible-iu:last-room:${handle}` : "";
  const [activeId, setActiveIdRaw] = useState<string>("");
  const setActiveId = (id: string) => {
    setActiveIdRaw(id);
    if (id && lastRoomKey && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(lastRoomKey, id);
      } catch {
        // Private-mode etc.
      }
    }
  };
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

  /** Build a 1080×1080 share card for the verse + the user's marks on
   *  it, then hand off to navigator.share (with a download fallback).
   *  Fetches the verse text in KJV since the share card targets a
   *  permanent record of "this verse, marked like so." */
  async function shareVerse(verseId: string): Promise<void> {
    const parsed = parseVerseRef(verseId);
    if (!parsed) return;
    try {
      const translation = "King James Version";
      const chapter = await api.bibleChapter(
        parsed.book,
        parsed.chapter,
        translation,
      );
      const verseRow = chapter.verses.find((v) => v.verse === parsed.verse);
      if (!verseRow) return;
      const bookName = OSIS_TO_BOOK_NAME[parsed.book] ?? parsed.book;
      const label = `${bookName} ${parsed.chapter}:${parsed.verse}`;
      await shareVerseCard({
        verseId: parsed.ref,
        verseLabel: label,
        translation,
        text: verseRow.text,
        annotations,
      });
    } catch {
      // Quiet on failure — share is non-essential. Future: surface a
      // toast.
    }
  }
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
  const workspaceRef = useRef<WorkspaceHandle | null>(null);
  // Resolved agent scope — mirrored from Workspace so the chip above
  // the composer can render "Asking · {scope}" without the user
  // guessing what scope the next /ask will land at.
  const [agentScope, setAgentScope] = useState<WorkspaceScope | null>(null);
  function toggleComposer() {
    setComposerOpen((v) => !v);
  }
  function submitComposer() {
    const text = composerDraft.trim();
    if (!text || sending) return;
    // Slash-command interception — runs only on the Bible tab where
    // the agent lives. Notes / Chat composers pass `/foo` through as
    // literal content. Returns true when handled so the caller knows
    // not to fall through to the regular submit.
    if (tab === "bible" && text.startsWith("/")) {
      const handled = handleSlashCommand(text);
      if (handled) {
        setComposerDraft("");
        composerInputRef.current?.focus();
        return;
      }
    }
    if (tab === "bible") {
      workspaceRef.current?.ask(text);
      // Backend increments the counter inside /reason — wait briefly
      // for that turn to land then re-pull, so the chip updates.
      setTimeout(() => {
        void refreshRoomQuota();
      }, 800);
    } else if (tab === "notes") {
      notesApi.add({
        body: text,
        scope: "personal",
        verse_anchor: focus?.ref,
      });
    } else if (tab === "chat" && active) {
      // Real chat — POST to the server. The websocket subscription
      // in ChatPanel will pick the message back up and render it,
      // so we don't optimistically prepend here.
      void api.chatPost(active.id, text).catch(() => {});
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
  /** Returns true when the input was consumed as a slash command. */
  function handleSlashCommand(raw: string): boolean {
    const [head, ...rest] = raw.slice(1).split(/\s+/);
    const cmd = head.toLowerCase();
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "new":
      case "clear":
      case "reset":
        workspaceRef.current?.clear();
        return true;
      case "help":
      case "?":
        // Compact alert — kept lightweight on purpose. The agent
        // turns themselves carry the heavy UI, so reusing those for
        // help would over-engineer the answer.
        alert(
          [
            "Slash commands:",
            "  /new (or /clear, /reset) — start a fresh agent conversation",
            "  /help — this message",
          ].join("\n"),
        );
        return true;
      default:
        // Unknown command — soft-fail with a hint instead of sending
        // it to the agent (which would just see /typo and answer it).
        alert(
          `Unknown command: /${cmd}\nType /help for the command list.${arg ? `\n\n(args: “${arg}”)` : ""}`,
        );
        return true;
    }
  }
  const [railOpen, setRailOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // When the user taps the avatar we open Settings on the Profile
  // detail page; tapping the hamburger opens Settings on its root
  // list (everything else). One sheet, two entry points.
  const [settingsMode, setSettingsMode] = useState<"profile" | "menu">("menu");
  const [adminOpen, setAdminOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [focus, setFocus] = useState<VerseFocus | null>(null);
  const [seededRoomId, setSeededRoomId] = useState<string | null>(null);
  // The signed-in user's avatar URL. Fetched on mount and re-pulled
  // whenever the Profile sheet refreshes the user so the header icon
  // updates the moment an upload finishes.
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .authMe()
      .then((p) => alive && setMyAvatarUrl(p.avatar_url ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const active = useMemo(
    () => rooms.find((r) => r.id === activeId),
    [rooms, activeId],
  );
  // Resolve the active room's accent — admin override or auto-derived
  // from the room id. Falls back to a neutral key when no room is
  // active so the header still has *some* tint.
  const accentKey = active
    ? resolveAccent(active.accent ?? null, active.id)
    : resolveAccent(null, "default");
  const accent = ACCENT_PALETTE[accentKey];
  // How tall the soft keyboard is right now — added to the composer's
  // bottom anchor so it stays glued to the top of the keyboard on iOS
  // (where `position: fixed; bottom: 0` would otherwise sit behind it).
  const keyboardInset = useKeyboardInset();
  // Per-room daily-question quota. Renders inline next to the scope
  // chip on the Bible tab so the user can see "3 left today" before
  // burning their last slot. Best-effort — backend store is
  // single-instance and the hook silently swallows errors.
  const { quota: roomQuota, refresh: refreshRoomQuota } = useRoomQuota(
    active?.id ?? null,
  );
  // selfUserId scopes the personal-notes Y.Doc so it can't leak to
  // other room members. Without it we still get group notes via the
  // shared doc but the "add personal note" path is a no-op.
  const notesApi = useYjsNotes(activeId, selfUserId);

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
          role: r.role,
          imageUrl: r.image_url ?? null,
          accent: r.accent_color ?? null,
          unreadCount: r.unread_count ?? 0,
        }));
        setRooms(mapped);
        if (pendingRoomId && mapped.some((r) => r.id === pendingRoomId)) {
          setActiveId(pendingRoomId);
          onPendingRoomConsumed?.();
        } else if (!activeId && mapped.length > 0) {
          // Restore the last room the user opened (per-user key).
          // Fall back to the first room when the saved id is stale
          // (room left, deleted, or this is a new sign-in).
          let initial = mapped[0].id;
          if (lastRoomKey && typeof localStorage !== "undefined") {
            try {
              const saved = localStorage.getItem(lastRoomKey);
              if (saved && mapped.some((r) => r.id === saved)) {
                initial = saved;
              }
            } catch {
              // ignore
            }
          }
          setActiveId(initial);
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
      {/* Top app bar. `pt-[env(safe-area-inset-top)]` keeps the avatar
       *  + group pill clear of the iOS notch / Dynamic Island and the
       *  Android status bar when the app is installed as a PWA. The
       *  `linear-gradient` overlay tints the band with the active
       *  group's accent color (auto-derived per id, or admin-picked
       *  via AdminPanel) so each group reads as visually distinct. */}
      <header
        className="relative flex items-center justify-between gap-2 border-b border-neutral-200 bg-paper px-2 py-2 dark:border-neutral-800 dark:bg-neutral-900"
        style={{
          paddingTop:
            "calc(env(safe-area-inset-top, 0px) + 0.5rem)",
          paddingLeft:
            "calc(env(safe-area-inset-left, 0px) + 0.5rem)",
          paddingRight:
            "calc(env(safe-area-inset-right, 0px) + 0.5rem)",
          backgroundImage: `linear-gradient(to bottom, var(--biu-accent-band), transparent 110%)`,
          ["--biu-accent-band" as string]:
            theme === "dark" ? accent.bandDark : accent.band,
        }}
      >
        <button
          onClick={() => setRailOpen(true)}
          className="group inline-flex h-10 items-center gap-1.5 rounded-full border border-neutral-200 bg-paper px-3 text-[12px] font-semibold text-neutral-700 shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]"
          aria-label="Open groups"
          title="Switch groups"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="9" cy="8" r="3.5" />
            <circle cx="17" cy="9" r="2.5" />
            <path d="M3.5 18.5c.6-2.6 2.9-4.5 5.5-4.5s4.9 1.9 5.5 4.5" />
            <path d="M15.5 18c.3-1.6 1.8-2.8 3.5-2.8s3.2 1.2 3.5 2.8" />
          </svg>
          <span>Groups</span>
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
          {active?.name ?? "Bible IU"}
        </div>
        <div className="flex items-center gap-1">
          {/* Header is intentionally minimal — Share + Admin both
              live inside the Profile sheet under "This room". The
              avatar is the single entry point. */}
          <button
            onClick={() => {
              setSettingsMode("profile");
              setSettingsOpen(true);
            }}
            className="group grid h-11 w-11 place-items-center rounded-full hover:bg-paper-soft dark:hover:bg-neutral-800"
            aria-label="Profile"
          >
            {/* 3D ring: a thin highlight on top + soft drop shadow
                below + a subtle inner shadow on the image. Reads as a
                pressed-into-glass coin rather than a flat circle. */}
            <span
              className="grid place-items-center rounded-full p-[1.5px] shadow-[0_2px_6px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform group-active:scale-95 dark:shadow-[0_2px_6px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
              style={{
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.85), rgba(180,180,180,0.35) 45%, rgba(0,0,0,0.18))",
              }}
            >
              <span className="grid place-items-center rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45),inset_0_-1px_2px_rgba(0,0,0,0.20)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),inset_0_-1px_2px_rgba(0,0,0,0.55)]">
                <Avatar handle={handle} url={myAvatarUrl} size={40} />
              </span>
            </span>
          </button>
          <button
            onClick={() => {
              setSettingsMode("menu");
              setSettingsOpen(true);
            }}
            className="grid h-11 w-11 place-items-center rounded-full border border-neutral-200 bg-paper text-neutral-700 shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]"
            aria-label="Open settings"
            title="Settings"
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
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
            {/* Workspace stays mounted regardless of which tab is
                active — unmount/remount would tear down the Yjs
                conversation doc, which races IndexedDB rehydration
                and makes the agent "forget" the thread between tab
                switches. CSS visibility instead of conditional render. */}
            <div
              className="h-full"
              style={{ display: tab === "bible" ? "block" : "none" }}
              aria-hidden={tab !== "bible"}
            >
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
                bookmarks={bookmarks}
                onSetBookmark={setBookmark}
                onRemoveBookmarkAt={removeBookmarkAt}
                onDoubleTapBookmark={handleBookmarkDoubleTap}
                timezone={settings.timezone}
                selfUserId={selfUserId}
                socialNotesEnabled={settings.socialNotesEnabled}
                onScopeChange={setAgentScope}
                annotations={annotations}
                onApplyAnnotation={applyAnnotation}
                onClearAnnotationKind={clearAnnotationKind}
                onClearAnnotations={clearAnnotations}
                annotationTarget={annotationTarget}
                onAnnotationTargetChange={setAnnotationTarget}
                bottomInset
              />
            </div>

            {tab === "notes" && (
              <NotesSidebar
                focus={focus}
                notes={notesApi}
                roomId={active.id}
                hideComposer
                socialNotesEnabled={settings.socialNotesEnabled}
                selfUserId={selfUserId}
              />
            )}
            {tab === "chat" && (
              <ChatPanel
                roomId={active.id}
                roomName={active.name}
                selfUserId={selfUserId}
                accentKey={accentKey}
                dark={theme === "dark"}
                onRead={() =>
                  setRooms((prev) =>
                    prev.map((r) =>
                      r.id === active.id ? { ...r, unreadCount: 0 } : r,
                    ),
                  )
                }
              />
            )}
            {tab === "bookmarks" && (
              <BookmarksPanel
                bookmarks={pickLatestPerBook(bookmarks)}
                timezone={settings.timezone}
                dark={theme === "dark"}
                onPick={(b) => {
                  setFocus({
                    book: b.book,
                    chapter: b.chapter,
                    verse: b.verse,
                    ref: `${b.book}.${b.chapter}.${b.verse}`,
                  });
                  setTab("bible");
                }}
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
            className="pointer-events-none fixed right-3 z-40 pt-2"
            style={{
              bottom: keyboardInset,
              paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)",
            }}
          >
            <button
              onClick={toggleComposer}
              // Square 64x64 pill, squircle corners matching the tab
              // bar (`rounded-[28px]`) so the two glass elements feel
              // like the same material rather than a circle next to a
              // rounded rectangle. Border picks up the active group's
              // accent so the AI surface reads as "yours" (or
              // "ours" — themed per group).
              style={{
                borderColor:
                  theme === "dark" ? accent.ringDark : accent.ring,
                borderWidth: "2px",
              }}
              className={`pointer-events-auto grid h-[64px] w-[64px] place-items-center rounded-[28px] backdrop-blur-2xl backdrop-saturate-200 transition-all ${
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

      {/* Floating scope chip — visible only on the Bible tab while
          the AI composer is open. Spells out what scope the next
          /ask will use so the user can't be surprised by an answer
          about a verse when they meant the chapter. Tap to widen
          one level (verse → chapter → testament → bible). */}
      {tab === "bible" && composerOpen && agentScope && (
        <div
          className="pointer-events-none fixed inset-x-0 z-40 flex justify-center"
          style={{
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 86px)",
          }}
        >
          <button
            onClick={() => workspaceRef.current?.widenScope()}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-white/40 bg-paper/70 px-3 py-1 text-[11px] font-medium text-neutral-800 shadow-[0_4px_14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/55 dark:text-neutral-100 dark:shadow-[0_4px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]"
            title="Tap to widen the scope"
            aria-label={`Agent scope: ${agentScope.label}. Tap to widen.`}
          >
            <span className="rounded-full bg-neutral-900/10 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-600 dark:bg-white/15 dark:text-neutral-300">
              {agentScope.kind}
            </span>
            <span className="truncate">Asking about {agentScope.label}</span>
            {roomQuota && roomQuota.limit != null && roomQuota.remaining != null && (
              <span
                className={`ml-1 rounded-full px-1.5 text-[9px] font-semibold ${
                  roomQuota.remaining <= 1
                    ? "bg-amber-200 text-amber-900 dark:bg-amber-700/60 dark:text-amber-100"
                    : "bg-neutral-900/10 text-neutral-600 dark:bg-white/15 dark:text-neutral-300"
                }`}
                aria-label={`${roomQuota.remaining} of ${roomQuota.limit} questions left today`}
                title={`${roomQuota.remaining} of ${roomQuota.limit} questions left today`}
              >
                {roomQuota.remaining} left
              </span>
            )}
            {agentScope.kind !== "bible" && (
              <span className="text-neutral-400" aria-hidden>
                ⤺
              </span>
            )}
          </button>
        </div>
      )}

      {/* Apple "liquid glass" detached tab bar — floats over the
       *  scripture/content rather than bolting to the bottom edge.
       *  Fixed positioning lets the glass blur show through whatever
       *  is behind it. Main content pads its bottom (see <main>) so
       *  scrolled text doesn't tuck permanently behind the bar. */}
      <div
        className="pointer-events-none fixed inset-x-0 z-40 flex justify-start pl-[20px] pr-[88px] pt-2"
        style={{
          bottom: keyboardInset,
          paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)",
        }}
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
            onShare={(verseId) => {
              void shareVerse(verseId);
            }}
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
              aria-label={
                tab === "bible"
                  ? "Ask the agent"
                  : tab === "notes"
                    ? "New personal note"
                    : "Chat message"
              }
              className="min-w-0 flex-1 self-stretch bg-transparent px-3 text-[16px] text-neutral-900 placeholder:text-neutral-500 focus:outline-none dark:text-neutral-50 dark:placeholder:text-neutral-400"
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
            role="tablist"
            aria-label="Main tabs"
            onKeyDown={(e) => {
              // ARIA tablist pattern — arrow keys step through the
              // tabs without touching the rest of the focus order.
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const idx = TAB_ORDER.indexOf(tab);
              const dir = e.key === "ArrowRight" ? 1 : -1;
              const next = (idx + dir + TAB_ORDER.length) % TAB_ORDER.length;
              setTab(TAB_ORDER[next]);
            }}
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
              badge={active?.unreadCount || undefined}
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
              className="mx-3 mt-3 inline-flex items-center justify-center gap-2 rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-3 text-[14px] font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/40"
            >
              <span className="grid h-6 w-6 place-items-center rounded-full bg-amber-200 text-amber-900 dark:bg-amber-700/60 dark:text-amber-100" aria-hidden>
                +
              </span>
              New group
            </button>
            <nav className="mt-2 flex-1 overflow-y-auto">
              {rooms.length === 0 && (
                <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400">
                  No groups yet. Tap "+ New group" to start one.
                </p>
              )}
              {rooms.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setActiveId(r.id);
                    setRailOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-paper-soft dark:hover:bg-neutral-800 ${
                    r.id === activeId
                      ? "bg-paper-soft dark:bg-neutral-800"
                      : ""
                  }`}
                >
                  <RoomAvatar
                    id={r.id}
                    name={r.name}
                    type={r.type}
                    imageUrl={r.imageUrl}
                    size={48}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-neutral-900 dark:text-neutral-50">
                      {r.name}
                    </span>
                    <span className="block truncate text-[12px] text-neutral-500 dark:text-neutral-400">
                      {r.type === "direct"
                        ? "Direct chat"
                        : r.role === "admin"
                          ? "Group · admin"
                          : "Group"}
                    </span>
                  </span>
                  {!!r.unreadCount && r.unreadCount > 0 && (
                    <span
                      aria-label={`${r.unreadCount} unread`}
                      className="ml-2 grid min-h-[22px] min-w-[22px] place-items-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white shadow-[0_2px_6px_rgba(239,68,68,0.45)]"
                    >
                      {r.unreadCount > 99 ? "99+" : r.unreadCount}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </aside>
        </>
      )}

      {/* Modals — TODO: convert to bottom sheets in task #49 */}
      {/* Admin panel mounts only when the signed-in user is an admin
          of the active group room. The server still enforces every
          mutation, but mounting only for admins means the panel never
          shows up in a non-admin's DOM in the first place. */}
      {active &&
        active.type === "group" &&
        selfUserId &&
        active.role === "admin" && (
          <AdminPanel
            open={adminOpen}
            onClose={() => setAdminOpen(false)}
            roomId={active.id}
            roomName={active.name}
            roomType={active.type}
            roomImageUrl={active.imageUrl ?? null}
            onRoomImageChanged={(url) =>
              setRooms((prev) =>
                prev.map((r) =>
                  r.id === active.id ? { ...r, imageUrl: url } : r,
                ),
              )
            }
            roomAccentColor={active.accent ?? null}
            onRoomAccentChanged={(c) =>
              setRooms((prev) =>
                prev.map((r) =>
                  r.id === active.id ? { ...r, accent: c } : r,
                ),
              )
            }
            selfRole={active.role}
            selfUserId={selfUserId}
          />
        )}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialPage={settingsMode === "profile" ? "profile" : null}
        settings={settings}
        onChange={onChangeSettings}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onSignOut={onSignOut}
        onDeleted={onDeleted}
        rooms={rooms}
        // "This room" section — Share + Admin are surfaced here
        // because the room context is the active selection. Skip for
        // direct rooms (no admin concept) and local-only rooms (not
        // yet persisted to the server, can't share/admin).
        activeRoom={
          active && active.type === "group" && !active.id.startsWith("local-")
            ? { id: active.id, name: active.name, role: active.role }
            : null
        }
        onShareRoom={() => setShareOpen(true)}
        onOpenRoomAdmin={(roomId) => {
          // Switch to the room first (AdminPanel renders inside the
          // active-room block) then pop the panel open on the next
          // tick so the switch has settled.
          setActiveId(roomId);
          setTimeout(() => setAdminOpen(true), 0);
        }}
        onProfile={(p) => setMyAvatarUrl(p.avatar_url ?? null)}
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
      role="tab"
      // Roving tabindex — only the active tab is in the natural tab
      // order; arrow keys (handled by the parent <nav role="tablist">)
      // move focus between the others.
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      aria-label={label}
      className={`relative flex min-w-[68px] flex-1 flex-col items-center justify-center gap-[3px] rounded-[22px] px-3 pb-1.5 pt-2 text-[10.5px] font-medium tracking-[0.01em] transition-all focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100 ${
        active
          ? "bg-white/55 text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:bg-white/15 dark:text-neutral-50"
          : "text-neutral-600 dark:text-neutral-300"
      }`}
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
  onReset,
  timezone,
  dark,
}: {
  bookmarks: BookmarkOut[];
  onPick: (b: BookmarkOut) => void;
  onReset: (book: string) => void;
  timezone?: string;
  dark: boolean;
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
      <ul className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {bookmarks.length === 0 && (
          <li className="mx-auto mt-4 max-w-xs rounded-2xl border border-neutral-200 bg-paper px-4 py-6 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <span
              className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
              aria-hidden
            >
              <BookmarkFilled />
            </span>
            <div className="text-[13px] font-semibold text-neutral-700 dark:text-neutral-200">
              No bookmarks yet
            </div>
            <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              Tap the ribbon next to any verse to mark where you left
              off in that book.
            </p>
          </li>
        )}
        {bookmarks.map((b) => {
          const tone = bookColor(b.book);
          // Same 3D recipe used in chat bubbles + Settings cards:
          // vertical gradient for the lit-from-above feel, deep drop
          // shadow + inset top highlight + crisp outline ring.
          const cardStyle: React.CSSProperties = {
            backgroundImage: dark
              ? "linear-gradient(to bottom, #3a3a44, #1f1f25)"
              : "linear-gradient(to bottom, #ffffff, #e9ecf2)",
            boxShadow: [
              "0 6px 18px rgba(0,0,0,0.22)",
              "inset 0 1.5px 0 rgba(255,255,255,0.45)",
              dark
                ? "0 0 0 1px rgba(255,255,255,0.08)"
                : "0 0 0 1px rgba(0,0,0,0.06)",
            ].join(", "),
          };
          return (
            <li
              key={b.book}
              className="rounded-2xl"
              style={cardStyle}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  onClick={() => onPick(b)}
                  className="flex flex-1 items-center gap-3 text-left"
                  aria-label={`Jump to ${b.book} ${b.chapter}:${b.verse}`}
                >
                  <span
                    className={`grid h-10 w-10 place-items-center rounded-full ${tone.text} shadow-[0_2px_6px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.45)]`}
                    style={{
                      background:
                        "linear-gradient(135deg, rgba(255,255,255,0.85), rgba(0,0,0,0.06))",
                    }}
                  >
                    <BookmarkFilled />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-semibold text-neutral-900 dark:text-neutral-50">
                      {b.book} {b.chapter}:{b.verse}
                    </div>
                    <div className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                      {b.updated_at
                        ? new Date(b.updated_at).toLocaleString(undefined, {
                            timeZone: timezone || undefined,
                          })
                        : ""}
                    </div>
                  </div>
                </button>
                <button
                  onClick={() =>
                    setEditing((cur) => (cur === b.book ? null : b.book))
                  }
                  className={`grid h-9 w-9 place-items-center rounded-full transition ${
                    editing === b.book
                      ? "bg-neutral-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] dark:bg-neutral-50 dark:text-neutral-900"
                      : "text-neutral-400 hover:bg-paper-soft hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                  }`}
                  aria-label={`Edit ${b.book} bookmark`}
                  title={`Edit ${b.book} bookmark`}
                  aria-expanded={editing === b.book}
                >
                  <PencilIcon />
                </button>
              </div>
              {editing === b.book && (
                <div className="space-y-2 border-t border-neutral-200/70 px-3 py-2.5 dark:border-neutral-800/70">
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Reset clears the active bookmark AND every past flag
                    for this book.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Pill onClick={() => setEditing(null)}>Cancel</Pill>
                    <Pill
                      variant="destructive"
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
                    >
                      Reset {b.book}
                    </Pill>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChatPanel({
  roomId,
  roomName,
  selfUserId,
  accentKey,
  dark,
  onRead,
}: {
  roomId: string;
  roomName: string;
  selfUserId?: string;
  /** Active group's resolved accent — drives the "mine" bubble color
   *  so each group's chat reads as different. The header band is kept
   *  neutral so it doesn't double up with the top app bar's tint. */
  accentKey: import("../lib/accentColors").AccentKey;
  dark: boolean;
  /** Fired after the server confirms the room has been marked read.
   *  Parent zeroes the unread badge for this room. */
  onRead?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessageOut[]>([]);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Initial load — most recent 100 messages, chronological.
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    api
      .chatList(roomId, 100)
      .then((rows) => alive && setMessages(rows))
      .catch(() => {});
    api
      .roomMembers(roomId)
      .then((rows) => alive && setMemberCount(rows.length))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [roomId]);

  // Live updates via websocket. Reconnects with exponential backoff
  // if the connection drops (mobile waking from sleep, server
  // restart, etc.).
  useEffect(() => {
    if (!roomId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = 1000;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(`${proto}//${location.host}/ws/chat/${roomId}`);
      url.searchParams.set("password", getPassword());
      url.searchParams.set("session", getSessionToken());
      ws = new WebSocket(url.toString());
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ChatMessageOut;
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
          );
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onopen = () => {
        backoff = 1000;
      };
      ws.onclose = () => {
        if (closed) return;
        window.setTimeout(connect, Math.min(backoff, 15000));
        backoff *= 2;
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [roomId]);

  // Snap to bottom on new message AND on keyboard show/hide so the
  // latest message stays pinned above the composer.
  useStickToBottom(scrollerRef, [messages.length]);

  // Mark the room as read whenever the user is looking at the Chat
  // tab. Fires on mount (opening Chat zeroes the badge) and again
  // each time a new message lands while still viewing the room (so
  // the badge doesn't bounce up while the user is right here).
  useEffect(() => {
    if (!roomId) return;
    api
      .roomMarkRead(roomId)
      .then(() => onRead?.())
      .catch(() => {});
  }, [roomId, messages.length, onRead]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 bg-paper-soft px-4 py-2 text-[11px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
        <span>
          <span className="font-medium text-neutral-700 dark:text-neutral-200">
            {roomName}
          </span>
          {memberCount !== null && (
            <span> · {memberCount} {memberCount === 1 ? "member" : "members"}</span>
          )}
        </span>
      </div>
      <div
        ref={scrollerRef}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        aria-relevant="additions"
        className="flex-1 space-y-3 overflow-y-auto px-3 pt-3"
        style={{
          // 96px covers the floating composer + safe area at rest.
          // When the keyboard is open we don't need extra padding —
          // useKeyboardInset already lifts the composer onto the
          // keyboard, and the visualViewport shrink takes care of
          // the scroller height. Keep the base padding only.
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)",
        }}
      >
        {messages.length === 0 ? (
          <p className="pt-8 text-center text-xs text-neutral-500 dark:text-neutral-400">
            No messages yet. Be the first to say something.
          </p>
        ) : (
          messages.map((m) => (
            <ChatBubble
              key={m.id}
              msg={m}
              mine={!!selfUserId && m.author_user_id === selfUserId}
              accentKey={accentKey}
              dark={dark}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ChatBubble({
  msg,
  mine,
  accentKey,
  dark,
}: {
  msg: ChatMessageOut;
  mine: boolean;
  accentKey: import("../lib/accentColors").AccentKey;
  dark: boolean;
}) {
  const side = mine ? "items-end" : "items-start";
  const palette = ACCENT_PALETTE[accentKey];
  // "Mine" bubble: same physical material as the receiver bubble —
  // same neutral edge ring, same drop shadow, same inset highlight.
  // The ONLY visual distinction is the accent band tint on the
  // background (matches the top banner's composition) + a slightly
  // accent-tinted halo. Both bubbles therefore carry equal visual
  // weight; the sender just reads as the "color side" of the thread.
  const MINE_SURFACE = dark ? "#171717" : "#ffffff";
  const MINE_EDGE = dark ? "#101015" : "#9aa3b2";
  const myStyle: React.CSSProperties | undefined = mine
    ? {
        backgroundColor: MINE_SURFACE,
        backgroundImage: `linear-gradient(to bottom, ${dark ? palette.bandDark : palette.band}, transparent 110%)`,
        color: dark ? "#f5f5f5" : "#0f172a",
        boxShadow: [
          "0 8px 22px rgba(0,0,0,0.28)",
          "inset 0 1.5px 0 rgba(255,255,255,0.45)",
          // Neutral ring — matches the receiver bubble exactly so
          // neither side stands out for having a louder outline.
          `0 0 0 1.5px ${MINE_EDGE}`,
          // Halo uses the soft `band` tint — same quiet intensity as
          // the receiver's neutral halo, just in the group's color.
          `0 0 24px -4px ${dark ? palette.bandDark : palette.band}`,
        ].join(", "),
      }
    : undefined;
  // "Other" bubble: same 3D treatment as "mine" — vertical gradient,
  // heavy drop shadow, crisp ring, soft halo, glossy top highlight —
  // but in neutral tones so the accent stays exclusive to the user's
  // own messages. Both bubbles read as the same physical material;
  // identity is color.
  const NEUTRAL_TOP = dark ? "#3a3a44" : "#ffffff";
  const NEUTRAL_BOT = dark ? "#1f1f25" : "#dfe3ea";
  const NEUTRAL_EDGE = dark ? "#101015" : "#9aa3b2";
  const otherStyle: React.CSSProperties | undefined = !mine
    ? {
        backgroundImage: `linear-gradient(to bottom, ${NEUTRAL_TOP}, ${NEUTRAL_BOT})`,
        color: dark ? "#f5f5f5" : "#0f172a",
        boxShadow: [
          "0 8px 22px rgba(0,0,0,0.28)",
          "inset 0 1.5px 0 rgba(255,255,255,0.45)",
          `0 0 0 1.5px ${NEUTRAL_EDGE}`,
          `0 0 24px -4px ${NEUTRAL_EDGE}`,
        ].join(", "),
      }
    : undefined;
  const otherClass = "rounded-[18px] rounded-bl-md";
  const myClass = "rounded-[18px] rounded-br-md font-medium";
  // The author label color on "others" bubbles dims a bit in dark mode
  // — kept consistent regardless of accent so the eye-line going down
  // the thread stays calm.
  void dark;
  const authorLabel = msg.author_is_agent
    ? "Agent"
    : msg.author_user_id
      ? (msg.author_display_name || msg.author_handle || "?")
      : "(deleted user)";
  return (
    <div className={`flex flex-col gap-0.5 ${side}`}>
      {!mine && (
        <span className="px-2 text-[10px] font-semibold text-neutral-500 dark:text-neutral-400">
          {authorLabel}
        </span>
      )}
      <div
        className={`max-w-[82%] ${mine ? "px-3.5 py-2 text-[15px]" : "px-3.5 py-2 text-[15px]"} ${mine ? myClass : otherClass}`}
        style={mine ? myStyle : otherStyle}
      >
        {msg.body}
      </div>
      {msg.created_at && (
        <span className="mt-1 px-3 text-[11px] font-medium tracking-tight text-neutral-500 dark:text-neutral-400">
          {formatChatTime(msg.created_at)}
        </span>
      )}
    </div>
  );
}

function formatChatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
