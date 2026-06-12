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
import { ChatStatusStrip } from "./ChatStatusStrip";
import { ChatStatusComposer } from "./ChatStatusComposer";
import { ChatStatusViewer } from "./ChatStatusViewer";
import type { StatusOut } from "../lib/api";
import {
  AnnotationToolbar,
  type AnnotationTarget,
} from "../workspace/BibleView/AnnotationToolbar";
import { SWATCH_FILL } from "../workspace/BibleView/annotations";

/** One verse grouping the user's annotations for the Marks page
 *  Highlights view. Built in BookmarksPanel from the annotations[]
 *  prop. */
interface HighlightGroup {
  verseId: string;
  book: string;
  chapter: number;
  verse: number;
  rows: AnnotationOut[];
  latestAt: string;
}
import type { WorkspaceScope } from "../workspace/Workspace";
import { bookColor } from "../lib/testament";
import { useRoomQuota } from "../lib/useRoomQuota";
import { useStickToBottom } from "../lib/useStickToBottom";
import { useKeyboardInset } from "../lib/useKeyboardInset";
import { confirmDelete } from "../lib/confirmDialog";
import { ACCENT_PALETTE, resolveAccent } from "../lib/accentColors";
import {
  PinIcon as PinSvg,
  BellMuteIcon as BellMuteSvg,
  SearchIcon as SearchSvg,
  MenuIcon as MenuSvg,
  MagicIcon,
} from "../lib/Icons";
import { useYjsNotes } from "../workspace/NotesSidebar/yjsNotes";
import { NotesSidebar } from "../workspace/NotesSidebar/NotesSidebar";
import { useUnreadNoteCount } from "../workspace/NotesSidebar/noteReadTracker";
import {
  speechRecognitionSupported,
  startSpeech,
} from "../lib/speechRecognition";
import { Workspace, type VerseFocus } from "../workspace/Workspace";
import { Avatar } from "./Profile";
import { SettingsModal } from "./Settings";
import { NewRoomModal, type NewRoomValues } from "./NewRoomModal";
import { ShareRoomModal } from "./ShareRoomModal";
import { RoomAvatar } from "./RoomAvatar";
import { UserProfileSheet } from "./UserProfileSheet";
import { ContactsSheet } from "./ContactsSheet";
import { ActionButton, Pill } from "./SettingsButtons";
import { BottomSheet } from "./BottomSheet";

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
  /** Latest chat message in this room — used by the rooms rail to
   *  render WhatsApp-style row previews + sort by activity. Null
   *  when no chats yet. */
  lastMessageBody?: string | null;
  lastMessageAt?: string | null; // ISO-8601 UTC
  lastMessageAuthorHandle?: string | null;
}

type Tab = "bible" | "notes" | "chat" | "bookmarks";
const TAB_ORDER: Tab[] = ["bible", "notes", "chat", "bookmarks"];

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
  // Long-press + slide gesture on the standalone AI pill (Bible tab):
  // active = press-and-hold passed the 350ms threshold; dx/dy track
  // the drag from the original press point so the UI can lean the
  // pill toward the gesture target.
  const [aiPillGesture, setAiPillGesture] = useState<{
    active: boolean;
    dx: number;
    dy: number;
  } | null>(null);
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
  // the reader everywhere. Loaded once at mount + re-pulled whenever
  // the tab regains focus, so an edit on another device propagates
  // here within seconds of switching back. (A full WS subscription
  // would be nicer; focus-poll is dramatically cheaper and is the
  // pattern the rest of the read-only views use too.)
  const [annotations, setAnnotations] = useState<AnnotationOut[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .authAnnotationsList()
        .then((rs) => alive && setAnnotations(rs))
        .catch(() => {});
    refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  // Lightweight toast bus. Only used today by the annotation save/
  // remove paths to surface server errors that were previously
  // swallowed by empty catch blocks. Auto-dismisses after 3.5s.
  const [toast, setToast] = useState<{ text: string; kind: "error" | "info" } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  function annotationErrorText(e: unknown): string {
    const msg = (e as Error)?.message ?? "";
    if (msg.includes("401")) return "Sign in expired — refresh to keep your marks.";
    if (msg.includes("503") || msg.toLowerCase().includes("offline")) {
      return "Couldn't reach the server — mark not saved.";
    }
    return "Couldn't save that mark. Try again in a moment.";
  }

  const applyAnnotation = async (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
    range?: { start: number; end: number } | null,
  ) => {
    try {
      const r = await api.authAnnotationSet(verseId, kind, color, range);
      setAnnotations((as) => {
        // Whole-verse rows still upsert by (verse, kind) — drop the
        // old whole-verse row of the same kind. Sub-verse rows stack
        // by id, so we just remove the matching id if the same
        // (verse, kind, range) was re-applied (the server returned
        // the same id).
        const isSubVerse = range != null;
        if (isSubVerse) {
          return [r, ...as.filter((a) => a.id !== r.id)];
        }
        return [
          r,
          ...as.filter(
            (a) =>
              !(
                a.verse_id === verseId &&
                a.kind === kind &&
                a.start_offset == null &&
                a.end_offset == null
              ),
          ),
        ];
      });
    } catch (e) {
      setToast({ text: annotationErrorText(e), kind: "error" });
    }
  };
  const clearAnnotationKind = async (verseId: string, kind: AnnotationKind) => {
    try {
      await api.authAnnotationRemoveKind(verseId, kind);
      setAnnotations((as) =>
        as.filter((a) => !(a.verse_id === verseId && a.kind === kind)),
      );
    } catch (e) {
      setToast({
        text:
          (e as Error)?.message?.includes("503") || (e as Error)?.message?.toLowerCase()?.includes("offline")
            ? "Couldn't reach the server — your mark is still here."
            : "Couldn't remove that mark.",
        kind: "error",
      });
    }
  };
  const clearAnnotations = async (verseId: string) => {
    try {
      await api.authAnnotationClear(verseId);
      setAnnotations((as) => as.filter((a) => a.verse_id !== verseId));
    } catch (e) {
      setToast({
        text:
          (e as Error)?.message?.includes("503")
            ? "Couldn't reach the server — verse marks unchanged."
            : "Couldn't clear marks. Try again.",
        kind: "error",
      });
    }
  };
  const clearAnnotationById = async (annotationId: string) => {
    try {
      await api.authAnnotationRemoveById(annotationId);
      setAnnotations((as) => as.filter((a) => a.id !== annotationId));
    } catch (e) {
      setToast({ text: annotationErrorText(e), kind: "error" });
    }
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
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [attaching, setAttaching] = useState(false);
  // Long-press → action sheet → "Reply" target. Holds enough info to
  // render the quoted preview above the composer without going back
  // to the message list.
  const [replyTarget, setReplyTarget] = useState<{
    id: string;
    body: string;
    authorHandle: string | null;
    hasImage: boolean;
  } | null>(null);
  // Long-press → action sheet state. Same shape as replyTarget plus
  // the user's id (for "Direct message" CTA when not the author).
  const [actionMessage, setActionMessage] = useState<ChatMessageOut | null>(
    null,
  );

  async function attachChatImage(file: File) {
    if (!active || tab !== "chat" || attaching) return;
    if (file.size > 20 * 1024 * 1024) {
      // Surface via the existing error path? Easier: just bail with a
      // log. The composer will keep the typed caption.
      console.warn("Image too large (>20MB) — skipped.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      console.warn("Non-image dropped on attach — skipped.");
      return;
    }
    setAttaching(true);
    const caption = composerDraft.trim();
    try {
      await api.chatPostImage(
        active.id,
        file,
        caption,
        replyTarget?.id ?? "",
      );
      setComposerDraft("");
      setReplyTarget(null);
    } catch (e) {
      console.warn("Attach failed", e);
    } finally {
      setAttaching(false);
      composerInputRef.current?.focus();
    }
  }
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
      void api
        .chatPost(active.id, text, undefined, replyTarget?.id)
        .catch(() => {});
      setReplyTarget(null);
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
  // Profile-preview sheet opened by tapping a sender avatar in chat.
  // Holds onto the preview fields off the chat message so the UI
  // doesn't flash blank while /auth/users/{id} returns.
  const [profileView, setProfileView] = useState<{
    userId: string;
    handle: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    /** Layout for this open: chat-avatar taps keep the bottom-sheet
     *  feel (`sheet`); arriving via Contacts uses a full-page screen
     *  because the user explicitly navigated to view this person. */
    mode: "sheet" | "fullPage";
  } | null>(null);
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
  // Sync the OS / browser chrome strip above the page with the
  // banner's color. Without this the `<meta name="theme-color">` in
  // index.html stays at its hard-coded #171717, which on Android
  // Chrome and installed PWAs paints a dark gray bar above the
  // banner — looks like the banner doesn't reach the top. We
  // alpha-blend the accent band over the gradient's top stop
  // (white/dark) so the resulting solid color matches the very top
  // pixel of the banner.
  useEffect(() => {
    if (typeof document === "undefined") return;
    // No top banner anymore (user asked to remove it after the PWA
    // seam fight — see [[feedback-top-bar-seam-cause]]). Sync the
    // meta theme-color + html/body bg to MATCH THE CONTENT BG
    // (paper / neutral-900, not paper-soft / neutral-950) — the home
    // and notes panels render on bg-paper / dark:bg-neutral-900, so
    // tinting the PWA status bar to the darker neutral-950 created a
    // visible "the gray doesn't reach the top" band. Now the safe
    // area, the floating-buttons strip, and the content all share
    // one color from top to bottom.
    const solid = theme === "dark" ? "#171717" : "#f7f3ea";
    let tag = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "theme-color");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", solid);
    document.body.style.backgroundColor = solid;
    document.documentElement.style.backgroundColor = solid;
    return () => {
      document.body.style.backgroundColor = "";
      document.documentElement.style.backgroundColor = "";
    };
  }, [theme]);
  // How tall the soft keyboard is right now — added to the composer's
  // bottom anchor so it stays glued to the top of the keyboard on iOS
  // (where `position: fixed; bottom: 0` would otherwise sit behind it).
  const keyboardInset = useKeyboardInset();
  const [contactsOpen, setContactsOpen] = useState(false);
  // "scoped" = members of the active room only (chat-tab top-bar
  // contacts icon). "all" = every contact across every room the
  // user shares (rooms-rail header contacts icon).
  const [contactsMode, setContactsMode] = useState<"scoped" | "all">("scoped");
  // In-room chat search. Toggling open shows an inline search field
  // at the top of the chat panel; the query filters messages by body
  // (case-insensitive). Cleared when you leave the Chat tab.
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  // Bumped each time the user taps the search icon on the Notes tab.
  // NotesSidebar listens to the value and focuses its search input
  // when it changes — gives the avatar slot something to do on Notes
  // (it's now a search button instead of opening the Profile sheet).
  const [notesSearchTrigger, setNotesSearchTrigger] = useState(0);
  // Mirror of NotesSidebar's `searchOpen`. The top-bar magnifier
  // was retired in favor of the Edit button, but the slide-up gesture
  // still toggles search; the mirror stays so any future surfaces
  // that need to reflect "search is open" can subscribe without a
  // re-plumb.
  const [, setNotesSearchOpen] = useState(false);
  // "Edit mode" toggles on the Notes + Chat tabs. When on, the
  // corresponding panel surfaces delete affordances on items the user
  // can remove (own chat messages; personal-scope notes). Reset
  // whenever the tab changes so editing doesn't bleed across screens.
  const [notesEditMode, setNotesEditMode] = useState(false);
  const [chatEditMode, setChatEditMode] = useState(false);
  useEffect(() => {
    if (tab !== "notes") setNotesEditMode(false);
    if (tab !== "chat") setChatEditMode(false);
  }, [tab]);
  // Bible "second bounce" hide. When the user reaches the bottom of a
  // chapter and bounces twice within 1.5s, BibleView dispatches a
  // `bible:panel-hide` and the floating bottom panel + standalone AI
  // pill fade away so the closing verses read cleanly. Any scroll
  // away from the bottom (or a tab switch) brings them back.
  const [panelHidden, setPanelHidden] = useState(false);
  useEffect(() => {
    const onHide = () => setPanelHidden(true);
    const onShow = () => setPanelHidden(false);
    const onToggle = () => setPanelHidden((v) => !v);
    window.addEventListener("bible:panel-hide", onHide);
    window.addEventListener("bible:panel-show", onShow);
    window.addEventListener("bible:panel-toggle", onToggle);
    return () => {
      window.removeEventListener("bible:panel-hide", onHide);
      window.removeEventListener("bible:panel-show", onShow);
      window.removeEventListener("bible:panel-toggle", onToggle);
    };
  }, []);
  useEffect(() => {
    setPanelHidden(false);
  }, [tab]);
  // Same pattern as `notesSearchTrigger` — bumped when the search
  // button on the Marks tab top bar is tapped. BookmarksPanel toggles
  // its search field open/closed on each bump.
  const [marksSearchTrigger, setMarksSearchTrigger] = useState(0);
  // Marks tab view mode. "bookmarks" = the ribbon cards; "highlights" =
  // a flat list of every annotated verse pulled from the existing
  // annotations[] state. Toggled by the Marks-page hamburger menu in
  // the top-bar (which replaced the Settings hamburger on this tab).
  const [marksView, setMarksView] = useState<"bookmarks" | "highlights">(
    "bookmarks",
  );
  const [marksMenuOpen, setMarksMenuOpen] = useState(false);
  useEffect(() => {
    if (tab !== "chat") {
      setChatSearchOpen(false);
      setChatSearchQuery("");
    }
  }, [tab]);
  // Close the Marks page hamburger menu whenever the user navigates
  // off the tab so it doesn't reopen with stale state on return.
  useEffect(() => {
    if (tab !== "bookmarks") setMarksMenuOpen(false);
  }, [tab]);
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
  const notesApi = useYjsNotes(activeId, selfUserId, handle);
  // Unread count for the bottom-nav Notes badge. Same seen-set the
  // NotesSidebar mutates, so marking-read there updates the badge in
  // the same tab via the custom `notes-seen-changed` event.
  const noteIds = useMemo(() => notesApi.notes.map((n) => n.id), [notesApi.notes]);
  const unreadNoteCount = useUnreadNoteCount(noteIds, activeId, selfUserId);

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
          lastMessageBody: r.last_message_body ?? null,
          lastMessageAt: r.last_message_at ?? null,
          lastMessageAuthorHandle: r.last_message_author_handle ?? null,
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
  function onTouchEnd(_e: React.TouchEvent) {
    // Horizontal swipe-to-switch-tabs is OFF per user preference —
    // it was firing on accidental drags (e.g. while scrolling a
    // list). Tabs are now ONLY changed via the bottom-nav buttons.
    // Touch ref is still cleared so a future re-enable doesn't see
    // stale start coords.
    touchStart.current = null;
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
    <div className="flex h-full flex-col bg-paper dark:bg-neutral-900">
      {/* Top app bar. `pt-[env(safe-area-inset-top)]` keeps the avatar
       *  + group pill clear of the iOS notch / Dynamic Island and the
       *  Android status bar when the app is installed as a PWA. The
       *  `linear-gradient` overlay tints the band with the active
       *  group's accent color (auto-derived per id, or admin-picked
       *  via AdminPanel) so each group reads as visually distinct. */}
      {/* Top button row — no bar, no banner. After fighting the
       *  PWA seam for several iterations, the user asked to drop the
       *  unified band entirely. Buttons now float on the body bg as
       *  individual chrome pills (each carries its own border + glass
       *  shadow recipe). The per-group accent is no longer painted as
       *  a top band — see [[feedback-top-bar-seam-cause]]. */}
      <header
        className="relative z-30 flex items-center justify-between gap-2 px-2 py-2"
        style={{
          paddingTop:
            "calc(env(safe-area-inset-top, 0px) + 0.5rem)",
          paddingLeft:
            "calc(env(safe-area-inset-left, 0px) + 0.5rem)",
          paddingRight:
            "calc(env(safe-area-inset-right, 0px) + 0.5rem)",
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
          {/* On the Chat tab the user's own avatar slot becomes a
           *  search button — toggles an inline search field at the
           *  top of the chat panel. On the Notes tab the same slot
           *  also becomes a search button — bumps a trigger that
           *  NotesSidebar listens to to focus its existing search
           *  field. Every other tab keeps the avatar (taps through
           *  to the Profile sheet). */}
          {tab === "chat" ? (
            // Edit-mode toggle. ChatPanel listens for `chatEditMode`
            // and reveals a delete affordance on each of the user's
            // own messages while it's on. Search is still reachable
            // via the slide-up gesture on the AI pill — no need to
            // double up the top bar.
            <button
              onClick={() => setChatEditMode((v) => !v)}
              aria-label={chatEditMode ? "Done editing" : "Edit messages"}
              aria-pressed={chatEditMode}
              title={chatEditMode ? "Done" : "Edit your messages"}
              className={`grid h-11 min-w-[56px] place-items-center rounded-full border px-3 text-[13px] font-semibold shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)] ${
                chatEditMode
                  ? "border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100"
                  : "border-neutral-200 bg-paper text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              }`}
            >
              {chatEditMode ? "Done" : "Edit"}
            </button>
          ) : tab === "notes" ? (
            // Edit-mode toggle. NotesSidebar listens for `notesEditMode`
            // and reveals delete affordances on PERSONAL notes only —
            // group-scope notes are off-limits via this button. Search
            // moved to the slide-up gesture.
            <button
              onClick={() => setNotesEditMode((v) => !v)}
              aria-label={notesEditMode ? "Done editing" : "Edit notes"}
              aria-pressed={notesEditMode}
              title={notesEditMode ? "Done" : "Edit your personal notes"}
              className={`grid h-11 min-w-[56px] place-items-center rounded-full border px-3 text-[13px] font-semibold shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)] ${
                notesEditMode
                  ? "border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100"
                  : "border-neutral-200 bg-paper text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              }`}
            >
              {notesEditMode ? "Done" : "Edit"}
            </button>
          ) : tab === "bookmarks" ? (
            <button
              onClick={() => setMarksSearchTrigger((n) => n + 1)}
              aria-label="Search bookmarks"
              title="Search bookmarks"
              className="grid h-11 w-11 place-items-center rounded-full border border-neutral-200 bg-paper text-neutral-700 shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]"
            >
              <SearchSvg className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={() => {
                setSettingsMode("profile");
                setSettingsOpen(true);
              }}
              className="group grid h-11 w-11 place-items-center rounded-full hover:bg-paper-soft dark:hover:bg-neutral-800"
              aria-label="Profile"
            >
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
          )}
          {tab === "chat" ? (
            <button
              onClick={() => {
                setContactsMode("scoped");
                setContactsOpen(true);
              }}
              className="grid h-11 w-11 place-items-center rounded-full border border-neutral-200 bg-paper text-neutral-700 shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]"
              aria-label="Group members"
              title="Group members"
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                {/* iOS-style contact book glyph */}
                <rect x="4.5" y="3.5" width="14" height="17" rx="2.5" />
                <circle cx="11.5" cy="10" r="2.5" />
                <path d="M7.5 17c.6-2 2.2-3 4-3s3.4 1 4 3" />
                <path d="M19.5 7v3" />
                <path d="M19.5 14v3" />
              </svg>
            </button>
          ) : tab === "notes" ? (
            (() => {
              // On the Notes tab the hamburger becomes a single-tap
              // toggle between Personal and Group note scopes. Each
              // tap flips `settings.defaultNoteScope`; NotesSidebar
              // listens for SETTINGS_CHANGED and re-renders.
              const isGroup = settings.defaultNoteScope === "group";
              return (
                <button
                  onClick={() =>
                    onChangeSettings({
                      ...settings,
                      defaultNoteScope: isGroup ? "personal" : "group",
                    })
                  }
                  aria-pressed={isGroup}
                  aria-label={
                    isGroup
                      ? "Group notes (tap for personal)"
                      : "Personal notes (tap for group)"
                  }
                  title={
                    isGroup
                      ? "Group notes — shared with the group"
                      : "Personal notes — private to you"
                  }
                  style={
                    isGroup
                      ? {
                          // Group toggle picks up the active room's
                          // accent so it matches the color the admin
                          // chose in Settings → Group admin → palette,
                          // and so it never collides with the search
                          // icon's amber active state.
                          backgroundColor: accent.bubble,
                          color: accent.bubbleFg,
                          borderColor: theme === "dark" ? accent.ringDark : accent.ring,
                        }
                      : undefined
                  }
                  className={`inline-flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)] ${
                    isGroup
                      ? ""
                      : "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-700 dark:bg-violet-900/40 dark:text-violet-100"
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    {isGroup ? (
                      <>
                        <circle cx="9" cy="9" r="3" />
                        <circle cx="17" cy="10" r="2.5" />
                        <path d="M3.5 18c.6-2.6 2.9-4.5 5.5-4.5s4.9 1.9 5.5 4.5" />
                        <path d="M15 18c.3-1.6 1.8-2.8 3.5-2.8s3.2 1.2 3.5 2.8" />
                      </>
                    ) : (
                      <>
                        <circle cx="12" cy="8" r="4" />
                        <path d="M4 20c.7-3.5 4-6 8-6s7.3 2.5 8 6" />
                      </>
                    )}
                  </svg>
                  {isGroup ? "Group" : "Personal"}
                </button>
              );
            })()
          ) : tab === "bookmarks" ? (
            <div className="relative">
              <button
                onClick={() => setMarksMenuOpen((o) => !o)}
                className="grid h-11 w-11 place-items-center rounded-full border border-neutral-200 bg-paper text-neutral-700 shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]"
                aria-label="Marks views"
                aria-expanded={marksMenuOpen}
                aria-haspopup="menu"
                title="Switch view"
              >
                <MenuSvg className="h-5 w-5" />
              </button>
              {marksMenuOpen && (
                <>
                  {/* Tap-out scrim closes the popover without dismissing
                      the underlying tap target. */}
                  <button
                    type="button"
                    aria-hidden
                    tabIndex={-1}
                    onClick={() => setMarksMenuOpen(false)}
                    className="fixed inset-0 z-40 cursor-default bg-transparent"
                  />
                  <div
                    role="menu"
                    aria-label="Marks views"
                    className="absolute right-0 top-[calc(100%+8px)] z-50 grid w-[180px] gap-1 rounded-2xl border border-neutral-200 bg-paper p-2 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={marksView === "bookmarks"}
                      onClick={() => {
                        setMarksView("bookmarks");
                        setMarksMenuOpen(false);
                      }}
                      className={`rounded-xl px-3 py-2 text-left text-[13px] transition ${
                        marksView === "bookmarks"
                          ? "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                          : "text-neutral-700 hover:bg-paper-soft dark:text-neutral-200 dark:hover:bg-neutral-800"
                      }`}
                    >
                      Bookmarks
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={marksView === "highlights"}
                      onClick={() => {
                        setMarksView("highlights");
                        setMarksMenuOpen(false);
                      }}
                      className={`rounded-xl px-3 py-2 text-left text-[13px] transition ${
                        marksView === "highlights"
                          ? "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                          : "text-neutral-700 hover:bg-paper-soft dark:text-neutral-200 dark:hover:bg-neutral-800"
                      }`}
                    >
                      Highlights
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              onClick={() => {
                setSettingsMode("menu");
                setSettingsOpen(true);
              }}
              className="grid h-11 w-11 place-items-center rounded-full border border-neutral-200 bg-paper text-neutral-700 shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-transform active:scale-[0.96] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]"
              aria-label="Open settings"
              title="Settings"
            >
              <MenuSvg className="h-5 w-5" />
            </button>
          )}
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
                accentKey={accentKey}
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
                focusSearchTrigger={notesSearchTrigger}
                onSearchOpenChange={setNotesSearchOpen}
                editMode={notesEditMode}
              />
            )}
            {tab === "chat" && (
              <ChatPanel
                roomId={active.id}
                roomName={active.name}
                selfUserId={selfUserId}
                selfHandle={handle}
                selfAvatarUrl={myAvatarUrl}
                accentKey={accentKey}
                dark={theme === "dark"}
                searchOpen={chatSearchOpen}
                searchQuery={chatSearchQuery}
                onSearchQueryChange={setChatSearchQuery}
                onSearchClose={() => {
                  setChatSearchOpen(false);
                  setChatSearchQuery("");
                }}
                onRead={() =>
                  setRooms((prev) =>
                    prev.map((r) =>
                      r.id === active.id ? { ...r, unreadCount: 0 } : r,
                    ),
                  )
                }
                onAvatarTap={(userId, preview) => {
                  setProfileView({
                    userId,
                    handle: preview.handle,
                    displayName: preview.displayName,
                    avatarUrl: preview.avatarUrl,
                    mode: "sheet",
                  });
                }}
                onLongPress={(msg) => {
                  setActionMessage(msg);
                  // Soft haptic on supported devices.
                  if (
                    typeof navigator !== "undefined" &&
                    "vibrate" in navigator
                  ) {
                    try {
                      (
                        navigator as Navigator & {
                          vibrate?: (p: number) => void;
                        }
                      ).vibrate?.(10);
                    } catch {
                      // ignored
                    }
                  }
                }}
                editMode={chatEditMode}
                onDeleteMessage={async (messageId) => {
                  try {
                    await api.chatDelete(active.id, messageId);
                    // The WS publish from the backend will remove it
                    // from the list. Optimistic removal here would
                    // race with the broadcast.
                  } catch (e) {
                    alert(
                      `Couldn't delete message: ${(e as Error).message}`,
                    );
                  }
                }}
              />
            )}
            {tab === "bookmarks" && (
              <BookmarksPanel
                view={marksView}
                bookmarks={pickLatestPerBook(bookmarks)}
                annotations={annotations}
                timezone={settings.timezone}
                dark={theme === "dark"}
                focusSearchTrigger={marksSearchTrigger}
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
        // Long-press + slide gesture on the Bible tab's AI pill:
        //   long-press   → enters gesture mode (the pill grows + two
        //                  affordance icons appear: search above,
        //                  magic to the left)
        //   slide up     → search opens (dispatch bible:search)
        //   slide left   → agent composer toggles (existing behavior)
        //   no slide     → on release does nothing if gesture was
        //                  entered; if not entered, taps normally
        // Other tabs keep classic click-only.
        const meta =
          tab === "bible"
            ? {
                outline: <MagicIcon className="h-4 w-4" />,
                filled: <MagicIcon className="h-4 w-4" filled />,
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
        // Hide the AI pill while the soft keyboard is up unless the
        // composer is open — when the user is typing anywhere else
        // (search fields, etc.) the pill would float over their input.
        if (keyboardInset > 0 && !composerOpen) return null;
        return (
          <div
            className="pointer-events-none fixed right-3 z-40 flex flex-col items-end gap-2 pt-2"
            style={{
              bottom: keyboardInset,
              paddingBottom: "env(safe-area-inset-bottom)",
              opacity: panelHidden ? 0 : 1,
              transform: panelHidden ? "translateY(20px)" : "translateY(0)",
              transition: "opacity 260ms ease-out, transform 260ms ease-out",
              pointerEvents: panelHidden ? "none" : undefined,
            }}
          >
            {/* Floating 3D search icon removed — the AI pill's
             *  press-and-hold + slide-up gesture replaces it. */}
            {/* Gesture-mode affordances live inside the bottom panel,
             *  not floating around the pill — see the <nav> block. */}
            <button
              onPointerDown={(e) => {
                // Gesture detection runs on every tab so the panel +
                // pill push effect works everywhere. Tab-specific
                // actions (search vs. composer) are decided on release.
                const startX = e.clientX;
                const startY = e.clientY;
                const pid = e.pointerId;
                // Try to capture so the pointer keeps firing events on
                // this button even if the finger leaves its bounds.
                try {
                  (e.target as Element).setPointerCapture?.(pid);
                } catch {
                  // best-effort
                }
                let activated = false;
                const holdTimer = window.setTimeout(() => {
                  activated = true;
                  setAiPillGesture({ active: true, dx: 0, dy: 0 });
                }, 350);
                const onMove = (ev: PointerEvent) => {
                  if (ev.pointerId !== pid) return;
                  const dx = ev.clientX - startX;
                  const dy = ev.clientY - startY;
                  // Movement before activation cancels the long-press
                  // (the user is just trying to tap / accidental drag).
                  if (!activated) {
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                      window.clearTimeout(holdTimer);
                      cleanup();
                    }
                    return;
                  }
                  setAiPillGesture({ active: true, dx, dy });
                };
                const onUp = (ev: PointerEvent) => {
                  if (ev.pointerId !== pid) return;
                  window.clearTimeout(holdTimer);
                  if (activated) {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    const upDrag = -dy > 40 && Math.abs(dy) > Math.abs(dx);
                    const leftDrag = -dx > 40 && Math.abs(dx) > Math.abs(dy);
                    if (upDrag) {
                      // Slide-up = open this tab's search affordance.
                      // Each tab has its own surface, but the gesture
                      // dispatches to whichever one is current.
                      if (tab === "bible") {
                        window.dispatchEvent(new CustomEvent("bible:search"));
                      } else if (tab === "chat") {
                        // Toggle, not just open — mirrors the Notes
                        // pattern: slide-up once opens + focuses, slide-
                        // up again closes the bar. Lets the user undo
                        // the search without reaching for "Done".
                        setChatSearchOpen((v) => !v);
                      } else if (tab === "notes") {
                        setNotesSearchTrigger((n) => n + 1);
                      } else if (tab === "bookmarks") {
                        setMarksSearchTrigger((n) => n + 1);
                      }
                    } else if (leftDrag) {
                      // Composer toggle works on every tab.
                      toggleComposer();
                    }
                    // Released without enough drag in either direction
                    // = no action; the pill quietly returns to rest.
                  }
                  // If never activated (released before 350ms), treat
                  // as a normal tap — open/close the composer.
                  else {
                    toggleComposer();
                  }
                  cleanup();
                };
                const cleanup = () => {
                  setAiPillGesture(null);
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  window.removeEventListener("pointercancel", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
              }}
              onClick={(e) => {
                // The pointer flow above handles both taps (via the
                // not-yet-activated branch) and long-press gestures, so
                // we always suppress the synthetic click to avoid
                // double-triggering. The composer toggle still fires
                // from the pointer-up handler on every tab.
                e.preventDefault();
              }}
              // Square 64x64 pill, squircle corners matching the tab
              // bar (`rounded-[28px]`) so the two glass elements feel
              // like the same material rather than a circle next to a
              // rounded rectangle. Border picks up the active group's
              // accent so the AI surface reads as "yours" (or
              // "ours" — themed per group).
              style={{
                // Kill iOS magnifier + callout — the long-press gesture
                // is OURS, not Safari's.
                WebkitTouchCallout: "none",
                WebkitUserSelect: "none",
                userSelect: "none",
                borderColor:
                  theme === "dark" ? accent.ringDark : accent.ring,
                borderWidth: "2px",
                // Glass material: translucent so the content layer
                // beneath shows through. The per-group accent BORDER
                // still marks the pill as "yours" without painting
                // over the lensing surface.
                //
                // On the BIBLE tab the pill reads as a recessed well
                // CUT INTO the scripture page — pressing it feels like
                // peeling back the Bible to expose the agent beneath.
                // The recessed shadow stack (deep inner-top + light
                // bottom rim + dark hairline) replaces the lifted drop
                // shadow on Bible. Other tabs keep the floating look.
                boxShadow:
                  tab === "bible"
                    ? theme === "dark"
                      ? "inset 0 8px 18px rgba(0,0,0,0.75), inset 0 3px 8px rgba(0,0,0,0.50), inset 0 -2px 0 rgba(255,255,255,0.12), 0 0 0 1px rgba(0,0,0,0.55)"
                      : "inset 0 8px 18px rgba(0,0,0,0.35), inset 0 3px 8px rgba(0,0,0,0.20), inset 0 -2px 0 rgba(255,255,255,0.70), 0 0 0 1px rgba(0,0,0,0.18)"
                    : theme === "dark"
                      ? "0 6px 18px rgba(0,0,0,0.45), inset 0 1.5px 0 rgba(255,255,255,0.10), 0 0 0 1px rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.25)"
                      : "0 6px 18px rgba(0,0,0,0.18), inset 0 1.5px 0 rgba(255,255,255,0.55), 0 0 0 1px rgba(0,0,0,0.04), inset 0 -1px 0 rgba(0,0,0,0.06)",
                // Lean the pill toward the active drag direction so
                // the user feels the gesture taking hold.
                transform:
                  aiPillGesture?.active
                    ? `translate(${Math.max(-30, Math.min(0, aiPillGesture.dx * 0.4))}px, ${Math.max(-30, Math.min(0, aiPillGesture.dy * 0.4))}px) scale(1.05)`
                    : undefined,
                transition: aiPillGesture?.active
                  ? "transform 0ms"
                  : "transform 180ms cubic-bezier(0.32, 0.72, 0.0, 1)",
                touchAction: "none",
              }}
              className={`pointer-events-auto grid h-[64px] w-[64px] place-items-center rounded-[28px] backdrop-blur-2xl backdrop-saturate-[1.8] active:scale-[0.97] ${
                tab === "bible"
                  ? "bg-neutral-200/70 dark:bg-black/55"
                  : "glass-specular bg-paper/55 dark:bg-neutral-900/45"
              } ${
                open
                  ? "text-neutral-900 dark:text-neutral-50"
                  : "text-neutral-700 dark:text-neutral-200"
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
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 76px)",
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
        className="pointer-events-none fixed inset-x-0 z-40 flex justify-start pl-[20px] pr-[96px] pt-2"
        style={{
          bottom: keyboardInset,
          paddingBottom: "env(safe-area-inset-bottom)",
          opacity: panelHidden ? 0 : 1,
          transform: panelHidden ? "translateY(20px)" : "translateY(0)",
          transition: "opacity 260ms ease-out, transform 260ms ease-out",
          pointerEvents: panelHidden ? "none" : undefined,
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
            onClearById={clearAnnotationById}
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
          <div className="pointer-events-auto flex min-w-0 flex-1 flex-col gap-1.5">
            {tab === "chat" && replyTarget && (
              <div
                className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/90 px-3 py-2 text-[12px] shadow-[0_4px_14px_rgba(0,0,0,0.10)] backdrop-blur-md dark:border-amber-800/60 dark:bg-amber-900/40"
                role="status"
                aria-live="polite"
              >
                <span className="mt-0.5 inline-block h-full w-[3px] shrink-0 rounded-full bg-amber-500/80" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    Replying to{" "}
                    {replyTarget.authorHandle
                      ? `@${replyTarget.authorHandle}`
                      : "message"}
                  </div>
                  <div className="line-clamp-2 text-neutral-800 dark:text-neutral-100">
                    {replyTarget.hasImage && !replyTarget.body
                      ? "📷 Photo"
                      : replyTarget.body || "(empty message)"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyTarget(null)}
                  aria-label="Cancel reply"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-amber-700 transition hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-800/40"
                >
                  ✕
                </button>
              </div>
            )}
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
            //
            // On the BIBLE tab the agent composer reads as a layer
            // BENEATH the scripture page — pressing the pill feels
            // like peeling back the Bible to expose the agent. So the
            // glass-specular highlight + outer drop shadow are dropped
            // (those scream "floating on top"); the recessed inset
            // shadow stack carved into the rim makes it feel inset
            // INTO the page. Other tabs keep the floating look since
            // their composers are for outbound posting, not a hidden
            // layer.
            className={`pointer-events-auto relative flex h-[64px] w-full items-stretch gap-1 rounded-[28px] border px-1 py-1 backdrop-blur-2xl backdrop-saturate-[1.8] ${
              tab === "bible"
                ? "border-black/20 bg-neutral-200/70 dark:border-white/5 dark:bg-black/55"
                : "glass-specular border-white/40 bg-paper/55 dark:border-white/10 dark:bg-neutral-900/45"
            }`}
            style={{
              boxShadow:
                tab === "bible"
                  ? theme === "dark"
                    ? "inset 0 8px 18px rgba(0,0,0,0.75), inset 0 3px 8px rgba(0,0,0,0.50), inset 0 -2px 0 rgba(255,255,255,0.12), 0 0 0 1px rgba(0,0,0,0.55)"
                    : "inset 0 8px 18px rgba(0,0,0,0.35), inset 0 3px 8px rgba(0,0,0,0.20), inset 0 -2px 0 rgba(255,255,255,0.70), 0 0 0 1px rgba(0,0,0,0.18)"
                  : theme === "dark"
                    ? "0 6px 18px rgba(0,0,0,0.45), inset 0 1.5px 0 rgba(255,255,255,0.10), 0 0 0 1px rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.25)"
                    : "0 6px 18px rgba(0,0,0,0.18), inset 0 1.5px 0 rgba(255,255,255,0.55), 0 0 0 1px rgba(0,0,0,0.04), inset 0 -1px 0 rgba(0,0,0,0.06)",
              // Same contact-push as the tab nav: when the pill is
              // long-pressed and dragged left, the composer slides with
              // it once the colored ring meets its right edge. Mirrors
              // the nav math (CONTACT_GAP 22). Works on every tab.
              transform: aiPillGesture?.active
                ? (() => {
                    const pillDx = Math.max(
                      -30,
                      Math.min(0, aiPillGesture.dx * 0.4),
                    );
                    const CONTACT_GAP = 22;
                    const navDx = Math.min(0, pillDx + CONTACT_GAP);
                    return `translateX(${navDx}px)`;
                  })()
                : undefined,
              transition: aiPillGesture?.active
                ? "transform 0ms"
                : "transform 180ms cubic-bezier(0.32, 0.72, 0.0, 1)",
            }}
            aria-label={
              tab === "bible"
                ? "Ask the agent"
                : tab === "notes"
                  ? "Add a note"
                  : "Send a message"
            }
          >
            {aiPillGesture?.active && (() => {
              // Same gesture takeover as the closed-composer nav — when
              // the composer is open and the user long-presses the AI
              // pill, the form's inputs hide and the panel shows the
              // search-up / composer-left affordances so the hint is
              // identical across tab and composer states.
              const upActive =
                aiPillGesture.dy < -20 &&
                -aiPillGesture.dy > Math.abs(aiPillGesture.dx);
              const leftActive =
                aiPillGesture.dx < -20 &&
                Math.abs(aiPillGesture.dx) > Math.abs(aiPillGesture.dy);
              const composerLabel =
                tab === "bible"
                  ? "Activate Agent"
                  : tab === "chat"
                    ? "Send Message"
                    : tab === "notes"
                      ? "Add Note"
                      : "Compose";
              return (
                <div className="pointer-events-none absolute inset-0 z-10 flex h-full w-full items-center rounded-[28px] bg-paper/55 backdrop-blur-2xl dark:bg-neutral-900/45">
                  <div
                    className="absolute right-3 top-1 text-neutral-800 dark:text-neutral-100"
                    style={{
                      opacity: upActive ? 0.95 : 0.4,
                      transform: `scale(${upActive ? 1.3 : 1})`,
                      transformOrigin: "right top",
                      transition:
                        "opacity 140ms ease-out, transform 140ms ease-out",
                    }}
                  >
                    <SearchSvg className="h-5 w-5" />
                  </div>
                  <div
                    className="absolute inset-y-0 left-3 flex items-center gap-1.5 whitespace-nowrap text-neutral-800 dark:text-neutral-100"
                    style={{
                      opacity: leftActive ? 0.95 : 0.5,
                      transform: `scale(${leftActive ? 1.1 : 1})`,
                      transformOrigin: "left center",
                      transition:
                        "opacity 140ms ease-out, transform 140ms ease-out",
                    }}
                  >
                    <span
                      aria-hidden
                      className="text-[16px] leading-none"
                      style={{ letterSpacing: "-0.05em" }}
                    >
                      ‹‹
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">
                      {composerLabel}
                    </span>
                  </div>
                </div>
              );
            })()}
            {tab === "chat" && (
              <>
                <input
                  ref={attachInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void attachChatImage(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={attaching || !active}
                  className="grid h-[48px] w-[48px] shrink-0 self-center place-items-center rounded-full text-neutral-700 transition disabled:opacity-40 hover:bg-paper-soft dark:text-neutral-200 dark:hover:bg-neutral-800"
                  aria-label="Attach photo"
                  title="Attach photo"
                  onPointerDown={(e) => e.preventDefault()}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {attaching ? "…" : <PaperclipIcon />}
                </button>
              </>
            )}
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
            <VoiceInputButton
              onTranscript={(t) =>
                setComposerDraft((cur) => (cur ? `${cur} ${t}` : t))
              }
              language="en-US"
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
          </div>
        ) : keyboardInset > 0 ? (
          // Soft keyboard is up → hide the bottom tab bar so it
          // doesn't get pushed into the visible viewport and crowd
          // the input the user is typing into. Composer + annotation
          // toolbar branches above stay visible because the user is
          // actively interacting with them.
          null
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
            className="glass-specular pointer-events-auto relative flex h-[64px] flex-1 items-stretch rounded-[28px] border border-white/40 bg-paper/55 px-1 py-1 backdrop-blur-2xl backdrop-saturate-[1.8] dark:border-white/10 dark:bg-neutral-900/45"
            style={{
              // No iOS magnifier / selection callout — the panel is
              // chrome, not content. Same treatment as the standalone
              // pill so the long-press gesture isn't hijacked.
              WebkitTouchCallout: "none",
              WebkitUserSelect: "none",
              userSelect: "none",
              boxShadow:
                theme === "dark"
                  ? "0 6px 18px rgba(0,0,0,0.45), inset 0 1.5px 0 rgba(255,255,255,0.10), 0 0 0 1px rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.25)"
                  : "0 6px 18px rgba(0,0,0,0.18), inset 0 1.5px 0 rgba(255,255,255,0.55), 0 0 0 1px rgba(0,0,0,0.04), inset 0 -1px 0 rgba(0,0,0,0.06)",
              // Contact-driven push, no residual gap. Raw geometry is
              // ~20px between pill's left edge and nav's right edge
              // (pill right-3 + 64px wide vs. nav container's
              // pr-[96px]). But the pill's COLORED ring (2px accent
              // border) + outer shadow rim + 1.05x scale during gesture
              // all extend its visible edge past 64px, so the contact
              // moment happens earlier than the raw 20px would suggest.
              // CONTACT_GAP slightly exceeds the raw distance so the
              // nav preempts the ring — by the time the pill is fully
              // displaced, they're flush with zero gap. Vertical drags
              // don't translate the panel. Works on every tab.
              transform: aiPillGesture?.active
                ? (() => {
                    const pillDx = Math.max(
                      -30,
                      Math.min(0, aiPillGesture.dx * 0.4),
                    );
                    const CONTACT_GAP = 22;
                    const navDx = Math.min(0, pillDx + CONTACT_GAP);
                    return `translateX(${navDx}px)`;
                  })()
                : undefined,
              transition: aiPillGesture?.active
                ? "transform 0ms"
                : "transform 180ms cubic-bezier(0.32, 0.72, 0.0, 1)",
            }}
          >
            {aiPillGesture?.active ? (
              // Gesture takeover: tab buttons hide, affordances fill the
              // panel. TOP edge = faded search icon (slide UP), LEFT edge
              // = arrows + tab-specific composer label (slide LEFT).
              // Both brighten + scale when the active drag is heading
              // toward them.
              (() => {
                const upActive =
                  aiPillGesture.dy < -20 &&
                  -aiPillGesture.dy > Math.abs(aiPillGesture.dx);
                const leftActive =
                  aiPillGesture.dx < -20 &&
                  Math.abs(aiPillGesture.dx) > Math.abs(aiPillGesture.dy);
                const composerLabel =
                  tab === "bible"
                    ? "Activate Agent"
                    : tab === "chat"
                      ? "Send Message"
                      : tab === "notes"
                        ? "Add Note"
                        : "Compose";
                return (
                  <div className="pointer-events-none relative flex h-full w-full items-center">
                    {/* TOP — faded search icon at the top-right so it
                     *  doesn't collide horizontally with the composer
                     *  label on the left. */}
                    <div
                      className="absolute right-3 top-1 text-neutral-800 dark:text-neutral-100"
                      style={{
                        opacity: upActive ? 0.95 : 0.4,
                        transform: `scale(${upActive ? 1.3 : 1})`,
                        transformOrigin: "right top",
                        transition:
                          "opacity 140ms ease-out, transform 140ms ease-out",
                      }}
                    >
                      <SearchSvg className="h-5 w-5" />
                    </div>
                    {/* LEFT — arrows + tab-specific label, pinned to
                     *  left edge. */}
                    <div
                      className="absolute inset-y-0 left-3 flex items-center gap-1.5 whitespace-nowrap text-neutral-800 dark:text-neutral-100"
                      style={{
                        opacity: leftActive ? 0.95 : 0.5,
                        transform: `scale(${leftActive ? 1.1 : 1})`,
                        transformOrigin: "left center",
                        transition:
                          "opacity 140ms ease-out, transform 140ms ease-out",
                      }}
                    >
                      <span
                        aria-hidden
                        className="text-[16px] leading-none"
                        style={{ letterSpacing: "-0.05em" }}
                      >
                        ‹‹
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">
                        {composerLabel}
                      </span>
                    </div>
                  </div>
                );
              })()
            ) : (
              <>
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
                  badge={unreadNoteCount || undefined}
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
              </>
            )}
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
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setContactsMode("all");
                    setContactsOpen(true);
                    setRailOpen(false);
                  }}
                  className="grid h-9 w-9 place-items-center rounded text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
                  aria-label="All contacts across rooms"
                  title="All contacts"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    {/* Same contact-book glyph as the chat-tab icon
                        so users connect "this is the contacts UI." */}
                    <rect x="4.5" y="3.5" width="14" height="17" rx="2.5" />
                    <circle cx="11.5" cy="10" r="2.5" />
                    <path d="M7.5 17c.6-2 2.2-3 4-3s3.4 1 4 3" />
                    <path d="M19.5 7v3" />
                    <path d="M19.5 14v3" />
                  </svg>
                </button>
                <button
                  onClick={() => setRailOpen(false)}
                  className="grid h-9 w-9 place-items-center rounded text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
                  aria-label="Close menu"
                >
                  ✕
                </button>
              </div>
            </header>
            <RoomsRailBody
              rooms={rooms}
              activeId={activeId}
              pinnedRoomIds={settings.pinnedRoomIds}
              hiddenRoomIds={settings.hiddenRoomIds}
              mutedRoomIds={settings.mutedRoomIds}
              timezone={settings.timezone}
              onPick={(id) => {
                setActiveId(id);
                setRailOpen(false);
              }}
              onTogglePin={(id) => {
                const cur = settings.pinnedRoomIds;
                const next = cur.includes(id)
                  ? cur.filter((x) => x !== id)
                  : [id, ...cur];
                onChangeSettings({ ...settings, pinnedRoomIds: next });
              }}
              onToggleHide={(id) => {
                const cur = settings.hiddenRoomIds;
                const next = cur.includes(id)
                  ? cur.filter((x) => x !== id)
                  : [...cur, id];
                // Auto-unpin on hide so the pinned section doesn't
                // show a hidden room when "Show hidden" is off.
                const nextPinned = next.includes(id)
                  ? settings.pinnedRoomIds.filter((x) => x !== id)
                  : settings.pinnedRoomIds;
                onChangeSettings({
                  ...settings,
                  hiddenRoomIds: next,
                  pinnedRoomIds: nextPinned,
                });
              }}
              onLeaveOrDelete={async (id) => {
                const room = rooms.find((r) => r.id === id);
                if (!room) return;
                const isAdmin = room.role === "admin" && room.type === "group";
                const label = isAdmin ? "Delete" : "Leave";
                const msg = isAdmin
                  ? `Delete "${room.name}"? Members lose access immediately and the chat history is wiped. This can't be undone.`
                  : `Leave "${room.name}"? You'll need a fresh invite to come back.`;
                if (!confirm(msg)) return;
                try {
                  if (isAdmin) {
                    await api.deleteRoom(id);
                  } else {
                    await api.leaveRoom(id);
                  }
                  setRooms((prev) => prev.filter((r) => r.id !== id));
                  if (activeId === id) setActiveId("");
                } catch (e) {
                  alert(`Couldn't ${label.toLowerCase()} room: ${(e as Error).message}`);
                }
              }}
              onNewRoom={() => setNewRoomOpen(true)}
            />
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
            onRoomNameChanged={(newName) =>
              setRooms((prev) =>
                prev.map((r) =>
                  r.id === active.id ? { ...r, name: newName } : r,
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
      <BottomSheet
        open={!!actionMessage}
        onClose={() => setActionMessage(null)}
        title="Message"
      >
        {actionMessage && (
          <div className="flex flex-col gap-2 px-4 pb-5 pt-2">
            <div className="rounded-2xl border border-neutral-200 bg-paper-soft px-3 py-2 text-[13px] text-neutral-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {actionMessage.author_handle
                  ? `@${actionMessage.author_handle}`
                  : actionMessage.author_is_agent
                    ? "Agent"
                    : ""}
              </div>
              <div className="line-clamp-3">
                {actionMessage.attachment_image_url && !actionMessage.body
                  ? "📷 Photo"
                  : actionMessage.body || "(empty message)"}
              </div>
            </div>
            <div
              className="flex items-center justify-around gap-1 rounded-2xl border border-neutral-200 bg-paper px-2 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[0_2px_8px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.06)]"
              role="group"
              aria-label="React with emoji"
            >
              {(["❤️", "👍", "👎", "😂", "‼️", "❓"] as const).map((emoji) => {
                const tally = actionMessage.reactions?.find(
                  (r) => r.emoji === emoji,
                );
                const mine = !!tally?.mine;
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      if (!active) return;
                      void api
                        .chatReact(active.id, actionMessage.id, emoji)
                        .catch(() => {});
                      setActionMessage(null);
                    }}
                    className={`grid h-11 w-11 place-items-center rounded-full text-[24px] transition active:scale-90 ${
                      mine
                        ? "bg-amber-100 ring-2 ring-amber-300 dark:bg-amber-900/40 dark:ring-amber-700"
                        : "hover:bg-paper-soft dark:hover:bg-neutral-800"
                    }`}
                    aria-label={`React with ${emoji}`}
                    title={`React with ${emoji}`}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
            <ActionButton
              onClick={() => {
                setReplyTarget({
                  id: actionMessage.id,
                  body: actionMessage.body,
                  authorHandle: actionMessage.author_handle,
                  hasImage: !!actionMessage.attachment_image_url,
                });
                setActionMessage(null);
                setComposerOpen(true);
                setTimeout(
                  () => composerInputRef.current?.focus(),
                  30,
                );
              }}
            >
              ↩ Reply
            </ActionButton>
            <Pill
              onClick={() => {
                const text =
                  actionMessage.body ||
                  (actionMessage.attachment_image_url ? "(photo)" : "");
                navigator.clipboard?.writeText(text).catch(() => {});
                setActionMessage(null);
              }}
            >
              Copy text
            </Pill>
            {active &&
              active.type === "group" &&
              active.role === "admin" && (
                <Pill
                  variant="amber"
                  onClick={async () => {
                    const msg = actionMessage;
                    setActionMessage(null);
                    if (!msg) return;
                    try {
                      await api.chatPin(active.id, msg.id);
                    } catch (e) {
                      setToast({
                        text: `Couldn't ${msg.pinned_at ? "unpin" : "pin"}: ${(e as Error).message}`,
                        kind: "error",
                      });
                    }
                  }}
                >
                  {actionMessage.pinned_at ? (
                    "Unpin"
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <PinSvg className="h-3.5 w-3.5" filled />
                      Pin to top
                    </span>
                  )}
                </Pill>
              )}
            <Pill onClick={() => setActionMessage(null)}>Cancel</Pill>
          </div>
        )}
      </BottomSheet>
      <ContactsSheet
        open={contactsOpen}
        onClose={() => setContactsOpen(false)}
        inviteRoom={
          active && active.type === "group" && !active.id.startsWith("local-")
            ? { id: active.id, name: active.name }
            : null
        }
        // Two opening paths, controlled by `contactsMode`:
        //   "scoped" (chat-tab top bar) → JUST this group's members.
        //     Even for `local-` demo rooms — the server returns []
        //     rather than the cross-room set, because the user explicitly
        //     asked "who's in THIS group?" and a fallback would lie.
        //   "all"    (rooms-rail header)  → every contact across rooms.
        scopeRoomId={contactsMode === "scoped" ? (active?.id ?? null) : null}
        onPick={(uid, preview) => {
          // Coming from Contacts is an explicit navigation, not a
          // peek — open the profile as a full-page screen instead of
          // the half-sheet used on chat-avatar taps. UserProfileSheet
          // refetches the full profile from /auth/users/{id}; the
          // preview keeps the sheet from flashing blank.
          setContactsOpen(false);
          setProfileView({
            userId: uid,
            handle: preview.handle,
            displayName: preview.displayName,
            avatarUrl: preview.avatarUrl,
            mode: "fullPage",
          });
        }}
      />
      <UserProfileSheet
        open={!!profileView}
        userId={profileView?.userId ?? null}
        fullPage={profileView?.mode === "fullPage"}
        preview={{
          handle: profileView?.handle,
          displayName: profileView?.displayName,
          avatarUrl: profileView?.avatarUrl,
        }}
        onClose={() => setProfileView(null)}
        onMessage={async (uid) => {
          // Close the profile sheet first so the room switch
          // doesn't fight the sheet animation.
          setProfileView(null);
          try {
            const room = await api.dmOpen(uid);
            const item: RoomItem = {
              id: room.id,
              type: (room.type === "direct" ? "direct" : "group") as
                | "group"
                | "direct",
              name: room.name ?? "(unnamed)",
              role: room.role,
              imageUrl: room.image_url ?? null,
              accent: room.accent_color ?? null,
              unreadCount: room.unread_count ?? 0,
            };
            setRooms((prev) =>
              prev.some((r) => r.id === item.id)
                ? prev
                : [item, ...prev],
            );
            setActiveId(room.id);
            setTab("chat");
          } catch {
            // best-effort; user can retry from the profile sheet.
          }
        }}
      />
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-2 rounded-2xl border px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-md ${
            toast.kind === "error"
              ? "border-red-300 bg-red-50/95 text-red-900 dark:border-red-800 dark:bg-red-900/85 dark:text-red-100"
              : "border-neutral-300 bg-paper/95 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-100"
          }`}
          style={{
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 80px)",
          }}
        >
          <span className="flex-1 text-[13px]">{toast.text}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded-full px-1 text-[12px] opacity-70 hover:opacity-100"
          >
            ✕
          </button>
        </div>
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

/** Prefix server-relative chat image URLs with `/api` and append the
 *  deployment password + session token in the query string so the
 *  browser's <img> loader (which can't send custom headers) gets the
 *  same auth as jsonFetch. Same pattern as RoomAvatar. */
function chatImageWithAuth(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = path.startsWith("/api") ? path : `/api${path}`;
  const sep = base.includes("?") ? "&" : "?";
  const auth: string[] = [];
  const pw = getPassword();
  const tok = getSessionToken();
  if (pw) auth.push(`password=${encodeURIComponent(pw)}`);
  if (tok) auth.push(`session=${encodeURIComponent(tok)}`);
  return auth.length ? `${base}${sep}${auth.join("&")}` : base;
}

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 7l-7 7a4 4 0 0 0 5.66 5.66l8.5-8.5a6 6 0 0 0-8.49-8.49l-9.2 9.2" />
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

/**
 * Rooms-rail body — the left drawer's scrolling content. Three
 * sections (Pinned / Direct messages / Groups), a search box, and
 * per-row last-message preview + long-press to pin.
 *
 * Sort: each section by `lastMessageAt` descending; rooms with no
 * messages fall to the bottom in stable id order.
 */
function RoomsRailBody({
  rooms,
  activeId,
  pinnedRoomIds,
  hiddenRoomIds,
  mutedRoomIds,
  timezone,
  onPick,
  onTogglePin,
  onToggleHide,
  onLeaveOrDelete,
  onNewRoom,
}: {
  rooms: RoomItem[];
  activeId: string | null;
  pinnedRoomIds: string[];
  hiddenRoomIds: string[];
  mutedRoomIds: string[];
  timezone?: string;
  onPick: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggleHide: (id: string) => void;
  /** Swipe-to-reveal destructive action. For admins of a group room
   *  this deletes the room; for everyone else it leaves the room. */
  onLeaveOrDelete: (id: string) => void;
  onNewRoom: () => void;
}) {
  const mutedSet = new Set(mutedRoomIds);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const q = query.trim().toLowerCase();

  const matches = (r: RoomItem) =>
    !q ||
    r.name.toLowerCase().includes(q) ||
    (r.lastMessageBody ?? "").toLowerCase().includes(q);

  const byActivity = (a: RoomItem, b: RoomItem) => {
    // Newest activity first; rooms without any chat fall to the
    // bottom (lexicographic on id as a stable tiebreaker).
    const at = a.lastMessageAt ?? "";
    const bt = b.lastMessageAt ?? "";
    if (at && !bt) return -1;
    if (!at && bt) return 1;
    if (at !== bt) return at < bt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  };

  const pinSet = new Set(pinnedRoomIds);
  const hiddenSet = new Set(hiddenRoomIds);
  // Pre-filter by search. Hidden rooms fall away unless the user
  // flipped "Show hidden" — then we keep them but render the row in
  // its dedicated section at the bottom so they don't pollute the
  // main list.
  const searchFiltered = rooms.filter(matches);
  const visiblePool = showHidden
    ? searchFiltered
    : searchFiltered.filter((r) => !hiddenSet.has(r.id));

  // Pinned: render in the order the user pinned them (most-recent
  // pin at top), NOT by activity — the whole point of pinning is
  // manual ordering. Hidden rooms are excluded from pinned even
  // when "Show hidden" is on; they live in their own section.
  const pinned: RoomItem[] = [];
  for (const id of pinnedRoomIds) {
    if (hiddenSet.has(id)) continue;
    const r = visiblePool.find((x) => x.id === id);
    if (r) pinned.push(r);
  }
  const unpinned = visiblePool.filter(
    (r) => !pinSet.has(r.id) && !hiddenSet.has(r.id),
  );
  const dms = unpinned.filter((r) => r.type === "direct").sort(byActivity);
  const groups = unpinned.filter((r) => r.type === "group").sort(byActivity);
  const hiddenRows = showHidden
    ? searchFiltered.filter((r) => hiddenSet.has(r.id)).sort(byActivity)
    : [];
  const hiddenCount = hiddenRoomIds.length;

  return (
    <>
      <button
        onClick={onNewRoom}
        className="mx-3 mt-3 inline-flex items-center justify-center gap-2 rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-3 text-[14px] font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/40"
      >
        <span
          className="grid h-6 w-6 place-items-center rounded-full bg-amber-200 text-amber-900 dark:bg-amber-700/60 dark:text-amber-100"
          aria-hidden
        >
          +
        </span>
        New group
      </button>
      <div className="mx-3 mt-2">
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rooms…"
            aria-label="Search rooms"
            className="w-full rounded-full border border-neutral-200 bg-paper px-3 py-2 pl-8 text-[14px] text-neutral-800 placeholder:text-neutral-400 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400"
            aria-hidden
          >
            ⌕
          </span>
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1 text-[10px] text-neutral-500"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {/* `min-h-0` is required so this flex child can shrink and the
          `overflow-y-auto` actually kicks in — without it the nav
          inherits min-height: auto and pushes the rail off-screen
          instead of scrolling. */}
      <nav
        className="mt-2 min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]"
      >
        {rooms.length === 0 && (
          <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400">
            No rooms yet. Tap "+ New group" to start one.
          </p>
        )}
        {q && pinned.length + dms.length + groups.length === 0 && (
          <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400">
            No rooms match "{query.trim()}".
          </p>
        )}
        <RailSection title="Pinned" hidden={pinned.length === 0}>
          {pinned.map((r) => (
            <RailRow
              key={r.id}
              room={r}
              active={r.id === activeId}
              pinned
              hidden={false}
              muted={mutedSet.has(r.id)}
              timezone={timezone}
              onPick={onPick}
              onTogglePin={onTogglePin}
              onToggleHide={onToggleHide}
              onLeaveOrDelete={onLeaveOrDelete}
            />
          ))}
        </RailSection>
        <RailSection title="Direct messages" hidden={dms.length === 0}>
          {dms.map((r) => (
            <RailRow
              key={r.id}
              room={r}
              active={r.id === activeId}
              pinned={false}
              hidden={false}
              muted={mutedSet.has(r.id)}
              timezone={timezone}
              onPick={onPick}
              onTogglePin={onTogglePin}
              onToggleHide={onToggleHide}
              onLeaveOrDelete={onLeaveOrDelete}
            />
          ))}
        </RailSection>
        <RailSection title="Groups" hidden={groups.length === 0}>
          {groups.map((r) => (
            <RailRow
              key={r.id}
              room={r}
              active={r.id === activeId}
              pinned={false}
              hidden={false}
              muted={mutedSet.has(r.id)}
              timezone={timezone}
              onPick={onPick}
              onTogglePin={onTogglePin}
              onToggleHide={onToggleHide}
              onLeaveOrDelete={onLeaveOrDelete}
            />
          ))}
        </RailSection>
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            className="mx-3 mt-3 inline-flex w-[calc(100%-1.5rem)] items-center justify-center gap-2 rounded-full border border-neutral-200 bg-paper px-3 py-1.5 text-[11px] font-semibold text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
            aria-pressed={showHidden}
          >
            {showHidden
              ? `Hide hidden rooms (${hiddenCount})`
              : `Show hidden rooms (${hiddenCount})`}
          </button>
        )}
        <RailSection title="Hidden" hidden={hiddenRows.length === 0}>
          {hiddenRows.map((r) => (
            <RailRow
              key={r.id}
              room={r}
              active={r.id === activeId}
              pinned={false}
              hidden
              muted={mutedSet.has(r.id)}
              timezone={timezone}
              onPick={onPick}
              onTogglePin={onTogglePin}
              onToggleHide={onToggleHide}
              onLeaveOrDelete={onLeaveOrDelete}
            />
          ))}
        </RailSection>
      </nav>
    </>
  );
}

function RailSection({
  title,
  hidden,
  children,
}: {
  title: string;
  hidden?: boolean;
  children: React.ReactNode;
}) {
  if (hidden) return null;
  return (
    <div>
      <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </div>
      {children}
    </div>
  );
}

// Reveal width when the row is swiped open — three 64px action wells
// (pin + hide + leave/delete). Matches iOS Messages' swipe-actions feel.
const RAIL_SWIPE_REVEAL = 192;
// Drag threshold past which release snaps the row to the open state
// (otherwise it snaps back closed).
const RAIL_SWIPE_OPEN_THRESHOLD = 84;

function RailRow({
  room,
  active,
  pinned,
  hidden,
  muted,
  timezone,
  onPick,
  onTogglePin,
  onToggleHide,
  onLeaveOrDelete,
}: {
  room: RoomItem;
  active: boolean;
  pinned: boolean;
  hidden: boolean;
  muted: boolean;
  timezone?: string;
  onPick: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggleHide: (id: string) => void;
  onLeaveOrDelete: (id: string) => void;
}) {
  const preview = (() => {
    const body = (room.lastMessageBody ?? "").trim();
    if (!body) return null;
    const who = room.lastMessageAuthorHandle
      ? `${room.lastMessageAuthorHandle}: `
      : "";
    return `${who}${body}`;
  })();
  const stamp = formatRailStamp(room.lastMessageAt, timezone);

  // Swipe-to-reveal state. `offset` is the current X translation of
  // the foreground content (always 0 or negative — only left-swipe).
  // `open` is the resting state; while dragging we override with the
  // live offset. Single tap = open the room. Drag left past the
  // threshold = snap open; drag right (when open) = snap closed.
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const dragStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const draggingHoriz = useRef(false);

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    dragStart.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    draggingHoriz.current = false;
  }
  function handlePointerMove(e: React.PointerEvent) {
    const start = dragStart.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    // Lock horizontal once the gesture is clearly horizontal — otherwise
    // a near-vertical scroll would jiggle the row sideways.
    if (!draggingHoriz.current) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy) + 4) {
        draggingHoriz.current = true;
        try {
          (e.target as Element).setPointerCapture?.(e.pointerId);
        } catch {
          // best-effort — pointer capture is nice-to-have
        }
      } else {
        // Vertical scroll wins; cancel the gesture for this row.
        dragStart.current = null;
        return;
      }
    }
    const base = open ? -RAIL_SWIPE_REVEAL : 0;
    const next = Math.min(0, Math.max(-RAIL_SWIPE_REVEAL, base + dx));
    setOffset(next);
  }
  function handlePointerUp(e: React.PointerEvent) {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const elapsed = Date.now() - start.t;
    const isTap =
      !draggingHoriz.current && Math.abs(dx) < 8 && elapsed < 500;
    draggingHoriz.current = false;
    if (isTap) {
      // Tap on the foreground while closed = open the room.
      // Tap on the foreground while open = close the swipe.
      if (open) {
        setOpen(false);
        setOffset(0);
      } else {
        onPick(room.id);
      }
      return;
    }
    // Drag release: snap open or closed depending on final offset.
    const finalOffset = offset + (open ? 0 : 0); // current visible offset
    const shouldOpen = finalOffset <= -RAIL_SWIPE_OPEN_THRESHOLD;
    setOpen(shouldOpen);
    setOffset(shouldOpen ? -RAIL_SWIPE_REVEAL : 0);
  }
  function handlePointerCancel() {
    dragStart.current = null;
    draggingHoriz.current = false;
    setOffset(open ? -RAIL_SWIPE_REVEAL : 0);
  }

  return (
    <div
      // 3D card recipe shared with the chat bubbles, Settings cards,
      // and the Marks page (vertical-light gradient + deep drop +
      // inset top highlight + crisp outline ring). `mx-3 mb-2` gives
      // the cards breathing room so the shadow can read. `overflow
      // -hidden` keeps the swipe wells inside the rounded edge.
      className={`relative mx-3 mb-2 overflow-hidden rounded-2xl shadow-[0_6px_18px_rgba(0,0,0,0.22),0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.22),0_0_0_1px_rgba(255,255,255,0.08)] ${
        active ? "ring-2 ring-amber-300/70 dark:ring-amber-500/40" : ""
      }`}
    >
      {/* Action wells revealed underneath when the row slides left.
          Pin on the inner side (closer to the row), Hide on the
          outer edge — matches the Messages "Delete on the right" feel
          while keeping pin one tap closer to thumb travel. */}
      <div className="absolute inset-y-0 right-0 flex">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(room.id);
            // Snap closed after acting on the row.
            setOpen(false);
            setOffset(0);
          }}
          aria-label={pinned ? "Unpin room" : "Pin room"}
          className={`flex h-full w-16 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition ${
            pinned
              ? "bg-amber-500 text-white"
              : "bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
          }`}
        >
          <PinIcon filled={pinned} />
          <span>{pinned ? "Unpin" : "Pin"}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleHide(room.id);
            setOpen(false);
            setOffset(0);
          }}
          aria-label={hidden ? "Unhide room" : "Hide room"}
          className={`flex h-full w-16 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition ${
            hidden
              ? "bg-neutral-500 text-white hover:bg-neutral-600"
              : "bg-neutral-200 text-neutral-800 hover:bg-neutral-300 dark:bg-neutral-700/70 dark:text-neutral-100 dark:hover:bg-neutral-700"
          }`}
        >
          {hidden ? <EyeIcon /> : <EyeOffIcon />}
          <span>{hidden ? "Unhide" : "Hide"}</span>
        </button>
        {(() => {
          // Admin of a group room sees Delete; everyone else (members,
          // and either side of a DM) sees Leave. The hosting onLeaveOrDelete
          // handler dispatches to api.deleteRoom or api.leaveRoom and
          // updates local state.
          const isAdmin = room.role === "admin" && room.type === "group";
          const label = isAdmin ? "Delete" : "Leave";
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                setOffset(0);
                onLeaveOrDelete(room.id);
              }}
              aria-label={`${label} room`}
              className="flex h-full w-16 flex-col items-center justify-center gap-0.5 bg-red-500 text-[10px] font-semibold text-white transition hover:bg-red-600"
            >
              {isAdmin ? <TrashIcon /> : <ExitIcon />}
              <span>{label}</span>
            </button>
          );
        })()}
      </div>
      {/* Foreground row content — slides over the action wells. The
          gradient lives on the wrapper; this layer is transparent so
          the lit-from-above feel reads through. */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragStart.current
            ? "none"
            : "transform 180ms cubic-bezier(0.32, 0.72, 0.0, 1)",
          touchAction: "pan-y",
          WebkitTapHighlightColor: "transparent",
        }}
        className={`relative z-10 flex w-full cursor-pointer items-start gap-3 bg-gradient-to-b from-white to-[#e9ecf2] px-3 py-2.5 shadow-[inset_0_1.5px_0_rgba(255,255,255,0.45)] active:scale-[0.99] dark:from-[#3a3a44] dark:to-[#1f1f25] ${
          hidden ? "opacity-70" : ""
        }`}
        title={hidden ? "Hidden room · tap to open · swipe left for actions" : "Tap to open · swipe left for actions"}
      >
        <RoomAvatar
          id={room.id}
          name={room.name}
          type={room.type}
          imageUrl={room.imageUrl}
          size={48}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="block flex-1 truncate text-[15px] font-medium text-neutral-900 dark:text-neutral-50">
              {room.name}
            </span>
            {pinned && (
              <span
                aria-label="Pinned"
                title="Pinned"
                className="text-amber-600 dark:text-amber-300"
              >
                <PinSvg className="h-3 w-3" filled />
              </span>
            )}
            {muted && (
              <span
                aria-label="Notifications muted"
                title="Notifications muted"
                className="text-neutral-500 dark:text-neutral-400"
              >
                <BellMuteSvg className="h-3.5 w-3.5" />
              </span>
            )}
            {stamp && (
              <span className="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-500">
                {stamp}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className="block flex-1 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
              {preview ??
                (room.type === "direct"
                  ? "Direct chat"
                  : room.role === "admin"
                    ? "Group · admin"
                    : "Group")}
            </span>
            {hidden && (
              // Always-visible unhide affordance in the Hidden section
              // — swipe-to-reveal is fine for the main list but it's
              // not obvious that you can do it again on the already-
              // dimmed rows here. The button is a regular `<button>`
              // (not nested in the row's pointer-event area) so it
              // can't be swallowed by the swipe gesture.
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleHide(room.id);
                }}
                className="shrink-0 rounded-full border border-neutral-300 bg-paper px-2 py-0.5 text-[10px] font-semibold text-neutral-700 hover:bg-paper-soft dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
                aria-label="Unhide room"
              >
                Unhide
              </button>
            )}
            {!!room.unreadCount && room.unreadCount > 0 && (
              <span
                aria-label={`${room.unreadCount} unread`}
                className="shrink-0 grid min-h-[20px] min-w-[20px] place-items-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white shadow-[0_2px_6px_rgba(239,68,68,0.45)]"
              >
                {room.unreadCount > 99 ? "99+" : room.unreadCount}
              </span>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

function PinIcon({ filled }: { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 17v5" />
      <path d="M9 4.5l6 0 1 4 -3 2 0 4.5 -2 0 0 -4.5 -3 -2 z" />
    </svg>
  );
}

function EyeIcon() {
  return (
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
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
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
      <path d="M4 4l16 16" />
      <path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4.3" />
      <path d="M6.5 7.6A17 17 0 0 0 2 12s3.5 7 10 7c1.4 0 2.7-.2 3.9-.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

function TrashIcon() {
  return (
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
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function ExitIcon() {
  return (
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
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5" />
      <path d="M5 12h12" />
    </svg>
  );
}

/** Concise activity stamp for a rail row. Today → "5:23 PM", earlier
 *  this week → "Tue", older → "Jun 3". Empty string when no message.
 *  Honors the user's IANA timezone preference. */
function formatRailStamp(iso: string | null | undefined, timezone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = timezone || undefined;
  const now = new Date();
  const sameDay =
    now.toLocaleDateString(undefined, { timeZone: tz }) ===
    d.toLocaleDateString(undefined, { timeZone: tz });
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (now.getTime() - d.getTime() < 7 * dayMs) {
    return d.toLocaleDateString(undefined, { weekday: "short", timeZone: tz });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
}

/** Mic button for voice input. Toggles a SpeechRecognition session;
 *  while recording, interim transcript chunks stream into the
 *  composer as the user speaks. Single tap to start, tap again to
 *  stop. Hides silently when the browser doesn't support speech
 *  recognition — Firefox is the main miss today. */
function VoiceInputButton({
  onTranscript,
  language,
}: {
  onTranscript: (text: string) => void;
  language: string;
}) {
  const [recording, setRecording] = useState(false);
  const sessionRef = useRef<{ stop: () => void } | null>(null);
  // Accumulate the final-result chunks so the parent gets one clean
  // string per turn instead of one per phrase.
  const finalBufRef = useRef("");
  const lastInterimRef = useRef("");

  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  if (!speechRecognitionSupported()) return null;

  function start() {
    finalBufRef.current = "";
    lastInterimRef.current = "";
    sessionRef.current = startSpeech(language, {
      onResult: (t, isFinal) => {
        if (isFinal) {
          finalBufRef.current += (finalBufRef.current ? " " : "") + t.trim();
          lastInterimRef.current = "";
        } else {
          lastInterimRef.current = t.trim();
        }
      },
      onEnd: () => {
        const full = [finalBufRef.current, lastInterimRef.current]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (full) onTranscript(full);
        sessionRef.current = null;
        setRecording(false);
      },
      onError: (code) => {
        // `not-allowed` = user denied mic; `no-speech` = silent
        // session timed out. Both are quiet failures — no toast.
        sessionRef.current = null;
        setRecording(false);
        if (code !== "no-speech" && code !== "aborted") {
          // eslint-disable-next-line no-console
          console.warn("[speech] error:", code);
        }
      },
    });
    if (sessionRef.current) setRecording(true);
  }

  function stop() {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setRecording(false);
  }

  return (
    <button
      type="button"
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        if (recording) stop();
        else start();
      }}
      title={recording ? "Stop voice input" : "Voice input"}
      aria-label={recording ? "Stop voice input" : "Start voice input"}
      aria-pressed={recording}
      className={`grid h-10 w-10 shrink-0 place-items-center self-stretch rounded-full transition ${
        recording
          ? "bg-red-500 text-white shadow-[0_2px_6px_rgba(239,68,68,0.45)]"
          : "text-neutral-500 hover:bg-paper-soft hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    </button>
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
  view = "bookmarks",
  bookmarks,
  annotations,
  onPick,
  onReset,
  timezone,
  dark,
  focusSearchTrigger,
}: {
  /** Toggles between the ribbon cards (default) and a flat list of
   *  every verse the user has annotated. The Marks-page hamburger
   *  in the top app bar drives this. */
  view?: "bookmarks" | "highlights";
  bookmarks: BookmarkOut[];
  /** Every annotation the user has — used to render the highlights
   *  view. Already loaded in MobileShell for the Bible reader; this
   *  is just a read-only consumer. */
  annotations?: AnnotationOut[];
  onPick: (b: BookmarkOut) => void;
  onReset: (book: string) => void;
  timezone?: string;
  dark: boolean;
  /** Bumped by the parent each time the search icon on the top app
   *  bar is tapped. Each new value flips the search field's open/
   *  closed state and (when opening) focuses the input. */
  focusSearchTrigger?: number;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (focusSearchTrigger === undefined || focusSearchTrigger === 0) return;
    // Toggle visibility only — never call .focus()/.select() on the
    // input. Matches Notes + Chat: the user taps the field themselves
    // to avoid the iOS keyboard auto-popping and the field showing a
    // pre-selected "ready to type" state they didn't ask for.
    // (see [[feedback-search-keyboard-no-autopop]])
    setSearchOpen((open) => !open);
  }, [focusSearchTrigger]);

  // Plain-text filter over book code, full name, and the
  // formatted reference (e.g. "Genesis 1:1"). Empty query =
  // show everything.
  const q = query.trim().toLowerCase();
  const visible = !q
    ? bookmarks
    : bookmarks.filter((b) => {
        const name = (OSIS_TO_BOOK_NAME[b.book] ?? b.book).toLowerCase();
        const ref = `${name} ${b.chapter}:${b.verse}`;
        return (
          b.book.toLowerCase().includes(q) ||
          name.includes(q) ||
          ref.includes(q)
        );
      });

  // Highlights view: collapse the annotation rows by verse_id so the
  // user sees one card per annotated verse with a small color-dot
  // summary of which kinds/colors landed on that verse. Sorted by the
  // newest annotation in each group so recently-marked verses surface
  // first. Search query (when open) matches book code, full book name,
  // or the formatted reference.
  const highlightGroups = useMemo(() => {
    if (view !== "highlights") return [] as HighlightGroup[];
    const map = new Map<string, AnnotationOut[]>();
    for (const a of annotations ?? []) {
      const list = map.get(a.verse_id);
      if (list) list.push(a);
      else map.set(a.verse_id, [a]);
    }
    const groups: HighlightGroup[] = [];
    for (const [verseId, rows] of map.entries()) {
      const parts = verseId.split(".");
      if (parts.length !== 3) continue;
      const book = parts[0];
      const chapter = Number(parts[1]);
      const verse = Number(parts[2]);
      if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse)) continue;
      const latest = rows
        .map((r) => r.updated_at || "")
        .filter(Boolean)
        .sort()
        .pop() || "";
      groups.push({ verseId, book, chapter, verse, rows, latestAt: latest });
    }
    groups.sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1));
    if (!q) return groups;
    return groups.filter((g) => {
      const name = (OSIS_TO_BOOK_NAME[g.book] ?? g.book).toLowerCase();
      const ref = `${OSIS_TO_BOOK_NAME[g.book] ?? g.book} ${g.chapter}:${g.verse}`.toLowerCase();
      return (
        g.book.toLowerCase().includes(q) ||
        name.includes(q) ||
        ref.includes(q)
      );
    });
  }, [view, annotations, q]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 bg-paper-soft px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <h2 className="text-sm font-semibold">
          {view === "highlights" ? "Highlights" : "Last read"}
        </h2>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {view === "highlights"
            ? "Every verse you've marked — highlights, underlines, boxes, and the rest. Tap a card to jump to that verse."
            : "One bookmark per book — the latest verse you marked. Past marks in the same book stay as flags on the Bible page; double-tap a flag there to walk up the stack or remove it."}
        </p>
      </div>
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-neutral-200 bg-paper-soft px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-950">
          <div className="relative flex-1">
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={view === "highlights" ? "Search highlights…" : "Search bookmarks…"}
              aria-label={view === "highlights" ? "Search highlights" : "Search bookmarks"}
              className="w-full rounded-full border border-neutral-200 bg-paper px-3 py-2 pl-8 text-[14px] text-neutral-800 placeholder:text-neutral-400 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
            />
            <span
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400"
              aria-hidden
            >
              ⌕
            </span>
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1 text-[10px] text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-700/60"
                aria-label="Clear search"
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSearchOpen(false);
            }}
            className="rounded-full px-2 text-[12px] font-semibold text-neutral-600 hover:bg-paper-soft dark:text-neutral-300 dark:hover:bg-neutral-800"
            aria-label="Close search"
          >
            Done
          </button>
        </div>
      )}
      <ul
        className="flex-1 space-y-2.5 overflow-y-auto p-3"
        style={{
          // Same as ChatPanel + Bible scroller: leave room at the bottom
          // for the floating glass tab bar + standalone AI pill so the
          // last card isn't tucked permanently underneath. 96px covers
          // the floating UI + safe-area-inset at rest.
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 86px)",
        }}
      >
        {view === "highlights" && highlightGroups.length === 0 && (
          <li className="mx-auto mt-4 block max-w-xs rounded-2xl border border-neutral-200 bg-paper px-4 py-6 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="text-[13px] font-semibold text-neutral-700 dark:text-neutral-200">
              {q ? `No highlights match "${query.trim()}"` : "No highlights yet"}
            </div>
            <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              {q
                ? "Try a different book or reference."
                : "Long-press a verse on the Bible page to pick a highlighter, then mark it. Your marks land here."}
            </p>
          </li>
        )}
        {view === "highlights" && highlightGroups.map((g) => {
          const tone = bookColor(g.book);
          const fullName = OSIS_TO_BOOK_NAME[g.book] ?? g.book;
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
            <li key={g.verseId} className="rounded-2xl" style={cardStyle}>
              <button
                onClick={() =>
                  onPick({
                    book: g.book,
                    chapter: g.chapter,
                    verse: g.verse,
                    updated_at: g.latestAt,
                  } as BookmarkOut)
                }
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                aria-label={`Jump to ${fullName} ${g.chapter}:${g.verse}`}
              >
                <span
                  className={`grid h-10 w-10 place-items-center rounded-full ${tone.text} shadow-[0_2px_6px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.45)]`}
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(255,255,255,0.85), rgba(0,0,0,0.06))",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden
                  >
                    <path d="M4 4h12l4 6-4 6H4z" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-neutral-900 dark:text-neutral-50">
                    {fullName} {g.chapter}:{g.verse}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    {g.rows.slice(0, 8).map((a) => (
                      <span
                        key={a.id}
                        className={`h-2.5 w-2.5 rounded-full ${SWATCH_FILL[a.color] ?? ""}`}
                        title={`${a.kind} · ${a.color}`}
                        aria-hidden
                      />
                    ))}
                    <span className="ml-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                      {g.rows.length} mark{g.rows.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              </button>
            </li>
          );
        })}
        {view === "bookmarks" && bookmarks.length === 0 && (
          <li className="mx-auto mt-4 block max-w-xs rounded-2xl border border-neutral-200 bg-paper px-4 py-6 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)]">
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
        {view === "bookmarks" && bookmarks.length > 0 && visible.length === 0 && (
          <li className="px-1 text-[12px] text-neutral-500 dark:text-neutral-400">
            No bookmarks match “{query.trim()}”.
          </li>
        )}
        {view === "bookmarks" && visible.map((b) => {
          const tone = bookColor(b.book);
          const fullBookName = OSIS_TO_BOOK_NAME[b.book] ?? b.book;
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
                  aria-label={`Jump to ${fullBookName} ${b.chapter}:${b.verse}`}
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
                      {OSIS_TO_BOOK_NAME[b.book] ?? b.book} {b.chapter}:{b.verse}
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
                  aria-label={`Edit ${fullBookName} bookmark`}
                  title={`Edit ${fullBookName} bookmark`}
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
  selfHandle,
  selfAvatarUrl,
  accentKey,
  dark,
  onRead,
  onAvatarTap,
  onLongPress,
  searchOpen,
  searchQuery,
  onSearchQueryChange,
  onSearchClose,
  editMode,
  onDeleteMessage,
}: {
  roomId: string;
  roomName: string;
  selfUserId?: string;
  /** Caller's @handle. Used by the status strip to label the "Your
   *  status" tile and to render the viewer header on own statuses. */
  selfHandle?: string;
  /** Caller's avatar URL — same use as `selfHandle`. */
  selfAvatarUrl?: string | null;
  /** Active group's resolved accent — drives the "mine" bubble color
   *  so each group's chat reads as different. The header band is kept
   *  neutral so it doesn't double up with the top app bar's tint. */
  accentKey: import("../lib/accentColors").AccentKey;
  dark: boolean;
  /** When true, a search input replaces the room-name header and
   *  the message list filters to matches. Toggled by the search
   *  button in the top app bar. */
  searchOpen?: boolean;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
  onSearchClose?: () => void;
  /** Fired after the server confirms the room has been marked read.
   *  Parent zeroes the unread badge for this room. */
  onRead?: () => void;
  /** Tapping a sender's avatar opens a profile preview sheet (NOT a
   *  DM). The user can hit Message in the sheet to actually start
   *  a conversation. Parent owns the sheet state. */
  onAvatarTap?: (
    userId: string,
    preview: {
      handle: string | null;
      displayName: string | null;
      avatarUrl: string | null;
    },
  ) => void;
  /** Long-pressing a bubble fires this so the parent can pop an
   *  action sheet (Reply / Copy / etc.). */
  onLongPress?: (msg: ChatMessageOut) => void;
  /** Top-bar Edit toggle. When on, each of the caller's own
   *  messages shows a delete button; tapping it asks the parent to
   *  call the backend DELETE endpoint. */
  editMode?: boolean;
  onDeleteMessage?: (messageId: string) => void | Promise<void>;
}) {
  const [messages, setMessages] = useState<ChatMessageOut[]>([]);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Initial load — most recent 100 messages, chronological.
  // Reset the per-room state up-front so switching rooms doesn't
  // briefly render the previous room's last message + statuses
  // while the new fetches are in flight (the "ghost message" flash).
  useEffect(() => {
    if (!roomId) return;
    setMessages([]);
    setStatuses([]);
    setMemberCount(null);
    let alive = true;
    api
      .chatList(roomId, 100)
      .then((rows) => alive && setMessages(rows))
      .catch(() => {});
    api
      .roomMembers(roomId)
      .then((rows) => alive && setMemberCount(rows.length))
      .catch(() => {});
    api
      .statusList(roomId)
      .then((rows) => alive && setStatuses(rows))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [roomId]);

  // Status panel state. Live ops (`status:create`, `:delete`, `:view`)
  // arrive on the same chat WS and are handled below.
  const [statuses, setStatuses] = useState<StatusOut[]>([]);
  const [statusComposerOpen, setStatusComposerOpen] = useState(false);
  const [statusViewerList, setStatusViewerList] = useState<
    StatusOut[] | null
  >(null);

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
          const parsed = JSON.parse(event.data) as
            | ChatMessageOut
            | { _op: "delete"; id: string }
            | { _op: "status:create"; status: StatusOut }
            | { _op: "status:delete"; id: string }
            | { _op: "status:view"; id: string };
          // Delete envelopes drop the row instead of upserting it.
          // Other op kinds may be added later; the message-shaped
          // default path covers create / reaction / pin updates.
          if ("_op" in parsed && parsed._op === "delete") {
            setMessages((prev) => prev.filter((m) => m.id !== parsed.id));
            return;
          }
          if ("_op" in parsed && parsed._op === "status:create") {
            setStatuses((prev) => {
              if (prev.some((s) => s.id === parsed.status.id)) return prev;
              return [...prev, parsed.status];
            });
            return;
          }
          if ("_op" in parsed && parsed._op === "status:delete") {
            setStatuses((prev) => prev.filter((s) => s.id !== parsed.id));
            return;
          }
          if ("_op" in parsed && parsed._op === "status:view") {
            // Existence-gate the increment: only bump a status we
            // already have in the list. A forged or spammed envelope
            // for an unknown id can't inflate our counters this way.
            // We still cap the bump at +1 per envelope; persistent
            // truth lives in the server's tally, which the viewer
            // refetches via list_statuses on next open.
            setStatuses((prev) => {
              let touched = false;
              const next = prev.map((s) => {
                if (s.id === parsed.id) {
                  touched = true;
                  return { ...s, view_count: s.view_count + 1 };
                }
                return s;
              });
              return touched ? next : prev;
            });
            return;
          }
          const msg = parsed as ChatMessageOut;
          // Replace in place when the message is already in the list
          // (reaction toggle, edit, etc.); otherwise append. Without
          // this, reactions would silently fall on the floor.
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === msg.id);
            if (idx === -1) return [...prev, msg];
            const next = prev.slice();
            next[idx] = msg;
            return next;
          });
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
  //
  // `onRead` is held in a ref so a new inline arrow on every render
  // of the parent doesn't retrigger this effect — that previously
  // caused a runaway loop hammering POST /read tens of times a second.
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);
  useEffect(() => {
    if (!roomId) return;
    api
      .roomMarkRead(roomId)
      .then(() => onReadRef.current?.())
      .catch(() => {});
  }, [roomId, messages.length]);

  const q = (searchQuery ?? "").trim().toLowerCase();
  // Filter out "ghost" rows — bodies that still hold the deepseek
  // pre-parse scratchpad while we wait for the backend update with
  // the polished answer. If there's no extractable polished answer
  // AND no attachment, hide the whole bubble; otherwise the body
  // will be stripped at render time by stripRawCoT.
  const notGhost = (m: ChatMessageOut) => {
    if (!isRawCoTBody(m.body)) return true;
    if (m.attachment_image_url) return true;
    return extractPolishedAnswer(m.body) !== null;
  };
  const baseMessages = messages.filter(notGhost);
  const visibleMessages = q
    ? baseMessages.filter((m) => m.body.toLowerCase().includes(q))
    : baseMessages;
  return (
    <div className="flex h-full flex-col">
      {/* Status strip (24h "stories") above the chat header. */}
      <ChatStatusStrip
        statuses={statuses}
        selfUserId={selfUserId}
        selfHandle={selfHandle}
        selfAvatarUrl={selfAvatarUrl}
        onCompose={() => setStatusComposerOpen(true)}
        onOpenAuthor={(list) => setStatusViewerList(list)}
      />
      <ChatStatusComposer
        open={statusComposerOpen}
        onClose={() => setStatusComposerOpen(false)}
        roomId={roomId}
        onPosted={() => {
          // Optimistic refetch — the WS broadcast normally handles
          // this, but a no-op refetch keeps us correct if the socket
          // is mid-reconnect when we posted.
          void api.statusList(roomId).then(setStatuses).catch(() => {});
        }}
      />
      <ChatStatusViewer
        open={statusViewerList !== null}
        statuses={statusViewerList ?? []}
        selfUserId={selfUserId}
        onClose={() => setStatusViewerList(null)}
        onDeleted={(id) =>
          setStatuses((prev) => prev.filter((s) => s.id !== id))
        }
      />
      {searchOpen ? (
        <div className="flex items-center gap-2 border-b border-neutral-200 bg-paper-soft px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950">
          <div className="relative flex-1">
            <input
              type="search"
              value={searchQuery ?? ""}
              onChange={(e) => onSearchQueryChange?.(e.target.value)}
              placeholder={`Search ${roomName}…`}
              aria-label="Search messages"
              className="w-full rounded-full border border-neutral-200 bg-paper px-3 py-2 pl-8 text-[14px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
            />
            <span
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400"
              aria-hidden
            >
              ⌕
            </span>
            {(searchQuery ?? "").length > 0 && (
              <button
                type="button"
                onClick={() => onSearchQueryChange?.("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1 text-[10px] text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-700/60"
                aria-label="Clear search"
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => onSearchClose?.()}
            className="rounded-full px-2 text-[12px] font-semibold text-neutral-600 hover:bg-paper-soft dark:text-neutral-300 dark:hover:bg-neutral-800"
            aria-label="Close search"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="border-b border-neutral-200 bg-paper-soft px-4 py-2 text-[11px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
          <span>
            <span className="font-medium text-neutral-700 dark:text-neutral-200">
              {roomName}
            </span>
            {memberCount !== null && (
              <span>
                {" "}
                · {memberCount} {memberCount === 1 ? "member" : "members"}
              </span>
            )}
          </span>
        </div>
      )}
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
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 86px)",
        }}
      >
        {visibleMessages.length === 0 ? (
          <p className="pt-8 text-center text-xs text-neutral-500 dark:text-neutral-400">
            {q
              ? `No messages match "${searchQuery}".`
              : "No messages yet. Be the first to say something."}
          </p>
        ) : (
          visibleMessages.map((m) => {
            const isMine = !!selfUserId && m.author_user_id === selfUserId;
            return (
              <ChatBubble
                key={m.id}
                msg={m}
                mine={isMine}
                accentKey={accentKey}
                dark={dark}
                onAvatarClick={(userId) => {
                  onAvatarTap?.(userId, {
                    handle: m.author_handle,
                    displayName: m.author_display_name,
                    avatarUrl: m.author_avatar_url,
                  });
                }}
                onLongPress={() => onLongPress?.(m)}
                onReact={(emoji) => {
                  void api.chatReact(roomId, m.id, emoji).catch(() => {});
                }}
                showDelete={!!editMode && isMine}
                onDelete={async () => {
                  const ok = await confirmDelete({
                    title: "Delete Message?",
                    message: "This message will be removed for everyone in the group. This cannot be undone.",
                  });
                  if (ok) void onDeleteMessage?.(m.id);
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Detect chat bodies that briefly contain the raw deepseek model
 * output — the orchestrator's pre-parse text that carries
 * `note_to_append`, `S<N> says`, and `Answer: "<polished>"` tokens.
 * The backend may broadcast the pre-parse body once before an
 * update lands with the polished answer.
 *
 * Strong signals (any one is a smoking gun, since none of these
 * tokens appear in human-written chat):
 *   - the literal `note_to_append` field name
 *   - `S<N> says` claim references
 *   - `For note_to_append:` planning line
 *   - the literal `Answer: "` prompt-template prefix with preamble
 */
function isRawCoTBody(body: string): boolean {
  if (!body) return false;
  return (
    /\bnote_to_append\b/.test(body) ||
    /\bS\d+\s+says\b/i.test(body) ||
    /\bFor\s+note_to_append\b/i.test(body) ||
    /^[\s\S]{40,}\bAnswer:\s*["“]/m.test(body)
  );
}

/**
 * Pull the polished answer out of a raw-CoT body when the
 * `Answer: "..."` segment is present. Returns null if no clean
 * extract is possible — the caller should hide the bubble in that
 * case instead of showing the scratchpad.
 */
function extractPolishedAnswer(body: string): string | null {
  const m = body.match(/\bAnswer:\s*["“]([\s\S]+?)["”]\s*\.?\s*$/);
  if (m && m[1].trim().length > 0) return m[1].trim();
  // Fallback: take everything after the LAST `Answer:` up to end of
  // body if there's no quoted segment but the marker exists.
  const idx = body.lastIndexOf("Answer:");
  if (idx >= 0) {
    const tail = body
      .slice(idx + "Answer:".length)
      .replace(/^\s*["“]?/, "")
      .replace(/["”]\s*\.?\s*$/, "")
      .trim();
    if (tail.length > 0) return tail;
  }
  return null;
}

function stripRawCoT(body: string): string {
  if (!isRawCoTBody(body)) return body;
  return extractPolishedAnswer(body) ?? "";
}

function ChatBubble({
  msg,
  mine,
  accentKey,
  dark,
  onAvatarClick,
  onLongPress,
  onReact,
  showDelete,
  onDelete,
}: {
  msg: ChatMessageOut;
  mine: boolean;
  accentKey: import("../lib/accentColors").AccentKey;
  dark: boolean;
  /** Tap the sender avatar → open a 1:1 DM with them. */
  onAvatarClick?: (userId: string) => void;
  /** Press-and-hold the bubble for ~400ms → opens an action sheet
   *  (Reply / Copy / etc.). */
  onLongPress?: () => void;
  /** Tap an existing reaction chip → toggle the viewer's reaction
   *  for that emoji. */
  onReact?: (emoji: string) => void;
  /** Top-bar Edit mode is on AND this bubble belongs to the viewer.
   *  Renders a delete pill alongside the bubble; tapping it asks the
   *  parent to call the backend. */
  showDelete?: boolean;
  onDelete?: () => void;
}) {
  // Long-press detection: 400ms hold without > ~8px movement.
  const pressTimer = useRef<number | null>(null);
  const pressFired = useRef(false);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };
  const startPress = (e: React.PointerEvent) => {
    if (!onLongPress) return;
    pressFired.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      pressFired.current = true;
      pressTimer.current = null;
      onLongPress();
    }, 400);
  };
  const movePress = (e: React.PointerEvent) => {
    const s = pressStart.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (dx * dx + dy * dy > 64) cancelPress(); // ~8px drift = scroll, not press
  };
  const side = mine ? "items-end" : "items-start";
  const palette = ACCENT_PALETTE[accentKey];
  // "Mine" bubble: same 3D recipe as the receiver bubble (vertical
  // gradient + drop shadow + inset highlight + crisp edge ring + halo)
  // but painted in the group's accent. Identity is COLOR, not material —
  // both bubbles carry equal weight and the same physical surface, the
  // sender is just the "color side" of the thread. Pulls `palette.bubble`
  // (saturated, white-text-readable) directly so each group's theme
  // actually shows up instead of fading to neutral.
  const MINE_TOP = `color-mix(in srgb, ${palette.bubble} 78%, ${dark ? "#ffffff" : "#ffffff"} 22%)`;
  const MINE_BOT = palette.bubble;
  const MINE_EDGE = `color-mix(in srgb, ${palette.bubble} 50%, #000000 50%)`;
  const myStyle: React.CSSProperties | undefined = mine
    ? {
        backgroundImage: `linear-gradient(to bottom, ${MINE_TOP}, ${MINE_BOT})`,
        color: palette.bubbleFg,
        boxShadow: [
          "0 8px 22px rgba(0,0,0,0.28)",
          "inset 0 1.5px 0 rgba(255,255,255,0.45)",
          // Crisp edge ring in a darker tone of the accent so the bubble
          // outline reads as themed, not generic.
          `0 0 0 1.5px ${MINE_EDGE}`,
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
  // Show the sender avatar to the LEFT of the bubble row (WhatsApp-
  // style). Tappable when we have a real user id — pops a 1:1 DM.
  const showAvatar =
    !mine && !msg.author_is_agent && !!msg.author_user_id;
  const avatarHandle =
    msg.author_handle ?? msg.author_display_name ?? "?";
  return (
    <div className={`flex flex-col gap-0.5 ${side}`}>
      {!mine && (
        <span
          className={`text-[10px] font-semibold text-neutral-500 dark:text-neutral-400 ${
            showAvatar ? "ml-11 px-1" : "px-2"
          }`}
        >
          {authorLabel}
        </span>
      )}
      <div className={`flex max-w-[82%] items-end gap-2 ${mine ? "self-end" : ""}`}>
        {/* Edit-mode delete pill — left of the bubble for "mine"
         *  messages. Only renders when the top-bar Edit toggle is on
         *  and this bubble belongs to the viewer (parent gates that). */}
        {showDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="shrink-0 self-center rounded-full bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_2px_6px_rgba(0,0,0,0.15)] transition active:scale-[0.96] hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-500"
            aria-label="Delete message"
            title="Delete message"
          >
            Delete
          </button>
        )}
        {showAvatar && (
          <button
            type="button"
            onClick={() => onAvatarClick?.(msg.author_user_id!)}
            className="shrink-0 self-end rounded-full focus:outline-none focus:ring-2 focus:ring-amber-400"
            aria-label={`View ${avatarHandle}'s profile`}
            title={`View ${avatarHandle}'s profile`}
          >
            <Avatar
              handle={avatarHandle}
              url={msg.author_avatar_url}
              size={36}
            />
          </button>
        )}
        <div
          className={`overflow-hidden ${mine ? myClass : otherClass} ${
            onLongPress ? "cursor-pointer select-none" : ""
          }`}
          style={mine ? myStyle : otherStyle}
          onPointerDown={startPress}
          onPointerMove={movePress}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={(e) => {
            // Right-click / long-press menu suppression — we open our
            // own action sheet instead of the OS context menu.
            if (onLongPress) {
              e.preventDefault();
              onLongPress();
            }
          }}
        >
          {msg.reply_to_id && (
            <div
              className={`mx-2 mt-2 rounded-xl border-l-[3px] px-2.5 py-1.5 text-[12px] ${
                mine
                  ? "border-amber-500 bg-black/10 dark:bg-white/10"
                  : "border-amber-500 bg-black/5 dark:bg-white/5"
              }`}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
                {msg.reply_to_author_handle
                  ? `@${msg.reply_to_author_handle}`
                  : "Reply"}
              </div>
              <div className="line-clamp-2 opacity-80">
                {msg.reply_to_has_image && !msg.reply_to_body
                  ? "📷 Photo"
                  : msg.reply_to_body || "(message)"}
              </div>
            </div>
          )}
          {msg.attachment_image_url && (
            <img
              src={chatImageWithAuth(msg.attachment_image_url)}
              alt={msg.body || "attachment"}
              className="block max-h-80 w-full object-cover"
            />
          )}
          {msg.body && (
            <div dir="auto" className="px-3.5 py-2 text-[15px]">{stripRawCoT(msg.body)}</div>
          )}
          {msg.pinned_at && (
            <div className="flex items-center gap-1 border-t border-amber-200/60 bg-amber-50/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/30 dark:text-amber-200">
              <PinSvg className="h-3 w-3" filled />
              <span>Pinned</span>
            </div>
          )}
        </div>
      </div>
      {msg.reactions && msg.reactions.length > 0 && (
        <div
          className={`-mt-2 flex flex-wrap gap-1 ${
            mine ? "self-end pr-2" : showAvatar ? "ml-11 pl-2" : "pl-2"
          }`}
        >
          {msg.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              onClick={() => onReact?.(r.emoji)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45)] transition active:scale-95 dark:shadow-[0_2px_6px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.06)] ${
                r.mine
                  ? "border-amber-300 bg-amber-50/80 text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100"
                  : "border-neutral-200 bg-paper text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              }`}
              title={r.mine ? "Tap to remove your reaction" : "Tap to add"}
              aria-pressed={r.mine}
              aria-label={`${r.emoji} reacted ${r.count}`}
            >
              <span>{r.emoji}</span>
              <span className="font-semibold tabular-nums">{r.count}</span>
            </button>
          ))}
        </div>
      )}
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
