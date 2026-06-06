/**
 * Center — Bible text + prompt box (CLAUDE.md §4.3).
 *
 * The full KJV (public domain) is served by GET /bible/books and
 * GET /bible/{book}/{chapter}. Books and verses come from the backend;
 * no scripture text is bundled in the frontend.
 */
import { useEffect, useRef, useState } from "react";
import {
  api,
  originalForBook,
  OSIS_TO_BOOK_NAME,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationOut,
  type BibleBookOut,
  type BibleVerseMulti,
  type ReadingPlanDayOut,
  type ReadingPlanSummary,
} from "../../lib/api";
import type { VerseFocus } from "../Workspace";
import type { NotesApi } from "../NotesSidebar/notesStore";
import { NoteSocialBlock } from "../NotesSidebar/NoteSocialBlock";
import { RichNoteField } from "../NotesSidebar/RichNoteField";
import { bookColor } from "../../lib/testament";
import { type AnnotationTarget } from "./AnnotationToolbar";
import {
  BOLD_TEXT,
  BOX_BORDER,
  DECORATION_COLOR,
  HIGHLIGHT_BG,
  annotationsForVerse,
} from "./annotations";
import { GLASS_CARD_INLINE } from "../../lib/glass";
import { readSettings, SETTINGS_CHANGED } from "../../lib/settings";

interface Props {
  book: string;
  chapter: number;
  translation: string;
  focus: VerseFocus | null;
  notes: NotesApi;
  onPickBook: (b: string) => void;
  onPickChapter: (c: number) => void;
  onPickTranslation: (t: string) => void;
  onClickVerse: (v: number) => void;
  /** Hide the book/chapter/translation toolbar (focus mode). */
  hideToolbar?: boolean;
  /** Focus mode state — drives the focus pill icon direction. */
  focusMode?: boolean;
  /** Toggles the focus pill (collapse / expand the chrome). */
  onToggleFocus?: () => void;
  /** When true, each verse renders with original-language (Hebrew/Greek)
   * + Arabic alongside the selected translation. */
  showOriginal?: boolean;
  /** All of the user's last-read bookmarks. We use this to render a
   *  divider line under the bookmarked verse in the current book. */
  bookmarks?: {
    book: string;
    chapter: number;
    verse: number;
    updated_at?: string;
  }[];
  /** Single-tap on an empty ribbon → add a mark at this verse. The
   *  ribbon never removes on single tap; see `onRemoveBookmarkAt` for
   *  the double-tap path. */
  onSetBookmark?: (book: string, chapter: number, verse: number) => void;
  /** Double-tap on a filled ribbon → remove that mark. Wired through
   *  by the shell so single-tap-to-add / double-tap-to-remove is the
   *  consistent gesture across the ribbon and the last-read divider. */
  onRemoveBookmarkAt?: (book: string, chapter: number, verse: number) => void;
  /** Caller-decided behavior when the user double-taps a divider:
   *  navigate up the stack or delete the topmost flag in the book. */
  onDoubleTapBookmark?: (
    book: string,
    chapter: number,
    verse: number,
  ) => void;
  /** User-picked IANA timezone for the divider timestamp. "" = browser. */
  timezone?: string;
  /** Room id — needed when notes-as-posts is on, so the inline note
   *  panel can render hearts/comments under each group note. */
  roomId?: string;
  /** Stable user id (from /auth/me). Used to show a delete button on
   *  the viewer's own comments. */
  selfUserId?: string;
  /** Settings → "Social on group notes". When on, every inline group
   *  note (non-agent) sprouts a heart + flat comment thread. */
  socialNotesEnabled?: boolean;
  /** All of the user's verse annotations. When supplied, the renderer
   *  paints highlights/underlines/strikes on matching verses and the
   *  long-press gesture surfaces the toolbar. */
  annotations?: AnnotationOut[];
  onApplyAnnotation?: (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
  ) => void;
  onClearAnnotationKind?: (verseId: string, kind: AnnotationKind) => void;
  onClearAnnotations?: (verseId: string) => void;
  /** Lifted from BibleView so the shell's bottom panel can render
   *  the tool strip when a verse is long-pressed. BibleView itself
   *  no longer renders the toolbar; it just reports the target. */
  annotationTarget?: { verseId: string; label?: string } | null;
  onAnnotationTargetChange?: (
    t: { verseId: string; label?: string } | null,
  ) => void;
  /** When true the scripture scroller pads its bottom to clear the
   *  floating glass composer + AI pill in MobileShell. Otherwise
   *  the last verse hides behind the bar. */
  bottomInset?: boolean;
}

export function BibleView({
  book,
  chapter,
  translation,
  focus,
  notes,
  onPickBook,
  onPickChapter,
  onPickTranslation,
  onClickVerse,
  hideToolbar,
  focusMode,
  onToggleFocus,
  showOriginal,
  bookmarks,
  onSetBookmark,
  onRemoveBookmarkAt,
  onDoubleTapBookmark,
  timezone,
  roomId,
  selfUserId,
  socialNotesEnabled,
  annotations,
  onApplyAnnotation,
  annotationTarget,
  onAnnotationTargetChange,
  bottomInset,
}: Props) {
  const [books, setBooks] = useState<BibleBookOut[]>([]);
  const [verses, setVerses] = useState<BibleVerseMulti[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [autoFocusVerse, setAutoFocusVerse] = useState<string | null>(null);
  // Manual double-tap detector — iOS Safari is inconsistent about firing
  // `dblclick`/`click` on text spans (the magnifier/selection intercepts),
  // so we listen for `pointerup` directly and time the gap ourselves.
  const lastTapRef = useRef<{ verseId: string; t: number } | null>(null);
  // Same trick for the bookmark divider — track the last tap by its
  // book/chapter/verse key, fire onDoubleTapBookmark on the second tap.
  const lastDividerTapRef = useRef<{ key: string; t: number } | null>(null);
  // And the same for the ribbon button — single tap on empty adds a
  // mark, double tap on filled removes it. We never delete on a
  // single tap (the user explicitly asked for double-tap-to-remove).
  const lastRibbonTapRef = useRef<{ key: string; t: number } | null>(null);
  const handleRibbonTap = (
    chapter: number,
    verse: number,
    filled: boolean,
  ) => {
    const key = `${book}.${chapter}.${verse}`;
    const now = Date.now();
    const last = lastRibbonTapRef.current;
    if (filled && last && last.key === key && now - last.t < 400) {
      lastRibbonTapRef.current = null;
      onRemoveBookmarkAt?.(book, chapter, verse);
      return;
    }
    lastRibbonTapRef.current = { key, t: now };
    if (!filled) onSetBookmark?.(book, chapter, verse);
  };

  // Apple-style long-press → annotation toolbar. Holding a verse text
  // for ~400ms fires the haptic + flips the shell's bottom panel from
  // tab bar to the annotation tool strip; releasing before then is
  // treated as a normal tap (handled by the existing onPointerUp/click
  // path elsewhere on the verse).
  const setAnnotationTarget = (t: AnnotationTarget | null) => {
    onAnnotationTargetChange?.(t);
  };
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{
    verseId: string;
    x: number;
    y: number;
  } | null>(null);
  const longPressFiredRef = useRef(false);
  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  };
  const startLongPress = (
    e: React.PointerEvent,
    verseId: string,
    label: string,
  ) => {
    if (!annotations || !onApplyAnnotation) return;
    longPressFiredRef.current = false;
    longPressStartRef.current = {
      verseId,
      x: e.clientX,
      y: e.clientY,
    };
    cancelLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      longPressTimerRef.current = null;
      // Haptic tick on supported devices (iOS Safari ignores this, but
      // Chromium-based mobile honors it).
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          (navigator as Navigator & { vibrate?: (p: number) => void }).vibrate?.(
            10,
          );
        } catch {
          // Ignore — vibrate can throw under user-activation policy.
        }
      }
      setAnnotationTarget({ verseId, label });
    }, 380);
  };
  const moveLongPress = (e: React.PointerEvent) => {
    const start = longPressStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    // Treat any meaningful drag as a scroll intent and abort the timer.
    if (dx * dx + dy * dy > 64) cancelLongPress();
  };

  const toggleExpand = (verseId: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(verseId)) next.delete(verseId);
      else next.add(verseId);
      return next;
    });

  // Chapter-level note panel — collapsed by default, toggles via the
  // pill next to the chapter title. The anchor format is `BOOK.CHAPTER`
  // (two segments) which the NotesApi treats as a distinct bucket
  // from verse anchors (`BOOK.CHAPTER.VERSE`, three segments).
  const [chapterNotesOpen, setChapterNotesOpen] = useState(false);
  // Auto-collapse when the user navigates to a different chapter so
  // the panel doesn't follow them with stale state.
  useEffect(() => {
    setChapterNotesOpen(false);
  }, [book, chapter]);
  const chapterNotes = notes.forChapter(book, chapter);

  const openForNewNote = (verseId: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(verseId)) {
        // Already open → double-tap closes it (toggle behavior).
        next.delete(verseId);
        setAutoFocusVerse(null);
      } else {
        next.add(verseId);
        setAutoFocusVerse(verseId);
      }
      return next;
    });
  };

  const handleVerseTap = (verseId: string) => {
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && last.verseId === verseId && now - last.t < 400) {
      lastTapRef.current = null;
      openForNewNote(verseId);
      return true;
    }
    lastTapRef.current = { verseId, t: now };
    return false;
  };

  useEffect(() => {
    let alive = true;
    api
      .bibleBooks()
      .then((bs) => alive && setBooks(bs))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const wanted = showOriginal
      ? ["King James Version", originalForBook(book), "Arabic (SVD)"]
      : ["King James Version"];
    api
      .bibleChapterMulti(book, chapter, wanted)
      .then((c) => {
        if (alive) setVerses(c.verses);
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [book, chapter, showOriginal]);

  const currentBook = books.find((b) => b.code === book);
  const chapterCount = currentBook?.chapters ?? 1;
  const bookName = currentBook?.name ?? book;

  // Horizontal swipe = previous / next chapter. Wraps across books at
  // the boundaries (Gen 1 ↤ stays put; Rev 22 ↦ stays put). The
  // touch handler lives on the verses scroller so vertical reading
  // scroll is unaffected; we only commit on horizontal moves that
  // beat both a distance threshold and a vertical-drift cap.
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_DX_MIN = 60;
  const SWIPE_DY_MAX = 50;
  const advanceChapter = (dir: 1 | -1) => {
    const target = chapter + dir;
    if (target >= 1 && target <= chapterCount) {
      onPickChapter(target);
      return;
    }
    // Past the edge — hop to the adjacent book's first/last chapter.
    const idx = books.findIndex((b) => b.code === book);
    if (idx < 0) return;
    if (dir === 1 && idx + 1 < books.length) {
      const next = books[idx + 1];
      onPickBook(next.code);
      onPickChapter(1);
    } else if (dir === -1 && idx > 0) {
      const prev = books[idx - 1];
      onPickBook(prev.code);
      onPickChapter(prev.chapters ?? 1);
    }
  };
  const onChapterSwipeStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    swipeStartRef.current = { x: t.clientX, y: t.clientY };
  };
  const onChapterSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dy) > SWIPE_DY_MAX) return;
    if (Math.abs(dx) < SWIPE_DX_MIN) return;
    // Drag left → next chapter; drag right → previous chapter. Mirrors
    // the natural "page turn" direction of a book in LTR languages.
    advanceChapter(dx < 0 ? 1 : -1);
  };

  // Double-tap on the verses scroller (away from any verse-number /
  // ribbon button) → dismiss the annotation strip. The user asked
  // for "double tap the screen above the panel anywhere where the
  // Bible is" to return the bottom panel to its tabs view.
  const lastScrollerTapRef = useRef<{ t: number; x: number; y: number } | null>(
    null,
  );
  const onScrollerDoubleTapDismiss = (e: React.PointerEvent) => {
    if (!annotationTarget) return;
    const now = Date.now();
    const last = lastScrollerTapRef.current;
    lastScrollerTapRef.current = { t: now, x: e.clientX, y: e.clientY };
    if (!last || now - last.t > 400) return;
    const ddx = e.clientX - last.x;
    const ddy = e.clientY - last.y;
    if (ddx * ddx + ddy * ddy > 900) return; // taps must be near each other
    onAnnotationTargetChange?.(null);
    lastScrollerTapRef.current = null;
  };

  return (
    <>
    <div className="flex h-full flex-col bg-paper dark:bg-neutral-900">
      {!hideToolbar && (
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
        <select
          value={book}
          onChange={(e) => {
            onPickBook(e.target.value);
            onPickChapter(1);
          }}
          className="rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm md:px-1.5 md:py-1 md:text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        >
          {books.length === 0 ? (
            <option value={book}>{book}</option>
          ) : (
            books.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))
          )}
        </select>
        <select
          value={chapter}
          onChange={(e) => onPickChapter(Number(e.target.value))}
          className="rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm md:px-1.5 md:py-1 md:text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        >
          {Array.from({ length: chapterCount }, (_, i) => i + 1).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <select
          value={translation}
          onChange={(e) => onPickTranslation(e.target.value)}
          className="rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm md:px-1.5 md:py-1 md:text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          title="Public-domain translations only until commercial licenses are wired (CLAUDE.md §7.6)."
        >
          <option value="King James Version">KJV (1611)</option>
          <option value="World English Bible">WEB (modern)</option>
        </select>
        {loading && (
          <span className="text-neutral-400 dark:text-neutral-500">
            loading…
          </span>
        )}
      </div>
      )}

      {onToggleFocus && (
        <div className="relative flex h-0 justify-center">
          <button
            onClick={onToggleFocus}
            className="absolute -top-px z-30 rounded-b-full border border-t-0 border-neutral-300 bg-paper px-3 py-0.5 text-[10px] text-neutral-500 shadow-sm hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
            title={focusMode ? "Show chrome" : "Hide chrome (focus mode)"}
            aria-label="Toggle focus mode"
          >
            {focusMode ? "▼" : "▲"}
          </button>
        </div>
      )}

      <div
        onTouchStart={onChapterSwipeStart}
        onTouchEnd={onChapterSwipeEnd}
        onPointerUp={onScrollerDoubleTapDismiss}
        className="flex-1 overflow-y-auto px-6 py-4"
        // Mirror ChatPanel + the notes list: when the floating glass
        // composer + 64px AI pill sit on top of this scroller, lift
        // the last verse above them so reading isn't cut off.
        style={
          bottomInset
            ? {
                paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)",
              }
            : undefined
        }
      >
        <TodaysReadingBanner
          currentBook={book}
          currentChapter={chapter}
          onJump={(b, c) => {
            onPickBook(b);
            onPickChapter(c);
          }}
        />
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {bookName} {chapter}
          </h2>
          <button
            onClick={() => setChapterNotesOpen((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
              chapterNotesOpen
                ? "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-700 dark:bg-violet-900/40 dark:text-violet-200"
                : "border-neutral-200 bg-paper text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
            title={
              chapterNotesOpen
                ? "Hide chapter notes"
                : "Notes on this whole chapter"
            }
            aria-expanded={chapterNotesOpen}
          >
            <span>✎ Chapter</span>
            {chapterNotes.length > 0 && (
              <span className="rounded-full bg-violet-500 px-1 text-[9px] text-white">
                {chapterNotes.length}
              </span>
            )}
          </button>
        </div>
        {chapterNotesOpen && (
          <ChapterNotePanel
            book={book}
            chapter={chapter}
            chapterNotes={chapterNotes}
            notes={notes}
            roomId={roomId}
            selfUserId={selfUserId}
            socialNotesEnabled={socialNotesEnabled}
          />
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-300">
            Failed to load: {error}
          </p>
        )}
        {!error && verses.length === 0 && !loading && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No verses returned.
          </p>
        )}
        {verses.length > 0 && (() => {
          // Pick the ACTIVE bookmark in this book = the one at the
          // highest position (chapter, verse). Past flags always sit
          // above it. Ribbons on other bookmarked verses still show
          // filled; only this one renders the "Last read" divider.
          type Bm = NonNullable<typeof bookmarks>[number];
          const latestInBook = (bookmarks || [])
            .filter((b) => b.book === book)
            .reduce<Bm | undefined>((acc, b) => {
              if (!acc) return b;
              if (
                b.chapter > acc.chapter ||
                (b.chapter === acc.chapter && b.verse > acc.verse)
              ) {
                return b;
              }
              return acc;
            }, undefined);
          return (
            <div className="space-y-1.5">
            {verses.map((v) => {
              const verseNotes = notes.forVerse(v.verse_id);
              const isExpanded = expanded.has(v.verse_id);
              const bookmarkHere = bookmarks?.find(
                (b) =>
                  b.book === book &&
                  b.chapter === chapter &&
                  b.verse === v.verse,
              );
              const isLatestHere =
                !!latestInBook &&
                latestInBook.chapter === chapter &&
                latestInBook.verse === v.verse;
              const ann = annotationsForVerse(annotations, v.verse_id);
              // Decoration stacking: only one underline-style can win
              // (CSS text-decoration is single-valued per element).
              // Priority — wavy > double > single, matching the
              // "more deliberate = more visible" mental model.
              const underlineCls = ann.wavy
                ? `underline decoration-wavy decoration-2 underline-offset-2 ${DECORATION_COLOR[ann.wavy.color]}`
                : ann.double_underline
                  ? `underline decoration-double decoration-2 underline-offset-2 ${DECORATION_COLOR[ann.double_underline.color]}`
                  : ann.underline
                    ? `underline decoration-2 underline-offset-2 ${DECORATION_COLOR[ann.underline.color]}`
                    : "";
              const annClasses = [
                ann.highlight
                  ? `rounded-sm px-0.5 ${HIGHLIGHT_BG[ann.highlight.color]}`
                  : "",
                underlineCls,
                ann.box
                  ? `rounded-md border-2 px-1 ${BOX_BORDER[ann.box.color]}`
                  : "",
                ann.bold ? `font-semibold ${BOLD_TEXT[ann.bold.color]}` : "",
              ]
                .filter(Boolean)
                .join(" ");
              const verseLabel = `${book} ${chapter}:${v.verse}`;
              const longPressHandlers = onApplyAnnotation
                ? {
                    onPointerDown: (e: React.PointerEvent) =>
                      startLongPress(e, v.verse_id, verseLabel),
                    onPointerMove: moveLongPress,
                    onPointerUp: (e: React.PointerEvent) => {
                      if (longPressFiredRef.current) {
                        // Don't fall through to focus/select on release.
                        e.preventDefault();
                        e.stopPropagation();
                      }
                      cancelLongPress();
                    },
                    onPointerCancel: cancelLongPress,
                    onPointerLeave: cancelLongPress,
                    onContextMenu: (e: React.MouseEvent) => {
                      // Suppress the native long-press context menu when
                      // the gesture is ours.
                      e.preventDefault();
                    },
                  }
                : {};
              return (
                <div key={v.verse_id}>
                  <p className="leading-relaxed">
                    <button
                      onPointerUp={(e) => {
                        if (e.button !== 0 && e.pointerType === "mouse") return;
                        const isDouble = handleVerseTap(v.verse_id);
                        if (!isDouble) onClickVerse(v.verse);
                      }}
                      className={`mr-2 inline-flex h-5 min-w-[1.4rem] touch-manipulation items-center justify-center rounded text-[11px] font-semibold ${
                        focus?.verse === v.verse &&
                        focus?.ref?.startsWith(`${book}.${chapter}.`)
                          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                          : "bg-scripture text-neutral-700 hover:bg-yellow-100 dark:bg-scripture-dark dark:text-amber-100 dark:hover:bg-amber-900"
                      }`}
                      title={`Tap to focus · double-tap to add a note (${v.verse_id})`}
                    >
                      {v.verse}
                    </button>
                    {onSetBookmark && (
                      <button
                        onClick={() =>
                          handleRibbonTap(chapter, v.verse, !!bookmarkHere)
                        }
                        className={`mr-1.5 inline-flex h-5 w-5 touch-manipulation items-center justify-center align-middle transition ${
                          bookmarkHere
                            ? bookColor(book).text
                            : "text-neutral-300 hover:text-amber-500 dark:text-neutral-700 dark:hover:text-amber-300"
                        }`}
                        aria-label={
                          bookmarkHere
                            ? `${book} mark at ${chapter}:${v.verse} — double-tap to remove`
                            : `Mark ${book} at ${chapter}:${v.verse}`
                        }
                        title={
                          bookmarkHere
                            ? "Marked — double-tap to remove"
                            : `Mark ${book} ${chapter}:${v.verse}`
                        }
                      >
                        <BookmarkRibbon filled={!!bookmarkHere} />
                      </button>
                    )}
                    {verseNotes.length > 0 && (
                      <button
                        onPointerUp={(e) => {
                          if (e.button !== 0 && e.pointerType === "mouse")
                            return;
                          const isDouble = handleVerseTap(v.verse_id);
                          if (!isDouble) toggleExpand(v.verse_id);
                        }}
                        className={`mr-2 inline-flex h-5 touch-manipulation items-center gap-1 rounded border px-1.5 text-[10px] font-medium ${
                          isExpanded
                            ? "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-700 dark:bg-violet-900/40 dark:text-violet-200"
                            : "border-neutral-300 bg-paper text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
                        }`}
                        title={`Tap to ${isExpanded ? "hide" : "show"} · double-tap to add a note`}
                      >
                        <span>✎</span>
                        <span>{verseNotes.length}</span>
                        <span aria-hidden>{isExpanded ? "▾" : "▸"}</span>
                      </button>
                    )}
                    {(() => {
                      const isAnnTarget =
                        annotationTarget?.verseId === v.verse_id;
                      // Apple "select-and-hold" feel: kill native text
                      // selection + the iOS magnifier on the verse so
                      // our long-press is the only gesture that fires.
                      // The press shows a soft ring around just THIS
                      // verse so the user sees what they targeted.
                      const noSelect: React.CSSProperties = {
                        WebkitTouchCallout: "none",
                        WebkitUserSelect: "none",
                        userSelect: "none",
                        touchAction: "manipulation",
                      };
                      const ringClasses = isAnnTarget
                        ? "ring-2 ring-offset-2 ring-neutral-900/80 dark:ring-neutral-100/80 ring-offset-paper dark:ring-offset-neutral-900 rounded"
                        : "";
                      return v.translations.length === 1 ? (
                        <span
                          dir={v.translations[0].direction}
                          {...longPressHandlers}
                          style={noSelect}
                          className={`text-[15px] text-neutral-800 transition-shadow dark:text-neutral-100 ${annClasses} ${ringClasses}`}
                        >
                          {v.translations[0].text}
                        </span>
                      ) : (
                        <span
                          {...longPressHandlers}
                          style={noSelect}
                          className={`text-[15px] text-neutral-800 transition-shadow dark:text-neutral-100 ${annClasses} ${ringClasses}`}
                        >
                          {v.translations[0].text}
                        </span>
                      );
                    })()}
                  </p>
                  {v.translations.length > 1 && (
                    <div className="mb-2 ml-7 mt-1 space-y-1">
                      {v.translations.slice(1).map((tr) => (
                        <div
                          key={tr.name}
                          dir={tr.direction}
                          {...longPressHandlers}
                          style={{
                            WebkitTouchCallout: "none",
                            WebkitUserSelect: "none",
                            userSelect: "none",
                            touchAction: "manipulation",
                          }}
                          className="rounded border border-neutral-200 bg-paper-soft px-2 py-1 text-[15px] text-neutral-800 dark:border-neutral-800 dark:bg-neutral-950/50 dark:text-neutral-100"
                        >
                          <div
                            dir="ltr"
                            className="mb-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
                          >
                            {tr.name}
                          </div>
                          <div
                            className={
                              tr.direction === "rtl" ? "text-right" : ""
                            }
                          >
                            {tr.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {isExpanded && (
                    <InlineNotePanel
                      verseId={v.verse_id}
                      verseNotes={verseNotes}
                      notes={notes}
                      autoFocus={autoFocusVerse === v.verse_id}
                      onAutoFocusHandled={() => setAutoFocusVerse(null)}
                      roomId={roomId}
                      selfUserId={selfUserId}
                      socialNotesEnabled={socialNotesEnabled}
                    />
                  )}
                  {bookmarkHere && isLatestHere && (() => {
                    const c = bookColor(book);
                    const dividerKey = `${book}.${chapter}.${v.verse}`;
                    const onDividerTap = () => {
                      if (!onDoubleTapBookmark) return;
                      const now = Date.now();
                      const last = lastDividerTapRef.current;
                      if (last && last.key === dividerKey && now - last.t < 400) {
                        lastDividerTapRef.current = null;
                        onDoubleTapBookmark(book, chapter, v.verse);
                        return;
                      }
                      lastDividerTapRef.current = { key: dividerKey, t: now };
                    };
                    return (
                      <button
                        type="button"
                        onClick={onDividerTap}
                        className="my-2 flex w-full touch-manipulation items-center gap-2 text-left"
                        aria-label={`Last-read marker at ${book} ${chapter}:${v.verse} — double-tap to walk up the stack or delete`}
                      >
                        <span
                          className={c.text}
                          aria-hidden="true"
                        >
                          <UpArrow />
                        </span>
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wide ${c.text}`}
                        >
                          Last read
                        </span>
                        <span className={`h-px flex-1 ${c.line}`} />
                        {bookmarkHere.updated_at && (
                          <>
                            <span
                              className={`whitespace-nowrap text-[10px] font-medium ${c.text}`}
                            >
                              {formatBookmarkStamp(bookmarkHere.updated_at, timezone)}
                            </span>
                            <span className={`h-px flex-1 ${c.line}`} />
                          </>
                        )}
                      </button>
                    );
                  })()}
                </div>
              );
            })}
          </div>
          );
        })()}
      </div>
    </div>
    </>
  );
}

/**
 * Inline expandable note panel anchored to a verse.
 *
 * notes-system.MD §5.4–§5.6: notes are fully editable inline using the
 * same rich editor as the sidebar; edits propagate to the sidebar
 * instantly because they share the underlying `NotesApi`.
 *
 * Scripture text is never modified (§5.5): the panel is an overlay
 * anchored to the verse, not part of the passage.
 */
function InlineNotePanel({
  verseId,
  verseNotes,
  notes,
  autoFocus,
  onAutoFocusHandled,
  roomId,
  selfUserId,
  socialNotesEnabled,
}: {
  verseId: string;
  verseNotes: ReturnType<NotesApi["forVerse"]>;
  notes: NotesApi;
  autoFocus?: boolean;
  onAutoFocusHandled?: () => void;
  roomId?: string;
  selfUserId?: string;
  socialNotesEnabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [draftScope, setDraftScope] = useState<"personal" | "group">(
    "personal",
  );
  // RichNoteField handles its own autofocus via the `autoFocus` prop;
  // we just need to clear the flag once we've handed it off.
  useEffect(() => {
    if (autoFocus) onAutoFocusHandled?.();
  }, [autoFocus, onAutoFocusHandled]);

  return (
    <div
      className={`mb-2 ml-7 mt-1 p-2 text-sm ring-1 ring-violet-300/50 dark:ring-violet-600/30 ${GLASS_CARD_INLINE}`}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-300">
        Notes on {verseId}
      </div>
      <ul className="space-y-1.5">
        {verseNotes.map((n) => (
          <li
            key={n.id}
            className={`group px-2 py-1.5 ${GLASS_CARD_INLINE} ${
              n.by_agent
                ? "ring-1 ring-violet-300/40 dark:ring-violet-700/30"
                : ""
            }`}
          >
            <div className="flex items-center justify-between text-[10px] text-neutral-500 dark:text-neutral-400">
              <span>{n.by_agent ? "Agent" : "You"}</span>
              <div className="flex items-center gap-1">
                <span>{n.scope}</span>
                <button
                  onClick={() => {
                    if (confirm("Delete this note?")) notes.remove(n.id);
                  }}
                  className="rounded px-1 text-neutral-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-900/40 dark:hover:text-red-300"
                  title="Delete note (notes-system.MD §5.9)"
                  aria-label="Delete note"
                >
                  ×
                </button>
              </div>
            </div>
            <RichNoteField
              value={n.body}
              onChange={(html) => notes.update(n.id, html)}
              ariaLabel={`Edit ${n.scope} note on ${verseId}`}
              compact
            />
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
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.replace(/<br\s*\/?>/g, "").trim();
          if (!trimmed) return;
          notes.add({
            scope: draftScope,
            body: draft,
            verse_anchor: verseId,
          });
          setDraft("");
        }}
        className="mt-2 flex items-end gap-2"
      >
        <div className={`flex-1 px-2.5 py-1.5 ${GLASS_CARD_INLINE}`}>
          <RichNoteField
            value={draft}
            onChange={setDraft}
            placeholder={`Add a ${draftScope} note on ${verseId}…`}
            ariaLabel={`New ${draftScope} note on ${verseId}`}
            autoFocus={!!autoFocus}
          />
        </div>
        <div className="flex flex-col gap-1">
          {/* Segmented glass pill matching the rest of the card
              family — replaces the native <select> which broke the
              visual line. */}
          <div
            role="radiogroup"
            aria-label="Note scope"
            className={`flex items-stretch p-0.5 text-[10px] ${GLASS_CARD_INLINE}`}
          >
            {(["personal", "group"] as const).map((s) => {
              const on = draftScope === s;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setDraftScope(s)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "ArrowRight" ||
                      e.key === "ArrowDown" ||
                      e.key === "ArrowLeft" ||
                      e.key === "ArrowUp"
                    ) {
                      e.preventDefault();
                      setDraftScope(s === "personal" ? "group" : "personal");
                    }
                  }}
                  className={`flex-1 rounded-full px-2 py-1 font-medium capitalize transition ${
                    on
                      ? "bg-neutral-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] dark:bg-neutral-100 dark:text-neutral-900"
                      : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-50"
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
          <button
            type="submit"
            className="rounded-full bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add
          </button>
        </div>
      </form>
    </div>
  );
}


/**
 * Notes pinned to the whole chapter (no verse anchor). Renders one
 * card per existing chapter note + a composer to add another. Lives
 * directly under the chapter heading so it reads as a header for the
 * passage.
 */
function ChapterNotePanel({
  book,
  chapter,
  chapterNotes,
  notes,
  roomId,
  selfUserId,
  socialNotesEnabled,
}: {
  book: string;
  chapter: number;
  chapterNotes: ReturnType<NotesApi["forChapter"]>;
  notes: NotesApi;
  roomId?: string;
  selfUserId?: string;
  socialNotesEnabled?: boolean;
}) {
  const anchor = `${book}.${chapter}`;
  const [draft, setDraft] = useState("");
  const [draftScope, setDraftScope] = useState<"personal" | "group">(
    "personal",
  );

  return (
    <div
      className={`mb-3 p-2 text-sm ring-1 ring-violet-300/50 dark:ring-violet-600/30 ${GLASS_CARD_INLINE}`}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-300">
        Notes on {book} {chapter}
      </div>
      <ul className="space-y-1.5">
        {chapterNotes.map((n) => (
          <li
            key={n.id}
            className={`group px-2 py-1.5 ${GLASS_CARD_INLINE} ${
              n.by_agent
                ? "ring-1 ring-violet-300/40 dark:ring-violet-700/30"
                : ""
            }`}
          >
            <div className="flex items-center justify-between text-[10px] text-neutral-500 dark:text-neutral-400">
              <span>{n.by_agent ? "Agent" : "You"}</span>
              <div className="flex items-center gap-1">
                <span>{n.scope}</span>
                <button
                  onClick={() => {
                    if (confirm("Delete this note?")) notes.remove(n.id);
                  }}
                  className="rounded px-1 text-neutral-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-900/40 dark:hover:text-red-300"
                  title="Delete note (notes-system.MD §5.9)"
                  aria-label="Delete note"
                >
                  ×
                </button>
              </div>
            </div>
            <RichNoteField
              value={n.body}
              onChange={(html) => notes.update(n.id, html)}
              ariaLabel={`Edit ${n.scope} note on ${book} ${chapter}`}
              compact
            />
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
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.replace(/<br\s*\/?>/g, "").trim();
          if (!trimmed) return;
          notes.add({
            scope: draftScope,
            body: draft,
            verse_anchor: anchor,
          });
          setDraft("");
        }}
        className="mt-2 flex items-end gap-2"
      >
        <div className={`flex-1 px-2.5 py-1.5 ${GLASS_CARD_INLINE}`}>
          <RichNoteField
            value={draft}
            onChange={setDraft}
            placeholder={`Add a ${draftScope} note on ${book} ${chapter}…`}
            ariaLabel={`New ${draftScope} note on ${book} ${chapter}`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div
            role="radiogroup"
            aria-label="Note scope"
            className={`flex items-stretch p-0.5 text-[10px] ${GLASS_CARD_INLINE}`}
          >
            {(["personal", "group"] as const).map((s) => {
              const on = draftScope === s;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setDraftScope(s)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "ArrowRight" ||
                      e.key === "ArrowDown" ||
                      e.key === "ArrowLeft" ||
                      e.key === "ArrowUp"
                    ) {
                      e.preventDefault();
                      setDraftScope(s === "personal" ? "group" : "personal");
                    }
                  }}
                  className={`flex-1 rounded-full px-2 py-1 font-medium capitalize transition ${
                    on
                      ? "bg-neutral-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] dark:bg-neutral-100 dark:text-neutral-900"
                      : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-50"
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
          <button
            type="submit"
            className="rounded-full bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add
          </button>
        </div>
      </form>
    </div>
  );
}

function formatBookmarkStamp(iso: string, timezone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Concise: "Jun 3 · 5:23 AM" — fits in the middle of the divider.
  // Honor user-picked IANA timezone when set; empty string = browser default.
  const tz = timezone || undefined;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  return `${date} · ${time}`;
}

function UpArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 18.5V5.5" />
      <path d="M5.5 12 12 5.5l6.5 6.5" />
    </svg>
  );
}

/**
 * Banner shown at the top of the Bible scroller when the viewer is
 * enrolled in any reading plan. Picks the first enrolled plan, fetches
 * `today`, and renders a tap-to-jump pill for each ref.
 *
 * Tracks which of today's refs the user has visited in this session
 * (current book/chapter passed in via props). Once all refs are
 * covered, the **Mark done** button highlights and a single tap
 * completes the day via `api.readingPlanComplete`. The user can also
 * mark done early — the auto-detection is a hint, not a gate.
 *
 * On completion: brief "✓ Done!" confirmation, then the banner hides
 * for the rest of the session. (Returns next render cycle for the
 * next day's reading because `today.completed` flips server-side.)
 */
function TodaysReadingBanner({
  currentBook,
  currentChapter,
  onJump,
}: {
  currentBook: string;
  currentChapter: number;
  onJump: (book: string, chapter: number) => void;
}) {
  const [plan, setPlan] = useState<ReadingPlanSummary | null>(null);
  const [today, setToday] = useState<ReadingPlanDayOut | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [justDone, setJustDone] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());

  // User toggle from Settings → Reading plans. Reading once at mount
  // is fine — flipping the toggle while viewing the Bible doesn't
  // need to retro-hide the banner; the next page load will. localStorage
  // also propagates across tabs via the `storage` event below.
  const [enabled, setEnabled] = useState(() => {
    try {
      return readSettings().todaysReadingBanner;
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const refresh = () => {
      try {
        setEnabled(readSettings().todaysReadingBanner);
      } catch {
        // ignore — fall back to default true
      }
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(SETTINGS_CHANGED, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(SETTINGS_CHANGED, refresh);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const all = await api.readingPlansList();
        const enrolled = all.find((p) => p.enrolled);
        if (!enrolled) return;
        const day = await api.readingPlanToday(enrolled.id);
        if (cancelled) return;
        setPlan(enrolled);
        setToday(day);
      } catch {
        // Endpoint is best-effort; silently hide on failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Whenever the user navigates to a new chapter (via tap-jump,
  // dropdown, or swipe), remember it so we can auto-detect when all
  // of today's refs have been read.
  useEffect(() => {
    if (!currentBook || !currentChapter) return;
    setVisited((s) => {
      const next = new Set(s);
      next.add(`${currentBook}.${currentChapter}`);
      return next;
    });
  }, [currentBook, currentChapter]);

  if (!enabled) return null;
  if (hidden || !plan || !today) return null;
  if (today.completed && !justDone) return null;
  const refs = today.refs ?? [];
  if (refs.length === 0) return null;

  // Parse "PSA.23" or "JHN.3.16-21" → { book: "PSA", chapter: 23, label }
  const parsed = refs.map((ref) => {
    const segs = ref.split(".");
    const book = segs[0] ?? "GEN";
    const chapter = Number(segs[1] ?? "1") || 1;
    const verseFragment = segs.slice(2).join(".");
    const bookName = OSIS_TO_BOOK_NAME[book] ?? book;
    const label = verseFragment
      ? `${bookName} ${chapter}:${verseFragment}`
      : `${bookName} ${chapter}`;
    const visitedRef = visited.has(`${book}.${chapter}`);
    return { ref, book, chapter, label, visited: visitedRef };
  });

  const allVisited = parsed.every((p) => p.visited);

  async function markDone() {
    if (!plan || !today || busy) return;
    setBusy(true);
    try {
      await api.readingPlanComplete(plan.id, today.day_index);
      setJustDone(true);
      // Give the user a beat to see "✓ Done!" before fading out.
      setTimeout(() => setHidden(true), 1500);
    } catch {
      // Best-effort — failed completes can be retried next render.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 shadow-sm backdrop-blur-md dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-100">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden>{justDone ? "✓" : "📖"}</span>
          <span className="font-semibold">
            {justDone ? "Done!" : "Today's reading"}
          </span>
          <span className="text-amber-700/80 dark:text-amber-200/70">
            {plan.name} · Day {today.day_index}
          </span>
        </div>
        {!justDone && (
          <button
            onClick={() => setHidden(true)}
            aria-label="Dismiss for now"
            title="Dismiss for now"
            className="rounded-full px-1.5 text-amber-700/70 hover:bg-amber-100 dark:text-amber-200/70 dark:hover:bg-amber-800/40"
          >
            ×
          </button>
        )}
      </div>
      {!justDone && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {parsed.map(({ ref, book, chapter, label, visited: v }) => (
            <button
              key={ref}
              onClick={() => onJump(book, chapter)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition ${
                v
                  ? "border-emerald-400 bg-emerald-100/80 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-100"
                  : "border-amber-300 bg-paper text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-neutral-900 dark:text-amber-100 dark:hover:bg-amber-900/40"
              }`}
            >
              {v && <span aria-hidden>✓</span>}
              {label}
            </button>
          ))}
          <button
            onClick={() => void markDone()}
            disabled={busy}
            aria-label="Mark today's reading as done"
            className={`ml-auto inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-60 ${
              allVisited
                ? "bg-emerald-600 text-white shadow-sm hover:bg-emerald-500"
                : "border border-amber-400 bg-paper text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:bg-neutral-900 dark:text-amber-100 dark:hover:bg-amber-900/40"
            }`}
          >
            {busy ? "Saving…" : "Mark done"}
          </button>
        </div>
      )}
    </div>
  );
}

function BookmarkRibbon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 3.5h11a.5.5 0 0 1 .5.5v16.5l-6-3.6-6 3.6V4a.5.5 0 0 1 .5-.5Z" />
    </svg>
  );
}
