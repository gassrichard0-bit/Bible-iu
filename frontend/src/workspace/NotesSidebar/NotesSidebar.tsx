/**
 * Right — persistent Notes sidebar (CLAUDE.md §4.6, notes-system.MD §2).
 *
 * Two scopes: Personal (private — never visible to the agent or other
 * users) and Group (shared, agent has read oversight + may append with
 * attribution). The TipTap + tldraw on Yjs editor (notes-system.MD §3) is
 * a future build; this scaffold keeps the structure honest with plain
 * textareas tagged by scope.
 *
 * The sidebar is a *view* over the shared `NotesApi` (notes-system.MD
 * §5.6) — editing inline at a verse and editing here update the same row.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { VerseFocus } from "../Workspace";
import type { NotesApi, NoteRow } from "./notesStore";
import { NoteSocialBlock } from "./NoteSocialBlock";
import { GLASS_CARD_INLINE } from "../../lib/glass";
import { RichNoteField } from "./RichNoteField";
import { useStickToBottom } from "../../lib/useStickToBottom";
import { readSettings, SETTINGS_CHANGED } from "../../lib/settings";
import { OSIS_TO_BOOK_NAME } from "../../lib/api";
import {
  consumeInitFlag,
  loadSeenSet,
  saveSeenSet,
} from "./noteReadTracker";
import { canDeleteNote } from "./noteOwnership";

interface Props {
  focus: VerseFocus | null;
  notes: NotesApi;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  /** Mobile-only: shown as an "X" in the header when provided. */
  onCloseMobile?: () => void;
  /** Used as a stable key for switching rooms (re-mounts the per-room
   *  Yjs doc handle, resets per-room UI state). */
  roomId?: string;
  /** When true, the inline note-composer at the bottom is suppressed.
   *  MobileShell handles composing via the floating glass panel. */
  hideComposer?: boolean;
  /** Settings → Social on group notes. When on, group-scope notes
   *  that aren't agent-authored expose a heart + flat comment thread.
   *  Personal notes are never affected. */
  socialNotesEnabled?: boolean;
  /** Current user id — used to detect "my comment" so we show a
   *  delete button on it. */
  selfUserId?: string;
  /** Counter bumped by the parent when the search icon is tapped on
   *  the Notes tab's top bar. Each new value focuses the search
   *  input so the user can start typing immediately. */
  focusSearchTrigger?: number;
  /** Called whenever the in-sidebar search bar opens or closes, so
   *  the parent's top-bar magnifier can light up while search is
   *  active (matches the Chat tab's behavior). */
  onSearchOpenChange?: (open: boolean) => void;
  /** Top-bar Edit toggle. When on, PERSONAL notes show a delete
   *  button; group notes do not surface the affordance even if the
   *  caller authored them (group cleanup is a moderation task, not
   *  an editing one). */
  editMode?: boolean;
}

export function NotesSidebar({
  focus,
  notes,
  chatOpen,
  onToggleChat,
  onCloseMobile,
  roomId,
  hideComposer,
  socialNotesEnabled,
  selfUserId,
  focusSearchTrigger,
  onSearchOpenChange,
  editMode,
}: Props) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // The search field is hidden by default — the top-bar magnifier
  // toggles it open. Each tap of the icon flips `searchOpen`; opening
  // also focuses + selects the input so the user can type immediately.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    onSearchOpenChange?.(searchOpen);
  }, [searchOpen, onSearchOpenChange]);
  useEffect(() => {
    if (focusSearchTrigger === undefined || focusSearchTrigger === 0) return;
    // Toggle open/close only — DO NOT focus the input. Per user
    // preference, the keyboard should not auto-pop. They tap the
    // field themselves when ready to type.
    setSearchOpen((open) => !open);
  }, [focusSearchTrigger]);
  // Scope (personal vs group) is no longer a Notes-page toggle — it
  // lives in Settings → Group notes → "Default scope" so the page
  // surfaces a single, intentional view. We subscribe to the
  // same-tab `SETTINGS_CHANGED` event so flipping the toggle in
  // Settings updates this page without a reload.
  const [tab, setTab] = useState<"personal" | "group">(() => {
    try {
      return readSettings().defaultNoteScope;
    } catch {
      return "personal";
    }
  });
  useEffect(() => {
    const refresh = () => {
      try {
        setTab(readSettings().defaultNoteScope);
      } catch {
        // ignore — fall back to current
      }
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(SETTINGS_CHANGED, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(SETTINGS_CHANGED, refresh);
    };
  }, []);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLUListElement | null>(null);

  // Unread / All view. Defaults to All so a returning user lands on
  // the familiar full list. The unread count badge in the tab strip
  // is the prompt to switch.
  const [viewMode, setViewMode] = useState<"unread" | "all">("all");

  // Book + chapter filter chips. `null` = no filter. Chapter is only
  // meaningful when a book is selected; clearing the book also clears
  // the chapter.
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [chapterFilter, setChapterFilter] = useState<number | null>(null);

  // Per-(room, user) seen set. First mount snapshots every existing
  // note id into the set so the Unread view doesn't start at "all
  // history." Mutating the ref doesn't re-render — we bump a version
  // counter to trigger derived recalcs.
  const seenRef = useRef<Set<string>>(new Set());
  const [seenVersion, setSeenVersion] = useState(0);
  useEffect(() => {
    seenRef.current = loadSeenSet(roomId, selfUserId);
    if (consumeInitFlag(roomId, selfUserId)) {
      // Brand-new install for this (room, user) — every existing note
      // counts as already-seen so the badge doesn't scream on day 1.
      for (const n of notes.notes) seenRef.current.add(n.id);
      saveSeenSet(roomId, selfUserId, seenRef.current);
    }
    setSeenVersion((v) => v + 1);
    // We intentionally don't depend on `notes.notes` here — the init
    // snapshot is a one-time effect per (room, user).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, selfUserId]);

  function markSeen(ids: string[]) {
    let changed = false;
    for (const id of ids) {
      if (!seenRef.current.has(id)) {
        seenRef.current.add(id);
        changed = true;
      }
    }
    if (changed) {
      saveSeenSet(roomId, selfUserId, seenRef.current);
      setSeenVersion((v) => v + 1);
    }
  }

  // Plain-text search over the merged in-memory view. Note bodies
  // are sanitized HTML (RichNoteField), so strip tags before matching
  // so a query like "grace" hits text inside <b>/<u>/<em>. Server
  // never sees personal note bodies — privacy model preserved.
  const haystack = (html: string) =>
    html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const q = query.trim().toLowerCase();

  // Parse a note's anchor into book + chapter. Anchors look like
  // "GEN.1.1" (verse) or "GEN.1" (chapter). Unanchored notes get
  // `null` and only match the "All books" view.
  function parseAnchor(n: NoteRow): { book: string | null; chapter: number | null } {
    const a = n.verse_anchor;
    if (!a) return { book: null, chapter: null };
    const parts = a.split(".");
    const book = parts[0] || null;
    const chap = parts[1] ? parseInt(parts[1], 10) : NaN;
    return { book, chapter: Number.isFinite(chap) ? chap : null };
  }

  // Scope (existing) → search → book/chapter filter → unread filter.
  // We compute the scope+search baseline once so the book/chapter
  // chips can derive their option lists off the same population.
  const scoped = useMemo(
    () =>
      notes.notes
        .filter((n) => n.scope === tab)
        .filter((n) => !q || haystack(n.body).includes(q)),
    [notes.notes, tab, q],
  );

  // Book chip options — every book present in the scoped list.
  const bookOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of scoped) {
      const { book } = parseAnchor(n);
      if (book) counts.set(book, (counts.get(book) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [scoped]);

  // Chapter chip options — only the chapters of the selected book.
  const chapterOptions = useMemo(() => {
    if (!bookFilter) return [] as Array<[number, number]>;
    const counts = new Map<number, number>();
    for (const n of scoped) {
      const { book, chapter } = parseAnchor(n);
      if (book === bookFilter && chapter != null) {
        counts.set(chapter, (counts.get(chapter) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  }, [scoped, bookFilter]);

  // If the active book/chapter falls out of the option set (e.g. the
  // user changes scope and the book has no notes there), clear it.
  useEffect(() => {
    if (bookFilter && !bookOptions.some(([b]) => b === bookFilter)) {
      setBookFilter(null);
      setChapterFilter(null);
    }
  }, [bookOptions, bookFilter]);
  useEffect(() => {
    if (
      chapterFilter != null &&
      !chapterOptions.some(([c]) => c === chapterFilter)
    ) {
      setChapterFilter(null);
    }
  }, [chapterOptions, chapterFilter]);

  // Final list to render.
  const seen = seenRef.current;
  void seenVersion; // make `visible` recompute when seen changes
  const visible = scoped
    .filter((n) => {
      if (!bookFilter) return true;
      const { book, chapter } = parseAnchor(n);
      if (book !== bookFilter) return false;
      if (chapterFilter != null && chapter !== chapterFilter) return false;
      return true;
    })
    .filter((n) => viewMode === "all" || !seen.has(n.id));

  const unreadCount = useMemo(
    () => scoped.filter((n) => !seen.has(n.id)).length,
    // seenVersion forces recompute when seen mutates
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, seenVersion],
  );

  // Auto-mark notes as seen when the user is looking at the All view
  // (they've actively browsed). In Unread view we wait for an explicit
  // "Mark all read" so the user can see what's new before it disappears.
  useEffect(() => {
    if (viewMode !== "all") return;
    if (visible.length === 0) return;
    const ids = visible.map((n) => n.id);
    const t = window.setTimeout(() => markSeen(ids), 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, visible.length]);
  // Default-to-bottom, matching ChatPanel. Snap to the newest note
  // on first paint, when notes are added, when the user switches
  // between Personal ↔ Group, AND when the keyboard opens (so the
  // newest note stays pinned above the composer).
  useStickToBottom(listRef, [visible.length, tab]);

  return (
    <aside className="flex h-full flex-col border-l border-neutral-200 bg-paper dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          {onCloseMobile && (
            <button
              onClick={onCloseMobile}
              className="rounded p-1 text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
              aria-label="Close notes"
            >
              ✕
            </button>
          )}
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Notes
          </div>
          {onToggleChat && (
            <button
              onClick={onToggleChat}
              className="inline-flex min-h-[32px] items-center rounded-full border border-neutral-200 bg-paper px-3 py-1.5 text-[12px] font-semibold text-neutral-700 transition hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              title="Toggle chat panel below"
            >
              {chatOpen ? "Hide chat" : "Chat"}
            </button>
          )}
        </div>
      </div>

      {/* Search field — hidden by default. Toggled open by the top-bar
          magnifier (focusSearchTrigger). Plain-text — strips HTML
          before matching so styled notes still find their words.
          Search stays in the browser; the server never sees the
          contents of personal notes. */}
      {searchOpen && (
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-paper-soft px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="relative flex-1">
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab} notes…`}
            aria-label={`Search ${tab} notes`}
            className="w-full rounded-full border border-neutral-200 bg-paper px-3 py-2 pl-8 text-[14px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
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

      {/* View tabs + book/chapter filter chips. Kept compact so the
          note list still owns most of the column. */}
      <div className="border-b border-neutral-200 bg-paper-soft px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setViewMode("unread")}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
              viewMode === "unread"
                ? "bg-neutral-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] dark:bg-neutral-50 dark:text-neutral-900"
                : "border border-neutral-200 bg-paper text-neutral-700 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            }`}
            aria-pressed={viewMode === "unread"}
          >
            Unread
            {unreadCount > 0 && (
              <span
                className={`rounded-full px-1.5 text-[10px] font-bold ${
                  viewMode === "unread"
                    ? "bg-white/20 text-white dark:bg-neutral-900/20 dark:text-neutral-900"
                    : "bg-amber-500 text-white"
                }`}
              >
                {unreadCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              // Tapping "All" semantically means "show every note in
              // this scope." Carry-over book/chapter chips would
              // silently keep hiding notes (especially unanchored
              // ones, which fail any non-null book filter), so we
              // clear them along with the search query. The user can
              // re-apply filters via the chips immediately afterward.
              setViewMode("all");
              setBookFilter(null);
              setChapterFilter(null);
              setQuery("");
            }}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
              viewMode === "all"
                ? "bg-neutral-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] dark:bg-neutral-50 dark:text-neutral-900"
                : "border border-neutral-200 bg-paper text-neutral-700 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            }`}
            aria-pressed={viewMode === "all"}
          >
            All
          </button>
          {viewMode === "unread" && unreadCount > 0 && (
            <button
              type="button"
              onClick={() => markSeen(scoped.map((n) => n.id))}
              className="ml-auto rounded-full border border-neutral-200 bg-paper px-2 py-1 text-[10px] font-medium text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
              title="Mark every note as read"
            >
              Mark all read
            </button>
          )}

          {/* Single compact Book select — replaces the two horizontal
              chip rows. Chapter narrowing only appears once a book is
              picked, keeping the unfiltered state to one control. */}
          {bookOptions.length > 0 && (
            <select
              value={bookFilter ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setBookFilter(v || null);
                setChapterFilter(null);
              }}
              className="ml-auto rounded-full border border-neutral-200 bg-paper px-2.5 py-1 font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              aria-label="Filter notes by book"
            >
              <option value="">All books</option>
              {bookOptions.map(([book, count]) => (
                <option key={book} value={book}>
                  {OSIS_TO_BOOK_NAME[book] ?? book} ({count})
                </option>
              ))}
            </select>
          )}
          {bookFilter && chapterOptions.length > 0 && (
            <select
              value={chapterFilter ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setChapterFilter(v ? Number(v) : null);
              }}
              className="rounded-full border border-neutral-200 bg-paper px-2.5 py-1 font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              aria-label="Filter notes by chapter"
            >
              <option value="">All chapters</option>
              {chapterOptions.map(([ch, count]) => (
                <option key={ch} value={ch}>
                  Ch {ch} ({count})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <ul
        ref={listRef}
        className="flex-1 space-y-2 overflow-y-auto p-2"
        // When the inline composer is hidden, the floating glass
        // composer + AI pill in MobileShell sit on top of this list.
        // Mirror the chat panel's fix so the last note isn't tucked
        // permanently under the bar.
        style={
          hideComposer
            ? {
                paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)",
              }
            : undefined
        }
      >
        {visible.length === 0 && (
          <li className="text-xs text-neutral-500 dark:text-neutral-400">
            {q
              ? `No ${tab} notes match “${query.trim()}”.`
              : viewMode === "unread"
                ? "You're all caught up — no unread notes."
                : bookFilter
                  ? `No ${tab} notes for ${OSIS_TO_BOOK_NAME[bookFilter] ?? bookFilter}${chapterFilter != null ? ` ${chapterFilter}` : ""} yet.`
                  : "No notes yet."}
          </li>
        )}
        {visible.map((n) => {
          // Authorship gates editing the same way they gate deletion:
          // only the person who wrote the note can change it. Personal
          // notes are always the viewer's own (the privacy boundary).
          // Agent notes are never editable — they're system-generated
          // content, not the user's. Legacy group notes without an
          // author_user_id are locked too (matches canDeleteNote).
          const isAgent = !!n.by_agent;
          const isMine =
            !isAgent &&
            (n.scope === "personal" ||
              (!!selfUserId && n.author_user_id === selfUserId));
          const readOnly = !isMine || isAgent;
          // Label: agent → "Agent"; my own → "You"; someone else's
          // group note → their @handle so the rest of the group can
          // see who wrote it. Falls back to "Member" for legacy rows
          // with no recorded handle.
          const authorLabel = isAgent
            ? "Agent"
            : isMine
              ? "You"
              : n.author_handle
                ? `@${n.author_handle}`
                : "Member";
          return (
          <li
            key={n.id}
            className={`group px-2 py-1.5 text-sm ${GLASS_CARD_INLINE} ${
              n.by_agent
                ? "ring-1 ring-violet-300/60 dark:ring-violet-700/40"
                : ""
            }`}
          >
            <div className="flex items-center justify-between text-[10px] text-neutral-500 dark:text-neutral-400">
              <span>
                {authorLabel}
                {n.verse_anchor ? ` · ${n.verse_anchor}` : ""}
              </span>
              <div className="flex items-center gap-1">
                <span>{n.scope}</span>
                {canDeleteNote(n, selfUserId) && (
                  editMode && n.scope === "personal" ? (
                    // Edit-mode delete: prominent red pill, no hover
                    // hide. Personal-scope only — top-bar Edit is
                    // explicitly NOT a moderation tool for group notes.
                    <button
                      onClick={() => {
                        if (confirm("Delete this note?")) notes.remove(n.id);
                      }}
                      className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white shadow-[0_1px_2px_rgba(0,0,0,0.15)] hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-500"
                      title="Delete note"
                      aria-label="Delete note"
                    >
                      Delete
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        if (confirm("Delete this note?")) notes.remove(n.id);
                      }}
                      className="rounded px-1 text-neutral-400 opacity-50 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 md:opacity-0 dark:hover:bg-red-900/40 dark:hover:text-red-300"
                      title="Delete note (notes-system.MD §5.9)"
                      aria-label="Delete note"
                    >
                      ×
                    </button>
                  )
                )}
              </div>
            </div>
            <div className="mt-0.5">
              <RichNoteField
                value={n.body}
                onChange={(html) => notes.update(n.id, html)}
                ariaLabel={
                  readOnly
                    ? `${n.scope} note (read only)`
                    : `Edit ${n.scope} note`
                }
                compact
                roomId={roomId}
                readOnly={readOnly}
              />
            </div>
            {socialNotesEnabled &&
              roomId &&
              n.scope === "group" &&
              !n.by_agent && (
                <NoteSocialBlock
                  roomId={roomId}
                  noteId={n.id}
                  selfUserId={selfUserId}
                />
              )}
          </li>
          );
        })}
      </ul>

      {!hideComposer && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = draft.replace(/<br\s*\/?>/g, "").trim();
            if (!trimmed) return;
            notes.add({
              scope: tab,
              body: draft,
              verse_anchor: focus?.ref,
            });
            setDraft("");
          }}
          className="border-t border-neutral-200 p-2 dark:border-neutral-800"
        >
          <div className={`px-2.5 py-2 ${GLASS_CARD_INLINE}`}>
            <RichNoteField
              value={draft}
              onChange={setDraft}
              placeholder={
                focus ? `Note on ${focus.ref} (${tab})…` : `New ${tab} note…`
              }
              ariaLabel={`New ${tab} note`}
              roomId={roomId}
            />
          </div>
          <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-neutral-500 dark:text-neutral-400">
            <button
              type="submit"
              className="rounded-full bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Add
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}

