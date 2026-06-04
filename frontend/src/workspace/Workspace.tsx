/**
 * The VS Code-style study workspace (CLAUDE.md §4.2–§4.10).
 *
 * One persistent shell, two scopes (room ↔ verse). The verse focus is
 * lifted to the shell so the persistent Notes sidebar (§4.6) stays
 * coherent across chat ↔ study. The breadcrumb (§4.2) shows the current
 * scope.
 *
 * Layout:
 *  - Desktop (md+): resources column + a vertical split (Bible / Reasoning).
 *  - Mobile: single column; resources slide in as an overlay.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { ResourcesPanel } from "./ResourcesPanel/ResourcesPanel";
import { BibleView } from "./BibleView/BibleView";
import { ReasoningStream } from "./ReasoningStream/ReasoningStream";
import { TestamentGrid } from "./TestamentGrid";
import { BibleOverview } from "./BibleOverview";
import { testamentOf, type Testament } from "../lib/testament";
import type { NotesApi } from "./NotesSidebar/notesStore";
import type {
  AnnotationColor,
  AnnotationKind,
  AnnotationOut,
  ReasoningResponse,
} from "../lib/api";
import { parseVerseRef, streamReason } from "../lib/api";
import { Grip } from "../lib/Grip";
import { useIsDesktop } from "../lib/useMediaQuery";
import { useYjsConversation } from "./yjsConversation";

export interface ConversationTurn {
  id: string;
  question: string;
  verse_ref: string;
  reasoning: string;
  /** Raw streamed chain-of-thought (debug view). Separate from
   *  `reasoning` so debug mode can keep showing it even after the engine
   *  replaces `reasoning` with the polished summary. */
  rawCot: string;
  /** Pipeline stage breadcrumbs with seconds-since-start. */
  stages: { name: string; count: number | null; t: number }[];
  response: ReasoningResponse | null;
  pending: boolean;
  error?: string;
}

interface Props {
  roomId: string;
  roomName: string;
  focus: VerseFocus | null;
  onFocusChange: (f: VerseFocus | null) => void;
  notes: NotesApi;
  focusMode: boolean;
  onToggleFocus: () => void;
  debugMode: boolean;
  /** When true, the reasoning websocket sends a flag to skip the
   *  citation engine and rule layer. User-toggled in Settings. */
  bypassCitationEngine?: boolean;
  /** Stub-auth handle (from `Login.tsx`). Scopes the conversation
   *  Y.Doc per user (`TODO(spec)` real auth — CLAUDE.md §4.11). */
  handle: string;
  /** Mobile-first single-panel mode. When set, the center column
   *  renders only the named panel at full height, hiding the other
   *  (and any toolbars). The PromptBar stays as a sticky footer.
   *  Owned by MobileShell's tab bar. */
  mobilePanel?: "bible" | "ask";
  /** Suppress the in-Workspace PromptBar so an external host (e.g.
   *  MobileShell's glass panel) can supply its own chat input and
   *  drive `ask()` via the exposed ref. */
  hidePrompt?: boolean;
  /** Caller-supplied bookmark state. When provided, BibleView renders
   *  a ribbon icon on each verse number; tap to set/remove for the
   *  current book (one per book max). */
  bookmarks?: {
    book: string;
    chapter: number;
    verse: number;
    updated_at?: string;
  }[];
  onSetBookmark?: (book: string, chapter: number, verse: number) => void;
  /** Double-tap on a filled ribbon → remove just that mark. The
   *  shell maps this to the same backend call the Marks "X" uses. */
  onRemoveBookmarkAt?: (book: string, chapter: number, verse: number) => void;
  /** Called when the user double-taps a divider. Caller decides
   *  whether to navigate up the stack or delete the topmost one. */
  onDoubleTapBookmark?: (book: string, chapter: number, verse: number) => void;
  /** User-picked IANA timezone for timestamps; "" = browser default. */
  timezone?: string;
  /** Stable user id (from /auth/me). Used by the inline note panel to
   *  show "delete your own comment" on group-note posts. */
  selfUserId?: string;
  /** Settings → "Social on group notes". When on, every inline group
   *  note (non-agent) gets a heart + flat comment thread under it. */
  socialNotesEnabled?: boolean;
  /** All of the user's verse annotations (highlight/underline/strike).
   *  Threaded through BibleView so the long-press toolbar can mark up
   *  scripture without round-tripping to a parent for state. */
  annotations?: AnnotationOut[];
  onApplyAnnotation?: (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
  ) => void;
  onClearAnnotationKind?: (verseId: string, kind: AnnotationKind) => void;
  onClearAnnotations?: (verseId: string) => void;
  /** Lifted from BibleView so the bottom panel can render the
   *  annotation tool strip when a verse is long-pressed. */
  annotationTarget?: { verseId: string; label?: string } | null;
  onAnnotationTargetChange?: (
    t: { verseId: string; label?: string } | null,
  ) => void;
}

export interface VerseFocus {
  book: string;
  chapter: number;
  verse: number;
  ref: string;
}

/** Imperative API exposed via ref so the floating glass panel in
 *  MobileShell can submit a question without owning the conversation
 *  state. The `pending` flag tracks any in-flight turn so the chat
 *  send button can disable itself. */
export interface WorkspaceHandle {
  ask: (question: string) => void;
  isPending: () => boolean;
}

export const Workspace = forwardRef<WorkspaceHandle, Props>(function Workspace(
  {
    roomId,
    roomName,
    focus,
    onFocusChange,
    notes,
    focusMode,
    onToggleFocus,
    debugMode,
    bypassCitationEngine = false,
    handle,
    mobilePanel,
    hidePrompt,
    bookmarks,
    onSetBookmark,
    onRemoveBookmarkAt,
    onDoubleTapBookmark,
    timezone,
    selfUserId,
    socialNotesEnabled,
    annotations,
    onApplyAnnotation,
    onClearAnnotationKind,
    onClearAnnotations,
    annotationTarget,
    onAnnotationTargetChange,
  },
  workspaceRef,
) {
  const isDesktop = useIsDesktop();
  const [book, setBook] = useState("GEN");
  const [chapter, setChapter] = useState(1);
  // Second-level zoom-out: when set, the Bible panel renders a grid of
  // every book in that testament instead of the current chapter. Off
  // (null) is the normal chapter view.
  const [testamentView, setTestamentView] = useState<Testament | null>(null);
  // Third-level zoom-out: shows the whole Bible (OT + NT cards) so the
  // user can pivot between testaments. Mutually exclusive with
  // testamentView — only one of them is non-null/true at a time.
  const [bibleView, setBibleView] = useState(false);

  // External focus changes (room scripture_context seed, citation
  // click from outside, etc.) should pull the Bible view to that
  // book/chapter. Guard to only fire when the focus diverges from
  // the current view, otherwise this triggers in a loop.
  useEffect(() => {
    if (!focus) return;
    if (focus.book === book && focus.chapter === chapter) return;
    setBook(focus.book);
    setChapter(focus.chapter);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const [translation, setTranslation] = useState("WEB");
  const [resourcesOpen, setResourcesOpen] = useState(true);
  // The Original-language toggle lives in the Reasoning header (per
  // earlier UX move) but its state drives the Bible display: when true,
  // verses are rendered with their original-language text + Arabic
  // alongside the selected translation (CLAUDE.md §2.1, §7.1).
  const [showOriginal, setShowOriginal] = useState(false);

  // Conversation history per (user, room) — persisted via Yjs so it
  // survives a page refresh and syncs across tabs. The Y.Doc is
  // scoped by `handle` so users don't see each other's conversations
  // (rule-guide.MD §13 isolation, applied at the doc-id level).
  const conversation = useYjsConversation(handle, roomId);
  const turns = conversation.turns;

  // Default the resources panel closed on phones to free up screen space.
  useEffect(() => {
    setResourcesOpen(isDesktop);
  }, [isDesktop]);

  const latestResponse =
    [...turns].reverse().find((t) => t.response)?.response ?? null;
  const anyPending = turns.some((t) => t.pending);

  useImperativeHandle(
    workspaceRef,
    () => ({
      ask: (question: string) => ask(question),
      isPending: () => anyPending,
    }),
    // anyPending changes drive isPending(); ask itself closes over
    // current state via setTurns updaters so it doesn't need to be in
    // the dep list. Including it would force a new ref on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anyPending],
  );

  function jumpToCitation(source_id: string) {
    const parsed = parseVerseRef(source_id);
    if (!parsed) return;
    setBook(parsed.book);
    setChapter(parsed.chapter);
    onFocusChange(parsed);
  }

  function ask(question: string) {
    if (!question.trim()) return;
    // Pick a verse anchor for retrieval AND a human-readable scope
    // label that prefixes the question so the LLM knows the user is
    // asking at the current zoom level, not about the lone anchor verse.
    let verseRef: string;
    let scopeLabel: string;
    if (bibleView) {
      verseRef = "GEN.1.1";
      scopeLabel = "the Bible";
    } else if (testamentView) {
      verseRef = testamentView === "OT" ? "GEN.1.1" : "MAT.1.1";
      scopeLabel = testamentView === "OT" ? "the Old Testament" : "the New Testament";
    } else if (focus) {
      verseRef = focus.ref;
      scopeLabel = `${focus.book} ${focus.chapter}:${focus.verse}`;
    } else {
      verseRef = `${book}.${chapter}.1`;
      scopeLabel = `${book} chapter ${chapter}`;
    }
    const framedQuestion = `[About ${scopeLabel}] ${question.trim()}`;
    const turnId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const askedAt = performance.now();
    const newTurn: ConversationTurn = {
      id: turnId,
      question: question.trim(),
      verse_ref: verseRef,
      reasoning: "",
      rawCot: "",
      stages: [],
      response: null,
      pending: true,
    };

    // Build history from the most recent answered turns (limit 4).
    const history = turns
      .filter((t) => t.response && t.response.answer)
      .slice(-4)
      .map((t) => ({
        verse_ref: t.verse_ref,
        question: t.question,
        answer: t.response!.answer,
      }));

    conversation.add(newTurn);

    // Buffer the streamed CoT locally; flush to Yjs on each chunk so
    // other tabs see the live stream too.
    let cot = "";
    const stages: ConversationTurn["stages"] = [];

    // Live streaming over WebSocket — reasoning streams as the model
    // thinks; verified answer + claim cards arrive as one block after
    // the citation engine completes (citation-engine.MD §10). Each new
    // turn still goes through the full pipeline; prior answers are
    // context only, not implicit facts.
    streamReason(
      {
        room_id: roomId,
        verse_ref: verseRef,
        question: framedQuestion,
        history,
        bypass_citation_engine: bypassCitationEngine,
      },
      {
        onStage: (name, count) => {
          const tSec = (performance.now() - askedAt) / 1000;
          const label =
            count != null ? `[${name} · ${count}]` : `[${name}]`;
          stages.push({ name, count, t: tSec });
          conversation.update(turnId, {
            stages: [...stages],
            ...(cot ? {} : { reasoning: `${label} ` }),
          });
        },
        onReasoningChunk: (text) => {
          cot += text;
          conversation.update(turnId, { reasoning: cot, rawCot: cot });
        },
        onResult: (r) => {
          conversation.update(turnId, {
            response: r,
            reasoning: r.reasoning || cot,
            pending: false,
          });
        },
        onError: (msg) => {
          conversation.update(turnId, {
            reasoning: `Backend error: ${msg}`,
            error: msg,
            pending: false,
          });
        },
        onClose: () => {
          // Safety net — unstick if no result/error fired.
          conversation.update(turnId, { pending: false });
        },
      },
    );
  }

  // Three-step zoom-out: verse → chapter → testament → bible.
  function zoomOut() {
    if (focus) {
      onFocusChange(null);
      return;
    }
    if (testamentView === null && !bibleView) {
      setTestamentView(testamentOf(book) ?? "OT");
      return;
    }
    if (testamentView !== null) {
      // testament view → bible (OT + NT) view
      setTestamentView(null);
      setBibleView(true);
    }
    // At bibleView=true, we're at max zoom-out; the button hides.
  }
  function pickBookFromGrid(b: string) {
    setBook(b);
    setChapter(1);
    setTestamentView(null);
    setBibleView(false);
  }
  function pickTestamentFromBible(t: Testament) {
    setBibleView(false);
    setTestamentView(t);
  }

  return (
    <div className="relative flex h-full flex-col">
      {!focusMode && (
        <Breadcrumb
          roomName={roomName}
          book={book}
          chapter={chapter}
          focus={focus}
          testamentView={testamentView}
          bibleView={bibleView}
          canZoomOut={!bibleView}
          onZoomOut={zoomOut}
          resourcesOpen={resourcesOpen}
          onToggleResources={() => setResourcesOpen((v) => !v)}
        />
      )}

      {isDesktop ? (
        <PanelGroup direction="horizontal" className="flex-1">
          {resourcesOpen && (
            <Panel defaultSize={22} minSize={14} id="resources" order={1}>
              <ResourcesPanel
                scopedToVerse={!!focus}
                citationsUsed={latestResponse?.claims ?? []}
                focusVerseId={focus?.ref ?? null}
                onJumpToCitation={jumpToCitation}
              />
            </Panel>
          )}
          {resourcesOpen && <Grip />}
          <Panel
            defaultSize={resourcesOpen ? 78 : 100}
            minSize={40}
            id="center"
            order={2}
          >
            <CenterColumn
              book={book}
              chapter={chapter}
              translation={translation}
              focus={focus}
              notes={notes}
              setBook={setBook}
              setChapter={setChapter}
              setTranslation={setTranslation}
              onClickVerse={(v) =>
                onFocusChange({
                  book,
                  chapter,
                  verse: v,
                  ref: `${book}.${chapter}.${v}`,
                })
              }
              turns={turns}
              anyPending={anyPending}
              onAsk={ask}
              isDesktop
              focusMode={focusMode}
              onToggleFocus={onToggleFocus}
              showOriginal={showOriginal}
              onToggleOriginal={() => setShowOriginal((v) => !v)}
              onJumpToCitation={jumpToCitation}
              testamentView={testamentView}
              bibleView={bibleView}
              onPickBookFromGrid={pickBookFromGrid}
              onPickTestamentFromBible={pickTestamentFromBible}
              debugMode={debugMode}
              bookmarks={bookmarks}
              onSetBookmark={onSetBookmark}
              onRemoveBookmarkAt={onRemoveBookmarkAt}
              timezone={timezone}
              onDoubleTapBookmark={onDoubleTapBookmark}
              roomId={roomId}
              selfUserId={selfUserId}
              socialNotesEnabled={socialNotesEnabled}
              annotations={annotations}
              onApplyAnnotation={onApplyAnnotation}
              onClearAnnotationKind={onClearAnnotationKind}
              onClearAnnotations={onClearAnnotations}
              annotationTarget={annotationTarget}
              onAnnotationTargetChange={onAnnotationTargetChange}
            />
          </Panel>
        </PanelGroup>
      ) : (
        <>
          <CenterColumn
            book={book}
            chapter={chapter}
            translation={translation}
            focus={focus}
            notes={notes}
            setBook={setBook}
            setChapter={setChapter}
            setTranslation={setTranslation}
            onClickVerse={(v) =>
              onFocusChange({
                book,
                chapter,
                verse: v,
                ref: `${book}.${chapter}.${v}`,
              })
            }
            turns={turns}
            anyPending={anyPending}
            onAsk={ask}
            isDesktop={false}
            focusMode={focusMode}
            onToggleFocus={onToggleFocus}
            showOriginal={showOriginal}
            onToggleOriginal={() => setShowOriginal((v) => !v)}
            onJumpToCitation={jumpToCitation}
              testamentView={testamentView}
              bibleView={bibleView}
              onPickBookFromGrid={pickBookFromGrid}
              onPickTestamentFromBible={pickTestamentFromBible}
            debugMode={debugMode}
            mobilePanel={mobilePanel}
            hidePrompt={hidePrompt}
            bookmarks={bookmarks}
            onSetBookmark={onSetBookmark}
              onRemoveBookmarkAt={onRemoveBookmarkAt}
              timezone={timezone}
              onDoubleTapBookmark={onDoubleTapBookmark}
              roomId={roomId}
              selfUserId={selfUserId}
              socialNotesEnabled={socialNotesEnabled}
              annotations={annotations}
              onApplyAnnotation={onApplyAnnotation}
              onClearAnnotationKind={onClearAnnotationKind}
              onClearAnnotations={onClearAnnotations}
              annotationTarget={annotationTarget}
              onAnnotationTargetChange={onAnnotationTargetChange}
          />
          {/* Mobile slide-over for Resources */}
          {resourcesOpen && (
            <button
              onClick={() => setResourcesOpen(false)}
              aria-label="Close resources"
              className="absolute inset-0 z-20 bg-black/40"
            />
          )}
          <aside
            className={`absolute inset-y-0 left-0 z-30 w-[80vw] max-w-xs transform border-r border-neutral-200 bg-paper shadow-xl transition-transform dark:border-neutral-800 dark:bg-neutral-900 ${
              resourcesOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <ResourcesPanel
              scopedToVerse={!!focus}
              citationsUsed={latestResponse?.claims ?? []}
              focusVerseId={focus?.ref ?? null}
              onCloseMobile={() => setResourcesOpen(false)}
              onJumpToCitation={(id) => {
                jumpToCitation(id);
                setResourcesOpen(false);
              }}
            />
          </aside>
        </>
      )}
    </div>
  );
});

function CenterColumn(props: {
  book: string;
  chapter: number;
  translation: string;
  focus: VerseFocus | null;
  notes: NotesApi;
  setBook: (b: string) => void;
  setChapter: (c: number) => void;
  setTranslation: (t: string) => void;
  onClickVerse: (v: number) => void;
  turns: ConversationTurn[];
  anyPending: boolean;
  onAsk: (q: string) => void;
  isDesktop: boolean;
  focusMode: boolean;
  onToggleFocus: () => void;
  showOriginal: boolean;
  onToggleOriginal: () => void;
  onJumpToCitation: (source_id: string) => void;
  debugMode: boolean;
  mobilePanel?: "bible" | "ask";
  hidePrompt?: boolean;
  bookmarks?: {
    book: string;
    chapter: number;
    verse: number;
    updated_at?: string;
  }[];
  onSetBookmark?: (book: string, chapter: number, verse: number) => void;
  onRemoveBookmarkAt?: (book: string, chapter: number, verse: number) => void;
  onDoubleTapBookmark?: (book: string, chapter: number, verse: number) => void;
  timezone?: string;
  testamentView: Testament | null;
  bibleView: boolean;
  onPickBookFromGrid: (book: string) => void;
  onPickTestamentFromBible: (t: Testament) => void;
  roomId: string;
  selfUserId?: string;
  socialNotesEnabled?: boolean;
  annotations?: AnnotationOut[];
  onApplyAnnotation?: (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
  ) => void;
  onClearAnnotationKind?: (verseId: string, kind: AnnotationKind) => void;
  onClearAnnotations?: (verseId: string) => void;
  annotationTarget?: { verseId: string; label?: string } | null;
  onAnnotationTargetChange?: (
    t: { verseId: string; label?: string } | null,
  ) => void;
}) {
  const {
    book,
    chapter,
    translation,
    focus,
    notes,
    setBook,
    setChapter,
    setTranslation,
    onClickVerse,
    turns,
    anyPending,
    onAsk,
    isDesktop,
    focusMode,
    onToggleFocus,
    showOriginal,
    onToggleOriginal,
    onJumpToCitation,
    debugMode,
    mobilePanel,
    hidePrompt,
    bookmarks,
    onSetBookmark,
    onRemoveBookmarkAt,
    onDoubleTapBookmark,
    timezone,
    testamentView,
    bibleView,
    onPickBookFromGrid,
    onPickTestamentFromBible,
    roomId,
    selfUserId,
    socialNotesEnabled,
    annotations,
    onApplyAnnotation,
    onClearAnnotationKind,
    onClearAnnotations,
    annotationTarget,
    onAnnotationTargetChange,
  } = props;

  // The Bible panel renders one of three views depending on zoom:
  //   bibleView  → BibleOverview (OT + NT cards)
  //   testament  → TestamentGrid (all books in that testament)
  //   default    → BibleView (current chapter)
  const bibleOrGrid = bibleView ? (
    <BibleOverview
      currentBook={book}
      onPickTestament={onPickTestamentFromBible}
    />
  ) : testamentView ? (
    <TestamentGrid
      testament={testamentView}
      currentBook={book}
      onPickBook={onPickBookFromGrid}
      onZoomIn={() => onPickBookFromGrid(book)}
    />
  ) : (
    <BibleView
      book={book}
      chapter={chapter}
      translation={translation}
      focus={focus}
      notes={notes}
      onPickBook={setBook}
      onPickChapter={setChapter}
      onPickTranslation={setTranslation}
      onClickVerse={onClickVerse}
      hideToolbar={focusMode}
      focusMode={focusMode}
      onToggleFocus={onToggleFocus}
      showOriginal={showOriginal}
      bookmarks={bookmarks}
      onSetBookmark={onSetBookmark}
      onRemoveBookmarkAt={onRemoveBookmarkAt}
      onDoubleTapBookmark={onDoubleTapBookmark}
      timezone={timezone}
      roomId={roomId}
      selfUserId={selfUserId}
      socialNotesEnabled={socialNotesEnabled}
      annotations={annotations}
      onApplyAnnotation={onApplyAnnotation}
      onClearAnnotationKind={onClearAnnotationKind}
      onClearAnnotations={onClearAnnotations}
      annotationTarget={annotationTarget}
      onAnnotationTargetChange={onAnnotationTargetChange}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isDesktop ? (
        <PanelGroup direction="vertical" className="flex-1">
          <Panel defaultSize={58} minSize={25}>
            {bibleOrGrid}
          </Panel>
          <Grip horizontal />
          <Panel defaultSize={42} minSize={20}>
            <ReasoningStream
              turns={turns}
              showOriginal={showOriginal}
              onToggleOriginal={onToggleOriginal}
              onJumpToCitation={onJumpToCitation}
              debugMode={debugMode}
            />
          </Panel>
        </PanelGroup>
      ) : mobilePanel === "ask" ? (
        // Mobile Ask tab: reasoning stream takes the whole column.
        <div className="min-h-0 flex-1">
          <ReasoningStream
            turns={turns}
            showOriginal={showOriginal}
            onToggleOriginal={onToggleOriginal}
            onJumpToCitation={onJumpToCitation}
            debugMode={debugMode}
          />
        </div>
      ) : mobilePanel === "bible" ? (
        // Mobile Bible tab: scripture takes the whole column.
        <div className="min-h-0 flex-1">{bibleOrGrid}</div>
      ) : (
        // Mobile (legacy combined view, unused once MobileShell is wired):
        // stack Bible above Reasoning with a draggable Grip.
        <PanelGroup direction="vertical" className="flex-1">
          <Panel defaultSize={60} minSize={20}>
            {bibleOrGrid}
          </Panel>
          <Grip horizontal />
          <Panel defaultSize={40} minSize={15}>
            <ReasoningStream
              turns={turns}
              showOriginal={showOriginal}
              onToggleOriginal={onToggleOriginal}
              onJumpToCitation={onJumpToCitation}
              debugMode={debugMode}
            />
          </Panel>
        </PanelGroup>
      )}
      {/* PromptBar is part of the agent UI. Suppressed in two cases:
       *  - mobilePanel="bible": Bible-only mobile view (AI off).
       *  - hidePrompt=true: caller drives ask() via the workspaceRef
       *    and supplies its own chat input (MobileShell glass panel). */}
      {mobilePanel !== "bible" && !hidePrompt && (
        <PromptBar
          focus={focus}
          book={book}
          chapter={chapter}
          testamentView={testamentView}
          bibleView={bibleView}
          onAsk={onAsk}
          pending={anyPending}
          notes={notes}
        />
      )}
    </div>
  );
}

function Breadcrumb({
  roomName,
  book,
  chapter,
  focus,
  testamentView,
  bibleView,
  canZoomOut,
  onZoomOut,
  resourcesOpen,
  onToggleResources,
}: {
  roomName: string;
  book: string;
  chapter: number;
  focus: VerseFocus | null;
  testamentView: Testament | null;
  bibleView: boolean;
  canZoomOut: boolean;
  onZoomOut: () => void;
  resourcesOpen: boolean;
  onToggleResources: () => void;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200 bg-paper px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      <button
        onClick={onToggleResources}
        className="mr-1 shrink-0 rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-paper-soft dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
        title={resourcesOpen ? "Hide resources panel" : "Show resources panel"}
        aria-label="Toggle resources panel"
      >
        {resourcesOpen ? "❮ Resources" : "Resources ❯"}
      </button>
      <span className="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">
        {roomName}
      </span>
      {bibleView ? (
        <>
          <Chev />
          <span className="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">
            The Bible
          </span>
        </>
      ) : testamentView ? (
        <>
          <Chev />
          <span className="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">
            {testamentView === "OT" ? "Old Testament" : "New Testament"}
          </span>
        </>
      ) : (
        <>
          <Chev />
          <span className="shrink-0">{book}</span>
          <Chev />
          <span className="shrink-0">{chapter}</span>
          {focus && (
            <>
              <Chev />
              <span className="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">
                v{focus.verse}
              </span>
            </>
          )}
        </>
      )}
      {canZoomOut && (
        <button
          className="ml-2 shrink-0 rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-paper-soft dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
          onClick={onZoomOut}
          title={
            focus
              ? "Zoom out to chapter"
              : testamentView
                ? "Zoom out to the whole Bible"
                : "Zoom out to testament"
          }
        >
          zoom out
        </button>
      )}
    </div>
  );
}

function Chev() {
  return (
    <span className="shrink-0 text-neutral-300 dark:text-neutral-600">›</span>
  );
}

function PromptBar({
  focus,
  book,
  chapter,
  testamentView,
  bibleView,
  onAsk,
  pending,
  notes,
}: {
  focus: VerseFocus | null;
  book: string;
  chapter: number;
  testamentView: Testament | null;
  bibleView: boolean;
  onAsk: (q: string) => void;
  pending: boolean;
  notes: NotesApi;
}) {
  const [q, setQ] = useState("");
  const [noteScope, setNoteScope] = useState<"personal" | "group">("personal");
  const [justSaved, setJustSaved] = useState<"personal" | "group" | null>(null);

  // Heuristic intent detection — no LLM needed. Questions tend to end
  // with "?" or start with an interrogative; notes are statements (often
  // first-person reflections or explicit "note:" prefixes).
  const intent: "question" | "note" = detectIntent(q);

  function saveAsNote() {
    const body = q.trim();
    if (!body) return;
    // Strip an explicit "note:" prefix so the saved body is the thought itself.
    const clean = body.replace(/^\s*note\s*(?:to\s+self)?\s*[:\-—]\s*/i, "");
    notes.add({
      scope: noteScope,
      body: clean || body,
      verse_anchor: focus?.ref,
    });
    setQ("");
    setJustSaved(noteScope);
    setTimeout(() => setJustSaved(null), 1500);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // Enter executes whichever action the heuristic picked.
        if (intent === "note") saveAsNote();
        else {
          onAsk(q);
          setQ("");
        }
      }}
      className="flex items-center gap-2 border-t border-neutral-200 bg-paper p-2 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={
          bibleView
            ? "Ask about the Bible… or jot a note"
            : testamentView === "OT"
              ? "Ask about the Old Testament… or jot a note"
              : testamentView === "NT"
                ? "Ask about the New Testament… or jot a note"
                : focus
                  ? `Ask about ${focus.book}.${focus.chapter}.${focus.verse}… or jot a note`
                  : `Ask about ${book} ${chapter}… or jot a note`
        }
        className="flex-1 rounded border border-neutral-200 bg-paper px-3 py-2 text-base md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
      />
      <button
        type="button"
        onClick={() =>
          setNoteScope((s) => (s === "personal" ? "group" : "personal"))
        }
        className={`shrink-0 rounded-l border px-1.5 py-2 text-[10px] font-medium uppercase tracking-wide ${
          noteScope === "personal"
            ? "border-neutral-300 bg-paper-soft text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            : "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-700 dark:bg-violet-900/40 dark:text-violet-200"
        }`}
        title={
          noteScope === "personal"
            ? "Personal note (only you, never visible to agent) — tap to switch to Group"
            : "Group note (shared with room, agent has read oversight) — tap to switch to Personal"
        }
      >
        {noteScope === "personal" ? "P" : "G"}
      </button>
      <button
        type="button"
        onClick={saveAsNote}
        disabled={!q.trim()}
        className={`-ml-px rounded-r border px-2.5 py-2 text-xs disabled:opacity-50 ${
          intent === "note"
            ? "border-neutral-900 bg-neutral-900 font-medium text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
            : "border-neutral-300 bg-paper-soft text-neutral-700 hover:bg-yellow-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-amber-900/40"
        }`}
        title={
          focus
            ? `Save as your ${noteScope} note on ${focus.ref}`
            : `Save as your ${noteScope} note`
        }
      >
        {justSaved
          ? `✓ ${justSaved === "personal" ? "Personal" : "Group"}`
          : "📝 Note"}
      </button>
      <button
        type="button"
        onClick={() => {
          if (!q.trim()) return;
          onAsk(q);
          setQ("");
        }}
        disabled={pending || !q.trim()}
        className={`rounded px-3 py-2 text-sm disabled:opacity-50 ${
          intent === "question"
            ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
            : "border border-neutral-300 bg-paper-soft text-neutral-700 hover:bg-yellow-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-amber-900/40"
        }`}
      >
        {pending ? "…" : "Ask"}
      </button>
    </form>
  );
}

/** Cheap heuristic intent detector — no LLM. Returns "note" when the
 *  text looks like a statement / explicit note prefix; "question"
 *  otherwise (the default). Used by PromptBar to pick which button is
 *  primary when the user hits Enter. */
function detectIntent(raw: string): "question" | "note" {
  const text = raw.trim();
  if (!text) return "question";
  // Explicit "note:" / "note to self:" prefix is unambiguous.
  if (/^\s*note\s*(?:to\s+self)?\s*[:\-—]/i.test(text)) return "note";
  // Question mark anywhere → question.
  if (/[?]/.test(text)) return "question";
  const first = text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const QUESTION_WORDS = new Set([
    "what", "why", "when", "where", "who", "whom", "whose",
    "how", "which", "can", "could", "would", "will", "do",
    "does", "did", "is", "are", "was", "were", "has", "have",
    "had", "should", "shall", "may", "might", "explain",
    "show", "tell", "list", "find", "give", "describe",
    "compare", "summarize", "bring", "provide", "name",
  ]);
  if (QUESTION_WORDS.has(first)) return "question";
  // Statement-leading first-person reflections → note.
  const NOTE_LEADERS = /^(i (?:think|feel|remember|love|wonder|want|am|notice|see|believe|like|need|hope|wish)|note (?:to self)?|reminder|todo|remember|today)/i;
  if (NOTE_LEADERS.test(text)) return "note";
  // Default: when in doubt, treat as question (Ask is the safer fallback
  // — it surfaces the citation engine; saving an accidental question as
  // a note is recoverable but the reverse wastes an LLM call).
  return "question";
}

