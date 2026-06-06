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
import { useRef, useState } from "react";
import type { VerseFocus } from "../Workspace";
import type { NotesApi } from "./notesStore";
import { NoteSocialBlock } from "./NoteSocialBlock";
import { GLASS_CARD_INLINE } from "../../lib/glass";
import { RichNoteField } from "./RichNoteField";
import { useStickToBottom } from "../../lib/useStickToBottom";

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
}: Props) {
  const [tab, setTab] = useState<"personal" | "group">("personal");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLUListElement | null>(null);

  // Plain-text search over the merged in-memory view. Note bodies
  // are sanitized HTML (RichNoteField), so strip tags before matching
  // so a query like "grace" hits text inside <b>/<u>/<em>. Server
  // never sees personal note bodies — privacy model preserved.
  const haystack = (html: string) =>
    html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const q = query.trim().toLowerCase();
  const visible = notes.notes
    .filter((n) => n.scope === tab)
    .filter((n) => !q || haystack(n.body).includes(q));
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
                // Roving tabindex: only the selected radio is in the
                // tab order. Arrow keys (handled below) move focus
                // between members — the WAI-ARIA radiogroup pattern.
                tabIndex={on ? 0 : -1}
                onClick={() => setTab(s)}
                onKeyDown={(e) => {
                  if (
                    e.key === "ArrowRight" ||
                    e.key === "ArrowDown" ||
                    e.key === "ArrowLeft" ||
                    e.key === "ArrowUp"
                  ) {
                    e.preventDefault();
                    setTab(s === "personal" ? "group" : "personal");
                  }
                }}
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

      {/* Search across the current scope. Plain-text — strips HTML
          before matching so styled notes still find their words.
          Search stays in the browser; the server never sees the
          contents of personal notes. */}
      <div className="border-b border-neutral-200 bg-paper-soft px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab} notes…`}
            aria-label={`Search ${tab} notes`}
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
              : "No notes yet."}
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

