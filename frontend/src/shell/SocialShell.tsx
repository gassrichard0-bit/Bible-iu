/**
 * The "front door" — left rail of groups and DMs (CLAUDE.md §4.1, §4.10).
 * Selecting a room opens it; the workspace renders the VS Code shell.
 *
 * Layout:
 *  - Desktop (md+): room rail is always visible on the left; notes are
 *    a resizable panel column on the right.
 *  - Mobile: rail is a slide-over drawer triggered by the hamburger;
 *    notes are a full-height slide-over from the right.
 */
import { useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { Workspace, type VerseFocus } from "../workspace/Workspace";
import { NotesSidebar } from "../workspace/NotesSidebar/NotesSidebar";
import { useYjsNotes } from "../workspace/NotesSidebar/yjsNotes";
import { ThemeToggle } from "./ThemeToggle";
import { SettingsModal } from "./Settings";
import { Avatar } from "./Profile";
import { NewRoomModal, type NewRoomValues } from "./NewRoomModal";
import { ShareRoomModal } from "./ShareRoomModal";
import {
  api,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationOut,
} from "../lib/api";
import { GLASS_CARD_INLINE } from "../lib/glass";
import { Grip } from "../lib/Grip";
import type { Settings } from "../lib/settings";
import type { Theme } from "../lib/theme";
import { useIsDesktop } from "../lib/useMediaQuery";

interface RoomItem {
  id: string;
  type: "group" | "direct";
  name: string;
  lastMessage?: string;
  unread?: number;
  /** Optional starting verse for the workspace when the user opens
   *  this room. Set on the welcome room to JHN.3.16. */
  focusedVerse?: string;
}

interface Props {
  handle: string;
  /** Stable user id from /auth/me. See MobileShell for the same prop. */
  selfUserId?: string;
  onSignOut: () => void;
  onDeleted: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  /** Set by App when the user just accepted an invite — we refresh the
   *  room list and auto-select it on first render. */
  pendingRoomId?: string | null;
  onPendingRoomConsumed?: () => void;
}

export function SocialShell({
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
  const isDesktop = useIsDesktop();
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [shareOpen, setShareOpen] = useState(false);
  const [view, setView] = useState<"chat" | "study">("study");
  const [notesOpen, setNotesOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [railOpenMobile, setRailOpenMobile] = useState(false);
  // Focus mode hides the page header, the workspace breadcrumb, and the
  // Bible toolbar — everything above the scripture column. A small
  // floating "exit focus" button is the only escape.
  const [focusMode, setFocusMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  // Verse focus is set by the workspace but persists at shell level so
  // the Notes sidebar (CLAUDE.md §4.6) stays coherent across chat ↔ study.
  const [focus, setFocus] = useState<VerseFocus | null>(null);
  // Tracks which room's focusedVerse we've already applied — prevents
  // re-applying after the user navigates away from the seeded verse.
  const [seededRoomId, setSeededRoomId] = useState<string | null>(null);

  const active = useMemo(
    () => rooms.find((r) => r.id === activeId),
    [rooms, activeId],
  );

  // Verse annotations — paper-Bible style marks (highlight, underline,
  // strikethrough). Per-user, room-independent.
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
        ...as.filter((a) => !(a.verse_id === verseId && a.kind === kind)),
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

  // When the active room changes and it carries a `focusedVerse` we
  // haven't honored yet, jump to it. The user can navigate away after
  // and we stay where they go.
  useEffect(() => {
    if (!active || !active.focusedVerse) return;
    if (seededRoomId === active.id) return;
    const parsed = parseVerseRef(active.focusedVerse);
    if (parsed) {
      setFocus(parsed);
      setSeededRoomId(active.id);
    }
  }, [active, seededRoomId]);

  // Per-room note state — backed by Yjs/CRDT so other tabs (and other
  // devices, once auth lands) merge cleanly (CLAUDE.md §8,
  // notes-system.MD §3.1, §5.6). Skip when the active room hasn't
  // loaded yet — connecting Yjs with an empty room ID hits a 403 on
  // the server (no route match) and floods the console.
  const notesApi = useYjsNotes(activeId);

  useEffect(() => {
    void api.health().catch(() => {});
  }, []);

  // Load the user's real rooms from the backend on mount, and any time
  // a pending invite-accept lands. Falls back to a quiet empty list if
  // the backend is unreachable — the new-room button still works.
  useEffect(() => {
    let alive = true;
    api
      .listRooms()
      .then((list) => {
        if (!alive) return;
        const mapped: RoomItem[] = list.map((r) => ({
          id: r.id,
          type: (r.type === "direct" ? "direct" : "group") as
            | "group"
            | "direct",
          name: r.name ?? "(unnamed)",
          focusedVerse: r.scripture_context?.focused_verse,
        }));
        setRooms(mapped);
        // First load → pick the pending invite room if any, else the
        // first room. On subsequent loads, only switch if we just got
        // a pending room.
        if (pendingRoomId && mapped.some((r) => r.id === pendingRoomId)) {
          setActiveId(pendingRoomId);
          onPendingRoomConsumed?.();
        } else if (!activeId && mapped.length > 0) {
          setActiveId(mapped[0].id);
        }
      })
      .catch(() => {
        // Backend unreachable — keep an empty list.
      });
    return () => {
      alive = false;
    };
  }, [pendingRoomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default notes panel: open on desktop, closed on mobile (more screen
  // room for scripture/reasoning).
  useEffect(() => {
    setNotesOpen(isDesktop);
  }, [isDesktop]);

  async function createRoom(values: NewRoomValues) {
    try {
      const r = await api.createRoom(values.type, values.name);
      const item: RoomItem = { id: r.id, type: values.type, name: values.name };
      setRooms((rs) => [item, ...rs]);
      setActiveId(item.id);
    } catch {
      // backend unreachable — keep a local-only entry so the UI still works
      const id = `local-${Date.now()}`;
      const item: RoomItem = { id, type: values.type, name: values.name };
      setRooms((rs) => [item, ...rs]);
      setActiveId(item.id);
    }
    setRailOpenMobile(false);
  }

  function pickRoom(id: string) {
    setActiveId(id);
    setRailOpenMobile(false);
  }

  return (
    <div className="relative flex h-full">
      {/* Backdrop for mobile drawers */}
      {!isDesktop && railOpenMobile && (
        <button
          onClick={() => setRailOpenMobile(false)}
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-black/40"
        />
      )}

      <aside
        className={`${
          isDesktop
            ? "flex w-64 shrink-0 border-r"
            : `fixed inset-y-0 left-0 z-40 w-72 border-r shadow-xl transition-transform ${
                railOpenMobile ? "translate-x-0" : "-translate-x-full"
              }`
        } flex-col border-neutral-200 bg-paper dark:border-neutral-800 dark:bg-neutral-900`}
      >
        <div className="flex items-center justify-between px-3 py-2">
          <div className="text-sm font-semibold">Bible IU</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSettingsOpen(true);
                setRailOpenMobile(false);
              }}
              className="flex items-center gap-1.5 rounded p-1 text-neutral-500 hover:bg-paper-soft hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              title={`Signed in as ${handle} — open settings`}
              aria-label="Settings"
            >
              <Avatar handle={handle} size={24} />
              <span className="text-[10px]">⚙</span>
            </button>
            {!isDesktop && (
              <button
                onClick={() => setRailOpenMobile(false)}
                className="rounded p-1 text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
                aria-label="Close menu"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <button
          onClick={() => setNewRoomOpen(true)}
          className="mx-3 mb-2 rounded border border-dashed border-neutral-300 px-2 py-2 text-xs text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
        >
          + New room
        </button>
        <input
          placeholder="Search"
          className="mx-3 mb-2 rounded border border-neutral-200 bg-paper px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        <nav className="flex-1 overflow-y-auto">
          {rooms.map((r) => (
            <button
              key={r.id}
              onClick={() => pickRoom(r.id)}
              className={`flex w-full items-start gap-2 px-3 py-3 text-left text-sm hover:bg-paper-soft dark:hover:bg-neutral-800/60 ${
                r.id === activeId
                  ? "bg-paper-soft dark:bg-neutral-800"
                  : ""
              }`}
            >
              <span className="mt-1 inline-block h-2 w-2 rounded-full bg-neutral-400 dark:bg-paper-soft0" />
              <span className="flex-1 truncate">
                <span className="block truncate font-medium">{r.name}</span>
                <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                  {r.lastMessage ?? "—"}
                </span>
              </span>
              {r.unread ? (
                <span className="rounded-full bg-neutral-900 px-1.5 text-[10px] text-white dark:bg-neutral-100 dark:text-neutral-900">
                  {r.unread}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {!focusMode && (
        <header className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-paper px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900 md:px-4">
          <div className="flex min-w-0 items-center gap-2">
            {!isDesktop && (
              <button
                onClick={() => setRailOpenMobile(true)}
                className="rounded p-1.5 text-neutral-600 hover:bg-paper-soft dark:text-neutral-300 dark:hover:bg-neutral-800"
                aria-label="Open menu"
              >
                ☰
              </button>
            )}
            <div className="truncate text-sm font-medium">
              {active?.name ?? "—"}
            </div>
            {active && active.type === "group" && !active.id.startsWith("local-") && (
              <button
                onClick={() => setShareOpen(true)}
                className="shrink-0 rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                title="Share this room"
                aria-label="Share room"
              >
                ↗ Share
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1 md:gap-1.5">
            <div className="flex rounded border border-neutral-200 text-xs dark:border-neutral-700">
              <button
                onClick={() => setView("chat")}
                className={`flex h-8 items-center justify-center px-2 md:px-2.5 ${
                  view === "chat"
                    ? "bg-paper-soft dark:bg-neutral-800"
                    : ""
                }`}
                title="Chat view"
                aria-label="Chat view"
                aria-pressed={view === "chat"}
              >
                <span className="hidden md:inline">Chat</span>
                <span className="md:hidden">💬</span>
              </button>
              <button
                onClick={() => setView("study")}
                className={`flex h-8 items-center justify-center px-2 md:px-2.5 ${
                  view === "study"
                    ? "bg-paper-soft dark:bg-neutral-800"
                    : ""
                }`}
                title="Study view"
                aria-label="Study view"
                aria-pressed={view === "study"}
              >
                <span className="hidden md:inline">Study</span>
                <span className="md:hidden">📖</span>
              </button>
            </div>
            <button
              onClick={() => setNotesOpen((v) => !v)}
              className="flex h-8 items-center justify-center rounded border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              title="Toggle notes (CLAUDE.md §4.6)"
              aria-label="Toggle notes"
            >
              <span className="hidden md:inline">
                {notesOpen ? "Hide notes" : "Notes"}
              </span>
              <span className="md:hidden">✎</span>
            </button>
            <ThemeToggle theme={theme} onToggle={onToggleTheme} compact />
          </div>
        </header>
        )}

        <div className="relative flex-1 overflow-hidden bg-paper-soft dark:bg-neutral-950">
          {isDesktop ? (
            <PanelGroup direction="horizontal" className="h-full">
              <Panel defaultSize={notesOpen ? 75 : 100} minSize={40}>
                {active && view === "study" && (
                  <Workspace
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
                    selfUserId={selfUserId}
                    socialNotesEnabled={settings.socialNotesEnabled}
                    annotations={annotations}
                    onApplyAnnotation={applyAnnotation}
                    onClearAnnotationKind={clearAnnotationKind}
                    onClearAnnotations={clearAnnotations}
                  />
                )}
                {active && view === "chat" && (
                  <ChatPlaceholder roomName={active.name} />
                )}
              </Panel>
              {notesOpen && <Grip />}
              {notesOpen && active && (
                <Panel defaultSize={25} minSize={18}>
                  <PanelGroup direction="vertical" className="h-full">
                    <Panel defaultSize={chatOpen ? 60 : 100} minSize={20}>
                      <NotesSidebar
                        focus={focus}
                        notes={notesApi}
                        roomId={active.id}
                        roomName={active.name}
                        chatOpen={chatOpen}
                        onToggleChat={() => setChatOpen((v) => !v)}
                        socialNotesEnabled={settings.socialNotesEnabled}
                        selfUserId={selfUserId}
                      />
                    </Panel>
                    {chatOpen && <Grip horizontal />}
                    {chatOpen && (
                      <Panel defaultSize={40} minSize={15}>
                        <ChatPlaceholder roomName={active.name} />
                      </Panel>
                    )}
                  </PanelGroup>
                </Panel>
              )}
            </PanelGroup>
          ) : (
            // Mobile: single column. Notes is a slide-over from the right.
            <>
              <div className="h-full">
                {active && view === "study" && (
                  <Workspace
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
                    selfUserId={selfUserId}
                    socialNotesEnabled={settings.socialNotesEnabled}
                    annotations={annotations}
                    onApplyAnnotation={applyAnnotation}
                    onClearAnnotationKind={clearAnnotationKind}
                    onClearAnnotations={clearAnnotations}
                  />
                )}
                {active && view === "chat" && (
                  <ChatPlaceholder roomName={active.name} />
                )}
              </div>
              {notesOpen && (
                <button
                  onClick={() => setNotesOpen(false)}
                  aria-label="Close notes"
                  className="absolute inset-0 z-20 bg-black/40"
                />
              )}
              <aside
                className={`absolute inset-y-0 right-0 z-30 flex w-[88vw] max-w-sm transform flex-col border-l border-neutral-200 bg-paper shadow-xl transition-transform dark:border-neutral-800 dark:bg-neutral-900 ${
                  notesOpen ? "translate-x-0" : "translate-x-full"
                }`}
              >
                {active && (
                  <PanelGroup direction="vertical" className="h-full">
                    <Panel defaultSize={chatOpen ? 60 : 100} minSize={20}>
                      <NotesSidebar
                        focus={focus}
                        notes={notesApi}
                        roomId={active.id}
                        roomName={active.name}
                        chatOpen={chatOpen}
                        onToggleChat={() => setChatOpen((v) => !v)}
                        onCloseMobile={() => setNotesOpen(false)}
                        socialNotesEnabled={settings.socialNotesEnabled}
                        selfUserId={selfUserId}
                      />
                    </Panel>
                    {chatOpen && <Grip horizontal />}
                    {chatOpen && (
                      <Panel defaultSize={40} minSize={15}>
                        <ChatPlaceholder roomName={active.name} />
                      </Panel>
                    )}
                  </PanelGroup>
                )}
              </aside>
            </>
          )}
        </div>
      </main>
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

interface DemoChatMsg {
  from: string;
  mine?: boolean;
  body: string;
  time: string;
}

const DEMO_DESKTOP_THREAD: DemoChatMsg[] = [
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
    body: "Quick Q — how do y’all read v.18?",
    time: "9:02 AM",
  },
  {
    from: "You",
    mine: true,
    body: "Paul anticipating the objection — he leans in instead of softening.",
    time: "9:04 AM",
  },
];

function ChatPlaceholder({ roomName }: { roomName: string }) {
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
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {DEMO_DESKTOP_THREAD.map((m, i) => (
          <DesktopChatBubble key={i} msg={m} />
        ))}
        <p className="pt-1 text-center text-[10px] text-neutral-400 dark:text-neutral-500">
          Demo conversation — real chat lands when{" "}
          <code>POST /rooms/{`{id}`}/chat</code> + websocket are wired up.
        </p>
      </div>
      <div className="flex items-center gap-2 border-t border-neutral-200 bg-paper p-2 dark:border-neutral-800 dark:bg-neutral-900">
        <input
          placeholder="Message…"
          className="flex-1 rounded border border-neutral-200 bg-paper px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        <button className="rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          Send
        </button>
      </div>
    </div>
  );
}

function DesktopChatBubble({ msg }: { msg: DemoChatMsg }) {
  const side = msg.mine ? "items-end" : "items-start";
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

/** Parse a backend verse ref like "JHN.3.16" into a VerseFocus. */
function parseVerseRef(ref: string): VerseFocus | null {
  const m = /^([A-Z0-9]{2,4})\.(\d+)\.(\d+)$/.exec(ref);
  if (!m) return null;
  return {
    book: m[1],
    chapter: Number(m[2]),
    verse: Number(m[3]),
    ref,
  };
}

