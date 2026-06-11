/**
 * `@`-mention autocomplete for note bodies. When the user types `@`
 * (with a leading space or at the very start) followed by 0+ chars,
 * this popover opens near the caret with a list of room members
 * filtered by what they've typed, matched against either handle OR
 * display_name. Tap a row (or hit Enter) and the trigger token gets
 * replaced with `@handle ` — the canonical form the backend resolves.
 *
 * The popover is purely presentational; the host (RichNoteField)
 * decides when to open, what to filter by, and what to do on select.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RoomMemberOut } from "../../lib/api";
import { api } from "../../lib/api";

interface Props {
  roomId: string;
  /** Pixel coords (viewport-relative) of the caret — anchors the
   *  popover above it. The host passes this from the editor view's
   *  `coordsAtPos`. */
  anchor: { left: number; top: number; bottom: number } | null;
  /** Text typed after the `@`. Empty = show all members. The host
   *  strips the leading `@` before passing this in. */
  query: string;
  /** User the popover should never offer to mention (the author —
   *  no need to push-notify yourself). */
  selfUserId: string;
  /** Called with the picked handle so the host can replace the
   *  partial token in the editor. */
  onPick: (handle: string) => void;
  /** Called when the user dismisses the popover with Escape, when no
   *  matches exist, or when the popover's host loses the trigger
   *  context. The host should clear its anchor state. */
  onClose: () => void;
}

export function MentionPopover({
  roomId,
  anchor,
  query,
  selfUserId,
  onPick,
  onClose,
}: Props) {
  const [members, setMembers] = useState<RoomMemberOut[] | null>(null);
  const [active, setActive] = useState(0);
  // Cache members per-room for the open-lifetime of this component so
  // every keystroke doesn't refetch. If the user closes + reopens the
  // popover later we'll fetch again (host unmounts the component).
  useEffect(() => {
    let alive = true;
    api
      .roomMembers(roomId)
      .then((rows) => {
        if (!alive) return;
        setMembers(rows.filter((r) => r.user_id !== selfUserId));
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, [roomId, selfUserId]);

  // Filter on the client — room sizes are small (< few hundred).
  const q = query.toLowerCase();
  const matches = (members ?? [])
    .filter((m) => {
      if (!q) return true;
      return (
        m.handle.toLowerCase().startsWith(q) ||
        m.display_name.toLowerCase().includes(q)
      );
    })
    .slice(0, 6);

  // Reset highlight when matches change so the up-arrow doesn't go
  // out of bounds after the list shrinks.
  useEffect(() => {
    setActive(0);
  }, [query, members]);

  // Keyboard navigation lives on the document so the editor doesn't
  // need to know the popover exists. Arrow keys move the highlight,
  // Enter picks, Escape dismisses.
  useEffect(() => {
    if (!anchor) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(matches.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        if (matches.length === 0) return;
        e.preventDefault();
        onPick(matches[active].handle);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [anchor, matches, active, onPick, onClose]);

  if (!anchor) return null;
  if (members === null) return null; // still loading

  // Position 8px above the caret with a small left offset for a
  // nicer visual gap. If there's not enough room above, flip below.
  const POPOVER_WIDTH = 240;
  const left = Math.max(
    8,
    Math.min(window.innerWidth - POPOVER_WIDTH - 8, anchor.left - 12),
  );
  const wantsBelow = anchor.top < 220;
  const style: React.CSSProperties = wantsBelow
    ? { position: "fixed", left, top: anchor.bottom + 8, width: POPOVER_WIDTH }
    : {
        position: "fixed",
        left,
        bottom: window.innerHeight - anchor.top + 8,
        width: POPOVER_WIDTH,
      };

  if (matches.length === 0) {
    return createPortal(
      <div
        role="listbox"
        aria-label="Mention members"
        style={style}
        className="z-[9999] rounded-2xl border border-neutral-200 bg-paper p-2 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
      >
        <div className="px-2 py-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">
          {q
            ? `No member matches "${q}"`
            : "No one else in this room yet"}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      role="listbox"
      aria-label="Mention members"
      style={style}
      className="z-[9999] grid gap-1 rounded-2xl border border-neutral-200 bg-paper p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
    >
      {matches.map((m, i) => (
        <button
          key={m.user_id}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => {
            // Stop the editor from blurring before we can pick the
            // candidate — mousedown fires before blur, click after.
            e.preventDefault();
            onPick(m.handle);
          }}
          onMouseEnter={() => setActive(i)}
          className={`flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[13px] transition ${
            i === active
              ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
              : "text-neutral-700 hover:bg-paper-soft dark:text-neutral-200 dark:hover:bg-neutral-800"
          }`}
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-200 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-100">
            {(m.display_name || m.handle).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">
              {m.display_name || m.handle}
            </span>
            <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              @{m.handle}
              {m.role === "admin" ? " · admin" : ""}
            </span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

// Hook used by the host: from a contenteditable selection (TipTap's
// view), detect whether the caret is currently inside an `@token` trigger
// and, if so, return both the token (without the `@`) and a Range to
// pass to coordsAtPos. The host owns the actual editor state and
// passes us the selection details.

/** Inspect the text immediately before `from` in the editor's text
 *  content and return the partial token if the caret is inside an
 *  active `@mention` trigger. Otherwise return null.
 *
 *  Trigger rules:
 *    - The `@` must be preceded by whitespace or be at the start of
 *      its node.
 *    - The chars after `@` must be `[a-zA-Z0-9_]{0,32}` — same
 *      character class the backend resolver accepts.
 *    - A whitespace char closes the trigger (so editing inside an
 *      already-tagged word doesn't re-open the popover).
 */
export function detectMentionTrigger(
  textBefore: string,
): { query: string; replaceStart: number } | null {
  // Walk backwards from the end, collecting handle-safe chars until
  // we hit `@` or a disqualifier.
  let i = textBefore.length - 1;
  const chars: string[] = [];
  while (i >= 0) {
    const ch = textBefore[i];
    if (/[a-zA-Z0-9_]/.test(ch)) {
      chars.unshift(ch);
      i--;
      if (chars.length > 32) return null;
      continue;
    }
    if (ch === "@") {
      // `@` is the trigger. The char BEFORE the `@` must be
      // whitespace OR start-of-string OR start-of-node.
      const prev = i > 0 ? textBefore[i - 1] : "";
      if (prev === "" || /\s/.test(prev)) {
        return { query: chars.join(""), replaceStart: i };
      }
      return null;
    }
    return null;
  }
  return null;
}
