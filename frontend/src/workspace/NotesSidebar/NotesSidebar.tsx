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
import { useEffect, useRef, useState } from "react";
import type { VerseFocus } from "../Workspace";
import type { NotesApi } from "./notesStore";
import { NoteSocialBlock } from "./NoteSocialBlock";
import { GLASS_CARD_INLINE } from "../../lib/glass";
import { RichNoteField } from "./RichNoteField";

interface Props {
  focus: VerseFocus | null;
  notes: NotesApi;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  /** Mobile-only: shown as an "X" in the header when provided. */
  onCloseMobile?: () => void;
  /** Room metadata used to detect the onboarding "Welcome" room and
   *  surface tip cards in place of the empty-state. */
  roomId?: string;
  roomName?: string;
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
}

export function NotesSidebar({
  focus,
  notes,
  chatOpen,
  onToggleChat,
  onCloseMobile,
  roomId,
  roomName,
  hideComposer,
  socialNotesEnabled,
  selfUserId,
}: Props) {
  const [tab, setTab] = useState<"personal" | "group">("personal");
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLUListElement | null>(null);
  const [tipsDismissed, setTipsDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined" || !roomId) return false;
    return localStorage.getItem(`bible-iu:welcome-tips-dismissed:${roomId}`) === "1";
  });
  // Re-check the dismissed flag when switching rooms, otherwise the
  // first room's state would stick.
  useEffect(() => {
    if (typeof window === "undefined" || !roomId) return;
    setTipsDismissed(
      localStorage.getItem(`bible-iu:welcome-tips-dismissed:${roomId}`) === "1",
    );
  }, [roomId]);

  const visible = notes.notes.filter((n) => n.scope === tab);
  // Default-to-bottom, matching ChatPanel. Snap to the newest note
  // on first paint, when notes are added, and when the user switches
  // between Personal ↔ Group (each list has its own anchor).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visible.length, tab]);
  const isWelcomeRoom = !!roomName && roomName.startsWith("Welcome to Bible IU");
  const showTips = isWelcomeRoom && !tipsDismissed && notes.notes.length === 0;

  function dismissTips() {
    if (typeof window === "undefined" || !roomId) return;
    localStorage.setItem(`bible-iu:welcome-tips-dismissed:${roomId}`, "1");
    setTipsDismissed(true);
  }

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
              className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-paper-soft dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              title="Toggle chat panel below"
            >
              {chatOpen ? "Hide chat" : "Chat"}
            </button>
          )}
        </div>
        <div
          role="radiogroup"
          aria-label="Note scope"
          className={`flex items-stretch p-0.5 text-[11px] ${GLASS_CARD_INLINE}`}
        >
          {(["personal", "group"] as const).map((s) => {
            const on = tab === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTab(s)}
                className={`rounded-full px-2.5 py-1 font-medium capitalize transition ${
                  on
                    ? "bg-neutral-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-50"
                }`}
                title={
                  s === "personal"
                    ? "Private to you. Never readable by the agent."
                    : "Shared with the room. Agent has read oversight."
                }
              >
                {s}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-b border-neutral-200 bg-paper-soft px-3 py-1.5 text-[10px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
        {tab === "personal"
          ? "Private. Invisible to the agent (rule-guide.MD §12)."
          : "Shared. Agent may append with attribution."}
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
        {visible.length === 0 && showTips && (
          <WelcomeTips onDismiss={dismissTips} />
        )}
        {visible.length === 0 && !showTips && (
          <li className="text-xs text-neutral-500 dark:text-neutral-400">
            No notes yet.
          </li>
        )}
        {visible.map((n) => (
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
                {n.by_agent ? "Agent" : "You"}
                {n.verse_anchor ? ` · ${n.verse_anchor}` : ""}
              </span>
              <div className="flex items-center gap-1">
                <span>{n.scope}</span>
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
              </div>
            </div>
            <div className="mt-0.5">
              <RichNoteField
                value={n.body}
                onChange={(html) => notes.update(n.id, html)}
                ariaLabel={`Edit ${n.scope} note`}
                compact
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
        ))}
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

const TIPS: { title: string; body: string }[] = [
  {
    title: "Ask any question about the verse",
    body: "Tap a verse number in the Bible, then type a question at the bottom. The agent answers with citations from KJV, Hebrew, Greek, and Arabic — and shows its reasoning.",
  },
  {
    title: "Personal vs Group notes",
    body: "Personal notes are private — even the agent can't read them. Group notes are shared with everyone in the room, and the agent can reference (or append to) them.",
  },
  {
    title: "Invite a friend",
    body: "Tap the ↗ Share button next to the room name to mint an invite link. Anyone with the link can join this room.",
  },
  {
    title: "Original languages + cross-refs",
    body: "Toggle Hebrew/Greek/Arabic in the Bible toolbar to see the source text. Cross-references (TSK) appear when you focus a verse.",
  },
];

function WelcomeTips({ onDismiss }: { onDismiss: () => void }) {
  return (
    <>
      <li className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Quick tour
        </span>
        <button
          onClick={onDismiss}
          className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          title="Hide these tips"
        >
          dismiss
        </button>
      </li>
      {TIPS.map((t, i) => (
        <li
          key={i}
          className={`px-2.5 py-2 text-xs ring-1 ring-amber-300/50 dark:ring-amber-600/30 ${GLASS_CARD_INLINE}`}
        >
          <div className="mb-0.5 font-semibold text-amber-900 dark:text-amber-100">
            {i + 1}. {t.title}
          </div>
          <div className="text-amber-800 dark:text-amber-200">{t.body}</div>
        </li>
      ))}
    </>
  );
}
