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
  type BibleSearchHit,
  type AdvancedSearchHit,
  type BibleVerseMulti,
  type ReadingPlanDayOut,
  type ReadingPlanSummary,
  type VerseTokenOut,
} from "../../lib/api";
import { BottomSheet } from "../../shell/BottomSheet";
import { speakSequence, armAudioSession } from "../../lib/tts";
import type { VerseFocus } from "../Workspace";
import type { NotesApi } from "../NotesSidebar/notesStore";
import { NoteSocialBlock } from "../NotesSidebar/NoteSocialBlock";
import { RichNoteField } from "../NotesSidebar/RichNoteField";
import { canDeleteNote } from "../NotesSidebar/noteOwnership";
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
import { MagicIcon, JumpIcon } from "../../lib/Icons";
import {
  parseReference,
  suggestReferences,
  formatReference,
  type ParsedReference,
} from "../../lib/bibleRefParser";
import { readSettings, SETTINGS_CHANGED } from "../../lib/settings";
import { ACCENT_PALETTE, type AccentKey } from "../../lib/accentColors";

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
  /** Active room's accent — drives the "group" side of the inline
   *  ScopePill so it matches the per-room theme picked in Settings,
   *  same as the Notes-tab top-bar scope toggle. */
  accentKey?: AccentKey;
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
  accentKey,
}: Props) {
  const scopePillPalette = accentKey ? ACCENT_PALETTE[accentKey] : undefined;
  const [books, setBooks] = useState<BibleBookOut[]>([]);
  const [verses, setVerses] = useState<BibleVerseMulti[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [autoFocusVerse, setAutoFocusVerse] = useState<string | null>(null);
  // Which verses have their token-study block open. Per-verse so
  // multiple expansions can coexist; the user might want to compare
  // Greek across two verses. Tokens are fetched lazily on first
  // open.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [tokensOpen, _setTokensOpen] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);

  // --- Voice reader state -----------------------------------------------
  // One consolidated panel slides out from the toolbar with Play/Pause
  // /Stop and a "Start from" segment selector. Reads the current chapter
  // verse-by-verse, advancing automatically, and (when reaching the end
  // of a chapter while still playing) loads the next chapter so a "Book
  // start" session can flow through multiple chapters until paused.
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voicePaused, setVoicePaused] = useState(false);
  const [voiceStartFrom, setVoiceStartFrom] = useState<
    "current" | "chapter" | "book"
  >("current");
  const [voiceCurrentVerseId, setVoiceCurrentVerseId] = useState<string | null>(
    null,
  );
  // Voice diagnostic state moved to Settings → Advanced page; this
  // file only DISPATCHES the diag events (via tts.ts) and a
  // session-start event below so Settings can label the run.
  const voiceHandleRef = useRef<{ stop: () => void } | null>(null);
  // Root of the Bible view — used to attach a native `selectstart`
  // killer so iOS Safari's magnifier + word-callout never engage on
  // this tab. React doesn't expose `onSelectStart` as a typed prop.
  const bibleRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bibleRootRef.current;
    if (!el) return;
    const block = (e: Event) => {
      const t = e.target as HTMLElement | null;
      // Allow text selection inside form fields so search input etc.
      // keeps working. Everything else: no selection.
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
    };
    el.addEventListener("selectstart", block);
    return () => el.removeEventListener("selectstart", block);
  }, []);
  // When true, the next chapter's verses should auto-trigger a fresh
  // reader session starting at verse 1. Cleared once consumed.
  const voiceContinueRef = useRef<boolean>(false);
  // Persistent resume position — {book, chapter, verseId} of wherever
  // the reader last was. Saved continuously as the reader advances so
  // pause / navigation / tab-reload all preserve the exact point. Lives
  // in localStorage so it survives page reload too. Cleared on natural
  // end-of-sequence and on explicit stop.
  const VOICE_RESUME_KEY = "bible-iu:voice-resume";
  const voiceResumeRef = useRef<{
    book: string;
    chapter: number;
    verseId: string;
  } | null>(null);
  // Hydrate on first mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(VOICE_RESUME_KEY);
      if (raw) voiceResumeRef.current = JSON.parse(raw);
    } catch {
      // best-effort; corrupt storage is fine to ignore
    }
  }, []);
  function _saveVoiceResume(verseId: string) {
    voiceResumeRef.current = { book, chapter, verseId };
    try {
      window.localStorage.setItem(
        VOICE_RESUME_KEY,
        JSON.stringify(voiceResumeRef.current),
      );
    } catch {
      // localStorage may be disabled (Safari private mode); we still
      // have the ref for the in-session resume path.
    }
  }
  function _clearVoiceResume() {
    voiceResumeRef.current = null;
    try {
      window.localStorage.removeItem(VOICE_RESUME_KEY);
    } catch {
      // ignore
    }
  }
  // Pending cross-chapter resume — set when the user taps play while
  // the saved position is in a different chapter/book. The
  // verses-changed effect picks it up once the new chapter loads.
  const voicePendingResumeRef = useRef<{
    book: string;
    chapter: number;
    verseId: string;
  } | null>(null);

  function _buildSequenceFromVerses(
    list: typeof verses,
    startIdx: number,
  ): { items: { id: string; text: string }[]; startIndex: number } {
    const items = list.map((v) => ({
      id: v.verse_id,
      text: v.translations[0]?.text || "",
    }));
    return { items, startIndex: Math.max(0, Math.min(startIdx, items.length - 1)) };
  }

  // Window-event bridge: the voice-reader UI now lives in Workspace's
  // breadcrumb bar (next to "zoom out"). BibleView still owns the
  // verses + navigation, so it stays as the source of truth and the
  // breadcrumb talks to it through these events.
  useEffect(() => {
    const onPlay = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { startFrom?: "current" | "chapter" | "book" }
        | undefined;
      if (detail?.startFrom) setVoiceStartFrom(detail.startFrom);
      // Defer one tick so the setVoiceStartFrom flushes before we
      // read it back inside startVoiceReader.
      window.setTimeout(() => startVoiceReader(), 0);
    };
    const onPause = () => pauseVoiceReader();
    const onResume = () => resumeVoiceReader();
    const onStop = () => stopVoiceReader();
    window.addEventListener("bible:voice-play", onPlay);
    window.addEventListener("bible:voice-pause", onPause);
    window.addEventListener("bible:voice-resume", onResume);
    window.addEventListener("bible:voice-stop", onStop);
    return () => {
      window.removeEventListener("bible:voice-play", onPlay);
      window.removeEventListener("bible:voice-pause", onPause);
      window.removeEventListener("bible:voice-resume", onResume);
      window.removeEventListener("bible:voice-stop", onStop);
    };
  }, [verses, book, chapter, focus, voiceStartFrom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push the reader's state out so the breadcrumb's dropdown can
  // reflect playing/paused state in its label and disabled controls.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("bible:voice-state", {
        detail: {
          playing: voicePlaying,
          paused: voicePaused,
          currentVerseId: voiceCurrentVerseId,
          startFrom: voiceStartFrom,
        },
      }),
    );
  }, [voicePlaying, voicePaused, voiceCurrentVerseId, voiceStartFrom]);

  function startVoiceReader() {
    // CRITICAL for iOS Safari: arm the AudioContext synchronously
    // inside the tap handler. We rely on BufferSource for chained
    // playback (HTMLAudio gets killed at natural silences mid-verse,
    // e.g. the colon in "righteous: but ..."). BufferSource only
    // works if the AudioContext is `running` before .start() is
    // called, and resume() must run inside a user gesture on iOS.
    armAudioSession();
    // Saved-position resume takes priority over every start-from mode
    // so the user's pause/resume gesture is honored exactly — even
    // across chapter or book boundaries (and across page reloads,
    // since the position lives in localStorage).
    const saved = voiceResumeRef.current;
    if (saved) {
      if (saved.book === book && saved.chapter === chapter) {
        // Same chapter as currently displayed — resume immediately.
        const idx = verses.findIndex((v) => v.verse_id === saved.verseId);
        if (idx >= 0) {
          const { items, startIndex } = _buildSequenceFromVerses(verses, idx);
          voiceHandleRef.current?.stop();
          window.dispatchEvent(
            new CustomEvent("voice:session-start", {
              detail: { startVerseId: items[startIndex]?.id ?? null },
            }),
          );
          const handle = speakSequence(items, {
            startIndex,
            onAdvance: (_i, item) => {
              setVoiceCurrentVerseId(item.id);
              _saveVoiceResume(item.id);
            },
            onEnd: () => {
              // Always continue across chapter boundaries. iOS users
              // expect the reader to flow like an audiobook — stopping
              // at chapter end forced them to tap Play repeatedly.
              // When we reach the last chapter of the last book we
              // genuinely run out; the inner branch handles that.
              if (chapter < chapterCount) {
                voiceContinueRef.current = true;
                onPickChapter(chapter + 1);
              } else {
                _clearVoiceResume();
                setVoicePlaying(false);
                setVoicePaused(false);
                setVoiceCurrentVerseId(null);
              }
            },
          });
          if (handle) {
            voiceHandleRef.current = handle;
            setVoicePlaying(true);
            setVoicePaused(false);
          }
          return;
        }
        // Saved verse_id no longer exists in this chapter — fall
        // through.
      } else {
        // Saved position is in a DIFFERENT chapter/book. Navigate
        // there and queue the resume; the verses-changed effect
        // below will pick it up when the new chapter loads.
        voicePendingResumeRef.current = saved;
        if (saved.book !== book) onPickBook(saved.book);
        if (saved.chapter !== chapter) onPickChapter(saved.chapter);
        setVoicePlaying(true);
        setVoicePaused(false);
        return;
      }
    }
    if (verses.length === 0) return;
    // No saved position — fall back to start-from mode.
    let startIdx = 0;
    if (voiceStartFrom === "current") {
      if (focus?.book === book && focus?.chapter === chapter) {
        const idx = verses.findIndex((v) => v.verse_id === focus.ref);
        if (idx >= 0) startIdx = idx;
      }
    } else if (voiceStartFrom === "book" && chapter !== 1) {
      // Book start: navigate to chapter 1 and queue an auto-resume.
      voiceContinueRef.current = true;
      onPickChapter(1);
      setVoicePlaying(true);
      setVoicePaused(false);
      return;
    }
    const { items, startIndex } = _buildSequenceFromVerses(verses, startIdx);
    if (items.length === 0) return;
    voiceHandleRef.current?.stop();
    window.dispatchEvent(
      new CustomEvent("voice:session-start", {
        detail: { startVerseId: items[startIndex]?.id ?? null },
      }),
    );
    const handle = speakSequence(items, {
      startIndex,
      onAdvance: (_i, item) => {
        setVoiceCurrentVerseId(item.id);
        _saveVoiceResume(item.id);
      },
      onEnd: () => {
        // Always continue across chapter boundaries — voice reader
        // should flow like an audiobook regardless of start-from mode.
        // Last chapter of the last book is the only natural stop.
        if (chapter < chapterCount) {
          voiceContinueRef.current = true;
          onPickChapter(chapter + 1);
          // Leave voicePlaying = true so the chapter-change effect
          // restarts us when the new verses arrive.
        } else {
          _clearVoiceResume();
          setVoicePlaying(false);
          setVoicePaused(false);
          setVoiceCurrentVerseId(null);
        }
      },
    });
    if (!handle) return;
    voiceHandleRef.current = handle;
    setVoicePlaying(true);
    setVoicePaused(false);
  }

  function pauseVoiceReader() {
    // iOS Safari's `speechSynthesis.pause()` is unreliable — it'll
    // hang the synth and never resume on some versions. So pause =
    // stop sequence; the resume position is already saved continuously
    // via _saveVoiceResume() on every advance, so resume() works
    // regardless of current chapter/book/page-reload.
    voiceHandleRef.current?.stop();
    voiceHandleRef.current = null;
    voiceContinueRef.current = false;
    setVoicePlaying(false);
    setVoicePaused(false);
  }
  function resumeVoiceReader() {
    // Legacy alias — breadcrumb dispatches voice-play directly now.
    startVoiceReader();
  }
  function stopVoiceReader() {
    voiceHandleRef.current?.stop();
    voiceHandleRef.current = null;
    voiceContinueRef.current = false;
    voicePendingResumeRef.current = null;
    _clearVoiceResume();
    setVoicePlaying(false);
    setVoicePaused(false);
    setVoiceCurrentVerseId(null);
  }

  // Verses-changed effect — handles both:
  //  (a) Multi-chapter continuation in "Book start" mode (voiceContinueRef)
  //  (b) Cross-chapter RESUME after pause+navigate (voicePendingResumeRef)
  // In both cases we want to start a fresh sequence in the just-loaded
  // chapter, starting at the appropriate verse, with the same advance
  // /end handlers as a normal start.
  useEffect(() => {
    if (verses.length === 0) return;
    let startIdx: number | null = null;
    const pending = voicePendingResumeRef.current;
    if (pending && pending.book === book && pending.chapter === chapter) {
      // Resume target landed in this chapter — start at the saved verse.
      const idx = verses.findIndex((v) => v.verse_id === pending.verseId);
      startIdx = idx >= 0 ? idx : 0;
      voicePendingResumeRef.current = null;
    } else if (voiceContinueRef.current) {
      // Book-start continuation — fresh chapter, start at verse 1.
      startIdx = 0;
      voiceContinueRef.current = false;
    } else {
      return;
    }
    const { items, startIndex } = _buildSequenceFromVerses(verses, startIdx);
    voiceHandleRef.current?.stop();
    // Chapter bridge: don't fire `voice:session-start` (that would
    // reset the diag log in Settings). The log continuation across
    // chapters is the whole reason to leave it alone here.
    const handle = speakSequence(items, {
      startIndex,
      onAdvance: (_i, item) => {
        setVoiceCurrentVerseId(item.id);
        _saveVoiceResume(item.id);
      },
      onEnd: () => {
        // Continue across chapter boundaries on every start mode.
        // Stops naturally at the last chapter of the current book.
        if (chapter < chapterCount) {
          voiceContinueRef.current = true;
          onPickChapter(chapter + 1);
        } else {
          _clearVoiceResume();
          setVoicePlaying(false);
          setVoicePaused(false);
          setVoiceCurrentVerseId(null);
        }
      },
    });
    if (handle) {
      voiceHandleRef.current = handle;
      setVoicePlaying(true);
      setVoicePaused(false);
    }
  }, [verses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop the reader when the BibleView unmounts so cancelled speech
  // doesn't keep going while the user is on another tab.
  useEffect(() => {
    return () => {
      voiceHandleRef.current?.stop();
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // best-effort
      }
    };
  }, []);
  // Listen for the global `bible:search` event so the shell header's
  // search button can open this sheet without threading a prop through
  // Workspace. Pattern matches SW_UPDATE_EVENT / SETTINGS_CHANGED.
  useEffect(() => {
    const onOpen = () => setSearchOpen(true);
    window.addEventListener("bible:search", onOpen);
    return () => window.removeEventListener("bible:search", onOpen);
  }, []);

  // Deferred-jump state for search results: a search hit can land on a
  // different book/chapter than the one currently displayed, so calling
  // `onClickVerse(hit.verse)` immediately would read the parent's STALE
  // closure of `book`/`chapter` and focus the wrong verse. Instead we
  // park the target verse here, kick off the book + chapter setters,
  // and wait until the parent re-renders BibleView with the new book +
  // chapter (which simultaneously refreshes its `onClickVerse` closure
  // to reference the new ones) — then fire the click.
  const [pendingVerseJump, setPendingVerseJump] = useState<number | null>(null);
  const pendingTargetRef = useRef<{ book: string; chapter: number } | null>(
    null,
  );
  useEffect(() => {
    if (pendingVerseJump == null || pendingTargetRef.current == null) return;
    const target = pendingTargetRef.current;
    if (book === target.book && chapter === target.chapter) {
      onClickVerse(pendingVerseJump);
      setPendingVerseJump(null);
      pendingTargetRef.current = null;
    }
  }, [book, chapter, pendingVerseJump, onClickVerse]);
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
    // Honor the user's `defaultTranslation` Settings choice via the
    // `translation` prop. Fall back to KJV if the prop is empty or
    // doesn't match a seeded translation name (the multi endpoint
    // 404s on unknowns).
    const primary = translation || "King James Version";
    const wanted = showOriginal
      ? [primary, originalForBook(book), "Arabic (SVD)"]
      : [primary];
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
  }, [book, chapter, showOriginal, translation]);

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
    // Reuse the touchstart on the scroller to also reset the bounce
    // tracker (each new gesture is one potential bounce attempt).
    bounceGestureRef.current = { startY: t.clientY, overscrolled: false };
  };
  const onChapterSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    // Bounce tracking. A "bounce" is a gesture that pushed the scroller
    // against its bottom limit and tried to drag further (finger moved
    // upward enough while the scroller was already at scrollHeight).
    // The first such gesture is noted; a second one within 1.5s
    // hides the floating tab panel + AI pill so the user can read
    // the closing verses cleanly. Single bounces, or bounces spaced
    // far apart, are ignored.
    const g = bounceGestureRef.current;
    bounceGestureRef.current = null;
    if (g?.overscrolled) {
      const now = Date.now();
      if (now - lastBounceAtRef.current < 1500) {
        window.dispatchEvent(new CustomEvent("bible:panel-hide"));
        lastBounceAtRef.current = 0;
      } else {
        lastBounceAtRef.current = now;
      }
    }
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
  // Bounce detection state. Tracked across a touch gesture and
  // between consecutive gestures.
  const bounceGestureRef = useRef<{
    startY: number;
    overscrolled: boolean;
  } | null>(null);
  const lastBounceAtRef = useRef<number>(0);
  const scrollerElRef = useRef<HTMLDivElement | null>(null);
  // Per-touch-move: if the scroller is at max scrollTop AND the finger
  // is dragging upward (trying to scroll past the end), mark the
  // current gesture as an overscroll.
  const onScrollerTouchMove = (e: React.TouchEvent) => {
    const g = bounceGestureRef.current;
    if (!g) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - g.startY;
    const el = scrollerElRef.current;
    if (!el) return;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (atBottom && dy < -30) g.overscrolled = true;
  };
  // Scroll handler — when the user moves AWAY from the bottom, surface
  // the panel + pill again and reset the bounce counter so the user
  // can re-arm the hide later.
  const onScrollerScroll = () => {
    const el = scrollerElRef.current;
    if (!el) return;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (!atBottom) {
      lastBounceAtRef.current = 0;
      window.dispatchEvent(new CustomEvent("bible:panel-show"));
    }
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
    {/* Scoped no-select. iOS Safari fires the selection magnifier
     *  + callout off any descendant that doesn't itself opt out,
     *  so we cover the whole tree from the root and explicitly
     *  re-enable text selection on form inputs only. */}
    <style>{`
      .bible-no-select, .bible-no-select * {
        -webkit-user-select: none !important;
        user-select: none !important;
        -webkit-touch-callout: none !important;
        -webkit-tap-highlight-color: transparent !important;
      }
      .bible-no-select input,
      .bible-no-select textarea,
      .bible-no-select [contenteditable="true"],
      .bible-no-select [contenteditable=""] {
        -webkit-user-select: text !important;
        user-select: text !important;
        -webkit-touch-callout: default !important;
      }
    `}</style>
    <div
      ref={bibleRootRef}
      className="bible-no-select flex h-full flex-col bg-paper dark:bg-neutral-900"
      onContextMenu={(e) => e.preventDefault()}
    >
      {!hideToolbar && (
      <div className="flex flex-nowrap items-center gap-2 overflow-x-auto border-b border-neutral-200 px-3 py-2 text-xs [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden dark:border-neutral-800">
        <select
          value={book}
          onChange={(e) => {
            onPickBook(e.target.value);
            onPickChapter(1);
          }}
          className="shrink-0 rounded-full border border-neutral-200 bg-paper px-2.5 py-1.5 font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.5)] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
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
          className="shrink-0 rounded-full border border-neutral-200 bg-paper px-2.5 py-1.5 font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.5)] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
        >
          {Array.from({ length: chapterCount }, (_, i) => i + 1).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <select
          value={translation}
          onChange={(e) => onPickTranslation(e.target.value)}
          className="shrink-0 rounded-full border border-neutral-200 bg-paper px-2.5 py-1.5 font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.5)] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          title="Public-domain + freely-licensed English translations. Paid translations (ESV/NIV/NASB) require separate licensing and aren't wired."
        >
          <optgroup label="Modern English">
            <option value="Berean Standard Bible">BSB (modern, free)</option>
            <option value="World English Bible">WEB (modern, public domain)</option>
            <option value="New English Translation">NET (scholarly, free)</option>
          </optgroup>
          <optgroup label="Classic English">
            <option value="King James Version">KJV (1611)</option>
            <option value="Geneva Bible (1599)">Geneva (1599)</option>
            <option value="Douay-Rheims Bible">Douay-Rheims (Catholic)</option>
          </optgroup>
          <optgroup label="Literal / Study">
            <option value="Young's Literal Translation">YLT (literal, 1898)</option>
          </optgroup>
        </select>
        {loading && (
          <span className="text-neutral-400 dark:text-neutral-500">
            loading…
          </span>
        )}
      </div>
      )}
      <BibleSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        translation={translation || "King James Version"}
        onJump={(hit) => {
          setSearchOpen(false);
          // If the hit is in the chapter already open, the focus path
          // through onClickVerse is safe — current `book`/`chapter` ARE
          // the target's. Otherwise stash the verse + target and let
          // the effect fire it once the parent's onClickVerse closure
          // has been refreshed with the new chapter.
          if (hit.book === book && hit.chapter === chapter) {
            onClickVerse(hit.verse);
            return;
          }
          pendingTargetRef.current = { book: hit.book, chapter: hit.chapter };
          setPendingVerseJump(hit.verse);
          onPickBook(hit.book);
          onPickChapter(hit.chapter);
        }}
      />

      {/* Voice diagnostic moved to Settings → Advanced. Subscribes to
       *  the global `tts:diag` event stream from there. */}

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
        ref={scrollerElRef}
        onTouchStart={onChapterSwipeStart}
        onTouchMove={onScrollerTouchMove}
        onTouchEnd={onChapterSwipeEnd}
        onScroll={onScrollerScroll}
        onPointerUp={onScrollerDoubleTapDismiss}
        className="flex-1 overflow-y-auto overflow-x-hidden pl-1 pr-3 py-4"
        // Mirror ChatPanel + the notes list: when the floating glass
        // composer + 64px AI pill sit on top of this scroller, lift
        // the last verse above them so reading isn't cut off.
        style={{
          // Kill iOS Safari's text-selection magnifier + the long-press
          // word-selection popup across the entire Bible scroller. The
          // standalone AI pill on this tab uses its own long-press
          // gesture to slide-trigger search / agent, and Safari's
          // selection UI was hijacking the gesture (showing the
          // magnifier the moment the user paused). Each verse text
          // span already had its own no-select inline; lifting it to
          // the scroller covers the gutters, banners, and bookmark
          // dividers too.
          WebkitTouchCallout: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
          ...(bottomInset
            ? {
                // Move the scroller's bottom EDGE above the floating
                // nav instead of just padding the scrolled content.
                // Original Apple-Liquid-Glass design intent was for
                // text to scroll behind the bar, but reading-while-
                // scrolling that way leaves the bottom visible verse
                // always tucked under the nav, which is unreadable.
                // marginBottom shrinks the flex-1 scroll region so
                // its bottom edge sits above the nav at every scroll
                // position; paddingBottom adds a comfortable empty
                // tail at the end of the chapter so reaching verse
                // N feels finished rather than abrupt.
                marginBottom: "calc(env(safe-area-inset-bottom, 0px) + 130px)",
                paddingBottom: "80px",
              }
            : {}),
        }}
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
            groupPalette={scopePillPalette}
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
                  <div className="flex items-start gap-2">
                  {/* Verse-row icon column — vertically stacked, sits
                   *  OUTSIDE the verse text frame to the left. Holds:
                   *    - the verse number (tappable focus/select)
                   *    - the original-languages toggle (אα)
                   *    - the bookmark ribbon
                   *    - the notes-count chip (when notes exist)
                   *  Width is fixed at ~36px so the right-hand verse
                   *  text wraps cleanly without being shifted around. */}
                  <div className="flex w-9 shrink-0 flex-col items-center gap-1 pt-0.5">
                    <button
                      onPointerUp={(e) => {
                        if (e.button !== 0 && e.pointerType === "mouse") return;
                        const isDouble = handleVerseTap(v.verse_id);
                        if (!isDouble) onClickVerse(v.verse);
                      }}
                      className={`inline-flex h-5 min-w-[1.4rem] touch-manipulation items-center justify-center rounded text-[11px] font-semibold ${
                        focus?.verse === v.verse &&
                        focus?.ref?.startsWith(`${book}.${chapter}.`)
                          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                          : "bg-scripture text-neutral-700 hover:bg-yellow-100 dark:bg-scripture-dark dark:text-amber-100 dark:hover:bg-amber-900"
                      }`}
                      title={`Tap to focus · double-tap to add a note (${v.verse_id})`}
                    >
                      {v.verse}
                    </button>
                    {/* Per-verse original-language toggle hidden by
                     *  user request. Hebrew/Greek study is still
                     *  reachable via the global "show original" toggle
                     *  in the breadcrumb. The state hook + render
                     *  branch below stay wired so re-enabling later is
                     *  one un-comment. */}
                    {onSetBookmark && (
                      <button
                        onClick={() =>
                          handleRibbonTap(chapter, v.verse, !!bookmarkHere)
                        }
                        className={`inline-flex h-5 w-5 touch-manipulation items-center justify-center align-middle transition ${
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
                  </div>
                  {/* Verse content column — receives all the wrapping
                   *  text so the icon column above never gets pushed
                   *  around by long verses. `min-w-0` is required for
                   *  flex children that contain text — without it the
                   *  content can blow past the parent's width. */}
                  <div className="min-w-0 flex-1">
                    <p className="leading-relaxed">
                      {/* Notes-count chip — inline with the verse text,
                       *  per user request. The other icons (verse num,
                       *  אα, bookmark) stay in the vertical column to
                       *  the left; only this one lives inline. */}
                      {verseNotes.length > 0 && (
                        <button
                          onPointerUp={(e) => {
                            if (e.button !== 0 && e.pointerType === "mouse")
                              return;
                            const isDouble = handleVerseTap(v.verse_id);
                            if (!isDouble) toggleExpand(v.verse_id);
                          }}
                          className={`mr-2 inline-flex h-5 touch-manipulation items-center gap-1 rounded border px-1.5 text-[10px] font-medium align-middle ${
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
                          className="rounded-xl border border-neutral-200 bg-paper-soft px-3 py-2 text-[15px] text-neutral-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-800 dark:bg-neutral-950/50 dark:text-neutral-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
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
                            {tr.direction === "ltr"
                              ? renderDivergenceHighlighted(
                                  v.translations[0].text,
                                  tr.text,
                                )
                              : tr.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  </div>
                  </div>
                  {/* Notes panel — sibling of the icon/text flex row
                   *  so it spans the FULL width of the verse, including
                   *  across the icon column on the left. */}
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
                      groupPalette={scopePillPalette}
                    />
                  )}
                  {tokensOpen.has(v.verse_id) && (
                    <TokenStudyBlock
                      book={book}
                      chapter={chapter}
                      verse={v.verse}
                      verseId={v.verse_id}
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
 * Bible search sheet. Opens from the magnifier button in the Bible
 * toolbar; debounced query against `/bible/search`. Each hit
 * links back to the verse via `onJump`. Currently scoped to the
 * single primary translation the reader is on — multi-translation
 * search is a future addition once we ship more public-domain
 * translations.
 */
function BibleSearchSheet({
  open,
  onClose,
  translation,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  translation: string;
  onJump: (hit: BibleSearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BibleSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Advanced (AI) search state — populated only when the user
  // explicitly taps "Find for me." Backed by /bible/advanced_search,
  // which routes through the DeepSeek generator with a paraphrase-
  // matching prompt and verifies each suggestion against the DB.
  const [aiHits, setAiHits] = useState<AdvancedSearchHit[] | null>(null);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);

  // Smart-match: parse the query as a Bible reference ("John 3:16",
  // "Gen 1:1-3", "Psa 23"). When it matches, surface a prominent
  // "Jump to..." tile at the top of the popup. Falls back silently
  // to null on free-text queries.
  const parsedRef: ParsedReference | null = parseReference(query);

  // Typeahead suggestions: when the user hasn't yet entered a chapter,
  // show every book whose name starts with what they've typed. "Jo"
  // → John, Joel, Jonah, Job, Joshua (canon order, max 6). Empty
  // when the query already contains a digit (full reference incoming)
  // or when the user has clearly moved on from a book-only query.
  const showSuggestions =
    query.trim().length >= 1 && (parsedRef == null || parsedRef.verse == null);
  const suggestions = showSuggestions
    ? suggestReferences(query, 6).filter(
        // Don't show a suggestion that equals the parsed reference
        // (would be a duplicate of the Jump tile).
        (s) => !(parsedRef && s.osis === parsedRef.book),
      )
    : [];

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(null);
      setErr(null);
      setAiHits(null);
      setAiErr(null);
    }
  }, [open]);

  // Drop stale AI suggestions whenever the query mutates — they refer
  // to the previous fragment, not the current one.
  useEffect(() => {
    setAiHits(null);
    setAiErr(null);
  }, [query]);

  async function runAdvancedSearch() {
    const q = query.trim();
    if (q.length < 3) return;
    setAiSearching(true);
    setAiErr(null);
    setAiHits(null);
    try {
      const hits = await api.bibleAdvancedSearch(q, translation);
      setAiHits(hits);
    } catch (e) {
      setAiErr((e as Error).message);
    } finally {
      setAiSearching(false);
    }
  }

  /** Construct a synthetic BibleSearchHit for a parsed reference so
   *  the existing `onJump` codepath (with the deferred-jump fix in
   *  BibleView) can navigate. The hit's `text` is empty because we
   *  haven't fetched the verse yet — onJump only needs book/chapter
   *  /verse. */
  function jumpToRef(r: ParsedReference) {
    onJump({
      verse_id: `${r.book}.${r.chapter}.${r.verse ?? 1}`,
      book: r.book,
      chapter: r.chapter,
      verse: r.verse ?? 1,
      text: "",
      translation,
    });
  }

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    let alive = true;
    setSearching(true);
    setErr(null);
    const timer = window.setTimeout(() => {
      api
        .bibleSearch(q, translation, 50)
        .then((hits) => {
          if (alive) setResults(hits);
        })
        .catch((e) => alive && setErr((e as Error).message))
        .finally(() => alive && setSearching(false));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, open, translation]);

  function renderText(text: string, q: string): React.ReactNode {
    const tokens = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return text;
    // Build one regex that matches any token (escape for safety).
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(${escaped.join("|")})`, "gi");
    const parts = text.split(re);
    return parts.map((p, i) =>
      re.test(p) ? (
        <mark
          key={i}
          className="rounded bg-amber-200 px-0.5 text-neutral-900 dark:bg-amber-700/60 dark:text-amber-50"
        >
          {p}
        </mark>
      ) : (
        <span key={i}>{p}</span>
      ),
    );
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Search the Bible"
      desktopMaxWidth="2xl"
      // Half-screen on first open; drag the handle up to grow to
      // near-full, drag down past the half-mark to dismiss. User can
      // pick the height instead of getting auto-expanded.
      snapPoints={[0.5, 0.92]}
      initialSnap={0}
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Verse text, "exact phrase", or reference (John 3:16)'
          aria-label="Search verses"
          className="w-full rounded-full border border-neutral-200 bg-paper px-4 py-2.5 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          onKeyDown={(e) => {
            // Enter on a parsed reference = jump immediately. Saves a tap
            // for power users who type a full reference and hit return.
            if (e.key === "Enter" && parsedRef) {
              e.preventDefault();
              jumpToRef(parsedRef);
            }
          }}
        />
        {/* Smart-match jump tile — parsed reference detected. Appears
         *  ABOVE everything else so the user can land on the verse
         *  without scrolling through text matches. */}
        {parsedRef && (
          <button
            type="button"
            onClick={() => jumpToRef(parsedRef)}
            className="flex w-full items-center justify-between gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-left shadow-[0_2px_6px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.5)] transition hover:bg-amber-100 active:scale-[0.99] dark:border-amber-700 dark:bg-amber-900/40 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-amber-900/60"
          >
            <span className="flex flex-col items-start">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Jump to
              </span>
              <span className="text-[15px] font-semibold text-amber-900 dark:text-amber-100">
                {formatReference(parsedRef)}
              </span>
            </span>
            <span className="text-amber-700 dark:text-amber-300" aria-hidden>
              <JumpIcon className="h-4 w-4" />
            </span>
          </button>
        )}
        {/* Typeahead book suggestions — shown only when the parser
         *  hasn't already locked on to a specific verse. Tapping a
         *  suggestion fills the query so the user can append a
         *  chapter / verse, or tap the resulting Jump tile. */}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s.osis}
                type="button"
                onClick={() => setQuery(`${s.display} `)}
                className="rounded-full border border-neutral-200 bg-paper px-3 py-1 text-[12px] font-medium text-neutral-700 shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.5)] transition hover:bg-paper-soft active:scale-[0.97] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:shadow-[0_1px_2px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-neutral-700"
              >
                {s.display}
              </button>
            ))}
          </div>
        )}
        <p className="px-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          Translation: {translation}. Type a reference ("John 3:16"),
          a phrase in quotes, or any words to match across verses.
        </p>
        {/* Advanced (AI) search — for fragments, paraphrases, typos.
         *  Positioned ABOVE the regular results so it stays visible
         *  the moment the user has typed enough. The agent guesses
         *  references; backend verifies each against the DB before
         *  they reach the UI (no fabricated scripture). */}
        {query.trim().length >= 3 && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={runAdvancedSearch}
              disabled={aiSearching}
              className="inline-flex items-center gap-1.5 self-start rounded-full border border-violet-300 bg-violet-50 px-3 py-1.5 text-[12px] font-semibold text-violet-900 shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.5)] transition hover:bg-violet-100 active:scale-[0.97] disabled:opacity-60 dark:border-violet-700 dark:bg-violet-900/40 dark:text-violet-100 dark:shadow-[0_1px_2px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-violet-900/60"
            >
              {aiSearching ? (
                "Asking the agent…"
              ) : (
                <>
                  <MagicIcon className="h-4 w-4" />
                  Use Agent
                </>
              )}
            </button>
            {aiErr && (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                {aiErr}
              </p>
            )}
            {aiHits && aiHits.length === 0 && !aiSearching && (
              <p className="px-1 text-[12px] text-neutral-500 dark:text-neutral-400">
                The agent couldn't pin down a verse from that fragment.
                Try a few more words or a key phrase.
              </p>
            )}
            {aiHits && aiHits.length > 0 && (
              <ul className="space-y-1.5">
                {aiHits.map((h) => {
                  const bookName = OSIS_TO_BOOK_NAME[h.book] ?? h.book;
                  const confTone =
                    h.confidence === "high"
                      ? "border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-900/40"
                      : h.confidence === "low"
                        ? "border-neutral-200 bg-paper-soft dark:border-neutral-700 dark:bg-neutral-800"
                        : "border-violet-200 bg-violet-50/70 dark:border-violet-800 dark:bg-violet-900/25";
                  return (
                    <li key={`ai-${h.verse_id}`}>
                      <button
                        type="button"
                        onClick={() => onJump(h)}
                        className={`flex w-full flex-col items-start gap-1 rounded-2xl border px-3 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.5)] transition active:scale-[0.99] dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)] ${confTone}`}
                      >
                        <div className="flex w-full items-center gap-1.5">
                          <span className="rounded-full bg-violet-200/70 px-1.5 text-[9px] font-bold uppercase tracking-wide text-violet-900 dark:bg-violet-700/60 dark:text-violet-50">
                            AI · {h.confidence}
                          </span>
                          <span className="text-[12px] font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
                            {bookName} {h.chapter}:{h.verse}
                          </span>
                        </div>
                        <div className="text-[14px] text-neutral-800 dark:text-neutral-100">
                          {h.text}
                        </div>
                        {h.rationale && (
                          <div className="text-[11px] italic text-neutral-500 dark:text-neutral-400">
                            {h.rationale}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {err && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {err}
          </p>
        )}
        {searching && (
          <p className="px-1 text-[12px] text-neutral-500 dark:text-neutral-400">
            Searching…
          </p>
        )}
        {!searching &&
          results !== null &&
          results.length === 0 &&
          query.trim().length >= 2 && (
            <p className="px-1 text-[12px] text-neutral-500 dark:text-neutral-400">
              No verses match "{query.trim()}".
            </p>
          )}
        {results && results.length > 0 && (
          <ul className="space-y-1.5">
            {results.map((h) => {
              const bookName = OSIS_TO_BOOK_NAME[h.book] ?? h.book;
              return (
                <li key={h.verse_id}>
                  <button
                    type="button"
                    onClick={() => onJump(h)}
                    className="flex w-full flex-col items-start gap-1 rounded-2xl border border-neutral-200 bg-paper px-3 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.5)] transition hover:bg-paper-soft active:scale-[0.99] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:bg-neutral-800"
                  >
                    <div className="text-[12px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      {bookName} {h.chapter}:{h.verse}
                    </div>
                    <div className="text-[14px] text-neutral-800 dark:text-neutral-100">
                      {renderText(h.text, query)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
}


/**
 * Per-word original-language study block for a verse.
 *
 * Renders the Hebrew/Greek tokens as tappable chips. Each chip shows
 * the surface form (the actual word in the verse); tapping it expands
 * to reveal the lemma, Strong's number, and morphology code so the
 * reader can study the word's underlying form without leaving the
 * verse. Data comes from `GET /bible/{book}/{ch}/{v}/tokens` which
 * is backed by OSHB (OT, CC-BY-4.0) and MorphGNT (NT, CC-BY-SA-3.0).
 *
 * Why a chip grid (and not inline annotation of the verse text):
 *   - Mobile-friendly tap targets — 44px each, no precision required.
 *   - Works the same way for LTR Greek + RTL Hebrew without bidi gymnastics.
 *   - Compact: even Heb 1 verse worth of chips fits a single column.
 */
function TokenStudyBlock({
  book,
  chapter,
  verse,
  verseId,
}: {
  book: string;
  chapter: number;
  verse: number;
  verseId: string;
}) {
  const [tokens, setTokens] = useState<VerseTokenOut[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    setTokens(null);
    api
      .bibleVerseTokens(book, chapter, verse)
      .then((rows) => alive && setTokens(rows))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [book, chapter, verse]);

  return (
    <div
      className={`mb-3 ml-7 mt-1 p-2 text-sm ring-1 ring-amber-300/50 dark:ring-amber-600/30 ${GLASS_CARD_INLINE}`}
    >
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
        <span>Hebrew / Greek · {verseId}</span>
        {tokens && (
          <span className="font-mono text-neutral-500 dark:text-neutral-400">
            {tokens.length} words
          </span>
        )}
      </div>
      {err && (
        <p className="text-[11px] text-red-600 dark:text-red-300">
          Couldn't load: {err}
        </p>
      )}
      {!err && tokens === null && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Loading…
        </p>
      )}
      {tokens && tokens.length === 0 && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          No original-language data for this verse yet.
        </p>
      )}
      {tokens && tokens.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tokens.map((t, i) => {
            const open = activeIdx === i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setActiveIdx(open ? null : i)}
                className={`rounded-full px-2 py-1 text-[14px] transition ${
                  open
                    ? "bg-amber-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
                    : "border border-amber-200 bg-amber-50/70 text-neutral-900 hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-neutral-100 dark:hover:bg-amber-900/50"
                }`}
                title={
                  t.strongs
                    ? `${t.lemma} · ${t.strongs}${t.morphology ? " · " + t.morphology : ""}`
                    : t.lemma
                }
              >
                {t.surface_form}
              </button>
            );
          })}
        </div>
      )}
      {tokens && activeIdx != null && tokens[activeIdx] && (
        <div
          className={`mt-2 rounded-2xl p-2 text-[12px] ${GLASS_CARD_INLINE}`}
        >
          <div className="text-[16px] text-neutral-900 dark:text-neutral-50">
            <span className="font-semibold">{tokens[activeIdx].surface_form}</span>
            <span className="ml-2 text-neutral-500 dark:text-neutral-400">
              (lemma: {tokens[activeIdx].lemma})
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            {tokens[activeIdx].strongs && (
              <a
                href={`https://www.blueletterbible.org/lexicon/${tokens[activeIdx].strongs!.toLowerCase()}/kjv/tr/0-1/`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-amber-200 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-900 hover:bg-amber-300 dark:bg-amber-700/60 dark:text-amber-100 dark:hover:bg-amber-700"
                title="Open Blue Letter Bible lexicon entry in a new tab"
              >
                {tokens[activeIdx].strongs}
              </a>
            )}
            {tokens[activeIdx].morphology && (
              <span className="rounded-full border border-neutral-300 bg-paper px-2 py-0.5 font-mono text-[11px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-200">
                {tokens[activeIdx].morphology}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
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
  groupPalette,
}: {
  verseId: string;
  verseNotes: ReturnType<NotesApi["forVerse"]>;
  notes: NotesApi;
  autoFocus?: boolean;
  onAutoFocusHandled?: () => void;
  roomId?: string;
  selfUserId?: string;
  socialNotesEnabled?: boolean;
  groupPalette?: { bubble: string; bubbleFg: string };
}) {
  const [draft, setDraft] = useState("");
  // Single scope toggle drives BOTH the list filter AND the composer
  // scope, matching the Notes-page model. Seeded from the user's
  // global default in Settings → Group notes; flipping it here is
  // local to the panel and doesn't change the global default (the
  // top-bar toggle on the Notes tab is the canonical way to do that).
  const [scope, setScope] = useState<"personal" | "group">(() => {
    try {
      return readSettings().defaultNoteScope;
    } catch {
      return "personal";
    }
  });
  useEffect(() => {
    const refresh = () => {
      try {
        setScope(readSettings().defaultNoteScope);
      } catch {
        /* keep current */
      }
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(SETTINGS_CHANGED, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(SETTINGS_CHANGED, refresh);
    };
  }, []);
  // RichNoteField handles its own autofocus via the `autoFocus` prop;
  // we just need to clear the flag once we've handed it off.
  useEffect(() => {
    if (autoFocus) onAutoFocusHandled?.();
  }, [autoFocus, onAutoFocusHandled]);

  const filteredNotes = verseNotes.filter((n) => n.scope === scope);

  return (
    <div
      className={`mb-2 ml-7 mt-1 p-2 text-sm ring-1 ring-violet-300/50 dark:ring-violet-600/30 ${GLASS_CARD_INLINE}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-300">
          Notes on {verseId}
        </div>
        <ScopePill scope={scope} onChange={setScope} groupPalette={groupPalette} />
      </div>
      <ul className="space-y-1.5">
        {filteredNotes.length === 0 && (
          <li className="px-1 py-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            No {scope} notes on this verse yet.
          </li>
        )}
        {filteredNotes.map((n) => (
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
                {canDeleteNote(n, selfUserId) && (
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
                )}
              </div>
            </div>
            <RichNoteField
              value={n.body}
              onChange={(html) => notes.update(n.id, html)}
              ariaLabel={`Edit ${n.scope} note on ${verseId}`}
              compact
              roomId={roomId}
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
            scope,
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
            placeholder={`Add a ${scope} note on ${verseId}…`}
            ariaLabel={`New ${scope} note on ${verseId}`}
            autoFocus={!!autoFocus}
            roomId={roomId}
          />
        </div>
        <button
          type="submit"
          className="rounded-full bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Add
        </button>
      </form>
    </div>
  );
}


/** Small two-state pill, "Personal" ↔ "Group", used by the inline
 *  note panels under verses + chapter headings. Mirrors the Notes-tab
 *  top-bar toggle so the model is consistent: one scope toggle drives
 *  both filter and composer. Colors match the in-app note styling:
 *  violet for personal, amber for group. */
function ScopePill({
  scope,
  onChange,
  groupPalette,
}: {
  scope: "personal" | "group";
  onChange: (s: "personal" | "group") => void;
  /** Active room's accent. When present, the "group" side paints with
   *  the per-room theme color (same source the Notes-tab top-bar
   *  scope toggle uses). When absent, falls back to amber. */
  groupPalette?: { bubble: string; bubbleFg: string };
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Note scope"
      className={`flex items-stretch p-0.5 text-[10px] ${GLASS_CARD_INLINE}`}
    >
      {(["personal", "group"] as const).map((s) => {
        const on = scope === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s)}
            onKeyDown={(e) => {
              if (
                e.key === "ArrowRight" ||
                e.key === "ArrowDown" ||
                e.key === "ArrowLeft" ||
                e.key === "ArrowUp"
              ) {
                e.preventDefault();
                onChange(s === "personal" ? "group" : "personal");
              }
            }}
            style={
              on && s === "group" && groupPalette
                ? {
                    backgroundColor: groupPalette.bubble,
                    color: groupPalette.bubbleFg,
                  }
                : undefined
            }
            className={`min-w-[58px] rounded-full px-2 py-0.5 font-semibold capitalize transition ${
              on
                ? s === "personal"
                  ? "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-100"
                  : groupPalette
                    ? ""
                    : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            {s}
          </button>
        );
      })}
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
  groupPalette,
}: {
  book: string;
  chapter: number;
  chapterNotes: ReturnType<NotesApi["forChapter"]>;
  notes: NotesApi;
  roomId?: string;
  selfUserId?: string;
  socialNotesEnabled?: boolean;
  groupPalette?: { bubble: string; bubbleFg: string };
}) {
  const anchor = `${book}.${chapter}`;
  const [draft, setDraft] = useState("");
  // Same scope-driven view + composer model as InlineNotePanel. Seeded
  // from Settings → Group notes default; flipping it here is local.
  const [scope, setScope] = useState<"personal" | "group">(() => {
    try {
      return readSettings().defaultNoteScope;
    } catch {
      return "personal";
    }
  });
  useEffect(() => {
    const refresh = () => {
      try {
        setScope(readSettings().defaultNoteScope);
      } catch {
        /* keep current */
      }
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(SETTINGS_CHANGED, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(SETTINGS_CHANGED, refresh);
    };
  }, []);

  const filteredNotes = chapterNotes.filter((n) => n.scope === scope);

  return (
    <div
      className={`mb-3 p-2 text-sm ring-1 ring-violet-300/50 dark:ring-violet-600/30 ${GLASS_CARD_INLINE}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-300">
          Notes on {book} {chapter}
        </div>
        <ScopePill scope={scope} onChange={setScope} groupPalette={groupPalette} />
      </div>
      <ul className="space-y-1.5">
        {filteredNotes.length === 0 && (
          <li className="px-1 py-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            No {scope} notes on this chapter yet.
          </li>
        )}
        {filteredNotes.map((n) => (
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
                {canDeleteNote(n, selfUserId) && (
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
                )}
              </div>
            </div>
            <RichNoteField
              value={n.body}
              onChange={(html) => notes.update(n.id, html)}
              ariaLabel={`Edit ${n.scope} note on ${book} ${chapter}`}
              compact
              roomId={roomId}
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
            scope,
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
            placeholder={`Add a ${scope} note on ${book} ${chapter}…`}
            ariaLabel={`New ${scope} note on ${book} ${chapter}`}
            roomId={roomId}
          />
        </div>
        <button
          type="submit"
          className="rounded-full bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Add
        </button>
      </form>
    </div>
  );
}

/** Word-level translation-divergence highlighter (rule-guide.MD §2.2).
 *
 *  Given a primary verse text and an alternate translation, returns a
 *  React fragment of the alternate text where every word NOT present
 *  in the primary's vocabulary gets a subtle amber underline. Lets
 *  the reader spot meaningful divergence at a glance without forcing
 *  a separate "compare versions" UI.
 *
 *  Strategy is intentionally simple: lowercase + strip punctuation +
 *  set-difference at word level. Catches real lexical disagreements
 *  ("forsake" vs "abandon"; "abundance" vs "extra"; "perish" vs "be
 *  destroyed") while ignoring stylistic punctuation. Functional words
 *  ("the", "a", "and") are kept in the comparison too — if one
 *  translation drops a "the" the diff catches it, which is usually
 *  meaningful in scripture.
 *
 *  Not a sentence-level NLI — just word presence. For deeper
 *  divergence (paraphrastic differences) we'd need an entailment
 *  pass; that's tracked separately. */
function renderDivergenceHighlighted(
  primary: string,
  alternate: string,
): React.ReactNode {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,!?;:"()‘’“”]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const primaryWords = new Set(norm(primary));
  // Walk the alternate text preserving its original whitespace +
  // punctuation. Each whitespace-separated token gets a presence
  // check; if absent in the primary, wrap with the divergence span.
  const parts = alternate.split(/(\s+)/);
  return (
    <>
      {parts.map((tok, i) => {
        if (!tok.trim()) return <span key={i}>{tok}</span>;
        const cleaned = tok
          .toLowerCase()
          .replace(/[.,!?;:"()‘’“”]/g, "")
          .trim();
        const isDivergent =
          cleaned.length > 1 && !primaryWords.has(cleaned);
        if (!isDivergent) return <span key={i}>{tok}</span>;
        return (
          <span
            key={i}
            className="rounded-sm border-b-2 border-amber-400/80 px-0.5 dark:border-amber-500/80"
            title="Diverges from the primary translation"
          >
            {tok}
          </span>
        );
      })}
    </>
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
    <div className="relative mx-auto mb-3 max-w-md rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-center text-[12px] text-amber-900 shadow-sm backdrop-blur-md dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-100">
      {!justDone && (
        <button
          onClick={() => setHidden(true)}
          aria-label="Dismiss for now"
          title="Dismiss for now"
          className="absolute right-2 top-1.5 rounded-full px-1.5 text-amber-700/70 hover:bg-amber-100 dark:text-amber-200/70 dark:hover:bg-amber-800/40"
        >
          ×
        </button>
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-2">
        <span aria-hidden>{justDone ? "✓" : "📖"}</span>
        <span className="font-semibold">
          {justDone ? "Done!" : "Today's reading"}
        </span>
        <span className="text-amber-700/80 dark:text-amber-200/70">
          {plan.name} · Day {today.day_index}
        </span>
      </div>
      {!justDone && (
        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
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
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-60 ${
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
